"""F-3 回归锁：ST 生成端点挂限流（2026-10-25）。

出处：docs/_active/report/REPORT_ST全量适配悲观审计_2026-10-22.md §2 F-3
     ——ST 端点族零限流，其中 `/api/backends/chat-completions/generate` 是
     **会烧钱**的那条（卡/插件经它直发上游模型，按 token 计费）。

口径（按派单单据）：
- 只挂 generate 这一条，其余 ST 端点不挂（避免误伤插件的正常读类调用）；
- 复用仓内既有 `enforce_rate_limit` 与既有档位 CHARACTER_CHAT_*（20/60s），
  不新建设置项；
- 正常单发不受影响，连续打满才 429。

用 monkeypatch 把客户端标识换成每条用例唯一的值：限流键是 `scope:client_ip`，
TestClient 的 host 恒为 "testclient"，不换的话本文件的"打满"会把后面用例的
额度一起吃掉（那就是典型的"测试互相污染出隐性红"）。

运行: cd backend && py -3 -m pytest tests/test_f3_st_generate_rate_limit.py -q
"""

import os
import sys
import uuid
from unittest.mock import patch

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.core.config import settings  # noqa: E402

GENERATE_PATH = "/api/backends/chat-completions/generate"
PAYLOAD = {
    "model": "test-model",
    "messages": [{"role": "user", "content": "hi"}],
    "stream": False,
}


def _isolated_client_ip():
    """把本用例的限流键与别人隔开（键 = scope:client_identifier）。"""
    tag = f"f3-{uuid.uuid4().hex[:12]}"
    return tag, patch(
        "app.core.rate_limit._client_identifier", return_value=tag,
    )


def _post(client, auth_headers):
    return client.post(GENERATE_PATH, headers=auth_headers, json=PAYLOAD)


class TestGenerateRateLimited:
    def test_generate_calls_enforce_rate_limit(self):
        """结构锁：端点必须显式调用 enforce_rate_limit（不是靠中间件蒙对）。"""
        import inspect
        from app.api import silly_tavern as st

        src = inspect.getsource(st.st_generate_chat_completion)
        assert "enforce_rate_limit(" in src, "generate 端点没挂限流"
        assert "st:chat-completions-generate" in src, (
            "scope 键漂移：与第一方 chat:character 共用配额 = 插件生成会吃掉用户对话额度"
        )

    def test_limit_uses_existing_tier_not_a_new_setting(self):
        """档位取既有 CHARACTER_CHAT_*，本批不新增限流设置项。"""
        import inspect
        from app.api import silly_tavern as st

        src = inspect.getsource(st.st_generate_chat_completion)
        assert "CHARACTER_CHAT_RATE_LIMIT_REQUESTS" in src
        assert "CHARACTER_CHAT_RATE_LIMIT_WINDOW_SECONDS" in src

    def test_normal_single_request_not_blocked(self, client, auth_headers):
        tag, p = _isolated_client_ip()
        with p:
            resp = _post(client, auth_headers)
        # 单发绝不能被限流拦（429 就是误伤）；上游是否有模型不算本批判据
        assert resp.status_code != 429, f"单发即被限流：{resp.text}"

    def test_exceeding_tier_returns_429(self, client, auth_headers):
        tag, p = _isolated_client_ip()
        limit = settings.CHARACTER_CHAT_RATE_LIMIT_REQUESTS
        assert limit > 0, "档位被配成 0（=关闭限流），本用例失去意义"
        codes = []
        with p:
            for _ in range(limit + 1):
                codes.append(_post(client, auth_headers).status_code)
        assert codes[-1] == 429, (
            f"打满 {limit} 次后第 {limit + 1} 次未被拦：{codes}"
        )

    def test_429_carries_retry_after(self, client, auth_headers):
        """429 必须带 Retry-After（仓内 enforce_rate_limit 的既有契约，
        插件据此退避；丢了它等于让插件硬重试）。"""
        tag, p = _isolated_client_ip()
        limit = settings.CHARACTER_CHAT_RATE_LIMIT_REQUESTS
        with p:
            for _ in range(limit + 1):
                resp = _post(client, auth_headers)
            assert resp.status_code == 429, resp.text
            assert "retry-after" in {k.lower() for k in resp.headers}, dict(resp.headers)

    def test_invalid_payload_still_counts_toward_limit(self, client, auth_headers):
        """限流计"请求"而非"成功请求"：空 messages 本该 400，但同样进账，
        否则刷错载荷就能绕过额度（这也是 enforce 放在业务校验之前的原因）。"""
        tag, p = _isolated_client_ip()
        limit = settings.CHARACTER_CHAT_RATE_LIMIT_REQUESTS
        codes = []
        bad = {"model": "test-model", "messages": [], "stream": False}
        with p:
            for _ in range(limit + 1):
                codes.append(client.post(
                    GENERATE_PATH, headers=auth_headers, json=bad,
                ).status_code)
        assert codes[0] == 400, f"前置：空 messages 应 400，实为 {codes[0]}"
        assert codes[-1] == 429, f"失败载荷未计入额度 ⇒ 可被绕过：{codes}"


class TestOtherSTEndpointsUnlimited:
    """派单口径明写"其余端点不挂"——这里锁住"没有顺手多挂"，
    防止后来人以"补齐限流"为名把读类端点也拦掉（那会误伤插件）。"""

    def test_only_generate_carries_the_rate_limit(self):
        import inspect
        from app.api import silly_tavern as st

        mod_src = inspect.getsource(st)
        # import 行写的是 "import enforce_rate_limit"（后面不带括号），
        # 所以 "enforce_rate_limit(" 的出现次数 == 调用点数，本批应为 1。
        calls = mod_src.count("enforce_rate_limit(")
        assert calls == 1, (
            f"enforce_rate_limit 调用点数 = {calls}（本批只该有 generate 一处）"
            "——多挂需先按派单口径逐端点评估误伤面"
        )

    def test_chats_get_is_not_rate_limited(self, client, auth_headers):
        """同 IP 连打 chats/get 不应出现 429（读类端点保持不限流）。"""
        tag, p = _isolated_client_ip()
        with p:
            for _ in range(settings.CHARACTER_CHAT_RATE_LIMIT_REQUESTS + 2):
                resp = client.post(
                    "/api/chats/get", headers=auth_headers,
                    json={"avatar_url": "nope.png", "ch_name": "x"},
                )
                assert resp.status_code != 429, resp.text
