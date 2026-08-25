"""二期批次 S 线：N-8 止血滑动续期验证测试。

spec: docs/SPEC_二期_vectorized接线与N8止血_2026-08-25.md §2
- 剩余 >2/3 → 无续期头
- 剩余 <1/3 → 有 X-Palink-Token-Refresh，且解码 sub 一致 / exp 更晚 / jti 不同
- upload-scope 令牌不触发续期（通道隔离不变）
- 中间件端到端：request.state.token_refresh 落到响应头
"""

import asyncio
import os
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone

import jwt as pyjwt
import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.api.dependencies import get_current_user  # noqa: E402
from app.core.config import settings  # noqa: E402
from app.core.security import create_access_token  # noqa: E402


def _decode(token: str) -> dict:
    return pyjwt.decode(
        token, settings.SECRET_KEY, algorithms=["HS256"],
        options={"verify_signature": True},
    )


def _mk_token(username: str, *, minutes: float, scope: str = None,
              with_jti: bool = True) -> str:
    """手工构造指定剩余寿命的 JWT（绕开 create_access_token 的固定有效期）。"""
    payload = {"sub": username}
    if scope is not None:
        payload["scope"] = scope
    if with_jti:
        payload["jti"] = uuid.uuid4().hex
    payload["exp"] = datetime.now(timezone.utc) + timedelta(minutes=minutes)
    return pyjwt.encode(payload, settings.SECRET_KEY, algorithm="HS256")


class _FakeState:
    pass


class _FakeRequest:
    def __init__(self):
        self.state = _FakeState()


def _call_get_current_user(db_session, token: str):
    req = _FakeRequest()
    user = asyncio.run(get_current_user(token=token, db=db_session, request=req))
    return user, req


# ---------------------------------------------------------------------------
# 单元层：get_current_user 滑动续期判定
# ---------------------------------------------------------------------------
class TestSlidingRenewalUnit:
    def test_fresh_token_does_not_renew(self, db_session, test_user):
        """剩余 >2/3（满血 12h）→ 不签发新 token。"""
        token = create_access_token({"sub": test_user.username})
        _, req = _call_get_current_user(db_session, token)
        assert not hasattr(req.state, "token_refresh"), "满寿命令牌不得续期"

    def test_midlife_token_above_threshold_does_not_renew(self, db_session, test_user):
        """剩余 5h（> 有效期/3=4h）→ 不续期。"""
        token = _mk_token(test_user.username, minutes=300)
        _, req = _call_get_current_user(db_session, token)
        assert not hasattr(req.state, "token_refresh")

    def test_low_remaining_token_renews(self, db_session, test_user):
        """剩余 <1/3 → 签发新 token：sub 一致 / exp 更晚 / jti 不同 / 无 scope。"""
        old_payload = {
            "sub": test_user.username,
            "jti": "old-jti-value",
            "exp": datetime.now(timezone.utc) + timedelta(minutes=60),
        }
        old_token = pyjwt.encode(old_payload, settings.SECRET_KEY, algorithm="HS256")

        _, req = _call_get_current_user(db_session, old_token)
        assert hasattr(req.state, "token_refresh"), "低寿命令牌必须续期"

        new_token = req.state.token_refresh
        old_decoded = _decode(old_token)
        new_decoded = _decode(new_token)

        assert new_decoded.get("sub") == old_decoded.get("sub"), "身份必须一致"
        assert new_decoded.get("exp") > old_decoded.get("exp"), "新 exp 必须更晚"
        assert new_decoded.get("jti") != old_decoded.get("jti"), "jti 必须全新"
        assert "scope" not in new_decoded, "续期令牌不得携带 scope"

    def test_upload_scope_token_never_renews(self, db_session, test_user):
        """upload-scope 短时效令牌即使临近过期也绝不换发主 JWT。"""
        token = _mk_token(
            test_user.username, minutes=1, scope="upload", with_jti=False,
        )
        user, req = _call_get_current_user(db_session, token)
        assert user.username == test_user.username
        assert not hasattr(req.state, "token_refresh"), "upload 通道隔离不得被污染"


# ---------------------------------------------------------------------------
# 端到端：中间件把 request.state.token_refresh 写入响应头
# ---------------------------------------------------------------------------
class TestRenewalHeaderEndToEnd:
    ENDPOINT = "/api/worldbooks"

    def _real_auth_request(self, client, token: str):
        """临时摘除 conftest 的 get_current_user override，走真实鉴权+续期链路。"""
        from app.main import app

        saved = app.dependency_overrides.pop(get_current_user, None)
        try:
            return client.get(
                self.ENDPOINT, headers={"Authorization": f"Bearer {token}"},
            )
        finally:
            if saved is not None:
                app.dependency_overrides[get_current_user] = saved

    def test_low_remaining_gets_refresh_header(self, client, test_user):
        token = _mk_token(test_user.username, minutes=60)
        resp = self._real_auth_request(client, token)
        assert resp.status_code == 200, resp.text
        header_value = resp.headers.get("X-Palink-Token-Refresh")
        assert header_value, "低寿命令牌请求必须收到续期头"
        decoded = _decode(header_value)
        assert decoded.get("sub") == test_user.username

    def test_fresh_token_no_header(self, client, test_user):
        token = create_access_token({"sub": test_user.username})
        resp = self._real_auth_request(client, token)
        assert resp.status_code == 200, resp.text
        assert resp.headers.get("X-Palink-Token-Refresh") is None, \
            "满寿命令牌不得出现续期头"

    def test_upload_channel_has_no_main_jwt_in_header(self, client, test_user):
        """query-token/upload 通道不走 get_current_user，天然不产生主 JWT 续期头。"""
        upload_token = _mk_token(
            test_user.username, minutes=5, scope="upload", with_jti=False,
        )
        from app.main import app

        saved = app.dependency_overrides.pop(get_current_user, None)
        try:
            # 附件查询通道（_verify_upload_access）：无 scope 校验通过的合法场景
            # 需要真实上传文件，这里仅验证主 API 对 query token 的拒绝路径，
            # 以及该响应绝不携带续期头。
            resp = client.get(self.ENDPOINT, params={"token": upload_token})
            assert resp.headers.get("X-Palink-Token-Refresh") is None
        finally:
            if saved is not None:
                app.dependency_overrides[get_current_user] = saved


# ---------------------------------------------------------------------------
# 参数口径：阈值 = ACCESS_TOKEN_EXPIRE_MINUTES / 3
# ---------------------------------------------------------------------------
class TestThresholdContract:
    def test_threshold_is_one_third_of_expiry(self):
        threshold_seconds = settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60 / 3.0
        assert threshold_seconds == pytest.approx(240 * 60), \
            "12h 默认下续期阈值应为 4h（spec §2 一步到位定稿）"
