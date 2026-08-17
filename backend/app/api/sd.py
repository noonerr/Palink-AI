"""
Stable Diffusion API routes (SillyTavern 1.18.0 compatible).

Provides a minimal subset of SD endpoints that ST expects:
  POST /api/sd/generate, POST /api/sd/img2img,
  GET  /api/sd/get-models, GET /api/sd/get-samplers,
  GET  /api/sd/parsers, POST /api/sd/comfy/get-workflow,
  GET  /api/sd/status

Actual generation is delegated to image_generation_service.
"""
import logging
from typing import Any, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Response
from pydantic import BaseModel, Field

from .dependencies import get_current_user
from ..models import User
from ..services.image_generation_service import (
    generate_sd_webui_image,
    generate_sd_webui_img2img,
    get_comfyui_provider,
    get_sd_status,
    get_sd_webui_provider,
    list_sd_models,
    list_sd_samplers,
)

router = APIRouter(prefix="/api/sd", tags=["stable-diffusion"])
logger = logging.getLogger(__name__)


# ------------------------------------------------------------------
# Request models (extra fields allowed for forward-compatibility with ST)
# ------------------------------------------------------------------

class SDGenerateRequest(BaseModel):
    prompt: str = ""
    negative_prompt: str = ""
    sampler: str = "Euler a"
    steps: int = Field(default=20, ge=1, le=150)
    cfg_scale: float = Field(default=7.0, ge=1.0, le=30.0)
    width: int = Field(default=512, ge=64, le=2048)
    height: int = Field(default=512, ge=64, le=2048)
    seed: int = -1

    model_config = {"extra": "allow"}


class SDImg2ImgRequest(BaseModel):
    prompt: str = ""
    negative_prompt: str = ""
    sampler: str = "Euler a"
    steps: int = Field(default=20, ge=1, le=150)
    cfg_scale: float = Field(default=7.0, ge=1.0, le=30.0)
    denoising_strength: float = Field(default=0.75, ge=0.0, le=1.0)
    seed: int = -1
    init_images: list[str] = Field(default_factory=list)

    model_config = {"extra": "allow"}


class SDComfyWorkflowRequest(BaseModel):
    name: Optional[str] = None

    model_config = {"extra": "allow"}


class SDComfySamplersRequest(BaseModel):
    url: Optional[str] = None

    model_config = {"extra": "allow"}


# ------------------------------------------------------------------
# Default ComfyUI workflow (minimal txt2img)
# ------------------------------------------------------------------

_DEFAULT_COMFY_WORKFLOW: dict[str, Any] = {
    "3": {
        "class_type": "KSampler",
        "inputs": {
            "seed": 0,
            "steps": 20,
            "cfg": 7.0,
            "sampler_name": "euler",
            "scheduler": "normal",
            "denoise": 1.0,
            "model": ["4", 0],
            "positive": ["6", 0],
            "negative": ["7", 0],
            "latent_image": ["5", 0],
        },
    },
    "4": {
        "class_type": "CheckpointLoaderSimple",
        "inputs": {"ckpt_name": "model.safetensors"},
    },
    "5": {
        "class_type": "EmptyLatentImage",
        "inputs": {"width": 512, "height": 512, "batch_size": 1},
    },
    "6": {
        "class_type": "CLIPTextEncode",
        "inputs": {"text": "prompt", "clip": ["4", 1]},
    },
    "7": {
        "class_type": "CLIPTextEncode",
        "inputs": {"text": "", "clip": ["4", 1]},
    },
    "8": {
        "class_type": "VAEDecode",
        "inputs": {"samples": ["3", 0], "vae": ["4", 2]},
    },
    "9": {
        "class_type": "SaveImage",
        "inputs": {"images": ["8", 0]},
    },
}


# ------------------------------------------------------------------
# Routes
# ------------------------------------------------------------------

@router.post("/generate")
async def sd_generate(
    request: SDGenerateRequest,
    current_user: User = Depends(get_current_user),
):
    """ST 兼容的文生图端点，返回 {"base64": [...], "seed": ...}。

    批次6: 请求体含 url 时按 ST stable-diffusion 插件协议转发到指定 SD WebUI
    （客户端传 url/auth，POST {url}/sdapi/v1/txt2img）；否则走 Palink provider。
    """
    body = request.model_dump()
    if body.get("url"):
        try:
            resp = await _sd_webui_forward(body, "/sdapi/v1/txt2img", method="POST")
            return resp.json()
        except HTTPException:
            raise
        except Exception as exc:
            logger.exception("SD proxy generate failed")
            raise HTTPException(status_code=500, detail=f"SD proxy generate failed: {exc}")
    provider = get_sd_webui_provider()
    if not provider or not provider.get("base_url"):
        return {"base64": [], "seed": -1}
    try:
        return await generate_sd_webui_image(
            prompt=request.prompt,
            negative_prompt=request.negative_prompt,
            sampler=request.sampler,
            steps=request.steps,
            cfg_scale=request.cfg_scale,
            width=request.width,
            height=request.height,
            seed=request.seed,
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("SD generate failed")
        raise HTTPException(status_code=500, detail=f"SD generate failed: {exc}")


@router.post("/img2img")
async def sd_img2img(
    request: SDImg2ImgRequest,
    current_user: User = Depends(get_current_user),
):
    """ST 兼容的图生图端点，返回 {"base64": [...], "seed": ...}。

    批次6: 请求体含 url 时转发到指定 SD WebUI（POST {url}/sdapi/v1/img2img）。
    """
    body = request.model_dump()
    if body.get("url"):
        try:
            resp = await _sd_webui_forward(body, "/sdapi/v1/img2img", method="POST")
            return resp.json()
        except HTTPException:
            raise
        except Exception as exc:
            logger.exception("SD proxy img2img failed")
            raise HTTPException(status_code=500, detail=f"SD proxy img2img failed: {exc}")
    provider = get_sd_webui_provider()
    if not provider or not provider.get("base_url"):
        return {"base64": [], "seed": -1}
    if not request.init_images:
        raise HTTPException(status_code=400, detail="init_images is required")
    try:
        return await generate_sd_webui_img2img(
            init_images=request.init_images,
            prompt=request.prompt,
            negative_prompt=request.negative_prompt,
            sampler=request.sampler,
            steps=request.steps,
            cfg_scale=request.cfg_scale,
            denoising_strength=request.denoising_strength,
            seed=request.seed,
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("SD img2img failed")
        raise HTTPException(status_code=500, detail=f"SD img2img failed: {exc}")


@router.get("/get-models")
async def sd_get_models(
    current_user: User = Depends(get_current_user),
):
    """获取可用模型列表 [{"title": "...", "id": "..."}]。"""
    try:
        return await list_sd_models()
    except Exception:
        logger.exception("Failed to list SD models")
        return []


@router.get("/get-samplers")
async def sd_get_samplers(
    current_user: User = Depends(get_current_user),
):
    """获取可用采样器列表。"""
    try:
        return await list_sd_samplers()
    except Exception:
        logger.exception("Failed to list SD samplers")
        return []


@router.get("/parsers")
async def sd_get_parsers(
    current_user: User = Depends(get_current_user),
):
    """返回支持的解析器列表。"""
    return ["stable_diffusion", "comfyui", "automatic1111"]


@router.post("/comfy/get-workflow")
async def sd_comfy_get_workflow(
    request: Optional[SDComfyWorkflowRequest] = Body(None),
    current_user: User = Depends(get_current_user),
):
    """返回 ComfyUI 默认工作流。"""
    provider = get_comfyui_provider()
    base_url = provider.get("base_url", "") if provider else ""
    return {
        "workflow": _DEFAULT_COMFY_WORKFLOW,
        "base_url": base_url,
        "available": bool(base_url),
    }


@router.post("/comfy/samplers")
async def sd_comfy_samplers(
    request: Optional[SDComfySamplersRequest] = Body(None),
    current_user: User = Depends(get_current_user),
):
    """ComfyUI 连通性检测 + 采样器列表。

    Galgame 插件 ComfyUIAPI.checkConnection() 以 POST 调用本端点，
    仅需 2xx 响应即判定连接成功；同时返回采样器列表供插件使用。
    """
    try:
        samplers = await list_sd_samplers()
    except Exception:
        logger.exception("Failed to list SD samplers for comfy")
        samplers = []
    return {"samplers": samplers or []}


@router.get("/status")
async def sd_status(
    current_user: User = Depends(get_current_user),
):
    """返回 SD 服务状态。"""
    return await get_sd_status()


# ==========================================================================
# 批次6: ST stable-diffusion 插件代理端点（对齐 ST server stable-diffusion.js）
#
# ST 插件（public/scripts/extensions/stable-diffusion）的协议是：
# 客户端在请求 body 携带 {url, auth, ...SD 参数}，后端转发到用户配置的
# SD WebUI（/sdapi/v1/*）。以下端点补齐此前 404 的核心本地协议路径；
# ComfyUI 工作流 / 云端 provider（falai/together 等 20+）留待专项。
# ==========================================================================


async def _sd_webui_forward(
    body: dict,
    api_path: str,
    *,
    method: str = "GET",
    send_body: Optional[dict] = None,
) -> Any:
    """转发到用户指定的 SD WebUI（body.url/auth），返回 httpx Response。

    未传 url 时抛 400；上游错误抛 502。
    """
    url = (str(body.get("url") or "")).strip().rstrip("/")
    if not url:
        raise HTTPException(status_code=400, detail="url is required")
    import httpx
    headers = {}
    auth = body.get("auth")
    if auth:
        headers["Authorization"] = str(auth)
    target = url + api_path
    timeout = httpx.Timeout(300.0, connect=10.0)
    async with httpx.AsyncClient(timeout=timeout, verify=False) as client:
        if method == "GET":
            resp = await client.get(target, headers=headers)
        else:
            headers["Content-Type"] = "application/json"
            resp = await client.post(target, json=send_body if send_body is not None else body, headers=headers)
    if resp.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"SD WebUI returned HTTP {resp.status_code}")
    return resp


def _sd_body(request: Any) -> dict:
    """归一化请求体为 dict（兼容 pydantic 模型与裸 dict）。"""
    if isinstance(request, dict):
        return request
    if hasattr(request, "model_dump"):
        return request.model_dump()
    return {}


@router.post("/ping")
async def sd_ping(
    request: Any = Body(None),
    current_user: User = Depends(get_current_user),
):
    """ST: POST /api/sd/ping → GET {url}/sdapi/v1/options。"""
    try:
        await _sd_webui_forward(_sd_body(request), "/sdapi/v1/options")
        return Response(status_code=200)
    except Exception:
        return Response(status_code=500)


@router.post("/models")
async def sd_models(
    request: Any = Body(None),
    current_user: User = Depends(get_current_user),
):
    """ST: GET {url}/sdapi/v1/sd-models → [{value, text}]。"""
    try:
        resp = await _sd_webui_forward(_sd_body(request), "/sdapi/v1/sd-models")
        data = resp.json() if isinstance(resp.json(), list) else []
        return [{"value": m.get("title"), "text": m.get("title")} for m in data]
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("SD proxy models failed")
        raise HTTPException(status_code=502, detail=f"SD proxy models failed: {exc}")


@router.post("/get-model")
async def sd_get_model(
    request: Any = Body(None),
    current_user: User = Depends(get_current_user),
):
    """ST: GET {url}/sdapi/v1/options → sd_model_checkpoint。"""
    try:
        resp = await _sd_webui_forward(_sd_body(request), "/sdapi/v1/options")
        data = resp.json()
        return data.get("sd_model_checkpoint") if isinstance(data, dict) else ""
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("SD proxy get-model failed")
        raise HTTPException(status_code=502, detail=f"SD proxy get-model failed: {exc}")


@router.post("/set-model")
async def sd_set_model(
    request: Any = Body(None),
    current_user: User = Depends(get_current_user),
):
    """ST: POST {url}/sdapi/v1/options {sd_model_checkpoint: body.model}。"""
    body = _sd_body(request)
    model = body.get("model")
    if not model:
        raise HTTPException(status_code=400, detail="model is required")
    try:
        resp = await _sd_webui_forward(
            body, "/sdapi/v1/options", method="POST", send_body={"sd_model_checkpoint": model}
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=502, detail=f"SD WebUI returned HTTP {resp.status_code}")
        return Response(status_code=200)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("SD proxy set-model failed")
        raise HTTPException(status_code=502, detail=f"SD proxy set-model failed: {exc}")


@router.post("/samplers")
async def sd_samplers(
    request: Any = Body(None),
    current_user: User = Depends(get_current_user),
):
    """ST: GET {url}/sdapi/v1/samplers → names 数组。"""
    try:
        resp = await _sd_webui_forward(_sd_body(request), "/sdapi/v1/samplers")
        data = resp.json() if isinstance(resp.json(), list) else []
        return [m.get("name") for m in data if isinstance(m, dict)]
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("SD proxy samplers failed")
        raise HTTPException(status_code=502, detail=f"SD proxy samplers failed: {exc}")


@router.post("/schedulers")
async def sd_schedulers(
    request: Any = Body(None),
    current_user: User = Depends(get_current_user),
):
    """ST: GET {url}/sdapi/v1/schedulers → names 数组。"""
    try:
        resp = await _sd_webui_forward(_sd_body(request), "/sdapi/v1/schedulers")
        data = resp.json() if isinstance(resp.json(), list) else []
        return [m.get("name") for m in data if isinstance(m, dict)]
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("SD proxy schedulers failed")
        raise HTTPException(status_code=502, detail=f"SD proxy schedulers failed: {exc}")


@router.post("/upscalers")
async def sd_upscalers(
    request: Any = Body(None),
    current_user: User = Depends(get_current_user),
):
    """ST: GET {url}/sdapi/v1/upscalers → names 数组。"""
    try:
        resp = await _sd_webui_forward(_sd_body(request), "/sdapi/v1/upscalers")
        data = resp.json() if isinstance(resp.json(), list) else []
        return [m.get("name") for m in data if isinstance(m, dict)]
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("SD proxy upscalers failed")
        raise HTTPException(status_code=502, detail=f"SD proxy upscalers failed: {exc}")


@router.post("/vaes")
async def sd_vaes(
    request: Any = Body(None),
    current_user: User = Depends(get_current_user),
):
    """ST: GET {url}/sdapi/v1/sd-vae（回退 /sd-modules）→ names 数组。"""
    body = _sd_body(request)
    import httpx
    url = (str(body.get("url") or "")).strip().rstrip("/")
    if not url:
        raise HTTPException(status_code=400, detail="url is required")
    headers = {}
    if body.get("auth"):
        headers["Authorization"] = str(body["auth"])
    timeout = httpx.Timeout(60.0, connect=10.0)
    try:
        async with httpx.AsyncClient(timeout=timeout, verify=False) as client:
            data = None
            for api_path in ("/sdapi/v1/sd-vae", "/sdapi/v1/sd-modules"):
                resp = await client.get(url + api_path, headers=headers)
                if resp.status_code < 400:
                    try:
                        data = resp.json()
                    except Exception:
                        data = None
                    if isinstance(data, list):
                        break
        if not isinstance(data, list):
            raise HTTPException(status_code=502, detail="SD WebUI returned an error")
        return [m.get("model_name") for m in data if isinstance(m, dict)]
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("SD proxy vaes failed")
        raise HTTPException(status_code=502, detail=f"SD proxy vaes failed: {exc}")


@router.post("/sd-next/upscalers")
async def sd_next_upscalers(
    request: Any = Body(None),
    current_user: User = Depends(get_current_user),
):
    """ST: sd-next 兼容 upscalers（含 Latent 系列硬编码）。"""
    try:
        resp = await _sd_webui_forward(_sd_body(request), "/sdapi/v1/upscalers")
        data = resp.json() if isinstance(resp.json(), list) else []
        names = [m.get("name") for m in data if isinstance(m, dict)]
        latent = ["Latent", "Latent (antialiased)", "Latent (bicubic)", "Latent (bicubic antialiased)", "Latent (nearest)", "Latent (nearest-exact)"]
        return names + [n for n in latent if n not in names]
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("SD proxy sd-next/upscalers failed")
        raise HTTPException(status_code=502, detail=f"SD proxy sd-next/upscalers failed: {exc}")
