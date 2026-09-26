"""ComfyUI 取图闭环与 SD 出图参数透传回归（AUDIT-2026-09-25）。

背景：_generate_comfyui 只把工作流提交给 /prompt、从不取图（消息出图
路径恒 501）；SD WebUI 的 negative_prompt/steps/cfg_scale/sampler/seed
与 provider.model 全部硬编码不读取，且鉴权只发 Bearer（A1111 原生是
HTTP Basic）。
"""

import asyncio
import base64
import os
import sys

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import httpx  # noqa: E402
import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

import app.services.image_generation_service as imgsvc  # noqa: E402
from app.services.image_generation_service import (  # noqa: E402
    _extract_comfyui_image_ref,
    _generate_comfyui,
    _generate_sd_webui,
    _sd_auth_header,
    _validate_provider,
)


def _install_mock_httpx(monkeypatch, handler):
    """把 imgsvc 命名空间里的 httpx.AsyncClient 换成绑 MockTransport 的工厂。

    直接替换模块引用而非全局 httpx，避免测试间串扰。imgsvc 还引用
    httpx.HTTPStatusError / ConnectError / TimeoutException——用真实模块的
    属性兜住。
    """
    transport = httpx.MockTransport(handler)
    real_async_client = httpx.AsyncClient

    class _HttpxStub:
        HTTPStatusError = httpx.HTTPStatusError
        ConnectError = httpx.ConnectError
        TimeoutException = httpx.TimeoutException

        @staticmethod
        def AsyncClient(**kwargs):
            return real_async_client(transport=transport, **kwargs)

    monkeypatch.setattr(imgsvc, "httpx", _HttpxStub)


PNG_BYTES = b"\x89PNG\r\n\x1a\n fake-image-bytes"


class TestExtractComfyuiImageRef:
    def test_prefers_output_type(self):
        entry = {
            "outputs": {
                "9": {"images": [
                    {"filename": "tmp.png", "subfolder": "", "type": "temp"},
                    {"filename": "out.png", "subfolder": "sub", "type": "output"},
                ]},
            }
        }
        assert _extract_comfyui_image_ref(entry) == {
            "filename": "out.png", "subfolder": "sub", "type": "output",
        }

    def test_falls_back_to_any_image(self):
        entry = {"outputs": {"9": {"images": [{"filename": "tmp.png", "type": "temp"}]}}}
        assert _extract_comfyui_image_ref(entry)["filename"] == "tmp.png"

    def test_no_outputs_returns_none(self):
        assert _extract_comfyui_image_ref({}) is None
        assert _extract_comfyui_image_ref({"outputs": {}}) is None
        assert _extract_comfyui_image_ref({"status": {"status_str": "error"}}) is None


class TestComfyuiFetchLoop:
    def test_full_submit_poll_download(self, monkeypatch):
        """提交 → 轮询 history（第一次空、第二次就绪）→ /view 取图。"""
        state = {"polls": 0, "view_params": None, "workflow": None}

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/prompt":
                state["workflow"] = request.read()
                return httpx.Response(200, json={"prompt_id": "pid-1"})
            if request.url.path == "/history/pid-1":
                state["polls"] += 1
                if state["polls"] >= 2:
                    return httpx.Response(200, json={"pid-1": {
                        "status": {"status_str": "success"},
                        "outputs": {"9": {"images": [
                            {"filename": "c.png", "subfolder": "", "type": "output"},
                        ]}},
                    }})
                return httpx.Response(200, json={})
            if request.url.path == "/view":
                state["view_params"] = dict(request.url.params)
                return httpx.Response(200, content=PNG_BYTES)
            return httpx.Response(404)

        _install_mock_httpx(monkeypatch, handler)
        monkeypatch.setattr(imgsvc, "COMFYUI_POLL_INTERVAL_SECONDS", 0)

        result = asyncio.run(_generate_comfyui(
            base_url="http://127.0.0.1:8188", prompt="a lighthouse",
            negative_prompt="blurry", width=768, height=512, steps=30,
            cfg_scale=6.5, seed=-1, timeout_seconds=10,
        ))

        decoded = base64.b64decode(result["base64"][0])
        assert decoded == PNG_BYTES
        assert state["view_params"]["filename"] == "c.png"
        assert state["view_params"]["type"] == "output"
        # seed=-1 时取随机值（旧实现恒 0，每次同图）
        assert 0 <= result["seed"] <= imgsvc._COMFYUI_SEED_MAX
        assert result["prompt_id"] == "pid-1"
        assert state["polls"] == 2

    def test_explicit_seed_flows_into_workflow(self, monkeypatch):
        state = {"workflow": None}

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/prompt":
                state["workflow"] = request.read()
                return httpx.Response(200, json={"prompt_id": "pid-2"})
            if request.url.path == "/history/pid-2":
                return httpx.Response(200, json={"pid-2": {
                    "outputs": {"9": {"images": [{"filename": "x.png", "type": "output"}]}},
                }})
            if request.url.path == "/view":
                return httpx.Response(200, content=PNG_BYTES)
            return httpx.Response(404)

        _install_mock_httpx(monkeypatch, handler)
        monkeypatch.setattr(imgsvc, "COMFYUI_POLL_INTERVAL_SECONDS", 0)

        result = asyncio.run(_generate_comfyui(
            base_url="http://127.0.0.1:8188", prompt="p", seed=4242, timeout_seconds=10,
        ))
        assert result["seed"] == 4242
        assert b'"seed": 4242' in state["workflow"] or b'"seed":4242' in state["workflow"]

    def test_workflow_error_raises_502(self, monkeypatch):
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/prompt":
                return httpx.Response(200, json={"prompt_id": "pid-err"})
            if request.url.path == "/history/pid-err":
                return httpx.Response(200, json={"pid-err": {
                    "status": {"status_str": "error", "completed": False},
                }})
            return httpx.Response(404)

        _install_mock_httpx(monkeypatch, handler)
        monkeypatch.setattr(imgsvc, "COMFYUI_POLL_INTERVAL_SECONDS", 0)

        with pytest.raises(HTTPException) as exc_info:
            asyncio.run(_generate_comfyui(base_url="http://127.0.0.1:8188", prompt="p", timeout_seconds=5))
        assert exc_info.value.status_code == 502


class TestSdAuthHeader:
    def test_user_pass_uses_basic(self):
        expected = "Basic " + base64.b64encode(b"admin:secret").decode()
        assert _sd_auth_header("admin:secret") == expected

    def test_plain_token_uses_bearer(self):
        assert _sd_auth_header("sk-test") == "Bearer sk-test"

    def test_empty_returns_none(self):
        assert _sd_auth_header("") is None
        assert _sd_auth_header(None) is None


class TestSdParamsPassthrough:
    def test_params_and_checkpoint_reach_upstream(self, monkeypatch):
        state = {"payload": None, "headers": None}

        def handler(request: httpx.Request) -> httpx.Response:
            state["payload"] = request.read()
            state["headers"] = dict(request.headers)
            return httpx.Response(200, json={
                "images": [base64.b64encode(PNG_BYTES).decode()],
                "info": __import__("json").dumps({"seed": 777}),
            })

        _install_mock_httpx(monkeypatch, handler)

        result = asyncio.run(_generate_sd_webui(
            base_url="http://127.0.0.1:7860",
            prompt="a lighthouse",
            negative_prompt="lowres",
            sampler="DPM++ 2M",
            steps=40,
            cfg_scale=9.5,
            seed=123,
            api_key="admin:secret",
            model="myCheckpoint.safetensors",
        ))

        assert result["seed"] == 777
        text = state["payload"].decode()
        assert '"negative_prompt": "lowres"' in text or '"negative_prompt":"lowres"' in text
        assert "DPM++ 2M" in text
        assert '"steps": 40' in text or '"steps":40' in text
        assert '"cfg_scale": 9.5' in text or '"cfg_scale":9.5' in text
        # model → 按请求覆盖 checkpoint，不污染全局
        assert "myCheckpoint.safetensors" in text
        assert "override_settings" in text
        # user:pass → Basic 而非 Bearer
        assert state["headers"].get("authorization", "").startswith("Basic ")


class TestValidateProviderClamps:
    def test_new_params_round_trip(self):
        cleaned = _validate_provider({
            "id": "sd", "type": "sd_webui", "base_url": "https://api.example.com",
            "negative_prompt": "blurry", "steps": 45, "cfg_scale": 8.0,
            "sampler_name": "DPM++ 2M", "seed": 4242,
        })
        assert cleaned["negative_prompt"] == "blurry"
        assert cleaned["steps"] == 45
        assert cleaned["cfg_scale"] == 8.0
        assert cleaned["sampler_name"] == "DPM++ 2M"
        assert cleaned["seed"] == 4242

    def test_out_of_range_clamped(self):
        cleaned = _validate_provider({
            "id": "sd", "type": "sd_webui", "base_url": "https://api.example.com",
            "steps": 9999, "cfg_scale": 99, "seed": -5,
        })
        assert cleaned["steps"] == 150
        assert cleaned["cfg_scale"] == 30.0
        assert cleaned["seed"] == -1

    def test_garbage_falls_back_to_defaults(self):
        cleaned = _validate_provider({
            "id": "sd", "type": "sd_webui", "base_url": "https://api.example.com",
            "steps": "abc", "cfg_scale": None,
        })
        assert cleaned["steps"] == 20
        assert cleaned["cfg_scale"] == 7.0
        assert cleaned["sampler_name"] == "Euler a"
