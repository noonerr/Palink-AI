"""图片生成 provider base_url 的 SSRF 校验回归。

锁定 _validate_provider 对三种 provider 类型
（openai_compatible / sd_webui / comfyui）统一执行内网地址拦截，
masked 占位 base_url 保持跳过校验。
"""

import os
import socket
import sys

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import pytest  # noqa: E402

import app.services.mcp_service as mcp_service  # noqa: E402
from app.services.image_generation_service import _validate_provider  # noqa: E402

PROVIDER_TYPES = ("openai_compatible", "sd_webui", "comfyui")


@pytest.fixture(autouse=True)
def _force_private_network_guard(monkeypatch):
    """默认 APP_ENV=development 时私网会被放行，此处强制走真实拦截路径。"""
    monkeypatch.setattr(mcp_service, "_allow_private_urls_in_development", lambda: False)


@pytest.fixture(autouse=True)
def _stub_public_dns(monkeypatch):
    """api.example.com 固定解析为公网 IP，避免依赖外部 DNS。"""
    original_getaddrinfo = socket.getaddrinfo

    def fake_getaddrinfo(host, *args, **kwargs):
        if host == "api.example.com":
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))]
        return original_getaddrinfo(host, *args, **kwargs)

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)


def _provider(provider_type: str, base_url: str) -> dict:
    return {
        "id": provider_type,
        "type": provider_type,
        "base_url": base_url,
        "api_key": "sk-test",
    }


class TestInternalAddressRejected:
    @pytest.mark.parametrize("base_url", ["http://127.0.0.1:7860", "http://169.254.169.254"])
    @pytest.mark.parametrize("provider_type", PROVIDER_TYPES)
    def test_internal_base_url_raises(self, provider_type: str, base_url: str) -> None:
        with pytest.raises(ValueError, match="private/internal network address"):
            _validate_provider(_provider(provider_type, base_url))


class TestPublicAddressAllowed:
    @pytest.mark.parametrize("provider_type", PROVIDER_TYPES)
    def test_public_base_url_passes(self, provider_type: str) -> None:
        cleaned = _validate_provider(_provider(provider_type, "https://api.example.com"))
        assert cleaned["base_url"] == "https://api.example.com"


class TestMaskedBaseUrlSkipped:
    @pytest.mark.parametrize("provider_type", PROVIDER_TYPES)
    def test_masked_base_url_skips_validation(self, provider_type: str) -> None:
        cleaned = _validate_provider(_provider(provider_type, "********"))
        assert cleaned["base_url"] == "********"
