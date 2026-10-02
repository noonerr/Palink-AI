"""[IMAGE-PROXY] 图片代理服务回归（2026-09-27 用户报障：生态卡头像占位）。

背景：生态卡把头像/CG 图库放在 jsDelivr，主域 cdn.jsdelivr.net 在大陆网络
被阻断（实测 SSL EOF），testingcf 镜像可用。代理服务：URL 校验（仅公网
http/https）→ 镜像回退下载 → 落盘缓存 → 仅回传图片。
"""

import asyncio
import json
import os
import sys

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import httpx  # noqa: E402
import pytest  # noqa: E402

import app.services.image_proxy_service as proxy_module  # noqa: E402
from app.services.image_proxy_service import (  # noqa: E402
    _mirror_variants,
    proxy_image_bytes,
)

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


class _Resp:
    def __init__(self, status_code=200, content=PNG, headers=None):
        self.status_code = status_code
        self.content = content
        self.headers = headers or {"content-type": "image/png"}


class _MirrorClient:
    """按 URL 主机分派的假客户端：cdn/fastly/gcore 拒连（模拟被阻断），testingcf 成功。"""

    def __init__(self, calls):
        self._calls = calls

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url, **kwargs):
        self._calls.append(url)
        if any(h in url for h in ("cdn.jsdelivr.net", "fastly.jsdelivr.net", "gcore.jsdelivr.net")):
            raise httpx.ConnectError("blocked")
        if "testingcf.jsdelivr.net" in url:
            return _Resp(200, PNG, {"content-type": "image/png"})
        return _Resp(404, b"nope", {"content-type": "text/plain"})


class _HtmlClient:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url, **kwargs):
        return _Resp(200, b"<html>not an image</html>", {"content-type": "text/html"})


@pytest.fixture(autouse=True)
def _fresh_cache(tmp_path, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "DATA_DIR", str(tmp_path))


@pytest.fixture(autouse=True)
def _allow_all_public(monkeypatch):
    monkeypatch.setattr(
        proxy_module, "_is_public_http_url",
        lambda url: not any(h in url for h in ("10.0.0.", "127.0.0.1", "localhost", "169.254.")),
    )


def _run(coro):
    return asyncio.run(coro)


class TestMirrorFallback:
    def test_blocked_cdn_falls_back_to_testingcf(self, monkeypatch):
        calls = []
        monkeypatch.setattr(proxy_module.httpx, "AsyncClient", lambda **kw: _MirrorClient(calls))
        payload, ctype = _run(proxy_image_bytes(
            "https://cdn.jsdelivr.net/gh/user/repo/图库/avatar.png"
        ))
        assert payload == PNG
        assert ctype == "image/png"
        hosts = [u.split("/")[2] for u in calls]
        assert hosts[0] == "cdn.jsdelivr.net", "原始域必须先试"
        assert "testingcf.jsdelivr.net" in hosts, "阻断后应回退到可用镜像"

    def test_result_is_cached(self, monkeypatch):
        calls = []
        monkeypatch.setattr(proxy_module.httpx, "AsyncClient", lambda **kw: _MirrorClient(calls))
        url = "https://cdn.jsdelivr.net/gh/user/repo/cached.png"
        _run(proxy_image_bytes(url))
        # 首次下载：主域被阻断(1) + testingcf 成功(1) = 2 次网络请求
        assert len(calls) == 2, "首次下载应恰好尝试 1 次原始域 + 1 次可用镜像"
        _run(proxy_image_bytes(url))
        assert len(calls) == 2, "第二次应命中缓存而非再下载"


class TestValidation:
    @pytest.mark.parametrize("bad", [
        "http://127.0.0.1:8000/secret.png",
        "http://localhost/x.png",
        "http://10.0.0.5/internal.png",
        "http://169.254.1.1/metadata.png",
        "ftp://cdn.jsdelivr.net/x.png",
        "",
    ])
    def test_private_or_invalid_rejected(self, monkeypatch, bad):
        with pytest.raises(ValueError):
            _run(proxy_image_bytes(bad))

    def test_non_image_rejected(self, monkeypatch):
        monkeypatch.setattr(proxy_module.httpx, "AsyncClient", lambda **kw: _HtmlClient())
        with pytest.raises((RuntimeError, ValueError)):
            _run(proxy_image_bytes("https://testingcf.jsdelivr.net/gh/u/r/evil.png"))

    def test_all_mirrors_down_raises_last_error(self, monkeypatch):
        class _DeadClient:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            async def get(self, url, **kwargs):
                raise httpx.ConnectError("dead")

        monkeypatch.setattr(proxy_module.httpx, "AsyncClient", lambda **kw: _DeadClient())
        with pytest.raises(Exception):
            _run(proxy_image_bytes("https://cdn.jsdelivr.net/gh/u/r/a.png"))


class TestMirrorVariants:
    def test_jsdelivr_url_gets_mirror_chain(self):
        variants = _mirror_variants("https://cdn.jsdelivr.net/gh/u/r/a.png")
        assert variants[0].startswith("https://cdn.jsdelivr.net/")
        assert any("testingcf" in v for v in variants)
        assert all("/gh/u/r/a.png" in v for v in variants)

    def test_non_jsdelivr_single_variant(self):
        assert _mirror_variants("https://example.com/a.png") == ["https://example.com/a.png"]

    def test_testingcf_original_stays_first(self):
        variants = _mirror_variants("https://testingcf.jsdelivr.net/gh/u/r/a.png")
        assert variants[0].startswith("https://testingcf.jsdelivr.net/")
