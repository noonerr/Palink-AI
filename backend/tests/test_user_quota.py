"""用户 token 额度功能回归测试（2026-08-30 配额功能）。

覆盖：
1. quota_service 服务层语义：无行=不限 / NULL=不限 / 未超放行 / 超额抛错 /
   原子扣减（无行建行）/ 管理员设额与清零
2. 管理端 API：PUT /api/admin/users/{id}/quota（200 / 404 / 非 admin 403）+
   GET /api/admin/users 响应携带额度摘要
3. 主聊天入口预检：POST /api/chat 在额度耗尽时返回 402（先于模型校验）
4. 用量统计响应携带 quota 块
"""

import os
import sys

import pytest
from fastapi.testclient import TestClient

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from app.core.security import create_access_token, get_password_hash
    from app.models import User, UserQuota
    from app.services.quota_service import (
        QuotaExceededError,
        QUOTA_EXCEEDED_MESSAGE,
        deduct_usage,
        ensure_quota,
        get_quota_state,
        set_user_quota,
    )
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")


@pytest.fixture()
def admin_user(db_session):
    user = User(
        username="quota_admin",
        hashed_password=get_password_hash("TestPassword1"),
        role="admin",
        is_active=True,
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


@pytest.fixture()
def admin_client(client: TestClient, admin_user):
    """conftest 的 client 把 get_current_user 固定为 test_user；此处临时覆盖为 admin_user。"""
    from app.main import app
    from app.api.dependencies import get_current_user

    app.dependency_overrides[get_current_user] = lambda: admin_user
    yield client
    app.dependency_overrides.pop(get_current_user, None)


# ---------------------------------------------------------------------------
# 服务层语义
# ---------------------------------------------------------------------------

class TestQuotaService:
    def test_no_row_means_unlimited(self, db_session, test_user):
        state = get_quota_state(db_session, test_user.id)
        assert state["unlimited"] is True
        ensure_quota(db_session, test_user.id)  # 不抛

    def test_null_quota_means_unlimited(self, db_session, test_user):
        db_session.add(UserQuota(user_id=test_user.id, quota_tokens=None, used_tokens=500))
        db_session.commit()
        state = get_quota_state(db_session, test_user.id)
        assert state["unlimited"] is True
        assert state["used_tokens"] == 500
        ensure_quota(db_session, test_user.id)

    def test_under_quota_passes_and_over_quota_raises(self, db_session, test_user):
        db_session.add(UserQuota(user_id=test_user.id, quota_tokens=1000, used_tokens=999))
        db_session.commit()
        ensure_quota(db_session, test_user.id)  # 999 < 1000 放行

        db_session.query(UserQuota).filter(UserQuota.user_id == test_user.id).update(
            {"used_tokens": 1000}
        )
        db_session.commit()
        with pytest.raises(QuotaExceededError):
            ensure_quota(db_session, test_user.id)

    def test_deduct_creates_row_and_accumulates(self, db_session, test_user):
        deduct_usage(db_session, test_user.id, 300)
        deduct_usage(db_session, test_user.id, 200)
        db_session.commit()
        state = get_quota_state(db_session, test_user.id)
        assert state["used_tokens"] == 500
        assert state["unlimited"] is True  # 未设额度的用户也记账但不限

    def test_deduct_ignores_nonpositive(self, db_session, test_user):
        deduct_usage(db_session, test_user.id, 0)
        deduct_usage(db_session, test_user.id, None if False else -5)
        assert db_session.query(UserQuota).filter(UserQuota.user_id == test_user.id).first() is None

    def test_deduct_none_user_is_noop(self, db_session):
        deduct_usage(db_session, None, 500)  # 不抛即可

    def test_set_user_quota_create_update_reset(self, db_session, test_user):
        state = set_user_quota(db_session, test_user.id, 5000)
        db_session.commit()
        assert state["quota_tokens"] == 5000
        assert state["remaining"] == 5000

        deduct_usage(db_session, test_user.id, 1200)
        db_session.commit()
        state = set_user_quota(db_session, test_user.id, 5000, reset_used=True)
        db_session.commit()
        assert state["used_tokens"] == 0
        assert state["remaining"] == 5000

        # 设为 None → 回到不限
        state = set_user_quota(db_session, test_user.id, None)
        db_session.commit()
        assert state["unlimited"] is True

    def test_set_user_quota_creates_row_for_missing_user_row(self, db_session, test_user):
        # 无行用户直接设额 → 建行并生效
        set_user_quota(db_session, test_user.id, 100, reset_used=False)
        db_session.commit()
        ensure_quota(db_session, test_user.id)
        deduct_usage(db_session, test_user.id, 100)
        db_session.commit()
        with pytest.raises(QuotaExceededError):
            ensure_quota(db_session, test_user.id)


class TestMonthlyReset:
    def test_reset_triggers_when_period_month_differs(self, db_session, test_user):
        # 上个月设的月度额度，已用爆表 → 预检触发懒重置后放行
        db_session.add(UserQuota(
            user_id=test_user.id, quota_tokens=1000, used_tokens=1000,
            monthly_reset=True, period_month="2026-01",
        ))
        db_session.commit()
        ensure_quota(db_session, test_user.id)  # 不抛（已重置）
        row = db_session.query(UserQuota).filter(UserQuota.user_id == test_user.id).first()
        assert row.used_tokens == 0
        assert row.period_month != "2026-01"

    def test_no_reset_within_same_month(self, db_session, test_user):
        from app.services.quota_service import _current_period_month
        db_session.add(UserQuota(
            user_id=test_user.id, quota_tokens=1000, used_tokens=1000,
            monthly_reset=True, period_month=_current_period_month(),
        ))
        db_session.commit()
        with pytest.raises(QuotaExceededError):
            ensure_quota(db_session, test_user.id)  # 同月不重置 → 仍超额

    def test_no_reset_without_monthly_flag(self, db_session, test_user):
        db_session.add(UserQuota(
            user_id=test_user.id, quota_tokens=1000, used_tokens=1000,
            monthly_reset=False, period_month="2026-01",
        ))
        db_session.commit()
        with pytest.raises(QuotaExceededError):
            ensure_quota(db_session, test_user.id)

    def test_monthly_reset_skipped_for_unlimited(self, db_session, test_user):
        db_session.add(UserQuota(
            user_id=test_user.id, quota_tokens=None, used_tokens=500,
            monthly_reset=True, period_month="2026-01",
        ))
        db_session.commit()
        ensure_quota(db_session, test_user.id)
        row = db_session.query(UserQuota).filter(UserQuota.user_id == test_user.id).first()
        assert row.used_tokens == 500  # 不限额度无重置意义，保持不动

    def test_api_sets_monthly_reset(self, admin_client: TestClient, db_session, test_user):
        resp = admin_client.put(
            f"/api/admin/users/{test_user.id}/quota",
            json={"quota_tokens": 5000000, "monthly_reset": True},
        )
        assert resp.status_code == 200
        body = resp.json()["quota"]
        assert body["monthly_reset"] is True
        assert body.get("period_month")

        # 列表接口同步携带 monthly 标记
        listed = admin_client.get("/api/admin/users").json()
        target = next(u for u in listed if u["id"] == test_user.id)
        assert target["quota_monthly_reset"] is True

        # 关闭 → 回到一次性额度
        resp = admin_client.put(
            f"/api/admin/users/{test_user.id}/quota",
            json={"monthly_reset": False},
        )
        assert resp.status_code == 200
        assert resp.json()["quota"]["monthly_reset"] is False


class TestComputeDeductTokens:
    def test_prefers_provider_reported_usage(self):
        from types import SimpleNamespace

        from app.services.quota_service import compute_deduct_tokens
        result = SimpleNamespace(total_tokens=1234, token_count=lambda: 999)
        assert compute_deduct_tokens(result, [{"role": "user", "content": "很长很长的一段话"}]) == 1234

    def test_fallback_estimates_prompt_and_completion(self):
        from types import SimpleNamespace

        from app.services.quota_service import compute_deduct_tokens
        result = SimpleNamespace(total_tokens=0, token_count=lambda: 50)
        messages = [{"role": "user", "content": "你好世界"}]
        est = compute_deduct_tokens(result, messages)
        assert est > 50  # prompt 侧有估算增量

    def test_fallback_handles_none_messages(self):
        from types import SimpleNamespace

        from app.services.quota_service import compute_deduct_tokens
        result = SimpleNamespace(total_tokens=0, token_count=lambda: 42)
        assert compute_deduct_tokens(result, None) >= 42

    def test_model_id_accepts_and_falls_back_gracefully(self):
        """model_id 传入时：有词表走精确计数，无词表（host 缺库/无网）优雅回退启发式，绝不抛。"""
        from app.services.quota_service import compute_deduct_tokens
        from app.services.stream_builder import StreamResult

        result = StreamResult()
        result.full_content = "一段正常的模型回答"
        result.total_tokens = 0
        # host venv 可能缺 tiktoken/tokenizers，或无网下载词表 —— 任何情况都不抛
        est = compute_deduct_tokens(result, [{"role": "user", "content": "你好"}], "deepseek-v4-pro")
        assert est >= 0

    def test_error_only_result_costs_zero(self):
        """中断/网关无响应的 "Error:" 占位文本不是模型输出：不扣费（对齐 ST isFinal 语义）。"""
        from app.services.quota_service import compute_deduct_tokens
        from app.services.stream_builder import StreamResult

        result = StreamResult()
        result.full_content = "Error: 请求已中断，未收到模型回复。"
        result.total_tokens = 0
        assert result.is_error_only() is True
        assert result.display_token_count() == 0
        assert compute_deduct_tokens(result, [{"role": "user", "content": "你好"}]) == 0

    def test_real_output_with_error_suffix_still_billed(self):
        """真实输出后追加错误后缀：照常计费（有真实消耗）。"""
        from app.services.quota_service import compute_deduct_tokens
        from app.services.stream_builder import StreamResult

        result = StreamResult()
        result.full_content = "这是一段真实的模型回答。\n\n[推理中断: 推理过程中发生错误]"
        result.total_tokens = 0
        assert result.is_error_only() is False
        assert result.display_token_count() > 0
        assert compute_deduct_tokens(result, [{"role": "user", "content": "你好"}]) > 0

    def test_provider_usage_still_billed_on_error_text(self):
        """供应商上报了真实 usage 时，即使 content 是错误文本也照实扣（消耗已发生）。"""
        from app.services.quota_service import compute_deduct_tokens
        from app.services.stream_builder import StreamResult

        result = StreamResult()
        result.full_content = "Error: 请求已中断，未收到模型回复。"
        result.total_tokens = 88
        assert compute_deduct_tokens(result, None) == 88

    def test_display_token_count_counts_normal_text(self):
        from app.services.stream_builder import StreamResult

        result = StreamResult()
        result.full_content = "正常的模型回答文本"
        assert result.display_token_count() == result.token_count() > 0


# ---------------------------------------------------------------------------
# 管理端 API
# ---------------------------------------------------------------------------

class TestAdminQuotaAPI:
    def test_set_quota_ok_and_listed(self, admin_client: TestClient, db_session, test_user):
        resp = admin_client.put(
            f"/api/admin/users/{test_user.id}/quota",
            json={"quota_tokens": 123456, "reset_used": True},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert body["quota"]["quota_tokens"] == 123456

        listed = admin_client.get("/api/admin/users").json()
        target = next(u for u in listed if u["id"] == test_user.id)
        assert target["quota_tokens"] == 123456
        assert target["quota_used_tokens"] == 0

    def test_set_quota_unlimited_via_null(self, admin_client: TestClient, db_session, test_user):
        resp = admin_client.put(
            f"/api/admin/users/{test_user.id}/quota",
            json={"quota_tokens": None},
        )
        assert resp.status_code == 200
        assert resp.json()["quota"]["unlimited"] is True

    def test_set_quota_404_for_missing_user(self, admin_client: TestClient):
        resp = admin_client.put(
            "/api/admin/users/999999/quota",
            json={"quota_tokens": 100},
        )
        assert resp.status_code == 404

    def test_set_quota_forbidden_for_non_admin(self, client: TestClient, test_user, auth_headers):
        resp = client.put(
            f"/api/admin/users/{test_user.id}/quota",
            json={"quota_tokens": 100},
            headers=auth_headers,
        )
        assert resp.status_code == 403

    def test_negative_quota_rejected(self, admin_client: TestClient, test_user):
        resp = admin_client.put(
            f"/api/admin/users/{test_user.id}/quota",
            json={"quota_tokens": -1},
        )
        assert resp.status_code == 400


# ---------------------------------------------------------------------------
# 主聊天入口预检（REST chat：额度预检先于模型校验 → 无需配置真实模型即可测 402）
# ---------------------------------------------------------------------------

class TestChatEntrypointEnforcement:
    def _exhaust_quota(self, db_session, user_id: int):
        db_session.add(UserQuota(user_id=user_id, quota_tokens=10, used_tokens=10))
        db_session.commit()

    def test_chat_returns_402_when_exhausted(self, client: TestClient, db_session, test_user, auth_headers):
        self._exhaust_quota(db_session, test_user.id)
        resp = client.post(
            "/api/chat",
            json={"message": "你好", "model": "local:test-model", "session_id": ""},
            headers=auth_headers,
        )
        assert resp.status_code == 402
        assert QUOTA_EXCEEDED_MESSAGE in resp.json()["detail"]

    def test_chat_not_402_when_quota_ok(self, client: TestClient, db_session, test_user, auth_headers):
        # 未设置额度（不限）→ 不应因额度被拦；后续可能因模型/配置问题失败，但绝不能是 402
        resp = client.post(
            "/api/chat",
            json={"message": "你好", "model": "local:test-model", "session_id": ""},
            headers=auth_headers,
        )
        assert resp.status_code != 402


# ---------------------------------------------------------------------------
# 用量统计响应携带 quota
# ---------------------------------------------------------------------------

class TestStatsQuotaBlock:
    def test_usage_stats_contains_quota(self, client: TestClient, db_session, test_user, auth_headers):
        db_session.add(UserQuota(user_id=test_user.id, quota_tokens=8000, used_tokens=100))
        db_session.commit()
        resp = client.get("/api/stats/usage?period=all", headers=auth_headers)
        assert resp.status_code == 200
        quota = resp.json().get("quota")
        assert quota is not None
        assert quota["unlimited"] is False
        assert quota["quota_tokens"] == 8000
        assert quota["remaining"] == 7900

    def test_admin_usage_contains_quota(self, admin_client: TestClient, db_session, test_user):
        resp = admin_client.get(
            f"/api/stats/admin/usage/{test_user.id}?period=all",
        )
        assert resp.status_code == 200
        assert resp.json()["quota"]["unlimited"] is True
