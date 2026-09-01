"""P2-3 网关探测与对账测试（SPEC_model_gateway_new_api.md §4 P2-3）。

HTTP 层全部 mock（monkeypatch gateway_service._http_*），不发真实网络请求。
项目无 pytest-asyncio：异步路径统一 asyncio.run 包裹（与 test_action_stream_no_content_guard.py 同惯例）。
"""

from __future__ import annotations

import asyncio

import pytest

from app.services import gateway_service
from app.services.gateway_service import (
    GatewayAuthError,
    aggregate_ledger_items,
    admin_login,
    detect_gateway,
    fetch_gateway_logs,
    gateway_root_from_base_url,
)

# 实测 v1.0.0-rc.30 /api/status 的精简样例（保留指纹字段）
NEWAPI_STATUS = {
    "success": True,
    "message": "",
    "data": {
        "system_name": "New API",
        "version": "v1.0.0-rc.30",
        "start_time": 1788287496,
        "docs_link": "https://docs.newapi.pro",
        "quota_per_unit": 500000,
        "data_export_default_time": "hour",
        "enable_data_export": True,
        "setup": True,
    },
}


@pytest.fixture(autouse=True)
def _clear_caches():
    gateway_service.clear_gateway_caches()
    yield
    gateway_service.clear_gateway_caches()


# ─── URL 帮手 ────────────────────────────────────────────────────────────────


class TestGatewayRoot:
    def test_strips_v1_suffix(self):
        assert gateway_root_from_base_url("http://new-api:3000/v1") == "http://new-api:3000"

    def test_strips_v1_with_trailing_slash(self):
        assert gateway_root_from_base_url("https://gw.example.com/v1/") == "https://gw.example.com"

    def test_no_v1_suffix_unchanged(self):
        assert gateway_root_from_base_url("https://gw.example.com") == "https://gw.example.com"


# ─── 指纹探测 ────────────────────────────────────────────────────────────────


class TestDetectGateway:
    def test_new_api_status_detected(self, monkeypatch):
        async def fake_get(url, **kwargs):
            assert url == "http://new-api:3000/api/status"
            return NEWAPI_STATUS

        monkeypatch.setattr(gateway_service, "_http_get_json", fake_get)
        info = asyncio.run(detect_gateway("http://new-api:3000/v1"))
        assert info == {
            "flavor": "new-api",
            "version": "v1.0.0-rc.30",
            "system_name": "New API",
            "admin_url": "http://new-api:3000",
        }

    def test_admin_url_override(self, monkeypatch):
        async def fake_get(url, **kwargs):
            return NEWAPI_STATUS

        monkeypatch.setattr(gateway_service, "_http_get_json", fake_get)
        info = asyncio.run(detect_gateway("http://new-api:3000/v1", admin_url_override="http://127.0.0.1:13001"))
        assert info["admin_url"] == "http://127.0.0.1:13001"

    def test_one_api_flavor_by_version(self, monkeypatch):
        payload = {
            "success": True,
            "data": {"version": "v0.8.2", "system_name": "One API", "start_time": 123, "quota_per_unit": 500000},
        }

        async def fake_get(url, **kwargs):
            return payload

        monkeypatch.setattr(gateway_service, "_http_get_json", fake_get)
        info = asyncio.run(detect_gateway("https://one.example.com/v1"))
        assert info is not None and info["flavor"] == "one-api"

    def test_not_gateway_when_fingerprint_missing(self, monkeypatch):
        # 只有 version 一个特征：普通 OpenAI 兼容代理常返回这个形状
        payload = {"success": True, "data": {"version": "1.2.3", "object": "list"}}

        async def fake_get(url, **kwargs):
            return payload

        monkeypatch.setattr(gateway_service, "_http_get_json", fake_get)
        assert asyncio.run(detect_gateway("https://api.example.com/v1")) is None

    def test_none_on_error_or_bad_shape(self, monkeypatch):
        async def raise_exc(url, **kwargs):
            raise RuntimeError("timeout")

        async def bad_shape(url, **kwargs):
            return {"success": False}

        monkeypatch.setattr(gateway_service, "_http_get_json", raise_exc)
        assert asyncio.run(detect_gateway("http://x/v1")) is None
        monkeypatch.setattr(gateway_service, "_http_get_json", bad_shape)
        assert asyncio.run(detect_gateway("http://x/v1")) is None
        assert asyncio.run(detect_gateway("")) is None


# ─── 管理登录 ────────────────────────────────────────────────────────────────


class TestAdminLogin:
    def test_success_returns_token(self, monkeypatch):
        async def fake_post(url, **kwargs):
            assert url.endswith("/api/user/login")
            return {"success": True, "data": {"access_token": "tok-1", "access_expires_at": 9999}}

        monkeypatch.setattr(gateway_service, "_http_post_json", fake_post)
        assert asyncio.run(admin_login("http://gw", "admin", "pw")) == "tok-1"

    def test_2fa_rejected_with_clear_message(self, monkeypatch):
        async def fake_post(url, **kwargs):
            return {"success": True, "data": {"require_2fa": True, "flow_token": "f"}}

        monkeypatch.setattr(gateway_service, "_http_post_json", fake_post)
        with pytest.raises(GatewayAuthError, match="两步验证"):
            asyncio.run(admin_login("http://gw", "admin", "pw"))

    def test_bad_credentials(self, monkeypatch):
        async def fake_post(url, **kwargs):
            return {"success": False, "message": "用户名或密码错误"}

        monkeypatch.setattr(gateway_service, "_http_post_json", fake_post)
        with pytest.raises(GatewayAuthError, match="用户名或密码错误"):
            asyncio.run(admin_login("http://gw", "admin", "wrong"))

    def test_missing_credentials_short_circuits(self):
        with pytest.raises(GatewayAuthError):
            asyncio.run(admin_login("http://gw", "", ""))


# ─── 日志拉取与聚合 ──────────────────────────────────────────────────────────


class TestFetchLogs:
    def test_pagination_stops_on_short_page(self, monkeypatch):
        calls = []

        async def fake_get(url, headers=None, params=None, timeout=None):
            calls.append(params)
            page = params["p"]
            if page == 1:
                items = [{"id": i, "prompt_tokens": 1, "completion_tokens": 2} for i in range(100)]
                return {"success": True, "data": {"page": 1, "page_size": 100, "total": 102, "items": items}}
            return {"success": True, "data": {"page": 2, "page_size": 100, "total": 102, "items": [{"id": 101}]}}
            # 第二页 1 条 < 100 → 停止

        monkeypatch.setattr(gateway_service, "_http_get_json", fake_get)
        result = asyncio.run(fetch_gateway_logs("http://gw", "tok", 0, 99))
        assert len(result["items"]) == 101
        assert result["truncated"] is False
        assert [c["p"] for c in calls] == [1, 2]
        assert calls[0]["type"] == 2  # 只拉消费日志
        assert calls[0]["page_size"] == 100

    def test_truncation_flag_at_max_pages(self, monkeypatch):
        async def fake_get(url, headers=None, params=None, timeout=None):
            page = params["p"]
            items = [{"id": i} for i in range(100)]
            return {"success": True, "data": {"page": page, "page_size": 100, "total": 99999, "items": items}}

        monkeypatch.setattr(gateway_service, "_http_get_json", fake_get)
        result = asyncio.run(fetch_gateway_logs("http://gw", "tok", 0, 99, max_pages=3))
        assert len(result["items"]) == 300
        assert result["truncated"] is True

    def test_legacy_bare_list_shape(self, monkeypatch):
        async def fake_get(url, headers=None, params=None, timeout=None):
            return {"success": True, "data": [{"id": 1}]}

        monkeypatch.setattr(gateway_service, "_http_get_json", fake_get)
        result = asyncio.run(fetch_gateway_logs("http://gw", "tok", 0, 99))
        assert result["items"] == [{"id": 1}]
        assert result["truncated"] is False


class TestAggregate:
    def test_aggregation_and_sorting(self):
        items = [
            {"model_name": "b-model", "prompt_tokens": 10, "completion_tokens": 5, "quota": 100, "created_at": 100},
            {"model_name": "a-model", "prompt_tokens": 100, "completion_tokens": 50, "quota": 900, "created_at": 200},
            {"model_name": "a-model", "prompt_tokens": "7", "completion_tokens": None, "quota": "3", "created_at": 300},
        ]
        agg = aggregate_ledger_items(items, recent_limit=2)
        assert agg["request_count"] == 3
        assert agg["prompt_tokens"] == 117
        assert agg["completion_tokens"] == 55
        assert agg["total_tokens"] == 172
        assert agg["total_quota"] == 1003
        assert agg["by_model"][0]["model"] == "a-model"  # total 降序
        assert agg["by_model"][0]["count"] == 2
        assert agg["recent"][0]["created_at"] == 300  # 时间降序
        assert len(agg["recent"]) == 2

    def test_defensive_against_garbage(self):
        agg = aggregate_ledger_items([{"model_name": None}, {}])
        assert agg["request_count"] == 2
        assert agg["total_tokens"] == 0
        assert agg["by_model"][0]["model"] == "未知模型"


# ─── 端点层（admin TestClient） ──────────────────────────────────────────────


@pytest.fixture()
def admin_client(db_session, test_user, monkeypatch):
    from fastapi.testclient import TestClient

    import app.api.dependencies as deps
    import app.api.gateway as gateway_api
    from app.core.database import get_db
    from app.main import app

    admin = test_user
    admin.role = "admin"
    db_session.add(admin)
    db_session.commit()

    # provider 列表不打真实文件，直接固定
    providers = [
        {"id": "prov-gw", "name": "网关", "base_url": "http://new-api:3000/v1", "api_key": "env:T",
         "is_active": True, "admin_username": "admin", "admin_password": "pw-secret"},
        {"id": "prov-plain", "name": "直连", "base_url": "https://api.deepseek.com/v1", "api_key": "sk-x",
         "is_active": True},
    ]
    monkeypatch.setattr(gateway_api, "get_providers", lambda: providers)

    def _override_get_db():
        yield db_session

    async def _override_user():
        return admin

    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[deps.get_current_user] = _override_user
    try:
        with TestClient(app) as c:
            yield c, gateway_api
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(deps.get_current_user, None)
        app.dependency_overrides.pop(deps.get_admin, None)
        admin.role = "user"


GW_DETECT_INFO = {"flavor": "new-api", "version": "v1.0.0-rc.30", "system_name": "New API", "admin_url": "http://new-api:3000"}


class TestGatewayEndpoints:
    def test_detect_reports_gateway_and_plain(self, admin_client, monkeypatch):
        client, gateway_api = admin_client

        async def fake_detect_entry(base_url, admin_url):
            return GW_DETECT_INFO if "new-api" in base_url else None

        monkeypatch.setattr(gateway_api, "_detect_entry", fake_detect_entry)
        resp = client.get("/api/admin/gateway/detect")
        assert resp.status_code == 200
        providers = resp.json()["providers"]
        assert providers["prov-gw"]["is_gateway"] is True
        assert providers["prov-gw"]["version"] == "v1.0.0-rc.30"
        assert providers["prov-plain"]["is_gateway"] is False

    def test_ledger_404_unknown_provider(self, admin_client):
        client, _ = admin_client
        assert client.get("/api/admin/gateway/ledger", params={"provider_id": "nope", "hours": 24}).status_code == 404

    def test_ledger_422_bad_hours(self, admin_client):
        client, _ = admin_client
        assert client.get(
            "/api/admin/gateway/ledger", params={"provider_id": "prov-gw", "hours": 7}
        ).status_code == 422

    def test_ledger_not_gateway_downgrade(self, admin_client, monkeypatch):
        client, gateway_api = admin_client

        async def fake_detect_entry(base_url, admin_url):
            return None

        monkeypatch.setattr(gateway_api, "_detect_entry", fake_detect_entry)
        resp = client.get("/api/admin/gateway/ledger", params={"provider_id": "prov-plain", "hours": 24})
        assert resp.status_code == 200
        body = resp.json()
        assert body["is_gateway"] is False
        assert "configured" not in body

    def test_ledger_missing_credentials_downgrade(self, admin_client, monkeypatch):
        client, gateway_api = admin_client

        async def fake_detect_entry(base_url, admin_url):
            return GW_DETECT_INFO

        monkeypatch.setattr(gateway_api, "_detect_entry", fake_detect_entry)
        # prov-plain 没配 admin_username/admin_password
        resp = client.get("/api/admin/gateway/ledger", params={"provider_id": "prov-plain", "hours": 24})
        assert resp.status_code == 200
        body = resp.json()
        assert body["is_gateway"] is True and body["configured"] is False

    def test_ledger_full_flow_with_palink_aggregation(self, admin_client, monkeypatch, db_session, test_user):
        from datetime import datetime, timedelta, timezone

        from app.models import ChatMessage, ChatSession, Character, CharacterChatMessage, CharacterChatSession

        client, gateway_api = admin_client
        now = datetime.now(timezone.utc)

        # Palink 侧记账：窗口内 3 条 assistant 消息 + 1 条不计入的 user 消息
        sess = ChatSession(id="s-gw-1", user_id=test_user.id, title="t")
        db_session.add(sess)
        db_session.flush()
        db_session.add(ChatMessage(session_id=sess.id, role="assistant", model="deepseek-v4-flash",
                                   prompt_tokens=100, tokens=50, created_at=now - timedelta(hours=1)))
        db_session.add(ChatMessage(session_id=sess.id, role="assistant", model="deepseek-v4-flash",
                                   prompt_tokens=30, tokens=20, created_at=now - timedelta(hours=2)))
        db_session.add(ChatMessage(session_id=sess.id, role="user", model="deepseek-v4-flash",
                                   prompt_tokens=999, tokens=999))
        character = Character(user_id=test_user.id, name="对账测试角色")
        db_session.add(character)
        db_session.flush()
        cs = CharacterChatSession(id="cs-gw-1", user_id=test_user.id, character_id=character.id, title="t")
        db_session.add(cs)
        db_session.flush()
        db_session.add(CharacterChatMessage(session_id=cs.id, role="assistant", model="deepseek-v4-flash",
                                            prompt_tokens=10, tokens=5, created_at=now - timedelta(hours=1)))
        db_session.commit()

        gw_items = [
            {"model_name": "deepseek-v4-flash", "prompt_tokens": 135, "completion_tokens": 70,
             "quota": 12345, "created_at": 1788288000, "token_name": "palink-backend"},
            {"model_name": "deepseek-v4-flash", "prompt_tokens": 5, "completion_tokens": 5,
             "quota": 55, "created_at": 1788280000, "token_name": "palink-backend"},
        ]

        async def fake_detect_entry(base_url, admin_url):
            return GW_DETECT_INFO

        async def fake_token(root, username, password):
            return "tok"

        async def fake_logs(root, token, start_ts, end_ts, max_pages=20):
            return {"items": gw_items, "truncated": False}

        monkeypatch.setattr(gateway_api, "_detect_entry", fake_detect_entry)
        monkeypatch.setattr(gateway_api, "get_admin_access_token", fake_token)
        monkeypatch.setattr(gateway_api, "fetch_gateway_logs", fake_logs)

        resp = client.get("/api/admin/gateway/ledger", params={"provider_id": "prov-gw", "hours": 24})
        assert resp.status_code == 200
        body = resp.json()
        gw = body["gateway"]
        assert gw["total_tokens"] == 215 and gw["prompt_tokens"] == 140 and gw["completion_tokens"] == 75
        assert gw["total_quota"] == 12400 and gw["request_count"] == 2
        assert gw["by_model"][0]["model"] == "deepseek-v4-flash"
        pl = body["palink"]
        assert pl["prompt_tokens"] == 140 and pl["completion_tokens"] == 75
        assert pl["request_count"] == 3  # user 消息不计
        assert body["drift"]["tokens"] == 0

    def test_ledger_auth_error_surface(self, admin_client, monkeypatch):
        client, gateway_api = admin_client

        async def fake_detect_entry(base_url, admin_url):
            return GW_DETECT_INFO

        async def fail_token(root, username, password):
            raise GatewayAuthError("用户名或密码错误")

        monkeypatch.setattr(gateway_api, "_detect_entry", fake_detect_entry)
        monkeypatch.setattr(gateway_api, "get_admin_access_token", fail_token)
        resp = client.get("/api/admin/gateway/ledger", params={"provider_id": "prov-gw", "hours": 24})
        assert resp.status_code == 200
        assert resp.json()["auth_error"] == "用户名或密码错误"
