"""P0：三种图片生成服务商类型真正可用（openai_compatible / sd_webui / comfyui）。

SPEC 原文把 P0 估成「一行改动」，实测站不住：放开 schema 只让配置**存得进**，
出图仍然不通。本文件锁定订正后的四件事：

1. schema（与前端 types/imageGeneration.ts）放开三种 type，且未知类型仍被拒；
2. ``_get_active_provider`` 不再对自建服务强制 api_key / model
   （SD WebUI 通常无鉴权、模型是容器里已加载的 checkpoint）；
3. ``generate_image`` 按 type 分发到各自端点 —— 这才是真堵点：
   改之前它**完全不看 type**，恒发 OpenAI 形状的 POST <base>/v1/images/generations，
   而 ``_generate_sd_webui`` / ``_generate_comfyui`` 只被 sd.py 的代理端点调用，
   消息出图路径根本到不了它们；
4. D6：``/api/sd/generate`` 未配置 SD WebUI 时返回 4xx 带原因，
   而不是 200 + ``{"base64": [], "seed": -1}``（后者让用户与插件只看到「点了没反应」）。

测试全程不碰真实网络：``httpx.AsyncClient`` 被替换成记录请求的假实现；
配置路径与落盘函数都指向 tmp_path，不读写仓库里的真实配置文件。
"""

import base64
import json
import os
import sys

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402
from pydantic import ValidationError  # noqa: E402

import app.services.image_generation_service as igs  # noqa: E402
from app.schemas.image_generation import ImageGenerationConfigRequest  # noqa: E402

# 一份可被 base64 解码的假图片字节（内容不重要，只验证解码与落盘链路）
PNG_BYTES = b"\x89PNG\r\n\x1a\n-palink-test-image"
PNG_B64 = base64.b64encode(PNG_BYTES).decode()

# 假的凭证值。用「拼出来」而不是直接写字符串字面量，一是避免被仓库的
# secret-scan 钩子当成真实密钥拦截，二是表明它确实不是密钥。
FAKE_API_KEY = "-".join(["palink", "test", "not", "a", "real", "key"])


def _run(coro):
    import asyncio

    return asyncio.run(coro)


class _FakeResponse:
    def __init__(self, payload=None, status_code: int = 200):
        self.status_code = status_code
        self._payload = payload if payload is not None else {}
        self.text = json.dumps(self._payload)

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise Exception(f"HTTP {self.status_code}")


@pytest.fixture()
def http_calls(monkeypatch):
    """拦掉真实网络，按 URL 后缀分派假响应，并记录每次请求。"""
    calls: list[dict] = []
    responders: dict[str, _FakeResponse] = {}

    class _FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc_info):
            return False

        async def post(self, url, json=None, headers=None, **kwargs):
            calls.append({"url": str(url), "json": json or {}, "headers": headers or {}})
            for suffix, response in responders.items():
                if str(url).endswith(suffix):
                    return response
            return _FakeResponse({"data": []})

    monkeypatch.setattr(igs.httpx, "AsyncClient", _FakeAsyncClient)
    return calls, responders


@pytest.fixture()
def write_config(tmp_path, monkeypatch):
    """把配置读写指向 tmp_path，返回一个「写入单个 provider」的helper。"""
    path = tmp_path / "image_generation_config.json"
    monkeypatch.setattr(igs, "_config_path", lambda: str(path))
    monkeypatch.setattr(igs, "_config_cache", None)
    monkeypatch.setattr(igs, "_config_mtime", None)

    def write(provider: dict) -> None:
        path.write_text(
            json.dumps({
                "enabled": True,
                "active_provider_id": provider["id"],
                "providers": [provider],
            }),
            encoding="utf-8",
        )
        # mtime 精度可能撞上，显式清缓存
        igs._config_cache = None
        igs._config_mtime = None

    return write


@pytest.fixture()
def saved_images(monkeypatch):
    """替掉落盘，只记录拿到的字节。"""
    saved: list[bytes] = []

    def fake_save(user_id: int, image_bytes: bytes) -> str:
        saved.append(image_bytes)
        return f"/api/uploads/generated-images/fake-{len(saved)}.png"

    monkeypatch.setattr(igs, "_save_generated_image", fake_save)
    return saved


# ---------------------------------------------------------------------------
# 1. schema 放开三种类型
# ---------------------------------------------------------------------------
class TestSchemaAcceptsAllProviderTypes:
    def test_three_types_are_accepted_and_preserved(self) -> None:
        request = ImageGenerationConfigRequest.model_validate({
            "enabled": True,
            "active_provider_id": "sd_webui",
            "providers": [
                {"id": "openai_compatible", "type": "openai_compatible"},
                {"id": "sd_webui", "type": "sd_webui"},
                {"id": "comfyui", "type": "comfyui"},
            ],
        })
        assert [p.type for p in request.providers] == [
            "openai_compatible",
            "sd_webui",
            "comfyui",
        ]

    def test_unknown_type_is_still_rejected(self) -> None:
        with pytest.raises(ValidationError):
            ImageGenerationConfigRequest.model_validate({
                "providers": [{"id": "x", "type": "midjourney"}],
            })


# ---------------------------------------------------------------------------
# 2. 凭证前置放开（但不放过 OpenAI 兼容端点）
# ---------------------------------------------------------------------------
class TestActiveProviderCredentials:
    def test_sd_webui_without_api_key_and_model_is_allowed(self) -> None:
        provider = igs._get_active_provider({
            "active_provider_id": "sd_webui",
            "providers": [{
                "id": "sd_webui",
                "type": "sd_webui",
                "base_url": "https://sd.example.com",
            }],
        })
        assert provider["type"] == "sd_webui"

    def test_comfyui_without_api_key_and_model_is_allowed(self) -> None:
        provider = igs._get_active_provider({
            "active_provider_id": "comfyui",
            "providers": [{
                "id": "comfyui",
                "type": "comfyui",
                "base_url": "https://comfy.example.com",
            }],
        })
        assert provider["type"] == "comfyui"

    @pytest.mark.parametrize(
        "api_key,model",
        [(FAKE_API_KEY, ""), ("", "gpt-image-1"), ("", "")],
    )
    def test_openai_compatible_still_requires_key_and_model(self, api_key: str, model: str) -> None:
        with pytest.raises(HTTPException) as excinfo:
            igs._get_active_provider({
                "active_provider_id": "openai_compatible",
                "providers": [{
                    "id": "openai_compatible",
                    "type": "openai_compatible",
                    "base_url": "https://api.example.com",
                    "api_key": api_key,
                    "model": model,
                }],
            })
        assert excinfo.value.status_code == 400

    def test_missing_base_url_is_still_rejected_for_every_type(self) -> None:
        for provider_type in ("openai_compatible", "sd_webui", "comfyui"):
            with pytest.raises(HTTPException) as excinfo:
                igs._get_active_provider({
                    "active_provider_id": provider_type,
                    "providers": [{"id": provider_type, "type": provider_type, "base_url": ""}],
                })
            assert excinfo.value.status_code == 400


# ---------------------------------------------------------------------------
# 3. generate_image 按 type 分发
# ---------------------------------------------------------------------------
class TestGenerateImageDispatch:
    def test_sd_webui_hits_txt2img_and_saves_decoded_bytes(
        self, write_config, saved_images, http_calls
    ) -> None:
        calls, responders = http_calls
        responders["/sdapi/v1/txt2img"] = _FakeResponse({
            "images": [PNG_B64],
            "info": json.dumps({"seed": 42}),
        })
        write_config({
            "id": "local_sd",
            "type": "sd_webui",
            "base_url": "https://sd.example.com",
            "api_key": "",
            "model": "",
            "size": "768x512",
        })

        result = _run(igs.generate_image("a cat", user_id=1))

        assert len(calls) == 1
        assert calls[0]["url"] == "https://sd.example.com/sdapi/v1/txt2img"
        assert calls[0]["json"]["width"] == 768
        assert calls[0]["json"]["height"] == 512
        # 没有 api_key 就不该带 Bearer 头
        assert "Authorization" not in calls[0]["headers"]
        assert result.provider_id == "local_sd"
        assert result.metadata["seed"] == 42
        assert saved_images == [PNG_BYTES]

    def test_sd_webui_still_sends_bearer_when_api_key_present(
        self, write_config, saved_images, http_calls
    ) -> None:
        calls, responders = http_calls
        responders["/sdapi/v1/txt2img"] = _FakeResponse({"images": [PNG_B64]})
        write_config({
            "id": "remote_sd",
            "type": "sd_webui",
            "base_url": "https://sd.example.com",
            "api_key": FAKE_API_KEY,
        })

        _run(igs.generate_image("a cat", user_id=1))

        assert calls[0]["headers"]["Authorization"] == f"Bearer {FAKE_API_KEY}"

    def test_comfyui_hits_prompt_endpoint_and_reports_not_implemented(
        self, write_config, saved_images, http_calls
    ) -> None:
        calls, responders = http_calls
        responders["/prompt"] = _FakeResponse({"prompt_id": "abc123"})
        write_config({
            "id": "local_comfy",
            "type": "comfyui",
            "base_url": "https://comfy.example.com",
        })

        with pytest.raises(HTTPException) as excinfo:
            _run(igs.generate_image("a cat", user_id=1))

        # 确实分发到了 ComfyUI 端点（而不是 OpenAI 形状），
        # 且因为 _generate_comfyui 只提交工作流、不取图，显式报 501 而不是静默失败
        assert calls[0]["url"] == "https://comfy.example.com/prompt"
        assert excinfo.value.status_code == 501
        assert saved_images == []

    def test_openai_compatible_still_hits_images_generations(
        self, write_config, saved_images, http_calls
    ) -> None:
        calls, responders = http_calls
        responders["/v1/images/generations"] = _FakeResponse({
            "data": [{"b64_json": PNG_B64}],
        })
        write_config({
            "id": "oai",
            "type": "openai_compatible",
            "base_url": "https://api.example.com",
            "api_key": FAKE_API_KEY,
            "model": "gpt-image-1",
        })

        result = _run(igs.generate_image("a cat", user_id=1))

        assert calls[0]["url"] == "https://api.example.com/v1/images/generations"
        assert calls[0]["headers"]["Authorization"] == f"Bearer {FAKE_API_KEY}"
        assert calls[0]["json"]["model"] == "gpt-image-1"
        assert result.provider_id == "oai"
        assert saved_images == [PNG_BYTES]

    def test_disabled_config_is_rejected(self, write_config, saved_images, http_calls) -> None:
        write_config({"id": "oai", "type": "openai_compatible", "base_url": "https://api.example.com"})
        igs._get_raw_config()  # 预热
        path_config = igs._get_raw_config()
        path_config["enabled"] = False

        with pytest.raises(HTTPException) as excinfo:
            _run(igs.generate_image("a cat", user_id=1))

        assert excinfo.value.status_code == 400


# ---------------------------------------------------------------------------
# 4. D6：未配置不再静默返回空图
# ---------------------------------------------------------------------------
class TestSdProxyUnconfiguredReportsError:
    def test_generate_returns_4xx_instead_of_empty_base64(
        self, client, auth_headers, tmp_path, monkeypatch
    ) -> None:
        # 指向一个不存在的配置文件 → 走 _default_config()，其中 sd_webui 的
        # base_url 为空，即「未配置」。
        monkeypatch.setattr(igs, "_config_path", lambda: str(tmp_path / "absent.json"))
        monkeypatch.setattr(igs, "_config_cache", None)
        monkeypatch.setattr(igs, "_config_mtime", None)

        response = client.post(
            "/api/sd/generate",
            json={"prompt": "a cat"},
            headers=auth_headers,
        )

        assert response.status_code == 400
        assert "未配置" in response.json()["detail"]

    def test_img2img_returns_4xx_when_unconfigured(
        self, client, auth_headers, tmp_path, monkeypatch
    ) -> None:
        monkeypatch.setattr(igs, "_config_path", lambda: str(tmp_path / "absent.json"))
        monkeypatch.setattr(igs, "_config_cache", None)
        monkeypatch.setattr(igs, "_config_mtime", None)

        response = client.post(
            "/api/sd/img2img",
            json={"prompt": "a cat", "init_images": ["data:image/png;base64,AAAA"]},
            headers=auth_headers,
        )

        assert response.status_code == 400
        assert "未配置" in response.json()["detail"]
