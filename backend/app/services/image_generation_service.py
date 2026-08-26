"""Image generation service and message insertion helpers."""

from __future__ import annotations

import base64
import json
import logging
import os
import re
import uuid
from dataclasses import dataclass
from typing import Any, Literal, Optional, Sequence
from urllib.parse import urlparse

import httpx
from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..core import settings
from ..models import Character, CharacterChatMessage, ChatMessage, User, UserSetting
from .mcp_service import _is_safe_mcp_url

logger = logging.getLogger(__name__)

MASKED_SECRET = "********"
DEFAULT_PROVIDER_ID = "openai_compatible"
DEFAULT_PROMPT_TEMPLATE = """Create an illustration for the following roleplay/chat moment.
Focus on visible scene, characters, actions, mood, clothing, environment, lighting, and composition.
Do not include text bubbles, UI elements, captions, or watermarks.

Dialogue context:
{{context}}

Target moment:
{{message}}"""

_config_cache: Optional[dict[str, Any]] = None
_config_mtime: Optional[float] = None


@dataclass(frozen=True)
class GeneratedImage:
    image_url: str
    prompt: str
    provider_id: str
    model: Optional[str] = None
    revised_prompt: Optional[str] = None
    metadata: Optional[dict[str, Any]] = None


def _config_path() -> str:
    return os.path.join(settings.DATA_DIR, "image_generation_config.json")


def _default_config() -> dict[str, Any]:
    return {
        "enabled": False,
        "active_provider_id": DEFAULT_PROVIDER_ID,
        "providers": [
            {
                "id": DEFAULT_PROVIDER_ID,
                "name": "OpenAI Compatible",
                "type": "openai_compatible",
                "enabled": True,
                "base_url": "",
                "api_key": "",
                "model": "",
                "size": "1024x1024",
                "quality": "",
                "style": "",
                "response_format": "auto",
                "timeout_seconds": 120,
            },
            {
                "id": "sd_webui",
                "name": "Stable Diffusion WebUI",
                "type": "sd_webui",
                "enabled": True,
                "base_url": "",
                "api_key": "",
                "model": "",
                "size": "512x512",
                "quality": "",
                "style": "",
                "response_format": "auto",
                "timeout_seconds": 120,
            },
            {
                "id": "comfyui",
                "name": "ComfyUI",
                "type": "comfyui",
                "enabled": True,
                "base_url": "",
                "api_key": "",
                "model": "",
                "size": "512x512",
                "quality": "",
                "style": "",
                "response_format": "auto",
                "timeout_seconds": 120,
            }
        ],
        "defaults": {
            "prompt_template": DEFAULT_PROMPT_TEMPLATE,
            "include_recent_context_count": 4,
        },
    }


def _is_masked(value: Any) -> bool:
    return isinstance(value, str) and value.startswith("****")


def _mask_sensitive(config: dict[str, Any]) -> dict[str, Any]:
    masked = json.loads(json.dumps(config))
    for provider in masked.get("providers", []):
        if isinstance(provider, dict) and provider.get("api_key"):
            provider["api_key"] = MASKED_SECRET
    return masked


def _merge_with_defaults(config: dict[str, Any]) -> dict[str, Any]:
    defaults = _default_config()
    merged = {**defaults, **config}
    merged_defaults = defaults["defaults"] | (config.get("defaults") or {})
    merged["defaults"] = merged_defaults
    providers = merged.get("providers")
    if not isinstance(providers, list) or not providers:
        merged["providers"] = defaults["providers"]
    return merged


def _get_raw_config() -> dict[str, Any]:
    global _config_cache, _config_mtime
    path = _config_path()
    try:
        mtime = os.path.getmtime(path)
        if _config_mtime == mtime and _config_cache is not None:
            return _config_cache
        with open(path, "r", encoding="utf-8") as handle:
            loaded = json.load(handle)
        if not isinstance(loaded, dict):
            return _default_config()
        _config_cache = _merge_with_defaults(loaded)
        _config_mtime = mtime
        return _config_cache
    except FileNotFoundError:
        return _default_config()
    except Exception as exc:
        logger.warning("Failed to load image generation config: %s", exc)
        return _default_config()


def get_image_generation_config(mask_secrets: bool = True) -> dict[str, Any]:
    config = _get_raw_config()
    return _mask_sensitive(config) if mask_secrets else json.loads(json.dumps(config))


def _validate_provider(provider: dict[str, Any]) -> dict[str, Any]:
    provider_type = provider.get("type") or "openai_compatible"
    if provider_type not in {"openai_compatible", "sd_webui", "comfyui"}:
        raise ValueError("Unsupported image generation provider type")

    base_url = str(provider.get("base_url") or "").strip()
    if base_url and not _is_masked(base_url):
        parsed = urlparse(base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("Image generation Base URL must be a valid HTTP(S) URL")
        if not _is_safe_mcp_url(base_url):
            raise ValueError("Image generation Base URL must not point to a private/internal network address")
        base_url = base_url.rstrip("/")

    timeout_seconds = int(provider.get("timeout_seconds") or 120)
    timeout_seconds = max(5, min(timeout_seconds, 600))
    response_format = str(provider.get("response_format") or "auto").strip().lower()
    if response_format not in {"auto", "b64_json", "url"}:
        response_format = "auto"

    return {
        "id": str(provider.get("id") or DEFAULT_PROVIDER_ID).strip() or DEFAULT_PROVIDER_ID,
        "name": str(provider.get("name") or "OpenAI Compatible").strip() or "OpenAI Compatible",
        "type": provider_type,
        "enabled": bool(provider.get("enabled", True)),
        "base_url": base_url,
        "api_key": str(provider.get("api_key") or ""),
        "model": str(provider.get("model") or "").strip(),
        "size": str(provider.get("size") or "1024x1024").strip() or "1024x1024",
        "quality": str(provider.get("quality") or "").strip(),
        "style": str(provider.get("style") or "").strip(),
        "response_format": response_format,
        "timeout_seconds": timeout_seconds,
    }


def save_image_generation_config(config: dict[str, Any]) -> dict[str, Any]:
    global _config_cache, _config_mtime
    current = _get_raw_config()
    providers_by_id = {
        provider.get("id"): provider
        for provider in current.get("providers", [])
        if isinstance(provider, dict) and provider.get("id")
    }

    cleaned_providers = []
    for provider in config.get("providers", []):
        if not isinstance(provider, dict):
            continue
        cleaned = _validate_provider(provider)
        previous = providers_by_id.get(cleaned["id"], {})
        if _is_masked(cleaned.get("api_key")):
            cleaned["api_key"] = previous.get("api_key", "")
        cleaned_providers.append(cleaned)

    if not cleaned_providers:
        cleaned_providers = current.get("providers", _default_config()["providers"])

    defaults_update = config.get("defaults") or {}
    defaults = current.get("defaults", _default_config()["defaults"]) | {
        "prompt_template": str(defaults_update.get("prompt_template") or current.get("defaults", {}).get("prompt_template") or DEFAULT_PROMPT_TEMPLATE),
        "include_recent_context_count": max(0, min(int(defaults_update.get("include_recent_context_count", current.get("defaults", {}).get("include_recent_context_count", 4)) or 4), 20)),
    }

    cleaned_config = {
        "enabled": bool(config.get("enabled", current.get("enabled", False))),
        "active_provider_id": str(config.get("active_provider_id") or current.get("active_provider_id") or DEFAULT_PROVIDER_ID),
        "providers": cleaned_providers,
        "defaults": defaults,
    }

    os.makedirs(os.path.dirname(_config_path()), exist_ok=True)
    with open(_config_path(), "w", encoding="utf-8") as handle:
        json.dump(cleaned_config, handle, ensure_ascii=False, indent=2)
    _config_cache = None
    _config_mtime = None
    return get_image_generation_config(mask_secrets=True)


def _get_active_provider(config: dict[str, Any], provider_id: Optional[str] = None) -> dict[str, Any]:
    selected_id = provider_id or config.get("active_provider_id") or DEFAULT_PROVIDER_ID
    provider = next((p for p in config.get("providers", []) if p.get("id") == selected_id), None)
    if not provider:
        raise HTTPException(status_code=400, detail="图片生成服务商不存在")
    if not provider.get("enabled", True):
        raise HTTPException(status_code=400, detail="图片生成服务商未启用")
    if not provider.get("base_url") or not provider.get("api_key") or not provider.get("model"):
        raise HTTPException(status_code=400, detail="图片生成服务尚未配置完整")
    return provider


def _build_generation_url(base_url: str) -> str:
    normalized = base_url.rstrip("/")
    if normalized.endswith("/images/generations"):
        return normalized
    if normalized.endswith("/v1"):
        return f"{normalized}/images/generations"
    return f"{normalized}/v1/images/generations"


def _decode_data_url(data_url: str) -> bytes:
    if "," not in data_url:
        raise ValueError("Invalid data URL")
    return base64.b64decode(data_url.split(",", 1)[1], validate=True)


async def _download_image(url: str, timeout_seconds: int) -> bytes:
    """Download a remote image URL.

    Note: ``follow_redirects=True`` skips re-validating redirect targets
    against the private-network guard; redirect-based SSRF is a known,
    accepted residual risk here (legitimate image CDNs commonly redirect).
    """
    async with httpx.AsyncClient(timeout=timeout_seconds, follow_redirects=True) as client:
        response = await client.get(url)
        response.raise_for_status()
        return response.content


def _save_generated_image(user_id: int, image_bytes: bytes) -> str:
    if not image_bytes:
        raise HTTPException(status_code=502, detail="图片生成服务返回了空图片")
    if len(image_bytes) > 30 * 1024 * 1024:
        raise HTTPException(status_code=502, detail="图片生成服务返回的图片过大")

    storage_dir = os.path.realpath(os.path.join(settings.UPLOAD_DIR, str(user_id), "generated-images"))
    user_root = os.path.realpath(os.path.join(settings.UPLOAD_DIR, str(user_id)))
    if not storage_dir.startswith(user_root):
        raise HTTPException(status_code=500, detail="Invalid generated image storage path")
    os.makedirs(storage_dir, exist_ok=True)

    filename = f"{uuid.uuid4().hex}.png"
    file_path = os.path.join(storage_dir, filename)
    with open(file_path, "wb") as handle:
        handle.write(image_bytes)
    return f"/api/uploads/generated-images/{filename}"


async def generate_image(prompt: str, user_id: int, provider_id: Optional[str] = None) -> GeneratedImage:
    config = _get_raw_config()
    if not config.get("enabled", False):
        raise HTTPException(status_code=400, detail="图片生成未启用")

    provider = _get_active_provider(config, provider_id)
    timeout_seconds = int(provider.get("timeout_seconds") or 120)
    payload: dict[str, Any] = {
        "model": provider["model"],
        "prompt": prompt,
        "size": provider.get("size") or "1024x1024",
    }
    response_format = str(provider.get("response_format") or "auto").lower()
    if response_format in {"b64_json", "url"}:
        payload["response_format"] = response_format
    elif "gpt-image-1" not in str(provider.get("model", "")).lower():
        payload["response_format"] = "b64_json"
    if provider.get("quality"):
        payload["quality"] = provider["quality"]
    if provider.get("style"):
        payload["style"] = provider["style"]

    headers = {"Authorization": f"Bearer {provider['api_key']}", "Content-Type": "application/json"}
    try:
        async with httpx.AsyncClient(timeout=timeout_seconds) as client:
            response = await client.post(_build_generation_url(provider["base_url"]), json=payload, headers=headers)
            response.raise_for_status()
            data = response.json()
    except httpx.HTTPStatusError as exc:
        logger.warning("Image generation provider returned an error: %s", exc.response.text[:500])
        raise HTTPException(status_code=502, detail="图片生成服务返回错误") from exc
    except Exception as exc:
        logger.warning("Image generation request failed: %s", exc)
        raise HTTPException(status_code=502, detail="图片生成请求失败") from exc

    items = data.get("data") if isinstance(data, dict) else None
    if not items or not isinstance(items, list) or not isinstance(items[0], dict):
        raise HTTPException(status_code=502, detail="图片生成服务响应格式无效")

    first = items[0]
    image_bytes: bytes
    if first.get("b64_json"):
        try:
            image_bytes = base64.b64decode(first["b64_json"], validate=True)
        except Exception as exc:
            raise HTTPException(status_code=502, detail="图片生成服务返回的 base64 无效") from exc
    elif first.get("url"):
        image_url = str(first["url"])
        image_bytes = _decode_data_url(image_url) if image_url.startswith("data:") else await _download_image(image_url, timeout_seconds)
    else:
        raise HTTPException(status_code=502, detail="图片生成服务未返回图片数据")

    local_url = _save_generated_image(user_id, image_bytes)
    return GeneratedImage(
        image_url=local_url,
        prompt=prompt,
        provider_id=provider["id"],
        model=provider.get("model"),
        revised_prompt=first.get("revised_prompt"),
        metadata={"size": provider.get("size")},
    )


_IMAGE_MD_RE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_FILE_LINK_RE = re.compile(r"\[📎[^\]]*\]\([^)]*\)")
_THINK_RE = re.compile(r"<think[\s\S]*?</think\s*>", re.IGNORECASE)


def clean_content_for_image_prompt(content: str) -> str:
    cleaned = _THINK_RE.sub("", content or "")
    cleaned = _IMAGE_MD_RE.sub("", cleaned)
    cleaned = _FILE_LINK_RE.sub("", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def append_generated_image_markdown(content: str, image_url: str) -> str:
    base = (content or "").rstrip()
    markdown = f"![生成图片]({image_url})"
    return f"{base}\n\n{markdown}" if base else markdown


def build_message_image_prompt(
    target_message: ChatMessage | CharacterChatMessage,
    context_messages: Sequence[ChatMessage | CharacterChatMessage],
    character: Optional[Character] = None,
) -> str:
    config = _get_raw_config()
    defaults = config.get("defaults", {})
    template = defaults.get("prompt_template") or DEFAULT_PROMPT_TEMPLATE
    context_limit = int(defaults.get("include_recent_context_count") or 4)

    nearby = list(context_messages)[-context_limit:] if context_limit > 0 else []
    context_lines = []
    if character:
        context_lines.append(f"Character: {character.name}")
        for label, value in (
            ("Description", character.description),
            ("Personality", character.personality),
            ("Scenario", character.scenario),
        ):
            if value:
                context_lines.append(f"{label}: {clean_content_for_image_prompt(value)[:800]}")
    for message in nearby:
        if message.id == target_message.id:
            continue
        text = clean_content_for_image_prompt(message.content)
        if text:
            context_lines.append(f"{message.role}: {text[:1200]}")

    target_text = clean_content_for_image_prompt(target_message.content)
    context = "\n".join(context_lines).strip() or "No additional context."
    return template.replace("{{context}}", context).replace("{{message}}", target_text[:3000] or target_message.role)


def image_result_to_dict(result: GeneratedImage, include_prompt: bool = False) -> dict[str, Any]:
    payload = {
        "image_url": result.image_url,
        "provider_id": result.provider_id,
        "model": result.model,
        "metadata": result.metadata or {},
    }
    if include_prompt:
        payload["prompt"] = result.prompt
        payload["revised_prompt"] = result.revised_prompt
    return payload


def message_to_dict(message: ChatMessage | CharacterChatMessage) -> dict[str, Any]:
    payload = {
        "id": message.id,
        "role": message.role,
        "content": message.content,
        "model": message.model,
        "created_at": message.created_at,
        "tokens": message.tokens,
    }
    if isinstance(message, CharacterChatMessage):
        payload["branch_id"] = message.branch_id
        payload["short_title"] = message.short_title
    return payload


async def generate_image_for_message(
    db: Session,
    user: User,
    message: ChatMessage | CharacterChatMessage,
    context_messages: Sequence[ChatMessage | CharacterChatMessage],
    character: Optional[Character] = None,
) -> GeneratedImage:
    prompt = build_message_image_prompt(message, context_messages, character)
    result = await generate_image(prompt=prompt, user_id=user.id)
    message.content = append_generated_image_markdown(message.content, result.image_url)
    db.add(message)
    db.commit()
    db.refresh(message)
    return result


async def maybe_generate_image_for_message(
    db: Session,
    user: User,
    message: ChatMessage | CharacterChatMessage,
    context_messages: Sequence[ChatMessage | CharacterChatMessage],
    target: Literal["chat", "character"],
    character: Optional[Character] = None,
) -> Optional[GeneratedImage]:
    user_setting = db.query(UserSetting).filter(UserSetting.user_id == user.id).first()
    if not user_setting or not getattr(user_setting, "auto_generate_chat_images", False):
        return None
    if not _get_raw_config().get("enabled", False):
        return None
    try:
        return await generate_image_for_message(db, user, message, context_messages, character)
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("Auto image generation failed for %s message %s: %s", target, message.id, exc)
        raise HTTPException(status_code=502, detail="自动图片生成失败") from exc


# ============================================================
# SD WebUI / ComfyUI 提供商支持
# ============================================================

def _get_provider_by_type(config: dict[str, Any], provider_type: str) -> Optional[dict[str, Any]]:
    """按类型查找图片生成服务商。"""
    for provider in config.get("providers", []):
        if isinstance(provider, dict) and provider.get("type") == provider_type:
            return provider
    return None


def get_sd_webui_provider() -> Optional[dict[str, Any]]:
    """获取 SD WebUI 服务商配置。"""
    config = _get_raw_config()
    return _get_provider_by_type(config, "sd_webui")


def get_comfyui_provider() -> Optional[dict[str, Any]]:
    """获取 ComfyUI 服务商配置。"""
    config = _get_raw_config()
    return _get_provider_by_type(config, "comfyui")


async def _generate_sd_webui(
    base_url: str,
    prompt: str,
    negative_prompt: str = "",
    sampler: str = "Euler a",
    steps: int = 20,
    cfg_scale: float = 7.0,
    width: int = 512,
    height: int = 512,
    seed: int = -1,
    timeout_seconds: int = 120,
    api_key: str = "",
) -> dict[str, Any]:
    """通过 SD WebUI /sdapi/v1/txt2img 端点生成图片。"""
    url = f"{base_url.rstrip('/')}/sdapi/v1/txt2img"
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    payload = {
        "prompt": prompt,
        "negative_prompt": negative_prompt,
        "sampler_name": sampler,
        "steps": steps,
        "cfg_scale": cfg_scale,
        "width": width,
        "height": height,
        "seed": seed,
        "batch_size": 1,
    }
    logger.info("SD WebUI txt2img: url=%s, steps=%d, cfg=%s, size=%dx%d", url, steps, cfg_scale, width, height)
    try:
        async with httpx.AsyncClient(timeout=timeout_seconds) as client:
            response = await client.post(url, json=payload, headers=headers)
            response.raise_for_status()
            data = response.json()
    except httpx.ConnectError as exc:
        raise HTTPException(status_code=502, detail=f"无法连接 SD WebUI 服务: {exc}") from exc
    except httpx.TimeoutException as exc:
        raise HTTPException(status_code=504, detail="SD WebUI 请求超时") from exc
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=502, detail=f"SD WebUI 返回错误: {exc.response.status_code}") from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"SD WebUI 请求失败: {exc}") from exc

    images = data.get("images", []) if isinstance(data, dict) else []
    if not images:
        raise HTTPException(status_code=502, detail="SD WebUI 未返回图片")

    used_seed = seed
    info_raw = data.get("info", "")
    if info_raw:
        try:
            info = json.loads(info_raw) if isinstance(info_raw, str) else info_raw
            used_seed = info.get("seed", seed)
        except Exception:
            pass

    return {"base64": images, "seed": used_seed}


async def _generate_sd_webui_img2img(
    base_url: str,
    init_images: list[str],
    prompt: str,
    negative_prompt: str = "",
    sampler: str = "Euler a",
    steps: int = 20,
    cfg_scale: float = 7.0,
    denoising_strength: float = 0.75,
    seed: int = -1,
    timeout_seconds: int = 120,
    api_key: str = "",
) -> dict[str, Any]:
    """通过 SD WebUI /sdapi/v1/img2img 端点生成图片。"""
    url = f"{base_url.rstrip('/')}/sdapi/v1/img2img"
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    payload = {
        "init_images": init_images,
        "prompt": prompt,
        "negative_prompt": negative_prompt,
        "sampler_name": sampler,
        "steps": steps,
        "cfg_scale": cfg_scale,
        "denoising_strength": denoising_strength,
        "seed": seed,
        "batch_size": 1,
    }
    logger.info("SD WebUI img2img: url=%s, steps=%d, cfg=%s", url, steps, cfg_scale)
    try:
        async with httpx.AsyncClient(timeout=timeout_seconds) as client:
            response = await client.post(url, json=payload, headers=headers)
            response.raise_for_status()
            data = response.json()
    except httpx.ConnectError as exc:
        raise HTTPException(status_code=502, detail=f"无法连接 SD WebUI 服务: {exc}") from exc
    except httpx.TimeoutException as exc:
        raise HTTPException(status_code=504, detail="SD WebUI 请求超时") from exc
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=502, detail=f"SD WebUI 返回错误: {exc.response.status_code}") from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"SD WebUI 请求失败: {exc}") from exc

    images = data.get("images", []) if isinstance(data, dict) else []
    if not images:
        raise HTTPException(status_code=502, detail="SD WebUI 未返回图片")

    used_seed = seed
    info_raw = data.get("info", "")
    if info_raw:
        try:
            info = json.loads(info_raw) if isinstance(info_raw, str) else info_raw
            used_seed = info.get("seed", seed)
        except Exception:
            pass

    return {"base64": images, "seed": used_seed}


async def _generate_comfyui(
    base_url: str,
    prompt: str,
    negative_prompt: str = "",
    width: int = 512,
    height: int = 512,
    steps: int = 20,
    cfg_scale: float = 7.0,
    seed: int = -1,
    timeout_seconds: int = 120,
) -> dict[str, Any]:
    """通过 ComfyUI HTTP API 提交工作流（最小实现）。"""
    url = f"{base_url.rstrip('/')}/prompt"
    workflow = {
        "3": {
            "class_type": "KSampler",
            "inputs": {
                "seed": seed if seed >= 0 else 0,
                "steps": steps,
                "cfg": cfg_scale,
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
            "inputs": {"width": width, "height": height, "batch_size": 1},
        },
        "6": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": prompt, "clip": ["4", 1]},
        },
        "7": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": negative_prompt, "clip": ["4", 1]},
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
    payload = {"prompt": workflow}
    logger.info("ComfyUI prompt submit: url=%s, size=%dx%d", url, width, height)
    try:
        async with httpx.AsyncClient(timeout=timeout_seconds) as client:
            response = await client.post(url, json=payload)
            response.raise_for_status()
            result = response.json()
    except httpx.ConnectError as exc:
        raise HTTPException(status_code=502, detail=f"无法连接 ComfyUI 服务: {exc}") from exc
    except httpx.TimeoutException as exc:
        raise HTTPException(status_code=504, detail="ComfyUI 请求超时") from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"ComfyUI 请求失败: {exc}") from exc

    prompt_id = result.get("prompt_id", "") if isinstance(result, dict) else ""
    return {"base64": [], "seed": seed, "prompt_id": prompt_id, "message": "ComfyUI 工作流已提交"}


async def generate_sd_webui_image(
    prompt: str,
    negative_prompt: str = "",
    sampler: str = "Euler a",
    steps: int = 20,
    cfg_scale: float = 7.0,
    width: int = 512,
    height: int = 512,
    seed: int = -1,
) -> dict[str, Any]:
    """通过 SD WebUI 生成图片，返回 {"base64": [...], "seed": ...}。"""
    provider = get_sd_webui_provider()
    if not provider or not provider.get("base_url"):
        raise HTTPException(status_code=400, detail="SD WebUI 未配置")
    return await _generate_sd_webui(
        base_url=provider["base_url"],
        prompt=prompt,
        negative_prompt=negative_prompt,
        sampler=sampler,
        steps=steps,
        cfg_scale=cfg_scale,
        width=width,
        height=height,
        seed=seed,
        timeout_seconds=int(provider.get("timeout_seconds") or 120),
        api_key=provider.get("api_key", ""),
    )


async def generate_sd_webui_img2img(
    init_images: list[str],
    prompt: str,
    negative_prompt: str = "",
    sampler: str = "Euler a",
    steps: int = 20,
    cfg_scale: float = 7.0,
    denoising_strength: float = 0.75,
    seed: int = -1,
) -> dict[str, Any]:
    """通过 SD WebUI 进行图生图，返回 {"base64": [...], "seed": ...}。"""
    provider = get_sd_webui_provider()
    if not provider or not provider.get("base_url"):
        raise HTTPException(status_code=400, detail="SD WebUI 未配置")
    return await _generate_sd_webui_img2img(
        base_url=provider["base_url"],
        init_images=init_images,
        prompt=prompt,
        negative_prompt=negative_prompt,
        sampler=sampler,
        steps=steps,
        cfg_scale=cfg_scale,
        denoising_strength=denoising_strength,
        seed=seed,
        timeout_seconds=int(provider.get("timeout_seconds") or 120),
        api_key=provider.get("api_key", ""),
    )


async def list_sd_models() -> list[dict[str, str]]:
    """获取 SD WebUI 可用模型列表。"""
    provider = get_sd_webui_provider()
    if not provider or not provider.get("base_url"):
        return []
    url = f"{provider['base_url'].rstrip('/')}/sdapi/v1/sd-models"
    headers = {}
    if provider.get("api_key"):
        headers["Authorization"] = f"Bearer {provider['api_key']}"
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(url, headers=headers)
            response.raise_for_status()
            data = response.json()
    except Exception as exc:
        logger.warning("Failed to list SD models: %s", exc)
        return []
    models = []
    for item in data if isinstance(data, list) else []:
        title = item.get("title", "") or item.get("model_name", "")
        model_id = item.get("model_name", "") or title
        models.append({"title": title, "id": model_id})
    return models


async def list_sd_samplers() -> list[dict[str, str]]:
    """获取 SD WebUI 可用采样器列表。"""
    provider = get_sd_webui_provider()
    if not provider or not provider.get("base_url"):
        return []
    url = f"{provider['base_url'].rstrip('/')}/sdapi/v1/samplers"
    headers = {}
    if provider.get("api_key"):
        headers["Authorization"] = f"Bearer {provider['api_key']}"
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(url, headers=headers)
            response.raise_for_status()
            data = response.json()
    except Exception as exc:
        logger.warning("Failed to list SD samplers: %s", exc)
        return []
    samplers = []
    for item in data if isinstance(data, list) else []:
        name = item.get("name", "")
        if name:
            samplers.append({"name": name})
    return samplers


async def get_sd_status() -> dict[str, Any]:
    """获取 SD 服务状态。"""
    provider = get_sd_webui_provider()
    if not provider or not provider.get("base_url"):
        return {"available": False, "type": "sd_webui", "base_url": ""}
    base_url = provider["base_url"]
    url = f"{base_url.rstrip('/')}/sdapi/v1/options"
    headers = {}
    if provider.get("api_key"):
        headers["Authorization"] = f"Bearer {provider['api_key']}"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(url, headers=headers)
            response.raise_for_status()
            return {"available": True, "type": "sd_webui", "base_url": base_url}
    except Exception:
        return {"available": False, "type": "sd_webui", "base_url": base_url}

