"""
TTS 语音合成 API
支持多TTS服务商配置、用户/角色语音绑定、声音克隆样本和试听
"""
import base64
import logging
import mimetypes
import os
import uuid
from typing import Optional

import httpx
from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import Response
from sqlalchemy.orm import Session

from .dependencies import get_admin, get_current_user
from ..core import get_db, settings
from ..core.rate_limit import enforce_rate_limit
from ..models import Character, TTSCloneSample, TTSVoiceBinding, User
from ..schemas.tts import (
    BindingsUpdateRequest,
    CustomProviderRequest,
    SetVoiceRequest,
    TTSConfigRequest,
    TTSPrefetchVoicesRequest,
    TTSPreviewRequest,
    TTSRequest,
    TTSResponse,
)
from ..services.mcp_service import _is_safe_mcp_url
from ..services.tts_service import (
    BUILTIN_PROVIDERS,
    DEFAULT_PREVIEW_TEXT,
    binding_to_public_dict,
    clean_text_for_tts,
    get_tts_config,
    save_tts_config,
    tts_service,
    _get_raw_config,
    _provider_config,
    _call_xiaomi_mimo_tts,
    _call_custom_api_tts,
)
from ..utils import normalize_upload_filename

router = APIRouter(prefix="/api/tts", tags=["tts"])
logger = logging.getLogger(__name__)

ALLOWED_AUDIO_EXTENSIONS = {".wav", ".mp3", ".m4a", ".flac", ".ogg"}
MAX_CLONE_SAMPLE_BYTES = 20 * 1024 * 1024
UPLOAD_READ_CHUNK_BYTES = 1024 * 1024
TTS_AUDIO_RATE_LIMIT_REQUESTS = 20
TTS_AUDIO_RATE_LIMIT_WINDOW_SECONDS = 60
AUDIO_SIGNATURES = {
    ".wav": (b"RIFF",),
    ".mp3": (b"ID3", b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"),
    ".flac": (b"fLaC",),
    ".ogg": (b"OggS",),
    ".m4a": (b"\x00\x00\x00",),
}


def _is_admin(user: User) -> bool:
    return user.role == "admin"


def _public_provider(provider: dict, is_builtin: bool = False) -> dict:
    return {
        "id": provider.get("id", ""),
        "name": provider.get("name", ""),
        "description": provider.get("description", ""),
        "engine_type": provider.get("engine_type", "browser"),
        "voices": provider.get("voices", []),
        "is_builtin": is_builtin,
    }


def _public_tts_config(config: dict) -> dict:
    all_providers = [
        _public_provider(provider, is_builtin=True)
        for provider in BUILTIN_PROVIDERS
    ] + [
        _public_provider(provider, is_builtin=False)
        for provider in config.get("providers", [])
        if isinstance(provider, dict)
    ]
    return {
        "enabled": config.get("enabled", True),
        "active_provider_id": config.get("active_provider_id", "browser"),
        "default_voice_gender": config.get("default_voice_gender", "female"),
        "default_voice_id": config.get("default_voice_id", ""),
        "available_providers": all_providers,
    }


def _raw_providers() -> list[dict]:
    config = get_tts_config()
    provider_configs = config.get("provider_configs", {})
    providers = []
    for provider in BUILTIN_PROVIDERS:
        builtin_config = provider_configs.get(provider["id"], {})
        providers.append({**provider, "is_builtin": True, "config": builtin_config})
    for provider in config.get("providers", []):
        providers.append({**provider, "is_builtin": False})
    return providers


async def _fetch_provider_voices_from_api(provider: dict, pconfig: dict) -> list[dict]:
    """从第三方 TTS 提供商 API 获取音色列表"""
    engine_type = provider.get("engine_type", "")
    voices = []

    if engine_type == "xiaomi_mimo":
        api_key = pconfig.get("api_key", "")
        if not api_key:
            return []
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.get(
                    "https://api.xiaomimimo.com/v1/audio/voices",
                    headers={"api-key": api_key},
                )
                if response.status_code == 200:
                    data = response.json()
                    voice_list = data.get("voices", []) or data.get("data", []) or data.get("result", [])
                    for v in voice_list:
                        if isinstance(v, dict):
                            voices.append({
                                "voice_id": v.get("voice_id") or v.get("id") or v.get("name", ""),
                                "gender": v.get("gender", "female"),
                                "description": v.get("description") or v.get("name", "") or v.get("voice_id", ""),
                            })
        except Exception:
            pass

    elif engine_type == "custom_api":
        base_url = pconfig.get("base_url", "")
        api_key = pconfig.get("api_key", "")
        if not base_url:
            return []
        if not _is_safe_mcp_url(base_url):
            logger.warning("TTS custom API base_url points to private/internal network: %s", base_url)
            return []
        voice_list_url = base_url.rstrip("/") + "/v1/audio/voices"
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.get(voice_list_url, headers=headers)
                if response.status_code == 200:
                    data = response.json()
                    voice_list = data.get("voices", []) or data.get("data", []) or data.get("result", [])
                    for v in voice_list:
                        if isinstance(v, dict):
                            voices.append({
                                "voice_id": v.get("voice_id") or v.get("id") or v.get("name", ""),
                                "gender": v.get("gender", "female"),
                                "description": v.get("description") or v.get("name", "") or v.get("voice_id", ""),
                            })
        except Exception:
            pass

    return voices


def _get_tts_provider(provider_id: str) -> Optional[dict]:
    for provider in _raw_providers():
        if provider.get("id") == provider_id:
            return provider
    return None


def _provider_supports_clone(provider_id: str) -> bool:
    provider = _get_tts_provider(provider_id)
    return bool(provider and provider.get("engine_type") == "xiaomi_mimo")


async def _read_upload_with_limit(file: UploadFile, max_bytes: int) -> bytes:
    chunks = []
    total = 0
    while True:
        chunk = await file.read(UPLOAD_READ_CHUNK_BYTES)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(status_code=413, detail="声音样本最大支持 20MB")
        chunks.append(chunk)
    return b"".join(chunks)


def _public_providers_for_user(user: User) -> list[dict]:
    if _is_admin(user):
        return _raw_providers()
    return [
        _public_provider(provider, is_builtin=provider.get("is_builtin", False))
        for provider in _raw_providers()
    ]


def _clone_sample_to_dict(sample: TTSCloneSample, db: Session) -> dict:
    usage_count = db.query(TTSVoiceBinding).filter(TTSVoiceBinding.clone_sample_id == sample.id).count()
    return {
        "id": sample.id,
        "name": sample.name,
        "provider_id": sample.provider_id,
        "source_voice_id": sample.source_voice_id,
        "filename": sample.filename,
        "file_size": sample.file_size,
        "mime_type": sample.mime_type,
        "duration_seconds": sample.duration_seconds,
        "created_at": sample.created_at,
        "updated_at": sample.updated_at,
        "usage_count": usage_count,
    }


def _validate_character_owner(db: Session, user: User, character_id: str) -> Character:
    character = db.query(Character).filter(Character.id == character_id, Character.user_id == user.id).first()
    if not character:
        raise HTTPException(status_code=404, detail="Character not found")
    return character


def _validate_binding_payload(db: Session, user: User, payload, allow_clone: bool) -> None:
    if payload.provider_id:
        provider_ids = [provider["id"] for provider in BUILTIN_PROVIDERS] + [
            provider.get("id", "") for provider in get_tts_config().get("providers", [])
        ]
        if payload.provider_id not in provider_ids:
            raise HTTPException(status_code=400, detail="TTS 服务商不存在")
    if payload.clone_sample_id:
        if not allow_clone:
            raise HTTPException(status_code=400, detail="全局默认不能使用用户私有克隆音色")
        sample = db.query(TTSCloneSample).filter(
            TTSCloneSample.id == payload.clone_sample_id,
            TTSCloneSample.user_id == user.id,
        ).first()
        if not sample:
            raise HTTPException(status_code=404, detail="声音克隆样本不存在")
        if not _provider_supports_clone(sample.provider_id):
            raise HTTPException(status_code=400, detail="该声音样本的服务商不支持音色克隆")
        if payload.provider_id and not _provider_supports_clone(payload.provider_id):
            raise HTTPException(status_code=400, detail="音色克隆当前仅支持小米 MIMO 服务商")


def _apply_bindings_update(
    db: Session,
    user: User,
    request: BindingsUpdateRequest,
    scope: str,
    target_user_id: Optional[int] = None,
    character_id: Optional[str] = None,
    allow_clone: bool = True,
) -> list[dict]:
    results = []
    for payload in request.bindings:
        role = tts_service.validate_role(payload.role)
        if payload.inherit:
            tts_service.clear_binding(db, role, scope, user_id=target_user_id, character_id=character_id)
            results.append({"role": role, "cleared": True})
            continue
        _validate_binding_payload(db, user, payload, allow_clone=allow_clone)
        binding = tts_service.upsert_binding(
            db,
            role=role,
            scope=scope,
            user_id=target_user_id,
            character_id=character_id,
            provider_id=payload.provider_id,
            voice_id=payload.voice_id,
            gender=payload.gender,
            clone_sample_id=payload.clone_sample_id,
            speed=payload.speed,
            volume=payload.volume,
            enabled=payload.enabled,
        )
        results.append(binding_to_public_dict(binding))
    db.commit()
    return results


def _validate_synthesis_request_character(db: Session, user: User, character_id: Optional[str]) -> None:
    if character_id:
        _validate_character_owner(db, user, character_id)


def _validate_override(db: Session, user: User, override: Optional[dict]) -> None:
    if not override:
        return
    provider_id = override.get("provider_id")
    if provider_id:
        provider_ids = [provider["id"] for provider in BUILTIN_PROVIDERS] + [
            provider.get("id", "") for provider in get_tts_config().get("providers", [])
        ]
        if provider_id not in provider_ids:
            raise HTTPException(status_code=400, detail="TTS 服务商不存在")
    clone_sample_id = override.get("clone_sample_id")
    if clone_sample_id:
        sample = db.query(TTSCloneSample).filter(
            TTSCloneSample.id == clone_sample_id,
            TTSCloneSample.user_id == user.id,
        ).first()
        if not sample:
            raise HTTPException(status_code=404, detail="声音克隆样本不存在")
        if not _provider_supports_clone(sample.provider_id):
            raise HTTPException(status_code=400, detail="该声音样本的服务商不支持音色克隆")
        if provider_id and not _provider_supports_clone(provider_id):
            raise HTTPException(status_code=400, detail="音色克隆当前仅支持小米 MIMO 服务商")


def _current_role_binding_state(db: Session, user: User, role: str, character_id: Optional[str] = None) -> dict:
    explicit = None
    if character_id:
        explicit = tts_service.get_explicit_binding(db, user.id, role, "character", character_id)
    if not explicit:
        explicit = tts_service.get_explicit_binding(db, user.id, role, "user")
    resolved = tts_service.resolve_voice_binding(db=db, user=user, role=role, character_id=character_id)
    return {"explicit": binding_to_public_dict(explicit), "resolved": resolved}


@router.post("/synthesize", response_model=TTSResponse)
async def synthesize_tts(
    request: TTSRequest,
    http_request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    try:
        _validate_synthesis_request_character(db, current_user, request.character_id)
        _validate_override(db, current_user, request.binding_override)
        result = tts_service.synthesize(
            text=request.text,
            voice_description=request.voice_description,
            is_narrator=request.is_narrator,
            db=db,
            user=current_user,
            role=request.role,
            character_id=request.character_id,
            binding_override=request.binding_override,
        )
        return TTSResponse(success=True, **result)
    except ValueError as e:
        _rid = getattr(http_request.state, "request_id", "unknown")
        logger.warning("TTS synthesis validation failed: %s request_id=%s", e, _rid)
        raise HTTPException(status_code=400, detail=f"语音合成请求无法处理 (request_id: {_rid})") from e
    except Exception:
        logger.exception("TTS synthesis failed")
        raise HTTPException(status_code=500, detail="TTS synthesis failed")


@router.post("")
async def synthesize_tts_st_compat(
    text: str = Form(...),
    voice: Optional[str] = Form(None),
    speed: float = Form(1.0),
    http_request: Request = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """ST 兼容的 TTS 端点：接受 form-encoded text/voice，返回二进制音频流。"""
    try:
        clean = clean_text_for_tts(text)
        if not clean:
            raise ValueError("No text to synthesize")
        binding_override: Optional[dict] = None
        if voice:
            binding_override = {"voice_id": voice}
        if speed != 1.0:
            binding_override = binding_override or {}
            binding_override["speed"] = speed
        content_type, audio_bytes = await tts_service.synthesize_audio(
            text=clean,
            db=db,
            user=current_user,
            binding_override=binding_override,
        )
        return Response(
            content=audio_bytes,
            media_type="audio/mpeg",
            headers={"Content-Disposition": "inline; filename=tts.mp3", "Cache-Control": "no-cache"},
        )
    except ValueError as e:
        _rid = getattr(http_request.state, "request_id", "unknown")
        logger.warning("ST-compat TTS validation failed: %s request_id=%s", e, _rid)
        raise HTTPException(status_code=400, detail=f"语音合成请求无法处理 (request_id: {_rid})") from e
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=502, detail=f"TTS provider error: {e.response.status_code}")
    except Exception:
        logger.exception("ST-compatible TTS synthesis failed")
        raise HTTPException(status_code=500, detail="TTS synthesis failed")


@router.post("/audio")
async def synthesize_audio(
    request: TTSRequest,
    http_request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    enforce_rate_limit(
        http_request,
        "tts:audio",
        TTS_AUDIO_RATE_LIMIT_REQUESTS,
        TTS_AUDIO_RATE_LIMIT_WINDOW_SECONDS,
    )
    try:
        _validate_synthesis_request_character(db, current_user, request.character_id)
        _validate_override(db, current_user, request.binding_override)
        content_type, audio_bytes = await tts_service.synthesize_audio(
            text=request.text,
            voice_description=request.voice_description,
            is_narrator=request.is_narrator,
            db=db,
            user=current_user,
            role=request.role,
            character_id=request.character_id,
            binding_override=request.binding_override,
        )
        return Response(
            content=audio_bytes,
            media_type=content_type,
            headers={"Content-Disposition": "inline; filename=tts_audio.wav", "Cache-Control": "no-cache"},
        )
    except ValueError as e:
        _rid = getattr(http_request.state, "request_id", "unknown")
        logger.warning("TTS audio validation failed: %s request_id=%s", e, _rid)
        raise HTTPException(status_code=400, detail=f"语音合成请求无法处理 (request_id: {_rid})") from e
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=502, detail=f"TTS provider error: {e.response.status_code}")
    except Exception:
        logger.exception("TTS audio synthesis failed")
        raise HTTPException(status_code=500, detail="TTS audio synthesis failed")


@router.get("/config")
async def get_config(current_user: User = Depends(get_current_user)):
    config = get_tts_config()
    if not _is_admin(current_user):
        return _public_tts_config(config)
    all_providers = list(BUILTIN_PROVIDERS) + config.get("providers", [])
    return {**config, "available_providers": all_providers}


@router.post("/config")
async def save_config(req: TTSConfigRequest, http_request: Request, current_user: User = Depends(get_admin)):
    current = _get_raw_config()
    updates = {}
    if req.enabled is not None:
        updates["enabled"] = req.enabled
    if req.active_provider_id is not None:
        valid_ids = [p["id"] for p in BUILTIN_PROVIDERS] + [p.get("id", "") for p in current.get("providers", [])]
        if req.active_provider_id not in valid_ids:
            raise HTTPException(status_code=400, detail=f"Invalid provider_id: {req.active_provider_id}")
        updates["active_provider_id"] = req.active_provider_id
    if req.default_voice_gender is not None:
        updates["default_voice_gender"] = req.default_voice_gender
    if req.default_voice_id is not None:
        updates["default_voice_id"] = req.default_voice_id
    if req.segmented_playback is not None:
        updates["segmented_playback"] = req.segmented_playback
    if req.providers is not None:
        updates["providers"] = req.providers
    if req.provider_configs is not None:
        updates["provider_configs"] = req.provider_configs

    merged = {**current, **updates}
    try:
        saved = save_tts_config(merged)
    except ValueError as e:
        _rid = getattr(http_request.state, "request_id", "unknown")
        logger.warning("TTS config save failed: %s request_id=%s", e, _rid)
        raise HTTPException(status_code=400, detail=f"TTS 配置无效 (request_id: {_rid})") from e
    all_providers = list(BUILTIN_PROVIDERS) + saved.get("providers", [])
    return {**saved, "available_providers": all_providers}


@router.get("/providers")
async def get_providers(current_user: User = Depends(get_current_user)):
    config = get_tts_config()
    return {"providers": _public_providers_for_user(current_user), "active_provider_id": config.get("active_provider_id", "browser")}


@router.post("/providers")
async def add_custom_provider(req: CustomProviderRequest, current_user: User = Depends(get_admin)):
    builtin_ids = [p["id"] for p in BUILTIN_PROVIDERS]
    if req.id in builtin_ids:
        raise HTTPException(status_code=400, detail="Cannot override builtin provider")

    config = get_tts_config()
    custom_providers = config.get("providers", [])
    for provider in custom_providers:
        if provider.get("id") == req.id:
            raise HTTPException(status_code=400, detail=f"Provider '{req.id}' already exists")

    new_provider = {
        "id": req.id,
        "name": req.name,
        "description": req.description or "",
        "engine_type": req.engine_type,
        "config_fields": req.config_fields or [
            {"key": "base_url", "label": "API 地址", "type": "text", "required": True, "placeholder": "https://api.example.com/v1/audio/speech"},
            {"key": "api_key", "label": "API Key", "type": "password", "required": False, "placeholder": "可选"},
        ],
        "config": req.config or {},
        "voices": req.voices or [
            {"voice_id": "default_female", "gender": "female", "description": "默认女声"},
            {"voice_id": "default_male", "gender": "male", "description": "默认男声"},
        ],
    }
    if req.engine_type == "custom_api":
        base_url = (req.config or {}).get("base_url", "")
        if base_url and not _is_safe_mcp_url(base_url):
            raise HTTPException(status_code=400, detail="TTS API 地址不能指向内网地址")
    custom_providers.append(new_provider)
    save_tts_config({**config, "providers": custom_providers})
    return {"success": True, "provider": new_provider}


@router.put("/providers/{provider_id}")
async def update_custom_provider(provider_id: str, req: CustomProviderRequest, current_user: User = Depends(get_admin)):
    builtin_ids = [p["id"] for p in BUILTIN_PROVIDERS]
    if provider_id in builtin_ids:
        raise HTTPException(status_code=400, detail="Cannot modify builtin provider")

    config = get_tts_config()
    custom_providers = config.get("providers", [])
    found = False
    for index, provider in enumerate(custom_providers):
        if provider.get("id") == provider_id:
            custom_providers[index] = {
                "id": provider_id,
                "name": req.name,
                "description": req.description or "",
                "engine_type": req.engine_type,
                "config_fields": req.config_fields or provider.get("config_fields", []),
                "config": req.config or provider.get("config", {}),
                "voices": req.voices or provider.get("voices", []),
            }
            found = True
            break
    if not found:
        raise HTTPException(status_code=404, detail=f"Provider '{provider_id}' not found")

    if req.engine_type == "custom_api":
        base_url = (req.config or {}).get("base_url", "")
        if base_url and not _is_safe_mcp_url(base_url):
            raise HTTPException(status_code=400, detail="TTS API 地址不能指向内网地址")

    save_tts_config({**config, "providers": custom_providers})
    return {"success": True}


@router.post("/providers/{provider_id}/fetch-voices")
async def fetch_provider_voices(
    provider_id: str,
    current_user: User = Depends(get_admin),
):
    """从 TTS 提供商 API 获取音色列表"""
    provider = _get_tts_provider(provider_id)
    if not provider:
        raise HTTPException(status_code=404, detail="TTS 服务商不存在")

    if provider.get("engine_type") == "browser":
        return {"success": True, "voices": provider.get("voices", []), "message": "浏览器内置无需获取"}

    pconfig = _provider_config(provider)
    voices = await _fetch_provider_voices_from_api(provider, pconfig)

    if not voices:
        return {"success": False, "voices": [], "message": "未获取到音色，请检查 API 配置"}

    return {"success": True, "voices": voices, "message": f"获取到 {len(voices)} 个音色"}


@router.put("/providers/{provider_id}/voices")
async def update_provider_voices(
    provider_id: str,
    voices: list,
    current_user: User = Depends(get_admin),
):
    """更新服务商的音色列表"""
    builtin_ids = [p["id"] for p in BUILTIN_PROVIDERS]
    if provider_id in builtin_ids:
        raise HTTPException(status_code=400, detail="无法修改内置服务商的音色列表")

    config = _get_raw_config()
    custom_providers = config.get("providers", [])
    found = False
    for index, provider in enumerate(custom_providers):
        if provider.get("id") == provider_id:
            custom_providers[index]["voices"] = voices
            found = True
            break

    if not found:
        raise HTTPException(status_code=404, detail=f"Provider '{provider_id}' not found")

    save_tts_config({**config, "providers": custom_providers})
    return {"success": True, "message": f"已更新 {len(voices)} 个音色"}


@router.post("/providers/{provider_id}/prefetch-voices")
async def prefetch_provider_voices(
    provider_id: str,
    request: Optional[TTSPrefetchVoicesRequest] = Body(None),
    preview_text_query: Optional[str] = Query(None, alias="preview_text"),
    current_user: User = Depends(get_admin),
    db: Session = Depends(get_db),
):
    """预下载服务商的所有音色到本地缓存"""
    provider = _get_tts_provider(provider_id)
    if not provider:
        raise HTTPException(status_code=404, detail="TTS 服务商不存在")

    engine_type = provider.get("engine_type", "")
    if engine_type == "browser":
        return {"success": True, "cached": [], "message": "浏览器内置无需预下载"}

    pconfig = _provider_config(provider)

    if engine_type == "xiaomi_mimo":
        api_key = pconfig.get("api_key", "")
        if not api_key:
            raise HTTPException(status_code=400, detail="小米 MIMO API Key 未配置")

    elif engine_type == "custom_api":
        base_url = pconfig.get("base_url", "")
        api_key = pconfig.get("api_key", "")
        if not base_url:
            raise HTTPException(status_code=400, detail="自定义 TTS API 地址未配置")

    voices = provider.get("voices", [])
    if not voices:
        fetched = await _fetch_provider_voices_from_api(provider, pconfig)
        if fetched:
            voices = fetched

    if not voices:
        raise HTTPException(status_code=400, detail="没有可预下载的音色")

    body_preview_text = request.preview_text if request else None
    preview_text = (body_preview_text or preview_text_query or DEFAULT_PREVIEW_TEXT).strip()
    short_text = preview_text[:15] if len(preview_text) > 15 else preview_text
    cached_results = []
    errors = []

    for voice in voices:
        voice_id = voice.get("voice_id", "")
        if not voice_id:
            continue
        try:
            if engine_type == "xiaomi_mimo":
                audio_bytes = await _call_xiaomi_mimo_tts(
                    text=short_text,
                    voice_id=voice_id,
                    api_key=pconfig.get("api_key", ""),
                    model=pconfig.get("model", "mimo-v2.5-tts"),
                )
            elif engine_type == "custom_api":
                audio_bytes = await _call_custom_api_tts(
                    text=short_text,
                    voice_id=voice_id,
                    base_url=pconfig.get("base_url", ""),
                    api_key=pconfig.get("api_key", ""),
                    model=pconfig.get("model", "tts-1"),
                )
            else:
                continue

            audio_b64 = base64.b64encode(audio_bytes).decode("ascii")
            cached_results.append({
                "voice_id": voice_id,
                "gender": voice.get("gender", "female"),
                "description": voice.get("description", voice_id),
                "audio_b64": audio_b64,
                "text": short_text,
            })
        except Exception as e:
            errors.append({"voice_id": voice_id, "error": str(e)})

    return {
        "success": True,
        "cached": cached_results,
        "errors": errors,
        "message": f"预下载完成：{len(cached_results)} 成功，{len(errors)} 失败"
    }


@router.get("/providers/{provider_id}/cached-voices")
async def get_cached_voices(
    provider_id: str,
    current_user: User = Depends(get_current_user),
):
    """获取已预下载的音色缓存列表"""
    provider = _get_tts_provider(provider_id)
    if not provider:
        raise HTTPException(status_code=404, detail="TTS 服务商不存在")

    voices = provider.get("voices", [])
    return {"success": True, "provider_id": provider_id, "voices": voices}


@router.delete("/providers/{provider_id}")
async def delete_custom_provider(provider_id: str, current_user: User = Depends(get_admin)):
    builtin_ids = [p["id"] for p in BUILTIN_PROVIDERS]
    if provider_id in builtin_ids:
        raise HTTPException(status_code=400, detail="Cannot delete builtin provider")

    config = get_tts_config()
    custom_providers = config.get("providers", [])
    updated = [provider for provider in custom_providers if provider.get("id") != provider_id]
    if len(updated) == len(custom_providers):
        raise HTTPException(status_code=404, detail=f"Provider '{provider_id}' not found")

    merged = {**config, "providers": updated}
    if config.get("active_provider_id") == provider_id:
        merged["active_provider_id"] = "browser"
    save_tts_config(merged)
    return {"success": True}


@router.get("/voices")
async def get_available_voices(current_user: User = Depends(get_current_user)):
    config = get_tts_config()
    active_provider_id = config.get("active_provider_id", "browser")
    voices = []
    for provider in _raw_providers():
        if provider.get("id") == active_provider_id:
            voices = provider.get("voices", [])
            break
    if not voices:
        for provider in _raw_providers():
            if provider.get("id") == "browser":
                voices = provider.get("voices", [])
                break
    return {"voices": voices, "provider_id": active_provider_id}


@router.post("/set-voice")
async def set_user_voice(request: SetVoiceRequest, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        config = get_tts_config()
        binding = tts_service.upsert_binding(
            db,
            role="character",
            scope="user",
            user_id=current_user.id,
            provider_id=config.get("active_provider_id", "browser"),
            voice_id=request.voice_id,
            gender=request.gender,
        )
        db.commit()
        return {"success": True, "voice_id": binding.voice_id, "gender": binding.gender}
    except Exception:
        db.rollback()
        logger.exception("Failed to save user TTS voice")
        raise HTTPException(status_code=500, detail="保存语音配置失败")


@router.get("/my-voice")
async def get_my_voice(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    resolved = tts_service.resolve_voice_binding(db=db, user=current_user, role="character")
    return {"voice_id": resolved.get("voice_id", ""), "gender": resolved.get("gender", "female")}


@router.get("/management")
async def get_management(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Return per-user TTS management panel data.

    Despite the name 'management', this endpoint returns the current user's
    TTS bindings, clone samples, and available voices — not admin-only config.
    The global_bindings field exposes admin-set defaults (provider metadata only,
    no API keys). Use /api/tts/admin/default-bindings for admin operations.
    """
    config = get_tts_config()
    tts_service.ensure_global_defaults(db)
    db.commit()
    roles = ["character", "narrator"]
    global_bindings = {
        role: binding_to_public_dict(tts_service.get_explicit_binding(db, None, role, "global"))
        for role in roles
    }
    my_bindings = {role: _current_role_binding_state(db, current_user, role) for role in roles}
    samples = db.query(TTSCloneSample).filter(TTSCloneSample.user_id == current_user.id).order_by(TTSCloneSample.created_at.desc()).all()
    voices_data = await get_available_voices(current_user)
    return {
        "enabled": config.get("enabled", True),
        "active_provider_id": config.get("active_provider_id", "browser"),
        "segmented_playback": config.get("segmented_playback", False),
        "providers": _public_providers_for_user(current_user),
        "voices": voices_data.get("voices", []),
        "global_bindings": global_bindings,
        "my_bindings": my_bindings,
        "clone_samples": [_clone_sample_to_dict(sample, db) for sample in samples],
        "can_admin": _is_admin(current_user),
    }


@router.put("/admin/default-bindings")
async def save_admin_default_bindings(
    request: BindingsUpdateRequest,
    http_request: Request,
    current_user: User = Depends(get_admin),
    db: Session = Depends(get_db),
):
    try:
        return {"success": True, "bindings": _apply_bindings_update(db, current_user, request, scope="global", allow_clone=False)}
    except ValueError as e:
        db.rollback()
        _rid = getattr(http_request.state, "request_id", "unknown")
        logger.warning("TTS default bindings update failed: %s request_id=%s", e, _rid)
        raise HTTPException(status_code=400, detail=f"语音绑定配置无效 (request_id: {_rid})") from e


@router.get("/my/bindings")
async def get_my_bindings(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return {"bindings": {role: _current_role_binding_state(db, current_user, role) for role in ["character", "narrator"]}}


@router.put("/my/bindings")
async def save_my_bindings(
    request: BindingsUpdateRequest,
    http_request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    try:
        return {"success": True, "bindings": _apply_bindings_update(db, current_user, request, scope="user", target_user_id=current_user.id)}
    except ValueError as e:
        db.rollback()
        _rid = getattr(http_request.state, "request_id", "unknown")
        logger.warning("TTS user bindings update failed: %s request_id=%s", e, _rid)
        raise HTTPException(status_code=400, detail=f"语音绑定配置无效 (request_id: {_rid})") from e


@router.get("/characters/{character_id}/voice-bindings")
async def get_character_voice_bindings(
    character_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _validate_character_owner(db, current_user, character_id)
    return {"bindings": {role: _current_role_binding_state(db, current_user, role, character_id) for role in ["character", "narrator"]}}


@router.put("/characters/{character_id}/voice-bindings")
async def save_character_voice_bindings(
    character_id: str,
    request: BindingsUpdateRequest,
    http_request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _validate_character_owner(db, current_user, character_id)
    try:
        return {
            "success": True,
            "bindings": _apply_bindings_update(
                db,
                current_user,
                request,
                scope="character",
                target_user_id=current_user.id,
                character_id=character_id,
            ),
        }
    except ValueError as e:
        db.rollback()
        _rid = getattr(http_request.state, "request_id", "unknown")
        logger.warning("TTS character bindings update failed: %s request_id=%s", e, _rid)
        raise HTTPException(status_code=400, detail=f"语音绑定配置无效 (request_id: {_rid})") from e


@router.get("/clone-samples")
async def list_clone_samples(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    samples = db.query(TTSCloneSample).filter(TTSCloneSample.user_id == current_user.id).order_by(TTSCloneSample.created_at.desc()).all()
    return {"samples": [_clone_sample_to_dict(sample, db) for sample in samples]}


@router.post("/clone-samples")
async def upload_clone_sample(
    file: UploadFile = File(...),
    name: str = Form(""),
    provider_id: str = Form("xiaomi_mimo"),
    source_voice_id: Optional[str] = Form(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    clone_provider_id = provider_id or "xiaomi_mimo"
    if not _get_tts_provider(clone_provider_id):
        raise HTTPException(status_code=400, detail="TTS 服务商不存在")
    if not _provider_supports_clone(clone_provider_id):
        raise HTTPException(status_code=400, detail="音色克隆当前仅支持小米 MIMO 服务商")

    original_name = file.filename or "voice-sample"
    extension = os.path.splitext(original_name)[1].lower()
    if extension not in ALLOWED_AUDIO_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"不支持的音频格式: {extension or '[none]'}")

    content = await _read_upload_with_limit(file, MAX_CLONE_SAMPLE_BYTES)
    if not content:
        raise HTTPException(status_code=400, detail="空音频文件不可上传")
    signatures = AUDIO_SIGNATURES.get(extension, ())
    if signatures and not any(content.startswith(signature) for signature in signatures):
        raise HTTPException(status_code=400, detail="音频文件内容与扩展名不匹配")

    mime_type = file.content_type or mimetypes.guess_type(original_name)[0] or "application/octet-stream"
    if not (mime_type.startswith("audio/") or mime_type in {"application/ogg", "video/mp4"}):
        raise HTTPException(status_code=400, detail="文件 MIME 类型不是音频")

    safe_filename = normalize_upload_filename(original_name)
    storage_dir = os.path.realpath(os.path.join(settings.UPLOAD_DIR, str(current_user.id), "tts_clones"))
    os.makedirs(storage_dir, exist_ok=True)
    stored_filename = f"{uuid.uuid4().hex}_{safe_filename}"
    file_path = os.path.realpath(os.path.join(storage_dir, stored_filename))
    if not (file_path == storage_dir or file_path.startswith(storage_dir + os.sep)):
        raise HTTPException(status_code=400, detail="Invalid upload path")

    with open(file_path, "wb") as output:
        output.write(content)

    sample = TTSCloneSample(
        user_id=current_user.id,
        name=name.strip() or os.path.splitext(original_name)[0],
        provider_id=clone_provider_id,
        source_voice_id=source_voice_id,
        filename=safe_filename,
        file_path=file_path,
        file_size=len(content),
        mime_type=mime_type,
    )
    db.add(sample)
    db.commit()
    db.refresh(sample)
    return {"success": True, "sample": _clone_sample_to_dict(sample, db)}


@router.delete("/clone-samples/{sample_id}")
async def delete_clone_sample(sample_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    sample = db.query(TTSCloneSample).filter(TTSCloneSample.id == sample_id, TTSCloneSample.user_id == current_user.id).first()
    if not sample:
        raise HTTPException(status_code=404, detail="声音样本不存在")
    usage_count = db.query(TTSVoiceBinding).filter(TTSVoiceBinding.clone_sample_id == sample.id).count()
    if usage_count > 0:
        raise HTTPException(status_code=400, detail="该声音样本仍被语音绑定使用，请先解除绑定")
    file_path = sample.file_path
    db.delete(sample)
    db.commit()
    if file_path and os.path.exists(file_path):
        try:
            os.remove(file_path)
        except Exception:
            logger.exception("Failed to delete TTS clone sample file")
    return {"success": True}


@router.post("/preview/metadata")
async def preview_metadata(
    request: TTSPreviewRequest,
    http_request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    text = clean_text_for_tts(request.text or DEFAULT_PREVIEW_TEXT)
    if not text:
        raise HTTPException(status_code=400, detail="没有可试听的文本")
    try:
        _validate_synthesis_request_character(db, current_user, request.character_id)
        _validate_override(db, current_user, request.binding_override)
        result = tts_service.synthesize(
            text=text,
            voice_description=request.voice_description,
            db=db,
            user=current_user,
            role=request.role,
            character_id=request.character_id,
            binding_override=request.binding_override,
        )
        return {"success": True, **result}
    except ValueError as e:
        _rid = getattr(http_request.state, "request_id", "unknown")
        logger.warning("TTS preview metadata validation failed: %s request_id=%s", e, _rid)
        raise HTTPException(status_code=400, detail=f"语音试听请求无效 (request_id: {_rid})") from e


@router.post("/preview/audio")
async def preview_audio(
    request: TTSPreviewRequest,
    http_request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    enforce_rate_limit(
        http_request,
        "tts:preview_audio",
        TTS_AUDIO_RATE_LIMIT_REQUESTS,
        TTS_AUDIO_RATE_LIMIT_WINDOW_SECONDS,
    )
    text = clean_text_for_tts(request.text or DEFAULT_PREVIEW_TEXT)
    if not text:
        raise HTTPException(status_code=400, detail="没有可试听的文本")
    try:
        _validate_synthesis_request_character(db, current_user, request.character_id)
        _validate_override(db, current_user, request.binding_override)
        content_type, audio_bytes = await tts_service.synthesize_audio(
            text=text,
            voice_description=request.voice_description,
            db=db,
            user=current_user,
            role=request.role,
            character_id=request.character_id,
            binding_override=request.binding_override,
        )
        return Response(
            content=audio_bytes,
            media_type=content_type,
            headers={"Content-Disposition": "inline; filename=tts_preview.wav", "Cache-Control": "no-cache"},
        )
    except ValueError as e:
        _rid = getattr(http_request.state, "request_id", "unknown")
        logger.warning("TTS preview audio validation failed: %s request_id=%s", e, _rid)
        raise HTTPException(status_code=400, detail=f"语音试听请求无效 (request_id: {_rid})") from e
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=502, detail=f"TTS provider error: {e.response.status_code}")
