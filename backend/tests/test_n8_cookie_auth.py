"""N8-a：JWT HttpOnly Cookie 签发 + 双轨鉴权 + CSRF 中间件验证测试。

spec: docs/SPEC_N8_HttpOnly_Cookie_立项_2026-08-25.md §2 / §3.4
覆盖：
1. 登录响应双 Set-Cookie 且属性断言（HttpOnly/SameSite/Path/Max-Age/Secure-prod）
2. Cookie 通路：登录 → cookie jar → 携带 palink_session 访问受保护端点 200
3. 双轨回归：Bearer 头通道不受影响；双凭据时 Bearer 优先；无效 Bearer 不回退 Cookie
4. CSRF 四态 + 豁免表（GET/HEAD/OPTIONS、/api/uploads/*、/api/token）+ 强制区准入语义
5. Origin 同源兜底（插件兼容）：同源裸 POST 通过、外站 Origin 403
6. 续期 Cookie 化：<1/3 寿命请求 → X-Palink-Token-Refresh 与 Set-Cookie 同时出现
7. 登出：Cookie 清理 + jti 拉黑（Cookie 通道与 Bearer 通道）
"""

import os
import sys
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

import jwt as pyjwt
import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.api.dependencies import get_current_user  # noqa: E402
from app.core.config import settings  # noqa: E402
from app.core.security import create_access_token  # noqa: E402

SESSION_COOKIE = "palink_session"
CSRF_COOKIE = "palink_csrf"
EXPECTED_MAX_AGE = str(settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60)


def _decode(token: str) -> dict:
    return pyjwt.decode(
        token, settings.SECRET_KEY, algorithms=["HS256"],
        options={"verify_signature": True},
    )


def _mk_low_life_token(username: str, minutes: float) -> str:
    """构造指定剩余寿命的主 JWT（<1/3 阈值触发滑动续期）。"""
    payload = {
        "sub": username,
        "jti": uuid.uuid4().hex,
        "exp": datetime.now(timezone.utc) + timedelta(minutes=minutes),
    }
    return pyjwt.encode(payload, settings.SECRET_KEY, algorithm="HS256")


@contextmanager
def _real_auth():
    """临时摘除 conftest 的 get_current_user override，走真实双轨鉴权链路。

    与 test_n8_sliding_renewal.py 的既有模式一致。
    """
    from app.main import app

    saved = app.dependency_overrides.pop(get_current_user, None)
    try:
        yield
    finally:
        if saved is not None:
            app.dependency_overrides[get_current_user] = saved


def _login(client, username: str, password: str):
    return client.post(
        "/api/token", data={"username": username, "password": password}
    )


def _set_cookie_headers(response) -> list[str]:
    """提取原始 Set-Cookie 头列表（属性断言需看原始串，而非解析后 jar）。"""
    return response.headers.get_list("set-cookie")


def _find_set_cookie(response, name: str) -> str:
    for raw in _set_cookie_headers(response):
        if raw.lower().startswith(f"{name}="):
            return raw
    raise AssertionError(f"Set-Cookie 未包含 {name}: {_set_cookie_headers(response)}")


# ---------------------------------------------------------------------------
# 1. 登录双 Set-Cookie 属性断言（§2.1）
# ---------------------------------------------------------------------------
class TestLoginSetCookie:
    def test_login_returns_double_set_cookie_with_attributes(self, client, test_user):
        resp = _login(client, test_user.username, "TestPassword1")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["access_token"] and body["token_type"] == "bearer"

        session_raw = _find_set_cookie(resp, SESSION_COOKIE)
        lowered = session_raw.lower()
        assert session_raw.startswith(f"{SESSION_COOKIE}=")
        assert len(session_raw.split(";", 1)[0]) > len(SESSION_COOKIE) + 1
        assert "httponly" in lowered, "会话 Cookie 必须 HttpOnly"
        assert f"max-age={EXPECTED_MAX_AGE}" in lowered
        assert "path=/" in lowered
        assert "samesite=lax" in lowered

        csrf_raw = _find_set_cookie(resp, CSRF_COOKIE)
        lowered_csrf = csrf_raw.lower()
        assert csrf_raw.startswith(f"{CSRF_COOKIE}=")
        csrf_value = csrf_raw.split(";", 1)[0].split("=", 1)[1]
        assert len(csrf_value) >= 32, "csrf 配对值应来自 secrets.token_urlsafe(32)"
        assert "httponly" not in lowered_csrf, "CSRF Cookie 必须可被 JS 读取"
        assert f"max-age={EXPECTED_MAX_AGE}" in lowered_csrf
        assert "path=/" in lowered_csrf
        assert "samesite=lax" in lowered_csrf

    def test_secure_flag_absent_in_development(self, client, test_user):
        """APP_ENV=development 下 Secure 不出现（本地 http 可携带）；production 才有。"""
        assert settings.APP_ENV == "development"
        resp = _login(client, test_user.username, "TestPassword1")
        session_raw = _find_set_cookie(resp, SESSION_COOKIE)
        assert "secure" not in session_raw.lower()

    def test_session_and_csrf_values_are_independent(self, client, test_user):
        resp = _login(client, test_user.username, "TestPassword1")
        session_value = _find_set_cookie(resp, SESSION_COOKIE).split(";", 1)[0]
        csrf_value = _find_set_cookie(resp, CSRF_COOKIE).split(";", 1)[0]
        assert session_value != csrf_value


# ---------------------------------------------------------------------------
# 2/3. 双轨鉴权（§2.2）
# ---------------------------------------------------------------------------
class TestDualTrackAuth:
    def test_cookie_channel_access_protected_endpoint(self, client, test_user):
        resp = _login(client, test_user.username, "TestPassword1")
        assert resp.status_code == 200
        assert SESSION_COOKIE in client.cookies, "登录后 cookie jar 应持有会话 Cookie"

        with _real_auth():
            me = client.get("/api/users/me")
        assert me.status_code == 200, me.text
        assert me.json()["username"] == test_user.username

    def test_bearer_channel_regression(self, client, test_user, auth_headers):
        with _real_auth():
            me = client.get("/api/users/me", headers=auth_headers)
        assert me.status_code == 200
        assert me.json()["username"] == test_user.username

    def test_dual_credentials_bearer_takes_priority(self, client, test_user):
        token = create_access_token({"sub": test_user.username})
        client.cookies.set(SESSION_COOKIE, token)
        with _real_auth():
            me = client.get(
                "/api/users/me",
                headers={"Authorization": f"Bearer {token}"},
                cookies={SESSION_COOKIE: token},
            )
        assert me.status_code == 200

    def test_invalid_bearer_does_not_fall_back_to_cookie(self, client, test_user):
        """显式携带无效 Bearer 时不得静默切换到 Cookie 通道（防通道混用歧义）。"""
        token = create_access_token({"sub": test_user.username})
        with _real_auth():
            me = client.get(
                "/api/users/me",
                headers={"Authorization": "Bearer not-a-valid-jwt"},
                cookies={SESSION_COOKIE: token},
            )
        assert me.status_code == 401

    def test_missing_both_channels_401_with_existing_message(self, client):
        with _real_auth():
            me = client.get("/api/users/me")
        assert me.status_code == 401
        assert me.json()["detail"] == "Could not validate credentials"


# ---------------------------------------------------------------------------
# 4. CSRF 中间件四态 + 豁免表（§2.3）
# ---------------------------------------------------------------------------
class TestCsrfMiddleware:
    TARGET = "/api/ws/ticket"

    def _authed_cookies(self, client, test_user) -> dict:
        token = create_access_token({"sub": test_user.username})
        csrf_value = uuid.uuid4().hex + uuid.uuid4().hex
        client.cookies.set(SESSION_COOKIE, token)
        client.cookies.set(CSRF_COOKIE, csrf_value)
        return {"session": token, "csrf": csrf_value}

    def test_mutating_with_session_cookie_without_any_pair_403_via_layered_guard(
        self, client
    ):
        """四态之"无任何凭据 403"：裸写请求在 ST 面被既有 MED-4 端点守卫拦截。

        全局中间件按 OWASP 口径只对携带会话 Cookie 的请求强制（无环境凭据即
        无可伪造权威）；ST 面的无凭据写请求仍由 core/csrf_guard.py 兜底 403，
        分层防御可观测结果一致。detail 断言 pin 住响应来自端点级守卫层。
        """
        resp = client.post("/api/settings/get")
        assert resp.status_code == 403
        assert resp.json()["detail"] == "CSRF token mismatch"

    def test_bare_mutating_without_session_reaches_auth_layer(self, client):
        """全局中间件语义：无会话 Cookie 的裸写请求不被 CSRF 层拦截（穿透至认证层）。"""
        with _real_auth():
            resp = client.post(self.TARGET)
        assert resp.status_code == 401
        assert resp.json()["detail"] != "CSRF validation failed"

    def test_cookie_without_header_403(self, client, test_user):
        self._authed_cookies(client, test_user)
        resp = client.post(self.TARGET)
        assert resp.status_code == 403

    def test_mismatched_header_403(self, client, test_user):
        self._authed_cookies(client, test_user)
        resp = client.post(self.TARGET, headers={"X-CSRF-Token": "wrong-value"})
        assert resp.status_code == 403

    def test_matching_header_passes_full_chain(self, client, test_user):
        """头匹配 → CSRF 放行 → Cookie 通道鉴权成功签发 WS ticket（兼证 §2.5）。"""
        creds = self._authed_cookies(client, test_user)
        with _real_auth():
            resp = client.post(
                self.TARGET, headers={"X-CSRF-Token": creds["csrf"]}
            )
        assert resp.status_code == 200, resp.text
        assert resp.json().get("ticket")

    def test_legacy_static_token_only_without_session_cookie(self, client):
        """MED-4 兼容：无会话 Cookie 时遗留静态 X-CSRF-Token 放行至认证层。"""
        resp = client.post(
            "/api/settings/get", headers={"X-CSRF-Token": "palink-csrf"}
        )
        assert resp.status_code != 403

    def test_legacy_static_token_rejected_when_session_present(self, client, test_user):
        """有会话 Cookie 时静态值不算数——必须走标准双提交（防降级绕过）。"""
        self._authed_cookies(client, test_user)
        resp = client.post(self.TARGET, headers={"X-CSRF-Token": "palink-csrf"})
        assert resp.status_code == 403

    def test_get_is_exempt(self, client, test_user):
        token = create_access_token({"sub": test_user.username})
        client.cookies.set(SESSION_COOKIE, token)
        with _real_auth():
            me = client.get("/api/users/me")
        assert me.status_code == 200

    def test_options_is_exempt(self, client):
        resp = client.options(self.TARGET)
        assert resp.status_code != 403

    def test_head_is_exempt(self, client):
        resp = client.head("/health")
        assert resp.status_code != 403

    def test_uploads_prefix_exempt(self, client, test_user):
        """/api/uploads/* 豁免（含 N-7 短令牌签发端点），无 CSRF 头也放行。"""
        token = create_access_token({"sub": test_user.username})
        client.cookies.set(SESSION_COOKIE, token)
        with _real_auth():
            resp = client.post("/api/uploads/token")
        assert resp.status_code == 200, resp.text
        assert resp.json().get("token")

    def test_api_token_path_exempt(self, client, test_user):
        """登录端点本身豁免 CSRF——无任何配对 Cookie 也可发起登录。"""
        client.cookies.clear()
        resp = _login(client, test_user.username, "TestPassword1")
        assert resp.status_code == 200

    def test_bearer_channel_skips_csrf(self, client, test_user, auth_headers):
        """Bearer 天然免疫 CSRF（项目既有语义，见 core/csrf_guard.py）。"""
        with _real_auth():
            resp = client.post(self.TARGET, headers=auth_headers)
        assert resp.status_code == 200, resp.text


# ---------------------------------------------------------------------------
# 5. Origin 同源兜底（§2.3 插件兼容，强制实现）
# ---------------------------------------------------------------------------
class TestOriginFallback:
    TARGET = "/api/ws/ticket"

    def _with_session(self, client, test_user):
        token = create_access_token({"sub": test_user.username})
        client.cookies.set(SESSION_COOKIE, token)

    def test_same_origin_bare_post_reaches_auth_layer(self, client):
        """同源 Origin 裸 POST（无任何凭据）过 CSRF，进入认证层得 401 而非 403。"""
        with _real_auth():
            resp = client.post(self.TARGET, headers={"Origin": "http://testserver"})
        assert resp.status_code == 401
        assert resp.json()["detail"] != "CSRF validation failed"

    def test_same_origin_with_session_cookie_passes(self, client, test_user):
        """主页面插件裸 fetch 场景：同源 Origin + 会话 Cookie，无 CSRF 头 → 200。"""
        self._with_session(client, test_user)
        with _real_auth():
            resp = client.post(self.TARGET, headers={"Origin": "http://testserver"})
        assert resp.status_code == 200, resp.text
        assert resp.json().get("ticket")

    def test_foreign_origin_403(self, client, test_user):
        self._with_session(client, test_user)
        with _real_auth():
            resp = client.post(
                self.TARGET, headers={"Origin": "https://evil.example.com"}
            )
        assert resp.status_code == 403

    def test_null_origin_403(self, client, test_user):
        """sandboxed iframe 的 Origin: null 不得命中兜底。"""
        self._with_session(client, test_user)
        with _real_auth():
            resp = client.post(self.TARGET, headers={"Origin": "null"})
        assert resp.status_code == 403


# ---------------------------------------------------------------------------
# 6. 滑动续期 Cookie 化（§2.4）
# ---------------------------------------------------------------------------
class TestRenewalCookie:
    ENDPOINT = "/api/worldbooks"

    def test_low_remaining_token_refreshes_header_and_cookie(self, client, test_user):
        old_token = _mk_low_life_token(test_user.username, minutes=60)
        with _real_auth():
            resp = client.get(
                self.ENDPOINT, headers={"Authorization": f"Bearer {old_token}"}
            )
        assert resp.status_code == 200, resp.text

        header_token = resp.headers.get("X-Palink-Token-Refresh")
        assert header_token, "低寿命令牌必须收到续期头"

        session_raw = _find_set_cookie(resp, SESSION_COOKIE)
        lowered = session_raw.lower()
        assert "httponly" in lowered
        assert f"max-age={EXPECTED_MAX_AGE}" in lowered
        assert "samesite=lax" in lowered
        cookie_value = session_raw.split(";", 1)[0].split("=", 1)[1]
        assert cookie_value == header_token, "Set-Cookie 必须与续期头同 token"

        decoded_old = _decode(old_token)
        decoded_new = _decode(header_token)
        assert decoded_new["sub"] == decoded_old["sub"]
        assert decoded_new["jti"] != decoded_old["jti"]

    def test_fresh_token_no_header_no_cookie_reset(self, client, test_user):
        token = create_access_token({"sub": test_user.username})
        with _real_auth():
            resp = client.get(
                self.ENDPOINT, headers={"Authorization": f"Bearer {token}"}
            )
        assert resp.status_code == 200
        assert resp.headers.get("X-Palink-Token-Refresh") is None
        names = [
            raw.split("=", 1)[0] for raw in _set_cookie_headers(resp)
        ]
        assert SESSION_COOKIE not in names, "满寿命令牌不得重设会话 Cookie"


# ---------------------------------------------------------------------------
# 6.5 st_router Cookie 认证兜底（N8-c 尾巴修复）
# ---------------------------------------------------------------------------
class TestStRouterCookieAuth:
    """st_router 60+ 端点（get_st_current_user → _token_from_request）纯 Cookie 认证。

    N8-c 终态 Bearer 退役后，_token_from_request 原只认 Bearer/X-Palink-Token
    头 → 导入等端点在 CSRF 修复后暴露 401 Authentication required。
    现增加 palink_session Cookie 兜底（与主依赖 get_current_user 双轨语义对齐）。
    """

    TARGET = "/api/characters/import"

    def _authed_cookies(self, client, test_user) -> dict:
        token = create_access_token({"sub": test_user.username})
        csrf_value = uuid.uuid4().hex + uuid.uuid4().hex
        client.cookies.set(SESSION_COOKIE, token)
        client.cookies.set(CSRF_COOKIE, csrf_value)
        return {"session": token, "csrf": csrf_value}

    def test_cookie_channel_passes_st_router_auth(self, client, test_user):
        """纯 Cookie + 双提交 CSRF → 穿过 st_router 认证层。

        空 multipart 预期 422（No file uploaded）——证明认证已通过，
        请求到达端点业务逻辑而非 401/403。
        """
        creds = self._authed_cookies(client, test_user)
        resp = client.post(self.TARGET, headers={"X-CSRF-Token": creds["csrf"]})
        assert resp.status_code == 422, resp.text
        assert "No file uploaded" in resp.json()["detail"]

    def test_without_credentials_401(self, client):
        """无任何凭据（静态 CSRF 值放行）→ 认证层 401 语义保持。"""
        resp = client.post(self.TARGET, headers={"X-CSRF-Token": "palink-csrf"})
        assert resp.status_code == 401
        assert resp.json()["detail"] == "Authentication required"

    def test_invalid_session_cookie_401_after_csrf_passes(self, client, test_user):
        """双提交配对通过但 session JWT 无效 → 401 Invalid or expired token。"""
        csrf_value = uuid.uuid4().hex + uuid.uuid4().hex
        client.cookies.set(SESSION_COOKIE, "not-a-jwt")
        client.cookies.set(CSRF_COOKIE, csrf_value)
        resp = client.post(self.TARGET, headers={"X-CSRF-Token": csrf_value})
        assert resp.status_code == 401
        assert resp.json()["detail"] == "Invalid or expired token"

    def test_bearer_channel_regression_on_st_router(self, client, test_user):
        """Bearer 通道回归：显式 Bearer 仍优先且可用（st-native bridge 兼容）。"""
        token = create_access_token({"sub": test_user.username})
        resp = client.post(
            self.TARGET,
            headers={"Authorization": f"Bearer {token}", "X-CSRF-Token": "palink-csrf"},
        )
        assert resp.status_code == 422, resp.text


# ---------------------------------------------------------------------------
# 7. 登出：Cookie 清理 + jti 拉黑（§2.1）
# ---------------------------------------------------------------------------
class TestLogout:
    def test_cookie_channel_logout_clears_cookies_and_blacklists_jti(
        self, client, test_user
    ):
        token = create_access_token({"sub": test_user.username})
        csrf_value = uuid.uuid4().hex + uuid.uuid4().hex
        client.cookies.set(SESSION_COOKIE, token)
        client.cookies.set(CSRF_COOKIE, csrf_value)

        with _real_auth():
            resp = client.post(
                "/api/auth/logout", headers={"X-CSRF-Token": csrf_value}
            )
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"status": "ok"}

        session_del = _find_set_cookie(resp, SESSION_COOKIE)
        csrf_del = _find_set_cookie(resp, CSRF_COOKIE)
        assert session_del.split(";", 1)[0] == f'{SESSION_COOKIE}=""'
        assert csrf_del.split(";", 1)[0] == f'{CSRF_COOKIE}=""'
        assert "max-age=0" in session_del.lower()
        assert "max-age=0" in csrf_del.lower()

        # jti 已拉黑：旧 Cookie 重放必须 401 revoked
        client.cookies.set(SESSION_COOKIE, token)
        with _real_auth():
            replay = client.get("/api/users/me")
        assert replay.status_code == 401
        assert replay.json()["detail"] == "Token has been revoked"

    def test_bearer_channel_logout_regression(self, client, test_user):
        token = create_access_token({"sub": test_user.username})
        with _real_auth():
            resp = client.post(
                "/api/auth/logout",
                headers={"Authorization": f"Bearer {token}"},
            )
        assert resp.status_code == 200
        with _real_auth():
            replay = client.get(
                "/api/users/me", headers={"Authorization": f"Bearer {token}"}
            )
        assert replay.status_code == 401
        assert replay.json()["detail"] == "Token has been revoked"
