"""ST Extras 转发代理回归：/api/summarize、/api/extra/translate、/api/translate/*。

背景（ADAPTATION.md「后端 ST Extras 端点」实测）：上述端点长期 404。
``silly_tavern.py`` 此前只定义了 ``STSummarizeRequest`` / ``STGenerateImageRequest``
两个 pydantic 模型却没有注册任何路由（孤立模型），导致：
  • memory 插件 ``callExtrasSummarizeAPI``、vectors 插件 ``summarizeExtra``
    的 ``doExtrasFetch('/api/summarize')`` 全部失败；
  • translate 插件 ``fetch('/api/translate/{provider}')`` 全部失败。

本测试锁定四条新增路由的转发契约——**与同批 P1-9 classify / P1-12 caption /
P1-13 elevenlabs 同构**：透传请求体到 ST sidecar，sidecar 缺位或不可达时
返回 502 ``{"error": "ST native service unavailable", "detail": ...}``。
"""

import os
import sys

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import httpx  # noqa: E402
import pytest  # noqa: E402

import app.api.silly_tavern as st  # noqa: E402

EXPECTED_ROUTES = (
    "/api/summarize",
    "/api/extra/translate",
    "/api/translate",
    "/api/translate/{provider}",
)


def _install_mock_httpx(monkeypatch, handler):
    """把 silly_tavern 命名空间里的 httpx.AsyncClient 换成绑 MockTransport 的工厂。

    转发器以 ``httpx.AsyncClient(timeout=..., follow_redirects=False)`` 构造客户端，
    工厂吞掉这两个参数并注入 transport，其余行为保持真实。
    """
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
        return httpx.Response(200, json={"summary": "hello"})

    _install_mock_httpx(monkeypatch, handler)
    return captured


class TestRoutesRegistered:
    def test_four_extras_routes_present(self):
        """四条路由必须都已注册（防止再次退回「只有模型没有路由」）。

        断言对象是 silly_tavern 的 router 本身：``app.main.app.routes`` 里
        api 路由被包在自定义的 ``_IncludedRouter`` 容器下，直接枚举取不到。
        路由是否真的挂到了 app 上，由 TestForwarding 的真机 TestClient 请求兜住。
        """
        registered = {getattr(r, "path", "") for r in st.router.routes}
        for path in EXPECTED_ROUTES:
            assert path in registered, f"{path} 未注册"


class TestForwarding:
    @pytest.mark.parametrize(
        "path,expected_path",
        [
            ("/api/summarize", "/api/summarize"),
            ("/api/extra/translate", "/api/extra/translate"),
            ("/api/translate", "/api/translate"),
            ("/api/translate/google", "/api/translate/google"),
        ],
    )
    def test_forwards_to_matching_sidecar_path(
        self, client, auth_headers, sidecar, path, expected_path
    ):
        """请求体原样透传，上游路径与本地路径一一对应。"""
        resp = client.post(path, json={"text": "abc", "params": {}}, headers=auth_headers)

        assert resp.status_code == 200
        assert sidecar["url"] == f"http://st-sidecar.test{expected_path}"
        assert sidecar["method"] == "POST"
        assert b"abc" in sidecar["body"]

    def test_summarize_response_passthrough(self, client, auth_headers, sidecar):
        """上游 {summary} 原样回给插件（memory 插件读 data.summary）。"""
        resp = client.post("/api/summarize", json={"text": "x", "params": {}}, headers=auth_headers)

        assert resp.json() == {"summary": "hello"}

    def test_unknown_provider_rejected_without_forwarding(
        self, client, auth_headers, sidecar
    ):
        """provider 参与拼接上游 URL，白名单外一律 400，且不发出任何出站请求。"""
        resp = client.post(
            "/api/translate/evilprovider", json={"text": "x"}, headers=auth_headers
        )

        assert resp.status_code == 400
        assert "url" not in sidecar, "白名单外的 provider 不应触发转发"

    @pytest.mark.parametrize("bad", ("../../evil", "%2e%2e", "google/../admin"))
    def test_provider_path_traversal_never_forwarded(
        self, client, auth_headers, sidecar, bad
    ):
        """路径穿越段不得命中转发（URL 归一化后 404，或命中白名单校验后 400）。

        断言口径是「绝不 200 且绝不出站」，而非具体状态码——前者才是安全属性。
        """
        resp = client.post(f"/api/translate/{bad}", json={"text": "x"}, headers=auth_headers)

        assert resp.status_code != 200, bad
        assert "url" not in sidecar, f"{bad} 不应触发转发"

    def test_known_providers_all_accepted(self, client, auth_headers, sidecar):
        """ST 1.18.0 translate 扩展的 8 个 provider 全部可达。"""
        for provider in sorted(st._ST_TRANSLATE_PROVIDERS):
            resp = client.post(
                f"/api/translate/{provider}", json={"text": "x"}, headers=auth_headers
            )
            assert resp.status_code == 200, provider
            assert sidecar["url"] == f"http://st-sidecar.test/api/translate/{provider}"


class TestErrorShape:
    def test_unconfigured_sidecar_returns_502(self, client, auth_headers, monkeypatch):
        """ST_NATIVE_SERVICE_URL 为空 → 502 且错误体与同族端点一致。"""
        monkeypatch.setattr(st.app_settings, "ST_NATIVE_SERVICE_URL", "")

        resp = client.post("/api/summarize", json={"text": "x"}, headers=auth_headers)

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

        resp = client.post("/api/summarize", json={"text": "x"}, headers=auth_headers)

        assert resp.status_code == 502
        assert resp.json()["error"] == "ST native service unavailable"


class TestAuth:
    @pytest.mark.parametrize("path", EXPECTED_ROUTES)
    def test_requires_authentication(self, client, path):
        """未认证请求不得进入转发（继承 get_st_current_user 中间件）。"""
        concrete = path.replace("{provider}", "google")
        resp = client.post(concrete, json={"text": "x"})

        assert resp.status_code in (401, 403)
