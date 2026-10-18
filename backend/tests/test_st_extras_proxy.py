"""ST sidecar 转发器回归：``_forward_extensions_to_st_native``。

## 历史

本文件原先锁定 ``/api/summarize`` / ``/api/extra/translate`` / ``/api/translate/*``
四条路由的「透传 sidecar」契约。2026-10-18 包 C 把这四条迁到 ``api/st_extras.py``
并换成真实实现（原生上游优先 + LLM 兜底），**透传契约不再适用于它们** ——
那四条的新契约由 ``test_st_extras_endpoints.py`` 覆盖。

转发器本身没有消失：``/api/speech/elevenlabs/*`` 七个端点仍在用它
（``silly_tavern.py`` 的 P1-13 段）。本文件改为锁定这条唯一存活链，
防止「转发器被顺手删掉」或「elevenlabs 端点被误改」。

## 为什么仍要测 502

sidecar 容器已随 st-native 双轨删除（2026-09-03），``ST_NATIVE_SERVICE_URL``
在部署里实测为空串 ⇒ 生产上 elevenlabs 端点**恒 502**。这不是 bug，是既定事实
（Palink 不持有 ElevenLabs API key）。测试锁定的是「错误形状一致、不抛异常、
不静默成功」，避免以后有人把它改成假 200。
"""

import os
import sys

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import httpx  # noqa: E402
import pytest  # noqa: E402

import app.api.silly_tavern as st  # noqa: E402

ELEVENLABS_ROUTES = (
    "/api/speech/elevenlabs/voices",
    "/api/speech/elevenlabs/voice-settings",
    "/api/speech/elevenlabs/synthesize",
    "/api/speech/elevenlabs/history",
    "/api/speech/elevenlabs/history-audio",
    "/api/speech/elevenlabs/voices/add",
    "/api/speech/elevenlabs/recognize",
)

# 包 C 迁走后，这四条不得再出现在 silly_tavern 的 router 上。
# 若重新出现，Starlette 会按注册顺序让先注册者静默胜出（重复注册事故）。
MOVED_TO_ST_EXTRAS = (
    "/api/summarize",
    "/api/extra/translate",
    "/api/translate",
    "/api/translate/{provider}",
)


def _install_mock_httpx(monkeypatch, handler):
    """把 silly_tavern 命名空间里的 httpx.AsyncClient 换成绑 MockTransport 的工厂。"""
    transport = httpx.MockTransport(handler)
    real_async_client = httpx.AsyncClient

    def factory(*args, **kwargs):
        kwargs.pop("timeout", None)
        kwargs.pop("follow_redirects", None)
        return real_async_client(transport=transport, *args, **kwargs)

    monkeypatch.setattr(st.httpx, "AsyncClient", factory)


@pytest.fixture
def sidecar(monkeypatch):
    """把 ST_NATIVE_SERVICE_URL 固定到哨兵地址，并返回请求记录器。"""
    monkeypatch.setattr(st.app_settings, "ST_NATIVE_SERVICE_URL", "http://st-sidecar.test")

    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["method"] = request.method
        captured["body"] = request.content
        return httpx.Response(200, json={"ok": True})

    _install_mock_httpx(monkeypatch, handler)
    return captured


class TestRouteRegistration:
    def test_elevenlabs_routes_present(self):
        registered = {getattr(r, "path", "") for r in st.router.routes}
        for path in ELEVENLABS_ROUTES:
            assert path in registered, f"{path} 未注册"

    def test_moved_extras_routes_are_gone_from_this_router(self):
        """包 C 迁走的四条不得残留——残留会造成重复注册、先注册者静默胜出。"""
        registered = {getattr(r, "path", "") for r in st.router.routes}
        for path in MOVED_TO_ST_EXTRAS:
            assert path not in registered, f"{path} 应从 silly_tavern 移除"


class TestForwarding:
    @pytest.mark.parametrize("path", ELEVENLABS_ROUTES)
    def test_forwards_to_matching_sidecar_path(self, client, auth_headers, sidecar, path):
        """请求体原样透传，上游路径与本地路径一一对应。"""
        resp = client.post(path, json={"text": "abc"}, headers=auth_headers)

        assert resp.status_code == 200
        assert sidecar["url"] == f"http://st-sidecar.test{path}"
        assert sidecar["method"] == "POST"
        assert b"abc" in sidecar["body"]


class TestErrorShape:
    def test_unconfigured_sidecar_returns_502(self, client, auth_headers, monkeypatch):
        """ST_NATIVE_SERVICE_URL 为空 → 502 且错误体与同族端点一致。"""
        monkeypatch.setattr(st.app_settings, "ST_NATIVE_SERVICE_URL", "")

        resp = client.post(
            "/api/speech/elevenlabs/voices", json={}, headers=auth_headers
        )

        assert resp.status_code == 502
        body = resp.json()
        assert body["error"] == "ST native service unavailable"
        assert "detail" in body

    def test_unreachable_sidecar_returns_502(self, client, auth_headers, monkeypatch):
        """上游连接失败 → 502（httpx.HTTPError 分支），不抛异常给调用方。"""
        monkeypatch.setattr(st.app_settings, "ST_NATIVE_SERVICE_URL", "http://st-sidecar.test")

        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("sidecar down", request=request)

        _install_mock_httpx(monkeypatch, handler)

        resp = client.post(
            "/api/speech/elevenlabs/voices", json={}, headers=auth_headers
        )

        assert resp.status_code == 502
        assert resp.json()["error"] == "ST native service unavailable"


class TestAuth:
    @pytest.mark.parametrize("path", ELEVENLABS_ROUTES)
    def test_requires_authentication(self, client, path):
        """未认证请求不得进入转发（继承 get_st_current_user 中间件）。"""
        resp = client.post(path, json={})

        assert resp.status_code in (401, 403)
