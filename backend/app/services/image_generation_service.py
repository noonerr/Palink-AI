"""Image generation service and message insertion helpers."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import random
import re
import time
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
from .message_media_service import (
    DEFAULT_MEDIA_HEIGHT,
    DEFAULT_MEDIA_WIDTH,
    MEDIA_STATUS_FAILED,
    MEDIA_STATUS_READY,
    attach_message_media,
    build_media_item,
    media_for_api,
    new_media_id,
    normalize_media_id,
    reset_media_for_retry,
    update_media_status,
)

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


class MessageImageGenerationError(HTTPException):
    """出图失败，且已把对应 media 项收敛成 `failed`。

    附带 `media`（`media_for_api` 快照）与 `media_id`：事件层与前端据此把占位
    收敛成失败态，**不必再查库**（此时调用方可能已经 rollback，ORM 对象不可用）。

    继承 HTTPException 是为了让 API 端点保持原有状态码与 detail 语义——
    对客户端而言这次改动完全透明。
    """

    def __init__(
        self,
        status_code: int,
        detail: str,
        *,
        media: Optional[dict[str, Any]] = None,
        media_id: Optional[str] = None,
    ) -> None:
        super().__init__(status_code=status_code, detail=detail)
        self.media = media
        self.media_id = media_id


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


def is_image_generation_available() -> bool:
    """工具暴露门控（P4 模型自主出图）：全局开关开且存在可用服务商。

    只读判定、永不抛异常——调用方（角色生成路径）用它决定是否把内置出图
    工具合并进 tools； False 时工具对模型不可见，行为与功能上线前一致。
    """
    try:
        config = _get_raw_config()
        if not config.get("enabled", False):
            return False
        _get_active_provider(config)
        return True
    except Exception as exc:
        logger.debug("Image generation availability check failed: %s", exc)
        return False


def is_image_tool_enabled_for_user(db: Session, user_id: Any) -> bool:
    """P4 模型自主出图的**暴露门控**：用户级开关 + 服务商就绪，两者缺一不可。

    与 `maybe_generate_image_for_message` 的用户级判定同源（同一列 `auto_generate_chat_images`、
    同一语义），只多一道服务商就绪检查——让模型看得见工具却画不出图，比干脆
    看不见更糟（模型会以为自己配过图，正文里就不再描述画面）。

    任何异常一律按**未启用**处理：宁可不暴露工具（退回纯文本），不可误暴露。
    """
    try:
        user_setting = db.query(UserSetting).filter(UserSetting.user_id == user_id).first()
        if not user_setting or not getattr(user_setting, "auto_generate_chat_images", False):
            return False
    except Exception as exc:
        logger.warning("Image tool gate check failed (user=%s): %s", user_id, exc)
        return False
    return is_image_generation_available()


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

    # [AUDIT-2026-09-25] SD/ComfyUI 出图参数收口（clamp 防呆，schema 层也有界）。
    try:
        steps = max(1, min(int(provider.get("steps") or 20), 150))
    except (TypeError, ValueError):
        steps = 20
    try:
        cfg_scale = max(0.0, min(float(provider.get("cfg_scale") or 7.0), 30.0))
    except (TypeError, ValueError):
        cfg_scale = 7.0
    try:
        seed = int(provider.get("seed", -1))
    except (TypeError, ValueError):
        seed = -1
    seed = max(seed, -1)

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
        "negative_prompt": str(provider.get("negative_prompt") or ""),
        "steps": steps,
        "cfg_scale": cfg_scale,
        "sampler_name": str(provider.get("sampler_name") or "Euler a").strip() or "Euler a",
        "seed": seed,
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
    if not provider.get("base_url"):
        raise HTTPException(status_code=400, detail="图片生成服务尚未配置完整")
    # [P0] api_key / model 的强制只对 OpenAI 兼容端点成立。自建 SD WebUI 与
    # ComfyUI 通常是本机无鉴权服务（没有 api_key），模型也是容器里已加载的
    # checkpoint（没有 model 名）。此前要求三者齐全，等于把这两类配置直接
    # 400 拦在门口——即使 schema 放开了也照样出不了图。
    if str(provider.get("type") or "openai_compatible") == "openai_compatible" and (
        not provider.get("api_key") or not provider.get("model")
    ):
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


def _parse_size(raw: Any, default_width: int, default_height: int) -> tuple[int, int]:
    """把 provider.size（"1024x1024" / "1024*1024"）解析成宽高，失败退回默认值。"""
    text = str(raw or "").strip().lower().replace("*", "x")
    if "x" in text:
        left, _, right = text.partition("x")
        try:
            width = int(left.strip())
            height = int(right.strip())
            if width > 0 and height > 0:
                return width, height
        except ValueError:
            pass
    return default_width, default_height


def _decode_b64_image(item: Any) -> bytes:
    """SD 系返回的图片是裸 base64（也容忍 data URL 形态与内部换行）。"""
    text = str(item or "").strip()
    if text.startswith("data:"):
        return _decode_data_url(text)
    try:
        return base64.b64decode("".join(text.split()), validate=True)
    except Exception as exc:
        raise HTTPException(status_code=502, detail="图片生成服务返回的 base64 无效") from exc


def _result_from_base64(
    provider: dict[str, Any],
    prompt: str,
    user_id: int,
    images: Any,
    seed: Any = None,
) -> GeneratedImage:
    """把「裸 base64 列表」统一落盘并组装成 GeneratedImage。"""
    if not images or not isinstance(images, list):
        raise HTTPException(status_code=502, detail="图片生成服务未返回图片数据")
    image_bytes = _decode_b64_image(images[0])
    local_url = _save_generated_image(user_id, image_bytes)
    metadata: dict[str, Any] = {"size": provider.get("size")}
    if seed is not None:
        metadata["seed"] = seed
    return GeneratedImage(
        image_url=local_url,
        prompt=prompt,
        provider_id=provider["id"],
        model=provider.get("model") or None,
        metadata=metadata,
    )


def _sd_auth_header(api_key: str) -> Optional[str]:
    """SD WebUI 鉴权头。A1111 原生 ``--api-auth`` 是 HTTP Basic（user:pass），
    此前只发 Bearer——开了 --api-auth 的实例连不上（AUDIT-2026-09-25）。
    约定：api_key 含 ":" 视为 user:pass 走 Basic，否则维持 Bearer（兼容
    前置网关）。"""
    key = (api_key or "").strip()
    if not key:
        return None
    if ":" in key:
        encoded = base64.b64encode(key.encode("utf-8")).decode("ascii")
        return f"Basic {encoded}"
    return f"Bearer {key}"


async def _generate_image_via_sd_webui(
    provider: dict[str, Any], prompt: str, user_id: int
) -> GeneratedImage:
    base_url = str(provider.get("base_url") or "")
    if not base_url:
        raise HTTPException(status_code=400, detail="SD WebUI 未配置 Base URL")
    width, height = _parse_size(provider.get("size"), 512, 512)
    # [AUDIT-2026-09-25] 出图参数从配置透传（此前全吃函数默认值的硬编码）。
    result = await _generate_sd_webui(
        base_url=base_url,
        prompt=prompt,
        negative_prompt=str(provider.get("negative_prompt") or ""),
        sampler=str(provider.get("sampler_name") or "Euler a"),
        steps=int(provider.get("steps") or 20),
        cfg_scale=float(provider.get("cfg_scale") or 7.0),
        seed=int(provider.get("seed", -1)),
        width=width,
        height=height,
        timeout_seconds=int(provider.get("timeout_seconds") or 120),
        api_key=provider.get("api_key", ""),
        model=str(provider.get("model") or ""),
    )
    return _result_from_base64(provider, prompt, user_id, result.get("base64"), result.get("seed"))


async def _generate_image_via_comfyui(
    provider: dict[str, Any], prompt: str, user_id: int
) -> GeneratedImage:
    base_url = str(provider.get("base_url") or "")
    if not base_url:
        raise HTTPException(status_code=400, detail="ComfyUI 未配置 Base URL")
    width, height = _parse_size(provider.get("size"), 512, 512)
    result = await _generate_comfyui(
        base_url=base_url,
        prompt=prompt,
        negative_prompt=str(provider.get("negative_prompt") or ""),
        width=width,
        height=height,
        steps=int(provider.get("steps") or 20),
        cfg_scale=float(provider.get("cfg_scale") or 7.0),
        seed=int(provider.get("seed", -1)),
        timeout_seconds=int(provider.get("timeout_seconds") or 120),
    )
    images = result.get("base64") or []
    if not images:
        raise HTTPException(status_code=502, detail="ComfyUI 未返回图片数据")
    return _result_from_base64(provider, prompt, user_id, images, result.get("seed"))


async def generate_image(prompt: str, user_id: int, provider_id: Optional[str] = None) -> GeneratedImage:
    config = _get_raw_config()
    if not config.get("enabled", False):
        raise HTTPException(status_code=400, detail="图片生成未启用")

    provider = _get_active_provider(config, provider_id)
    timeout_seconds = int(provider.get("timeout_seconds") or 120)

    # [P0] 按 provider.type 分发。此前这里**完全不看 type**，恒发 OpenAI 形状的
    # POST <base>/v1/images/generations；而 _generate_sd_webui / _generate_comfyui
    # 只被 sd.py 的代理端点调用，消息出图路径根本走不到它们——所以即使放开
    # schema 让配置存得进去，自建 SD / ComfyUI 依然出不了图。这才是真堵点。
    provider_type = str(provider.get("type") or "openai_compatible")
    if provider_type == "sd_webui":
        return await _generate_image_via_sd_webui(provider, prompt, user_id)
    if provider_type == "comfyui":
        return await _generate_image_via_comfyui(provider, prompt, user_id)

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
    # [P1.3] 带上媒体快照：调用方（前端）据此把本地占位整组收敛成服务端真相，
    # 而不是自己拼接 —— 服务端是 `extra.media` 的唯一权威。`content` 保持原值，
    # 出图不再改写正文（D1）。
    payload.update(media_for_api(message))
    return payload


def build_image_generated_event(message: ChatMessage | CharacterChatMessage, image: GeneratedImage) -> dict[str, Any]:
    """出图成功事件载荷（供 SSE / WS 六个发射点统一使用）。

    `media` / `media_index` / `media_display` 是前端收敛 pending 的依据；
    `content` 保留一个版本周期作为降级路径（旧前端仍按它替换正文）。
    """
    payload: dict[str, Any] = {
        "type": "message_image_generated",
        "message_id": message.id,
        "image": image_result_to_dict(image),
        "image_url": image.image_url,
        "content": message.content,
    }
    payload.update(media_for_api(message))
    return payload


def build_image_generation_failed_event(
    message_id: Any,
    error: str,
    *,
    media: Optional[dict[str, Any]] = None,
    media_id: Optional[str] = None,
) -> dict[str, Any]:
    """出图失败事件载荷。

    `media` 来自 `MessageImageGenerationError` 携带的快照——失败项此刻已经
    以 `failed` 落库，前端拿到它就能把动画停掉并显示原因 + 重试。
    """
    payload: dict[str, Any] = {
        "type": "message_image_generation_failed",
        "message_id": message_id,
        "error": error,
    }
    if isinstance(media, dict):
        payload.update(media)
    if media_id:
        payload["media_id"] = media_id
    return payload


def _seed_from_result(result: GeneratedImage) -> Optional[int]:
    """取上游真实 seed（SD WebUI 会把实际用的 seed 回在 metadata 里）。"""
    metadata = result.metadata if isinstance(result.metadata, dict) else {}
    seed = metadata.get("seed")
    return seed if isinstance(seed, int) and not isinstance(seed, bool) else None


async def generate_image_for_message(
    db: Session,
    user: User,
    message: ChatMessage | CharacterChatMessage,
    context_messages: Sequence[ChatMessage | CharacterChatMessage],
    character: Optional[Character] = None,
    *,
    media_id: Optional[str] = None,
    prompt: Optional[str] = None,
) -> GeneratedImage:
    """为一条消息配图：结果进 `extra.media`，**正文一行都不改**（D1 / 原 B2）。

    按 D3「乐观插入 + 事件收敛」分三段：

    1. 先落一条 `pending` 项（含宽高，前端据此预留骨架比例，避免完成后 CLS）；
    2. 成功 → 收敛为 `ready` + 本地 url + seed；
    3. 失败 → 收敛为 `failed` + 原因，并抛出带快照的 `MessageImageGenerationError`。

    `media_id` 是前端乐观占位时生成的 id（见 `normalize_media_id`）：给了就
    **原位复位**同一项（重试不堆残骸），不给则新插一项。

    `prompt` 是 P4 模型自主出图的入口：模型在工具调用里给出的画面描述**直接
    采用**，不再过 `build_message_image_prompt` 模板（模板面向"系统自动配图"
    的启发式拼装，模型已经给了完整画面描述）。不给则维持原启发式行为。
    """
    prompt = prompt or build_message_image_prompt(message, context_messages, character)

    # 未启用 / 服务商不可用必须挡在插 pending 之前：否则会留下一条永远
    # 不会收敛的占位（用户盯着骨架转圈直到超时）。
    config = _get_raw_config()
    if not config.get("enabled", False):
        raise HTTPException(status_code=400, detail="图片生成未启用")
    provider = _get_active_provider(config)
    width, height = _parse_size(provider.get("size"), DEFAULT_MEDIA_WIDTH, DEFAULT_MEDIA_HEIGHT)
    provider_id = str(provider.get("id") or "")

    adopted_id = normalize_media_id(media_id)
    if adopted_id and reset_media_for_retry(
        db,
        message,
        adopted_id,
        prompt=prompt,
        width=width,
        height=height,
        provider_id=provider_id,
    ):
        target_media_id = adopted_id
    else:
        target_media_id = adopted_id or new_media_id()
        attach_message_media(
            db,
            message,
            build_media_item(
                media_id=target_media_id,
                prompt=prompt,
                width=width,
                height=height,
                provider_id=provider_id,
            ),
        )

    try:
        result = await generate_image(prompt=prompt, user_id=user.id)
    except Exception as exc:
        detail = str(getattr(exc, "detail", "") or "图片生成失败")
        status_code = int(getattr(exc, "status_code", 502) or 502)
        update_media_status(db, message, target_media_id, MEDIA_STATUS_FAILED, error=detail)
        raise MessageImageGenerationError(
            status_code,
            detail,
            media=media_for_api(message),
            media_id=target_media_id,
        ) from exc

    update_media_status(
        db,
        message,
        target_media_id,
        MEDIA_STATUS_READY,
        url=result.image_url,
        seed=_seed_from_result(result),
        prompt=result.prompt,
        provider_id=result.provider_id,
    )
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


async def generate_image_for_assistant_message(
    db: Session,
    user: User,
    message: ChatMessage | CharacterChatMessage,
    context_messages: Sequence[ChatMessage | CharacterChatMessage],
    character: Optional[Character] = None,
    *,
    model_prompt: Optional[str] = None,
) -> Optional[GeneratedImage]:
    """角色助手消息落库后的**唯二**出图入口，两路接线（WS / SSE）共用。

    `model_prompt` 非空表示模型在流中通过内置工具自主请求过配图：直接采用它
    给画面描述，并**替代**本轮的启发式自动出图——两条路都走会出现"一消息双图"。
    为空则维持 P1 原有的启发式自动配图（受用户级开关与全局开关双重约束，见
    `maybe_generate_image_for_message`）。
    """
    if model_prompt is not None:
        return await generate_image_for_message(
            db, user, message, context_messages, character=character, prompt=model_prompt
        )
    return await maybe_generate_image_for_message(
        db, user, message, context_messages, target="character", character=character
    )


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
    model: str = "",
) -> dict[str, Any]:
    """通过 SD WebUI /sdapi/v1/txt2img 端点生成图片。"""
    url = f"{base_url.rstrip('/')}/sdapi/v1/txt2img"
    headers = {"Content-Type": "application/json"}
    auth_header = _sd_auth_header(api_key)
    if auth_header:
        headers["Authorization"] = auth_header
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
    # provider.model 此前完全不被读取；txt2img 支持按请求覆盖 checkpoint
    # （restore_afterwards 请求结束后恢复原模型，不污染全局状态）。
    if model:
        payload["override_settings"] = {"sd_model_checkpoint": model}
        payload["override_settings_restore_afterwards"] = True
    logger.info("SD WebUI txt2img: url=%s, steps=%d, cfg=%s, size=%dx%d, model=%s", url, steps, cfg_scale, width, height, model or "<server default>")
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
    auth_header = _sd_auth_header(api_key)
    if auth_header:
        headers["Authorization"] = auth_header
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


# ComfyUI /history 轮询间隔（测试里 monkeypatch 缩短）
COMFYUI_POLL_INTERVAL_SECONDS = 1.0
# ComfyUI 返回的 seed 是 32 位无符号整数
_COMFYUI_SEED_MAX = 2**32 - 1


def _extract_comfyui_image_ref(history_entry: dict) -> Optional[dict[str, str]]:
    """从 /history/{prompt_id} 条目里取第一张输出图的定位参数。

    ComfyUI 的 outputs 形如 ``{node_id: {"images": [{filename, subfolder, type}]}}``；
    优先取 ``type == "output"`` 的（临时预览是 "temp"）。取不到返回 None。
    """
    outputs = history_entry.get("outputs") if isinstance(history_entry, dict) else None
    if not isinstance(outputs, dict):
        return None
    fallback: Optional[dict[str, str]] = None
    for node_output in outputs.values():
        images = node_output.get("images") if isinstance(node_output, dict) else None
        if not isinstance(images, list):
            continue
        for image in images:
            if not isinstance(image, dict) or not image.get("filename"):
                continue
            ref = {
                "filename": str(image["filename"]),
                "subfolder": str(image.get("subfolder", "")),
                "type": str(image.get("type", "output")),
            }
            if ref["type"] == "output":
                return ref
            if fallback is None:
                fallback = ref
    return fallback


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
    """通过 ComfyUI HTTP API 出图：提交工作流 → 轮询 /history → /view 取图。

    审计（2026-09-25）实锤旧实现"只下单不取货"：POST /prompt 后直接返回，
    base64 恒为空，消息出图路径恒 501。这里补全取图闭环。
    """
    base = base_url.rstrip("/")
    # ComfyUI 没有 seed=-1 的"随机"约定：不取随机值会恒用 0（每次同图）。
    used_seed = seed if seed >= 0 else random.randint(0, _COMFYUI_SEED_MAX)
    workflow = {
        "3": {
            "class_type": "KSampler",
            "inputs": {
                "seed": used_seed,
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
    logger.info("ComfyUI prompt submit: url=%s, size=%dx%d, seed=%d", f"{base}/prompt", width, height, used_seed)
    try:
        async with httpx.AsyncClient(timeout=timeout_seconds) as client:
            response = await client.post(f"{base}/prompt", json=payload)
            response.raise_for_status()
            result = response.json()
            prompt_id = result.get("prompt_id", "") if isinstance(result, dict) else ""
            if not prompt_id:
                raise HTTPException(status_code=502, detail="ComfyUI 未返回 prompt_id")

            # 轮询 /history/{prompt_id}，outputs 就绪即取图
            deadline = time.monotonic() + max(timeout_seconds, 5)
            image_ref: Optional[dict[str, str]] = None
            while time.monotonic() < deadline:
                await asyncio.sleep(COMFYUI_POLL_INTERVAL_SECONDS)
                history_resp = await client.get(f"{base}/history/{prompt_id}")
                history_resp.raise_for_status()
                history_data = history_resp.json() if history_resp.content else {}
                entry = history_data.get(prompt_id) if isinstance(history_data, dict) else None
                if not isinstance(entry, dict):
                    continue
                status = entry.get("status") or {}
                if str(status.get("status_str", "")).lower() == "error":
                    raise HTTPException(status_code=502, detail="ComfyUI 工作流执行失败（见 ComfyUI 服务端日志）")
                image_ref = _extract_comfyui_image_ref(entry)
                if image_ref:
                    break
            if image_ref is None:
                raise HTTPException(status_code=504, detail="ComfyUI 出图超时（工作流未在时限内完成）")

            view_resp = await client.get(f"{base}/view", params=image_ref)
            view_resp.raise_for_status()
            image_bytes = view_resp.content
            if not image_bytes:
                raise HTTPException(status_code=502, detail="ComfyUI 返回空图片")

            return {
                "base64": [base64.b64encode(image_bytes).decode("ascii")],
                "seed": used_seed,
                "prompt_id": prompt_id,
            }
    except HTTPException:
        raise
    except httpx.ConnectError as exc:
        raise HTTPException(status_code=502, detail=f"无法连接 ComfyUI 服务: {exc}") from exc
    except httpx.TimeoutException as exc:
        raise HTTPException(status_code=504, detail="ComfyUI 请求超时") from exc
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=502, detail=f"ComfyUI 返回错误: {exc.response.status_code}") from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"ComfyUI 请求失败: {exc}") from exc


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
    auth_header = _sd_auth_header(provider.get("api_key", ""))
    if auth_header:
        headers["Authorization"] = auth_header
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
    auth_header = _sd_auth_header(provider.get("api_key", ""))
    if auth_header:
        headers["Authorization"] = auth_header
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
    auth_header = _sd_auth_header(provider.get("api_key", ""))
    if auth_header:
        headers["Authorization"] = auth_header
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(url, headers=headers)
            response.raise_for_status()
            return {"available": True, "type": "sd_webui", "base_url": base_url}
    except Exception:
        return {"available": False, "type": "sd_webui", "base_url": base_url}

