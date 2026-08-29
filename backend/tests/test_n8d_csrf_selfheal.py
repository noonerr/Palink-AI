"""N8-d: 端点级 CSRF 守卫 Origin 兜底 + palink_csrf cookie 自愈。

背景（2026-08-29 真实浏览器反向验证发现）：
- palink_csrf cookie 仅登录（双 Set-Cookie）时下发，滑动续期只重发
  palink_session。早于 N8-a 上线建立的存量会话、或 cookie 满
  ACCESS_TOKEN_EXPIRE_MINUTES 过期后的长寿命会话，浏览器里永远不再持有
  palink_csrf → 前端/插件 getCsrfToken() 恒为空 → Galgame 等经典轨插件
  调用 ST 兼容端点（/api/characters/chats 等）被 core/csrf_guard 端点级
  守卫 403 "CSRF token mismatch"（全局中间件有同源 Origin 兜底故不拦，
  端点守卫此前单点拒绝——宿主 pytest 全绿、真实用户必炸的典型盲区）。

覆盖：
1. 端点级守卫同源 Origin 兜底：会话 Cookie + 同源 Origin、无 CSRF 头 → 放行；
2. 兜底不削弱防护：外站 Origin / Origin:null → 仍 403；
3. cookie 自愈：持会话但缺 palink_csrf 的请求，响应补发 Set-Cookie；
4. 自愈闭环：补发的 cookie 值作为 X-CSRF-Token 头 → 双提交通过 → 200。
"""

import os
import sys

import pytest
from fastapi.testclient import TestClient

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.core.security import create_access_token  # noqa: E402
from tests.test_n8_cookie_auth import SESSION_COOKIE, _real_auth  # noqa: E402


def _with_session(client: TestClient, test_user) -> None:
    token = create_access_token({"sub": test_user.username})
    client.cookies.set(SESSION_COOKIE, token)


# ---------------------------------------------------------------------------
# 1+2. 端点级 csrf_guard 的同源 Origin 兜底（N8-d 新增分支）
# ---------------------------------------------------------------------------
class TestEndpointGuardOriginFallback:
    TARGET = "/api/settings/get"  # silly_tavern_router，挂端点级 csrf_guard

    def test_same_origin_session_cookie_no_header_passes(self, client, test_user):
        """存量无 palink_csrf 的会话：同源 Origin + 会话 Cookie、无 CSRF 头 → 200。

        修复前此处为 403 "CSRF token mismatch"（getCsrfToken() 为空，
        既非静态值也不等于缺失的 cookie）。
        """
        _with_session(client, test_user)
        with _real_auth():
            resp = client.post(self.TARGET, headers={"Origin": "http://testserver"})
        assert resp.status_code == 200, resp.text

    def test_foreign_origin_still_403(self, client, test_user):
        _with_session(client, test_user)
        with _real_auth():
            resp = client.post(self.TARGET, headers={"Origin": "https://evil.example.com"})
        assert resp.status_code == 403

    def test_null_origin_still_403(self, client, test_user):
        """sandboxed iframe 的 Origin: null 不得命中端点级兜底。"""
        _with_session(client, test_user)
        with _real_auth():
            resp = client.post(self.TARGET, headers={"Origin": "null"})
        assert resp.status_code == 403

    def test_no_origin_no_header_still_403(self, client, test_user):
        """无 Origin 的纯裸 POST（非浏览器 fetch 形态）维持原拒绝语义。"""
        _with_session(client, test_user)
        with _real_auth():
            resp = client.post(self.TARGET)
        assert resp.status_code == 403


# ---------------------------------------------------------------------------
# 3+4. palink_csrf cookie 自愈下发（main.py _ensure_csrf_cookie）
# ---------------------------------------------------------------------------
class TestCsrfCookieSelfHeal:
    GET_TARGET = "/api/users/me/settings"

    def test_get_mints_csrf_cookie_when_missing(self, client, test_user):
        """持会话但缺 palink_csrf 的任意响应补发 Set-Cookie。"""
        _with_session(client, test_user)
        with _real_auth():
            resp = client.get(self.GET_TARGET)
        assert resp.status_code == 200, resp.text
        set_cookies = resp.headers.get_list("set-cookie")
        assert any(c.startswith("palink_csrf=") for c in set_cookies), set_cookies

    def test_selfhealed_cookie_completes_double_submit(self, client, test_user):
        """自愈闭环：补发的 cookie 值作为 X-CSRF-Token 头 → 双提交通过。"""
        _with_session(client, test_user)
        with _real_auth():
            first = client.get(self.GET_TARGET)
            csrf_value = first.cookies.get("palink_csrf")
            assert csrf_value, "自愈未下发 palink_csrf"
            second = client.post("/api/settings/get", headers={"X-CSRF-Token": csrf_value})
        assert second.status_code == 200, second.text

    def test_no_session_no_mint(self, client):
        """无会话 Cookie 的匿名请求不得下发 CSRF cookie（无可保护的会话）。"""
        with _real_auth():
            resp = client.get(self.GET_TARGET)
        set_cookies = resp.headers.get_list("set-cookie")
        assert not any(c.startswith("palink_csrf=") for c in set_cookies), set_cookies
