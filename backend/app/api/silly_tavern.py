import base64
import binascii
import html
import io
import json
import logging
import os
import re
import time
import uuid
from datetime import datetime, timezone
from typing import Any, AsyncGenerator, Optional
from urllib.parse import quote, urljoin

import httpx
import jwt
from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import JSONResponse, RedirectResponse, Response, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, or_
from sqlalchemy.orm import Session, aliased, selectinload

from ..core import get_db, settings as app_settings
from ..core.cache import invalidate_user_cache
from ..core.security import sign_service_user_id
from ..core.token_blacklist import is_blacklisted
from ..character_card import (
    convert_character_to_chara_card,
    create_png_with_chara_card,
    extract_chara_card_from_png,
)
from ..models import (
    Character,
    CharacterChatMessage,
    CharacterChatSession,
    CharacterChatSessionBranch,
    ChatVariable,
    GenerationPreset,
    GlobalVariable,
    GroupChat,
    GroupChatSession,
    SystemSetting,
    User,
    UserSetting,
    WorldBook,
    WorldBookStage,
)
from ..services.character_import_service import CharacterImportService
from ..services.inference_dispatcher import ensure_model_available, stream_text_completion
from ..services.local_model_registry import list_enabled_chat_models
from ..services.provider_registry import get_providers
from ..services.stream_builder import StreamResult, stream_chat_deltas
from ..services.image_generation_service import generate_image, image_result_to_dict
from ..services.worldbook_import_utils import (
    entry_is_disabled,
    entry_keys,
    entry_secondary_keys,
)
from ..services.tts_service import clean_text_for_tts, tts_service
from ..services.websocket_manager import ws_manager

router = APIRouter(tags=["silly-tavern"])

_AVATAR_PREFIX = "palink-"
_AVATAR_SUFFIX = ".png"
_SESSION_PREFIX = "palink-session-"
_JSONL_SUFFIX = ".jsonl"
_ST_NATIVE_SESSION_COOKIE = "palink_st_native"
_ST_NATIVE_SESSION_TTL_SECONDS = 60 * 60 * 12
_TRANSPARENT_BACKGROUND_URL = (
    "url('data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
    "')"
)


class AvatarRequest(BaseModel):
    avatar_url: Optional[str] = None
    avatar: Optional[str] = None


class ChatGetRequest(AvatarRequest):
    ch_name: Optional[str] = None
    file_name: Optional[str] = None
    file: Optional[str] = None
    chatfile: Optional[str] = None


class ChatSaveRequest(ChatGetRequest):
    # ST 1.18.0 sends chat as a JSON-stringified array (string), while
    # Palink-native clients send a real array. Accept both.
    chat: Any = Field(default_factory=list)
    force: bool = False


class ChatSearchRequest(AvatarRequest):
    query: Optional[str] = ""
    group_id: Optional[str] = None


class ChatDeleteRequest(AvatarRequest):
    chatfile: str


class ChatRenameRequest(AvatarRequest):
    original_file: Optional[str] = None
    old_file_name: Optional[str] = None
    renamed_file: Optional[str] = None
    new_file_name: Optional[str] = None


class ChatGenerationRequest(AvatarRequest):
    # ST-compatible continue/regenerate/swipe request. Supports both
    # avatar_url (ST-style) and character_name (Palink-native) for character
    # resolution. file_name resolves the chat session.
    character_name: Optional[str] = None
    file_name: Optional[str] = None
    chat: Any = Field(default_factory=list)
    model: str = "local:test-model"
    temperature: float = 0.7
    top_p: Optional[float] = None
    max_tokens: int = 2048


def _request_avatar(req: AvatarRequest) -> Optional[str]:
    return req.avatar_url or req.avatar


def _request_file_name(req: ChatGetRequest) -> Optional[str]:
    return req.file_name or req.file or req.chatfile


def _get_or_create_user_setting(user: User, db: Session) -> UserSetting:
    setting = db.query(UserSetting).filter(UserSetting.user_id == user.id).first()
    if not setting:
        setting = UserSetting(user_id=user.id)
        db.add(setting)
        db.flush()
    return setting


def _safe_json_loads(raw: Any, fallback: Any) -> Any:
    if raw is None or raw == "":
        return fallback
    if isinstance(raw, (dict, list)):
        return raw
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError):
        return fallback
    return parsed if parsed is not None else fallback


def _extract_themes_from_settings(settings_data: dict[str, Any]) -> list:
    """Fix-7: 从 extension_settings.themes 读取主题列表。

    ST 1.18.0 期望 /api/settings/get 返回 themes 数组，
    之前硬编码为 []，导致 ST 主题扩展无法加载用户保存的主题。
    """
    if not isinstance(settings_data, dict):
        return []
    ext = settings_data.get("extension_settings")
    if not isinstance(ext, dict):
        return []
    themes = ext.get("themes")
    return themes if isinstance(themes, list) else []


def _get_global_world_names(db: Session, user: User) -> list[str]:
    """Fix-10: 从 Palink DB 读取全局世界书名称列表。

    ST 1.18.0 期望 /api/settings/get 返回 world_names 数组，
    之前硬编码为 []，导致 ST 世界书扩展无法加载全局世界书列表。
    """
    try:
        worldbooks = (
            db.query(WorldBook)
            .filter(WorldBook.user_id == user.id, WorldBook.character_id.is_(None))
            .order_by(WorldBook.name)
            .all()
        )
        return [wb.name for wb in worldbooks if wb.name]
    except Exception:
        return []


def _extract_quick_reply_presets(settings_data: dict[str, Any]) -> list:
    """Fix-6: 从 extension_settings.quickReplyV2.sets 读取 Quick Reply presets。

    ST 1.18.0 期望 /api/settings/get 返回 quickReplyPresets 数组，
    之前缺失，导致 ST Quick Reply 扩展无法加载用户保存的 sets。
    """
    if not isinstance(settings_data, dict):
        return []
    ext = settings_data.get("extension_settings")
    if not isinstance(ext, dict):
        return []
    # 优先 V2 结构
    qrv2 = ext.get("quickReplyV2")
    if isinstance(qrv2, dict):
        sets = qrv2.get("sets")
        if isinstance(sets, list):
            return sets
    # 回退 V1 结构
    qrv1 = ext.get("quickReply")
    if isinstance(qrv1, dict):
        sets = qrv1.get("sets")
        if isinstance(sets, list):
            return sets
    return []


def _sync_author_note_from_extension_settings(payload_data: dict[str, Any], setting: UserSetting) -> None:
    """Fix-8: 从 extension_settings.note 同步到 UserSetting（Author's Note）。

    ST iframe 通过 /api/settings/save 保存的 extension_settings.note 字段
    需同步到 UserSetting 表，提示词装配从 UserSetting.author_note 读取。
    """
    if not isinstance(payload_data, dict):
        return
    ext = payload_data.get("extension_settings")
    if not isinstance(ext, dict):
        return
    note = ext.get("note")
    if not isinstance(note, dict):
        return
    if "text" in note:
        setting.author_note = str(note.get("text") or "")
    if "position" in note:
        try:
            setting.author_note_position = int(note["position"])
        except (TypeError, ValueError):
            pass
    if "depth" in note:
        try:
            setting.author_note_depth = int(note["depth"])
        except (TypeError, ValueError):
            pass
    if "interval" in note:
        try:
            setting.author_note_frequency = int(note["interval"])
        except (TypeError, ValueError):
            pass


def _sync_jailbreak_from_settings(payload_data: dict[str, Any], setting: UserSetting) -> None:
    """D1 修复: 从 power_user.jailbreak / oai_settings 同步到 UserSetting.jailbreak。

    ST iframe 通过 /api/settings/save 保存的用户全局 jailbreak（ST 主界面 Jailbreak 框）
    需同步到 UserSetting.jailbreak 字段，st-compat 提示词装配从该字段读取。
    优先级: power_user.jailbreak → oai_settings.jailbreak。
    """
    if not isinstance(payload_data, dict):
        return
    jailbreak_value = None
    # 优先从 power_user.jailbreak 读取
    power_user_data = payload_data.get("power_user")
    if isinstance(power_user_data, dict):
        jb = power_user_data.get("jailbreak")
        if isinstance(jb, str) and jb.strip():
            jailbreak_value = jb
    # 回退到 oai_settings.jailbreak
    if jailbreak_value is None:
        oai = payload_data.get("oai_settings")
        if isinstance(oai, dict):
            jb = oai.get("jailbreak")
            if isinstance(jb, str) and jb.strip():
                jailbreak_value = jb
    if jailbreak_value is not None:
        setting.jailbreak = jailbreak_value


def _sync_personas_from_power_user(
    payload_data: dict[str, Any],
    user: User,
    db: Session,
    setting: UserSetting,
) -> None:
    """Fix-9: 从 power_user.personas 同步到 Persona 表。

    ST iframe 通过 /api/settings/save 保存的 power_user.personas 和
    persona_descriptions 需同步到 Persona 表，提示词装配从 Persona 表读取。
    """
    if not isinstance(payload_data, dict):
        return
    power_user_data = payload_data.get("power_user")
    if not isinstance(power_user_data, dict):
        return

    # 延迟导入避免循环
    from ..models import Persona

    personas = power_user_data.get("personas")
    persona_descriptions = power_user_data.get("persona_descriptions")

    if isinstance(personas, dict):
        desc_map = persona_descriptions if isinstance(persona_descriptions, dict) else {}
        for persona_name, persona_desc in personas.items():
            if not isinstance(persona_name, str) or not persona_name.strip():
                continue
            desc_text = ""
            if isinstance(desc_map, dict):
                desc_val = desc_map.get(persona_name)
                if isinstance(desc_val, str):
                    desc_text = desc_val

            existing = db.query(Persona).filter(
                Persona.user_id == user.id,
                Persona.name == persona_name,
            ).first()

            if existing:
                if desc_text:
                    existing.description = desc_text
            else:
                new_persona = Persona(
                    user_id=user.id,
                    name=persona_name,
                    description=desc_text,
                    persona_show=True,
                    persona_description_position=0,
                )
                db.add(new_persona)

    # 同步活跃 persona
    active_persona_name = power_user_data.get("persona_description")
    if isinstance(active_persona_name, str) and active_persona_name:
        active = db.query(Persona).filter(
            Persona.user_id == user.id,
            Persona.name == active_persona_name,
        ).first()
        if active:
            setting.active_persona_id = active.id

    # 同步 persona_description_position（全局设置）
    pos = power_user_data.get("persona_description_position")
    if pos is not None:
        try:
            pos_int = int(pos)
            # 应用到所有 personas（ST 行为：全局位置设置）
            user_personas = db.query(Persona).filter(Persona.user_id == user.id).all()
            for p in user_personas:
                p.persona_description_position = pos_int
        except (TypeError, ValueError):
            pass

    # 同步 persona_show
    show = power_user_data.get("persona_show_user")
    if show is not None:
        try:
            show_bool = bool(show)
            user_personas = db.query(Persona).filter(Persona.user_id == user.id).all()
            for p in user_personas:
                p.persona_show = show_bool
        except (TypeError, ValueError):
            pass


def _sync_themes_from_extension_settings(
    payload_data: dict[str, Any],
    user: User,
    db: Session,
) -> None:
    """Fix-7: 从 extension_settings.themes 同步到 Theme 表。

    ST iframe 通过 /api/settings/save 保存的 extension_settings.themes 数组
    需同步到 Theme 表，使 Palink 原生主题管理 UI 能读取这些主题。

    策略：按 (user_id, name) upsert。仅更新用户自定义主题，不影响系统预置
    主题 (user_id is NULL)。不删除 Theme 表中 payload 未包含的主题，避免
    误删 Palink 原生 UI 创建的主题。
    """
    if not isinstance(payload_data, dict):
        return
    ext = payload_data.get("extension_settings")
    if not isinstance(ext, dict):
        return
    themes = ext.get("themes")
    if not isinstance(themes, list):
        return
    # 延迟导入避免循环
    from ..models import Theme

    for theme_obj in themes:
        if not isinstance(theme_obj, dict):
            continue
        name = str(theme_obj.get("name") or "").strip()
        if not name:
            continue
        # 构造 config：theme_obj 中除 name 外的全部字段（保留 ST 主题结构）
        config = {k: v for k, v in theme_obj.items() if k != "name"}
        config_json = _json_dumps(config)
        existing = db.query(Theme).filter(
            Theme.user_id == user.id,
            Theme.name == name,
        ).first()
        if existing:
            existing.config_json = config_json
        else:
            new_theme = Theme(
                user_id=user.id,
                name=name,
                config_json=config_json,
                is_active=False,
            )
            db.add(new_theme)


def _parse_theme_config_json(raw: Optional[str]) -> dict:
    """解析 Theme.config_json 字段为 dict。"""
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
    except (json.JSONDecodeError, TypeError):
        return {}


def _theme_row_to_st_dict(t: Any) -> dict[str, Any]:
    """将 Theme 表行转为 ST 主题对象（name + config 中保存的全部字段）。"""
    theme_obj: dict[str, Any] = {"name": t.name}
    theme_obj.update(_parse_theme_config_json(t.config_json))
    return theme_obj


def _backfill_themes_from_db(
    settings_data: dict[str, Any],
    db: Session,
    user: User,
) -> None:
    """从 Theme 表回填 extension_settings.themes。

    当 extension_settings.themes 缺失或为空时，从 Theme 表读取用户可见的
    主题（用户自定义 + 系统预置），转为 ST 主题对象填入 extension_settings.themes，
    使 Palink 原生 UI 创建的主题在 ST sidecar 中可见。blob 中已有 themes
    时优先使用 blob 数据，不覆盖。
    """
    if not isinstance(settings_data, dict):
        return
    ext = settings_data.get("extension_settings")
    if not isinstance(ext, dict):
        ext = {}
        settings_data["extension_settings"] = ext
    # blob 中已有非空 themes 时不覆盖
    existing_themes = ext.get("themes")
    if isinstance(existing_themes, list) and existing_themes:
        return
    try:
        from ..models import Theme
        db_themes = (
            db.query(Theme)
            .filter(
                (Theme.user_id.is_(None)) | (Theme.user_id == user.id)
            )
            .order_by(Theme.user_id.asc(), Theme.id)
            .all()
        )
        if not db_themes:
            return
        ext["themes"] = [_theme_row_to_st_dict(t) for t in db_themes]
    except Exception:
        logging.getLogger(__name__).debug("Failed to backfill themes from DB", exc_info=True)


def _backfill_author_note_to_extension_settings(
    settings_data: dict[str, Any],
    setting: UserSetting,
) -> None:
    """Fix-8: 从 UserSetting 回填 extension_settings.note。

    当 extension_settings.note 缺失或为空时，从 UserSetting.author_note 等
    字段构造 note 对象填入 extension_settings.note，使 Palink 原生 UI 设置的
    Author Note 在 ST sidecar 中可见。blob 中已有 note 时优先使用 blob 数据。
    """
    if not isinstance(settings_data, dict):
        return
    ext = settings_data.get("extension_settings")
    if not isinstance(ext, dict):
        ext = {}
        settings_data["extension_settings"] = ext
    existing_note = ext.get("note")
    if isinstance(existing_note, dict) and existing_note:
        return
    # 没有 author_note 内容时不填入空 note，避免覆盖 ST 扩展的默认行为
    if not setting.author_note:
        return
    ext["note"] = {
        "text": str(setting.author_note or ""),
        "position": int(setting.author_note_position if setting.author_note_position is not None else 1),
        "depth": int(setting.author_note_depth if setting.author_note_depth is not None else 4),
        "interval": int(setting.author_note_frequency if setting.author_note_frequency is not None else 0),
    }


def _backfill_personas_to_power_user(
    settings_data: dict[str, Any],
    db: Session,
    user: User,
    setting: UserSetting,
) -> None:
    """Fix-9: 从 Persona 表回填 power_user.personas / persona_descriptions /
    persona_description（活跃 persona 名称）。

    当 power_user.personas 缺失或为空时，从 Persona 表读取当前用户的
    personas 构造 ST 兼容结构填入 power_user。同时若未设置 persona_description
    （活跃 persona 名称），从 UserSetting.active_persona_id 解析填入。
    """
    if not isinstance(settings_data, dict):
        return
    power_user_data = settings_data.get("power_user")
    if not isinstance(power_user_data, dict):
        power_user_data = {}
        settings_data["power_user"] = power_user_data
    # blob 中已有 personas 时不覆盖
    existing_personas = power_user_data.get("personas")
    if isinstance(existing_personas, dict) and existing_personas:
        return
    try:
        from ..models import Persona
        db_personas = (
            db.query(Persona)
            .filter(Persona.user_id == user.id)
            .order_by(Persona.created_at.asc())
            .all()
        )
        if not db_personas:
            return
        # ST 1.18.0 power_user.personas: {name: name}（键为 persona 名称）
        # persona_descriptions: {name: description_text}
        personas_map: dict[str, str] = {}
        descriptions_map: dict[str, str] = {}
        for p in db_personas:
            personas_map[p.name] = p.name
            descriptions_map[p.name] = p.description or ""
        power_user_data["personas"] = personas_map
        power_user_data["persona_descriptions"] = descriptions_map
        # 活跃 persona 名称（ST 字段 persona_description）
        if not isinstance(power_user_data.get("persona_description"), str) or not power_user_data.get("persona_description"):
            active_id = setting.active_persona_id
            if active_id:
                active = db.query(Persona).filter(
                    Persona.id == active_id,
                    Persona.user_id == user.id,
                ).first()
                if active:
                    power_user_data["persona_description"] = active.name
                    if "persona_description_position" not in power_user_data:
                        power_user_data["persona_description_position"] = int(
                            active.persona_description_position or 0
                        )
                    if "persona_show_user" not in power_user_data:
                        power_user_data["persona_show_user"] = bool(active.persona_show)
    except Exception:
        logging.getLogger(__name__).debug("Failed to backfill personas from DB", exc_info=True)


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


# [MODE-SEALED] 2026-08-24 用户拍板：除 palink-native 外的模式运行时封存不可达。
# sidecar mode 查询出口与 users.py 同步重定向（iframe 即使存在也只会被告知
# palink-native）。解封 = 移除守卫并恢复合法集判定。
_SEALED_ST_MODES = {"compat", "st-compat", "st-native"}
_LEGAL_ST_MODES = {"compat", "st-compat", "st-native", "palink-native"}  # 解封后恢复使用


def _normalize_silly_tavern_mode(mode: Optional[str]) -> str:
    raw = str(mode or "palink-native").strip() or "palink-native"
    aliases = {
        "iframe": "compat",
        "native": "palink-native",
    }
    normalized = aliases.get(raw, raw)
    if normalized in _LEGAL_ST_MODES and normalized not in _SEALED_ST_MODES:
        return normalized
    return "palink-native"


def _st_native_public_url(request: Request) -> str:
    configured = str(app_settings.ST_NATIVE_URL or "").strip()
    if configured:
        return configured.rstrip("/")

    public_port = int(getattr(app_settings, "ST_NATIVE_PUBLIC_PORT", 8000) or 8000)
    forwarded_proto = request.headers.get("X-Forwarded-Proto")
    scheme = forwarded_proto.split(",", 1)[0].strip() if forwarded_proto else request.url.scheme
    forwarded_host = request.headers.get("X-Forwarded-Host")
    host = forwarded_host.split(",", 1)[0].strip() if forwarded_host else request.url.hostname or "localhost"
    if ":" in host and not host.startswith("["):
        host = host.split(":", 1)[0]

    default_port = 443 if scheme == "https" else 80
    port_suffix = "" if public_port == default_port else f":{public_port}"
    return f"{scheme}://{host}{port_suffix}".rstrip("/")


def _token_from_request(request: Request, token: Optional[str] = None) -> Optional[str]:
    if token:
        return token
    proxy_token = request.headers.get("X-Palink-Token") or request.headers.get("X-Palink-Auth-Token")
    if proxy_token:
        return proxy_token.strip()
    auth_header = request.headers.get("Authorization") or ""
    if auth_header.lower().startswith("bearer "):
        return auth_header.split(" ", 1)[1].strip()
    # [N8-c 终态适配] Bearer 退役后 Palink 前端为纯 Cookie 认证——加
    # palink_session Cookie 兜底（N8-a 登录时下发，sub=username 与本函数
    # 解码语义一致，jti 黑名单检查在 _user_from_request_token 内生效）。
    # 显式携带但无效的 Bearer 仍不回退（凭据语义明确失败），与主依赖
    # get_current_user 的双轨语义对齐。覆盖 get_st_current_user 全部
    # 60+ 端点（导入/导出/tokenizer/merge-attributes 等）。
    return request.cookies.get("palink_session") or None


def _user_from_request_token(request: Request, db: Session, token: Optional[str] = None) -> User:
    auth_token = _token_from_request(request, token)
    if not auth_token:
        raise HTTPException(status_code=401, detail="Authentication required")
    try:
        payload = jwt.decode(auth_token, app_settings.SECRET_KEY, algorithms=["HS256"], options={"verify_signature": True})
        username = payload.get("sub")
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail="Invalid or expired token") from exc
    jti = payload.get("jti")
    if jti and is_blacklisted(jti):
        raise HTTPException(status_code=401, detail="Token has been revoked")
    if not username:
        raise HTTPException(status_code=401, detail="Invalid token")
    user = db.query(User).filter(User.username == username).first()
    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    return user


def _optional_user_from_request(request: Request, db: Session, token: Optional[str] = None) -> Optional[User]:
    """解析用户；匿名（无 cookie/token）时返回 None 而非抛 401，用于公开头像等无需鉴权的资源。"""
    try:
        return _user_from_st_native_session(request, db) or _user_from_request_token(request, db, token)
    except HTTPException:
        return None


def _create_st_native_session(
    user: User,
    character_id: Optional[str] = None,
    session_id: Optional[str] = None,
    branch_id: Optional[str] = None,
    model: Optional[str] = None,
) -> str:
    now = int(time.time())
    payload = {
        "sub": str(user.id),
        "username": user.username,
        "scope": "st-native",
        "iat": now,
        "exp": now + _ST_NATIVE_SESSION_TTL_SECONDS,
    }
    if character_id:
        payload["character_id"] = str(character_id)
    if session_id:
        payload["session_id"] = str(session_id)
    if branch_id:
        payload["branch_id"] = str(branch_id)
    if model:
        payload["model"] = str(model)
    return jwt.encode(payload, app_settings.SECRET_KEY, algorithm="HS256")


def _is_secure_request(request: Request) -> bool:
    forwarded_proto = request.headers.get("X-Forwarded-Proto") or ""
    proto = forwarded_proto.split(",", 1)[0].strip() if forwarded_proto else request.url.scheme
    return proto == "https"


def _set_st_native_session_cookie(
    response: Response,
    request: Request,
    user: User,
    character_id: Optional[str] = None,
    session_id: Optional[str] = None,
    branch_id: Optional[str] = None,
    model: Optional[str] = None,
) -> None:
    response.set_cookie(
        key=_ST_NATIVE_SESSION_COOKIE,
        value=_create_st_native_session(user, character_id, session_id, branch_id, model),
        max_age=_ST_NATIVE_SESSION_TTL_SECONDS,
        httponly=True,
        secure=_is_secure_request(request),
        samesite="lax",
        path="/",
    )


def _user_from_st_native_session(request: Request, db: Session) -> Optional[User]:
    raw = (
        request.cookies.get(_ST_NATIVE_SESSION_COOKIE)
        or request.headers.get("X-Palink-ST-Session")
        or ""
    ).strip()
    if not raw:
        return None
    try:
        payload = jwt.decode(raw, app_settings.SECRET_KEY, algorithms=["HS256"], options={"verify_signature": True})
    except jwt.PyJWTError:
        return None
    if payload.get("scope") != "st-native":
        return None
    try:
        user_id = int(payload.get("sub") or 0)
    except (TypeError, ValueError):
        return None
    user = db.query(User).filter(User.id == user_id).first()
    if not user or not user.is_active:
        return None
    return user


async def get_st_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    session_user = _user_from_st_native_session(request, db)
    if session_user:
        return session_user
    return _user_from_request_token(request, db)


def _st_native_session_payload(request: Request) -> dict[str, Any]:
    raw = (
        request.cookies.get(_ST_NATIVE_SESSION_COOKIE)
        or request.headers.get("X-Palink-ST-Session")
        or ""
    ).strip()
    if not raw:
        return {}
    try:
        payload = jwt.decode(raw, app_settings.SECRET_KEY, algorithms=["HS256"], options={"verify_signature": True})
    except jwt.PyJWTError:
        return {}
    return payload if payload.get("scope") == "st-native" else {}


def _st_native_auth_response(user: User, session_payload: Optional[dict[str, Any]] = None) -> Response:
    response = Response(status_code=204)
    response.headers["X-Palink-User-Id"] = str(user.id)
    # [N-6] 与 X-Palink-User-Id 配套的 HMAC 签名头：nginx auth_request_set
    # 捕获后随代理请求下发，openai_compat 侧按 verify_service_user_id 校验。
    if str(app_settings.ST_NATIVE_SERVICE_KEY or "").strip():
        response.headers["X-Palink-User-Sig"] = sign_service_user_id(user.id)
    response.headers["X-Palink-Username"] = quote(str(user.username or ""), safe="")
    response.headers["X-Palink-Is-Admin"] = "1" if str(user.role or "").lower() == "admin" else "0"
    payload = session_payload or {}
    header_map = {
        "character_id": "X-Palink-Character-Id",
        "session_id": "X-Palink-Session-Id",
        "branch_id": "X-Palink-Branch-Id",
        "model": "X-Palink-Model",
    }
    for key, header in header_map.items():
        value = str(payload.get(key) or "").strip()
        if value:
            response.headers[header] = quote(value, safe="")
    return response


def _svg_avatar(label: str = "AI") -> str:
    initials = "".join(part[:1] for part in re.split(r"\s+", str(label or "AI").strip()) if part)[:2].upper() or "AI"
    return (
        "<svg xmlns='http://www.w3.org/2000/svg' width='512' height='512' viewBox='0 0 512 512'>"
        "<defs><linearGradient id='g' x1='0' x2='1' y1='0' y2='1'>"
        "<stop offset='0' stop-color='#2563eb'/><stop offset='1' stop-color='#f97316'/>"
        "</linearGradient></defs>"
        "<rect width='512' height='512' fill='url(#g)'/>"
        "<circle cx='384' cy='112' r='84' fill='rgba(255,255,255,.18)'/>"
        f"<text x='256' y='292' text-anchor='middle' font-family='Arial, sans-serif' "
        f"font-size='148' font-weight='700' fill='white'>{html.escape(initials)}</text>"
        "</svg>"
    )


def _avatar_response(character: Character, token: Optional[str] = None) -> Response:
    avatar = (character.avatar or "").strip()
    if avatar.startswith("data:image/"):
        match = re.match(r"^data:(image/[a-zA-Z0-9.+-]+);base64,(.*)$", avatar, flags=re.DOTALL)
        if match:
            try:
                return Response(content=base64.b64decode(match.group(2)), media_type=match.group(1))
            except (ValueError, binascii.Error):
                pass
    if avatar.startswith("http://") or avatar.startswith("https://"):
        return RedirectResponse(avatar)
    if avatar.startswith("/api/uploads/") or avatar.startswith("/uploads/"):
        sep = "&" if "?" in avatar else "?"
        return RedirectResponse(f"{avatar}{sep}token={token}" if token else avatar)
    return Response(content=_svg_avatar(character.name), media_type="image/svg+xml")


def _public_models() -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for provider in get_providers():
        if provider.get("is_active") is not None and not provider.get("is_active"):
            continue
        for model in provider.get("models", []):
            if isinstance(model, dict):
                model_id = str(model.get("id") or "")
                display_name = model.get("name") or model.get("alias") or model_id
                context_length = model.get("context_length") or 4096
            else:
                model_id = str(model or "")
                display_name = model_id
                context_length = 4096
            if not model_id or model_id in seen:
                continue
            seen.add(model_id)
            result.append({
                "id": model_id,
                "name": display_name,
                "context_length": context_length,
            })
    for model in list_enabled_chat_models():
        model_id = str(model.get("id") or "")
        if not model_id or model_id in seen:
            continue
        seen.add(model_id)
        result.append({
            "id": model_id,
            "name": model.get("name") or model_id,
            "context_length": model.get("context_length") or 4096,
        })
    return result


def _system_default_character_chat_model(db: Session) -> str:
    setting = db.query(SystemSetting).filter(SystemSetting.key == "default_model_config").first()
    if not setting or not setting.value:
        return ""
    try:
        payload = json.loads(setting.value)
    except (TypeError, ValueError, json.JSONDecodeError):
        return ""
    if not isinstance(payload, dict):
        return ""
    return str(payload.get("default_character_chat_model") or "").strip()


def _default_model_id() -> str:
    return _default_model_id_for_db(None)


def _default_model_id_for_db(db: Optional[Session]) -> str:
    preferred = _system_default_character_chat_model(db) if db is not None else ""
    models = _public_models()
    available_ids = {str(model.get("id") or "") for model in models}
    if preferred and preferred in available_ids:
        return preferred
    models = _public_models()
    return str(models[0]["id"]) if models else "palink-default"


def _model_from_request(request: Request, payload: Optional[dict[str, Any]] = None, db: Optional[Session] = None) -> str:
    requested = str(
        request.headers.get("X-Palink-Model")
        or request.headers.get("X-Palink-Selected-Model")
        or ""
    ).strip()
    if not requested and isinstance(payload, dict):
        requested = str(payload.get("model") or payload.get("custom_model") or payload.get("openai_model") or "").strip()
    return requested or _default_model_id_for_db(db)


def _model_context_length(model_id: str) -> int:
    for model in _public_models():
        if str(model.get("id") or "") == model_id:
            try:
                return int(model.get("context_length") or 4096)
            except (TypeError, ValueError):
                return 4096
    return 4096


def _palink_status_text(model_id: str) -> str:
    return f"Palink API: {model_id}" if model_id else "Palink API"


def _is_palink_managed_url(url: Any, request: Request) -> bool:
    normalized = str(url or "").strip().rstrip("/")
    if not normalized:
        return True
    request_origin = str(request.base_url).rstrip("/")
    allowed = {
        "/api/openai/v1",
        f"{request_origin}/api/openai/v1",
        str(app_settings.ST_NATIVE_PALINK_OPENAI_URL or "").strip().rstrip("/"),
    }
    return normalized in {item for item in allowed if item}


def _apply_palink_connection_defaults(settings_data: dict[str, Any], request: Request, db: Session) -> dict[str, Any]:
    model_id = _model_from_request(request, db=db)
    oai_settings = settings_data.get("oai_settings") if isinstance(settings_data.get("oai_settings"), dict) else {}
    palink_openai_url = f"{str(request.base_url).rstrip('/')}/api/openai/v1"
    # Resolve chat completion source from preset/user setting (default "custom").
    oai_settings["chat_completion_source"] = _resolve_chat_completion_source_for_request(request, db)
    oai_settings["custom_url"] = palink_openai_url
    oai_settings["custom_model"] = model_id
    oai_settings["openai_model"] = model_id
    oai_settings["bypass_status_check"] = True
    # Ensure stream is enabled for better UX
    if "stream_openai" not in oai_settings:
        oai_settings["stream_openai"] = True
    settings_data["oai_settings"] = oai_settings
    settings_data["main_api"] = "openai"
    # Provide full model list for ST model selector
    available_models = _public_models()
    settings_data["palink"] = {
        **(settings_data.get("palink") if isinstance(settings_data.get("palink"), dict) else {}),
        "managed_api": True,
        "default_model": _default_model_id_for_db(db),
        "selected_model": model_id,
        "palink_openai_url": palink_openai_url,
        "available_models": available_models,
        "api_status": _palink_status_text(model_id),
    }
    return settings_data


def _approx_token_ids(text: str) -> list[int]:
    count = max(1, (len(text) + 3) // 4)
    return list(range(1, count + 1))


def _extract_tokenizer_text(payload: Any) -> str:
    if isinstance(payload, str):
        return payload
    if isinstance(payload, dict):
        text = payload.get("text")
        if isinstance(text, str):
            return text
        if text is not None:
            try:
                return json.dumps(text, ensure_ascii=False)
            except (TypeError, ValueError):
                return str(text)
        return json.dumps(payload, ensure_ascii=False)
    if isinstance(payload, list):
        return json.dumps(payload, ensure_ascii=False)
    try:
        return json.dumps(payload, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(payload or "")


def _default_preset(db: Session, user_id: int) -> Optional[GenerationPreset]:
    return (
        db.query(GenerationPreset)
        .filter(
            or_(GenerationPreset.user_id == user_id, GenerationPreset.user_id.is_(None)),
            GenerationPreset.is_default == True,
        )
        .order_by(GenerationPreset.user_id.is_(None), GenerationPreset.name)
        .first()
    )


# Supported native chat completion sources. "custom"/"openai" route through the
# existing OpenAI-compat path; the others select a native adapter.
_NATIVE_CHAT_COMPLETION_SOURCES = {"claude", "google", "mistral"}


def _normalize_chat_completion_source(value: Any) -> str:
    raw = str(value or "").strip().lower()
    if raw in _NATIVE_CHAT_COMPLETION_SOURCES or raw in {"openai", "custom"}:
        return raw
    return "custom"


def _resolve_chat_completion_source(
    db: Session,
    user_id: Optional[int],
    preset: Optional[GenerationPreset] = None,
    setting: Optional[UserSetting] = None,
) -> str:
    """Resolve the chat completion source from preset → user setting → default.

    Priority:
      1. GenerationPreset.chat_completion_source (if present and non-empty)
      2. UserSetting.silly_tavern_settings JSON → oai_settings.chat_completion_source
      3. Fallback to "custom" (Palink-managed OpenAI-compat proxy)
    """
    # 1. GenerationPreset field
    if preset is not None:
        val = getattr(preset, "chat_completion_source", None)
        if val and str(val).strip():
            return _normalize_chat_completion_source(val)
    # 2. UserSetting (silly_tavern_settings JSON → oai_settings.chat_completion_source)
    if setting is not None:
        raw = getattr(setting, "silly_tavern_settings", None)
        if isinstance(raw, str) and raw.strip():
            try:
                data = json.loads(raw)
                if isinstance(data, dict):
                    oai = data.get("oai_settings")
                    if isinstance(oai, dict):
                        val = oai.get("chat_completion_source")
                        if val and str(val).strip():
                            return _normalize_chat_completion_source(val)
            except (json.JSONDecodeError, TypeError):
                pass
    # 3. Lazy-load preset/setting when only user_id is available
    if user_id is not None and db is not None:
        if preset is None:
            preset = _default_preset(db, user_id)
            if preset is not None:
                val = getattr(preset, "chat_completion_source", None)
                if val and str(val).strip():
                    return _normalize_chat_completion_source(val)
        if setting is None:
            setting = (
                db.query(UserSetting).filter(UserSetting.user_id == user_id).first()
            )
            if setting is not None:
                raw = getattr(setting, "silly_tavern_settings", None)
                if isinstance(raw, str) and raw.strip():
                    try:
                        data = json.loads(raw)
                        if isinstance(data, dict):
                            oai = data.get("oai_settings")
                            if isinstance(oai, dict):
                                val = oai.get("chat_completion_source")
                                if val and str(val).strip():
                                    return _normalize_chat_completion_source(val)
                    except (json.JSONDecodeError, TypeError):
                        pass
    return "custom"


def _resolve_chat_completion_source_for_request(
    request: Request, db: Session
) -> str:
    """Resolve chat completion source for a request-bound settings override.

    Used by connection-defaults/override helpers that only have request+db.
    Resolves the current user from the request, then delegates to
    _resolve_chat_completion_source.
    """
    user = _user_from_st_native_session(request, db) or _user_from_request_token(request, db)
    if user is None:
        return "custom"
    return _resolve_chat_completion_source(db, user.id)


def _user_default_preset_for_update(db: Session, user_id: int) -> GenerationPreset:
    preset = (
        db.query(GenerationPreset)
        .filter(GenerationPreset.user_id == user_id, GenerationPreset.is_default == True)
        .order_by(GenerationPreset.name)
        .first()
    )
    if preset:
        return preset
    db.query(GenerationPreset).filter(
        GenerationPreset.user_id == user_id,
        GenerationPreset.is_default == True,
    ).update({"is_default": False})
    source = _default_preset(db, user_id)
    preset = GenerationPreset(
        user_id=user_id,
        name="SillyTavern Default",
        is_default=True,
        temperature=getattr(source, "temperature", 0.7) if source else 0.7,
        top_p=getattr(source, "top_p", 0.95) if source else 0.95,
        max_tokens=getattr(source, "max_tokens", 1024) if source else 1024,
        frequency_penalty=getattr(source, "frequency_penalty", 0.0) if source else 0.0,
        presence_penalty=getattr(source, "presence_penalty", 0.0) if source else 0.0,
        min_p=getattr(source, "min_p", 0.05) if source else 0.05,
        top_k=getattr(source, "top_k", 40) if source else 40,
        repetition_penalty=getattr(source, "repetition_penalty", 1.1) if source else 1.1,
        system_prompt_override=getattr(source, "system_prompt_override", None) if source else None,
        post_history_instructions=getattr(source, "post_history_instructions", None) if source else None,
        prompts_data=getattr(source, "prompts_data", None) if source else None,
        chat_completion_source=getattr(source, "chat_completion_source", "custom") if source else "custom",
    )
    db.add(preset)
    db.flush()
    return preset


def _avatar_key(character_id: str) -> str:
    return f"{_AVATAR_PREFIX}{character_id}{_AVATAR_SUFFIX}"


_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def _character_id_from_avatar(value: Optional[str], *, allow_uuid: bool = True) -> Optional[str]:
    raw = str(value or "").strip()
    if not raw:
        return None
    raw = raw.split("?")[0].replace("\\", "/").split("/")[-1]
    if raw.startswith(_AVATAR_PREFIX) and raw.endswith(_AVATAR_SUFFIX):
        return raw[len(_AVATAR_PREFIX):-len(_AVATAR_SUFFIX)]
    if allow_uuid and _UUID_RE.match(raw):
        return raw
    return None


def _session_file_name(session_id: str, with_suffix: bool = False) -> str:
    name = f"{_SESSION_PREFIX}{session_id}"
    return f"{name}{_JSONL_SUFFIX}" if with_suffix else name


def _session_id_from_file(value: Optional[str]) -> Optional[str]:
    raw = str(value or "").strip()
    if not raw:
        return None
    raw = raw.replace("\\", "/").split("/")[-1]
    if raw.endswith(_JSONL_SUFFIX):
        raw = raw[:-len(_JSONL_SUFFIX)]
    if raw.startswith(_SESSION_PREFIX):
        return raw[len(_SESSION_PREFIX):]
    return None


def _iso(dt: Any) -> str:
    if hasattr(dt, "isoformat"):
        return dt.isoformat()
    return str(dt or "")


def _st_iso_utc(dt: Any) -> str:
    """Format a datetime like ST getMessageTimeStamp() (RossAscends-mods.js:192).

    ST writes message ``send_date`` via ``Date.toISOString()`` → UTC ISO-8601 with
    millisecond precision + trailing ``Z``. Python's ``isoformat()`` (microseconds,
    no ``Z``) drops the UTC marker, so ST would render the time in the browser's
    local timezone. Naive datetimes are treated as UTC (Palink stores UTC).
    """
    if not hasattr(dt, "isoformat"):
        return str(dt or "")
    aware = dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)
    return aware.strftime("%Y-%m-%dT%H:%M:%S.") + f"{aware.microsecond // 1000:03d}Z"


def _character_for_avatar(db: Session, user: Optional[User], avatar_url: Optional[str], *options: Any) -> Character:
    character_id = _character_id_from_avatar(avatar_url)
    if not character_id:
        raise HTTPException(status_code=404, detail="Character not found")
    query = db.query(Character)
    if options:
        query = query.options(*options)
    # 匿名请求（如 sandbox iframe 内状态栏头像）：按 id 全局解析，不做 user 过滤
    if user is not None:
        query = query.filter(Character.user_id == user.id)
    character = query.filter(Character.id == character_id).first()
    if not character:
        raise HTTPException(status_code=404, detail="Character not found")
    return character


def _latest_session(db: Session, user: User, character: Character) -> Optional[CharacterChatSession]:
    return (
        db.query(CharacterChatSession)
        .filter(
            CharacterChatSession.user_id == user.id,
            CharacterChatSession.character_id == character.id,
        )
        .order_by(
            func.coalesce(CharacterChatSession.updated_at, CharacterChatSession.created_at).desc(),
            CharacterChatSession.created_at.desc(),
        )
        .first()
    )


def _session_for_file(
    db: Session,
    user: User,
    character: Character,
    file_name: Optional[str],
    session_id: Optional[str] = None,
) -> Optional[CharacterChatSession]:
    resolved_session_id = _session_id_from_file(file_name)
    if not resolved_session_id and session_id:
        resolved_session_id = str(session_id).strip() or None
    if resolved_session_id:
        session = db.query(CharacterChatSession).filter(
            CharacterChatSession.id == resolved_session_id,
            CharacterChatSession.user_id == user.id,
            CharacterChatSession.character_id == character.id,
        ).first()
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
        return session
    return _latest_session(db, user, character)


def _ensure_session(
    db: Session,
    user: User,
    character: Character,
    file_name: Optional[str] = None,
    session_id: Optional[str] = None,
) -> CharacterChatSession:
    session = _session_for_file(db, user, character, file_name, session_id)
    if session:
        return session

    now = datetime.now(timezone.utc)
    session = CharacterChatSession(
        character_id=character.id,
        user_id=user.id,
        title=f"{character.name} - SillyTavern",
        dialogue_mode="first_person",
        created_at=now,
        updated_at=now,
    )
    db.add(session)
    db.flush()
    branch = CharacterChatSessionBranch(
        session_id=session.id,
        branch_name="Branch 1",
        is_active=True,
        created_at=now,
        last_message_at=now,
    )
    db.add(branch)
    db.commit()
    db.refresh(session)
    return session


def _active_branch(db: Session, session: CharacterChatSession) -> Optional[CharacterChatSessionBranch]:
    branch = db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.session_id == session.id,
        CharacterChatSessionBranch.is_active == True,
    ).first()
    if branch:
        return branch
    branch = db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.session_id == session.id,
    ).order_by(CharacterChatSessionBranch.created_at.desc()).first()
    if branch:
        branch.is_active = True
        db.flush()
        return branch
    branch = CharacterChatSessionBranch(
        session_id=session.id,
        branch_name="Branch 1",
        is_active=True,
        created_at=datetime.now(timezone.utc),
        last_message_at=datetime.now(timezone.utc),
    )
    db.add(branch)
    db.flush()
    return branch


def _branch_for_context(
    db: Session,
    session: CharacterChatSession,
    branch_id: Optional[str] = None,
) -> Optional[CharacterChatSessionBranch]:
    resolved_branch_id = str(branch_id or "").strip()
    if resolved_branch_id:
        branch = db.query(CharacterChatSessionBranch).filter(
            CharacterChatSessionBranch.id == resolved_branch_id,
            CharacterChatSessionBranch.session_id == session.id,
        ).first()
        if not branch:
            raise HTTPException(status_code=404, detail="Branch not found")
        if not branch.is_active:
            db.query(CharacterChatSessionBranch).filter(
                CharacterChatSessionBranch.session_id == session.id,
                CharacterChatSessionBranch.is_active == True,
            ).update({"is_active": False}, synchronize_session=False)
            branch.is_active = True
            db.flush()
        return branch
    return _active_branch(db, session)


def _message_swipes(message: CharacterChatMessage) -> list[str]:
    swipes = _safe_json_loads(message.swipes, [])
    if isinstance(swipes, list) and swipes:
        return [str(item or "") for item in swipes]
    return [message.content or ""]


def _message_extra(message: CharacterChatMessage) -> dict[str, Any]:
    extra = _safe_json_loads(message.extra, {})
    return extra if isinstance(extra, dict) else {}


def _message_to_st(message: CharacterChatMessage, index: int, character: Character, user: User) -> dict[str, Any]:
    is_user = bool(message.is_user) if message.is_user is not None else message.role == "user"
    is_system = bool(message.is_system) if message.is_system is not None else message.role == "system"
    swipes = _message_swipes(message)
    try:
        swipe_id = max(0, min(int(message.swipe_id or 0), len(swipes) - 1))
    except (TypeError, ValueError):
        swipe_id = 0
    extra = _message_extra(message)
    swipe_info = extra.get("swipe_info")
    if not isinstance(swipe_info, list):
        swipe_info = [{"send_date": _iso(message.created_at), "extra": {}} for _ in swipes]
    clean_extra = {k: v for k, v in extra.items() if k != "swipe_info"}
    raw_content = message.content or ""
    cleaned_content = _clean_message_content_for_st(raw_content)
    cleaned_swipes = [_clean_message_content_for_st(s) for s in swipes]
    # ST V3 multimodal content: when content_json is present (JSON array of
    # OpenAI-style content parts), pass it through so the ST client can render
    # inline_image / inline_audio alongside the text ``mes`` field.
    content_json_parsed = _safe_json_loads(getattr(message, "content_json", None), None)
    if isinstance(content_json_parsed, list) and content_json_parsed:
        clean_extra = dict(clean_extra)
        clean_extra["content"] = content_json_parsed
    # P0-4 修复: 同步 CharacterChatMessage.tokens 列到 extra.token_count
    # ST 前端 (script.js:5830, 10242) 读 message.extra.token_count 显示 token 计数
    # 原 Palink 仅写入列，未同步 extra，导致 ST 显示 undefined
    if message.tokens is not None and "token_count" not in clean_extra:
        clean_extra = dict(clean_extra)
        clean_extra["token_count"] = int(message.tokens)
    # P1-1 修复: 同步 CharacterChatMessage.model 列到 extra.model
    # ST 前端 (script.js:6705) 读 newMessage.extra.model 显示模型名
    if message.model and "model" not in clean_extra:
        clean_extra = dict(clean_extra)
        clean_extra["model"] = message.model
    return {
        "id": message.id,
        "mesid": message.mesid if isinstance(message.mesid, int) else index,
        "name": message.name or (user.username if is_user else "System" if is_system else character.name),
        "is_user": is_user,
        "is_system": is_system,
        "is_name": clean_extra.get("is_name"),
        "send_date": _st_iso_utc(message.created_at),
        "mes": cleaned_content,
        "swipes": cleaned_swipes,
        "swipe_id": swipe_id,
        "swipe_info": swipe_info,
        "extra": clean_extra,
        "is_hidden": bool(message.is_hidden),
        "is_locked": bool(message.is_locked),
        # ST 1.18.0 top-level fields (script.js:5835, 6736-6737): lift back out
        # of extra so the ST client reads them where it expects.
        **{
            k: clean_extra.pop(k)
            for k in ("gen_started", "gen_finished", "force_avatar", "original_avatar")
            if clean_extra.get(k) is not None
        },
    }


def _clean_message_content_for_st(content: str) -> str:
    """同步到 ST 前清理消息内容中的 SmartCard 渲染层标签"""
    from ..services.st_sync_service import clean_smart_card_markup
    return clean_smart_card_markup(content, keep_inner_text=True)


def _st_message_role(item: dict[str, Any]) -> str:
    if item.get("is_system"):
        return "system"
    if item.get("is_user"):
        return "user"
    return "assistant"


def _st_message_content(item: dict[str, Any]) -> str:
    value = item.get("mes")
    if value is None:
        value = item.get("content") or item.get("message") or item.get("text") or ""
    return str(value)


def _st_message_swipes(item: dict[str, Any], content: str) -> list[str]:
    swipes = item.get("swipes")
    if isinstance(swipes, list) and swipes:
        return [str(entry or "") for entry in swipes]
    return [content]


def _st_message_extra(item: dict[str, Any], swipes: list[str], swipe_id: int) -> dict[str, Any]:
    extra = item.get("extra") if isinstance(item.get("extra"), dict) else {}
    extra = dict(extra)
    swipe_info = item.get("swipe_info")
    if not isinstance(swipe_info, list):
        swipe_info = [{"send_date": item.get("send_date") or "", "extra": {}} for _ in swipes]
    while len(swipe_info) < len(swipes):
        swipe_info.append({"send_date": item.get("send_date") or "", "extra": {}})
    extra["swipe_info"] = swipe_info
    for key in (
        "is_name",
        "force_avatar",
        "original_avatar",
        "avatar",
        "gen_id",
        # ST 1.18.0 top-level generation timing (script.js:6736-6737); stashed in
        # extra here so _message_to_st can lift it back to top-level on export.
        "gen_started",
        "gen_finished",
        "group_id",
        "group_name",
        "selected_group",
        "groups",
        # Phase 3 extra 字段补齐 (ST 1.18.0 对齐)
        # - reasoning/reasoning_type/reasoning_duration/reasoning_display_text:
        #   LLM 思考链原文 + 类型 + 耗时 + 用户可编辑文本 (双写兼容: 同时存在 content 内联)
        # - tool_invocations: LLM tool call 数组 (字段透传, 不实现主动 tool calling)
        # - files/media_display/media_index/media: 文件/媒体附件 (字段透传)
        # - bias/memory: per-message logit bias / memory context (字段透传)
        # - ignore: 消息标记为忽略时在 prompt 装配时跳过 (替代 ST Symbol.for('ignore'))
        "reasoning",
        "reasoning_type",
        "reasoning_duration",
        "reasoning_display_text",
        "tool_invocations",
        "files",
        "media_display",
        "media_index",
        "media",
        "bias",
        "memory",
        "ignore",
    ):
        if item.get(key) is not None:
            extra[key] = item.get(key)
    return extra


def _chat_messages(db: Session, session: CharacterChatSession, branch: Optional[CharacterChatSessionBranch]) -> list[CharacterChatMessage]:
    query = db.query(CharacterChatMessage).filter(CharacterChatMessage.session_id == session.id)
    if branch:
        query = query.filter(CharacterChatMessage.branch_id == branch.id)
    else:
        query = query.filter(CharacterChatMessage.branch_id.is_(None))
    return query.order_by(CharacterChatMessage.created_at, CharacterChatMessage.id).all()


def _parse_variable_value(value: Optional[str]) -> Any:
    """Restore a ChatVariable.value string to its original JSON type when possible."""
    if value is None:
        return None
    try:
        return json.loads(value)
    except (json.JSONDecodeError, TypeError, ValueError):
        return value


def _serialize_variable_value(value: Any) -> Optional[str]:
    """Serialize a variable value for Text-column storage; strings stay as-is."""
    if value is None:
        return None
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False)


def _chat_header(
    db: Session,
    session: CharacterChatSession,
    character: Character,
    user: User,
    branch: Optional[CharacterChatSessionBranch] = None,
) -> dict[str, Any]:
    # Merge persisted chat_metadata (note_prompt / variables / hidden_bots / etc.)
    # with Palink-internal routing fields so ST 1.18.0 round-trips correctly.
    metadata: dict[str, Any] = {}
    raw_metadata = getattr(session, "chat_metadata", None)
    if raw_metadata:
        if isinstance(raw_metadata, dict):
            metadata = dict(raw_metadata)
        elif isinstance(raw_metadata, str):
            try:
                decoded = json.loads(raw_metadata)
                if isinstance(decoded, dict):
                    metadata = decoded
            except (json.JSONDecodeError, TypeError):
                metadata = {}
    metadata["palink_session_id"] = session.id
    metadata["palink_character_id"] = character.id
    metadata["palink_branch_id"] = branch.id if branch else None
    # ST 1.18.0 background: prefer session.background, fall back to transparent
    session_bg = getattr(session, "background", None)
    metadata["bg"] = session_bg if isinstance(session_bg, str) and session_bg else "__transparent.png"
    # Merge ChatVariable records into chat_metadata.variables so ST plugins can
    # read them via getContext().chat_metadata.variables. DB variables take
    # priority over any variables already present in persisted chat_metadata.
    persisted_variables = metadata.get("variables")
    base_variables: dict[str, Any] = {}
    if isinstance(persisted_variables, dict):
        base_variables = dict(persisted_variables)
    db_variables: dict[str, Any] = {}
    for v in db.query(ChatVariable).filter(ChatVariable.session_id == session.id).all():
        if v.value is None:
            continue
        db_variables[v.key] = _parse_variable_value(v.value)
    if db_variables or base_variables:
        merged_variables = dict(base_variables)
        merged_variables.update(db_variables)
        metadata["variables"] = merged_variables
    return {
        "chat_metadata": metadata,
        "user_name": user.username or "User",
        "character_name": character.name,
        # ST 1.18.0 chat header 期望字段：chat_name 用于展示，file_name 用于
        # /api/characters/chats 列表与 delete/rename 端点定位文件。
        "chat_name": session.title or character.name,
        "file_name": _session_file_name(session.id, with_suffix=True),
    }


def _worldbook_to_charbook(wb: Optional[WorldBook]) -> Optional[dict[str, Any]]:
    if not wb:
        return None

    # ST 1.18.0 convertCharacterBook (world-info.js:5501) expects entries to be
    # an ARRAY with V3 field names (keys, secondary_keys, insertion_order, enabled,
    # extensions.*). Returning a dict or V2 field names causes
    # "characterBook.entries.forEach is not a function" pageerror.
    entries: list[dict[str, Any]] = []
    for i, stage in enumerate(wb.entries or []):
        ext = _safe_json_loads(stage.extensions_json, {})
        if not isinstance(ext, dict):
            ext = {}
        # Ensure all expected extension fields exist (ST reads them via ?? fallback)
        ext.setdefault("exclude_recursion", bool(stage.exclude_recursion))
        ext.setdefault("prevent_recursion", bool(stage.prevent_recursion))
        ext.setdefault("delay_until_recursion", bool(getattr(stage, "delay_until_recursion", False)))
        ext.setdefault("display_index", i)
        ext.setdefault("probability", stage.probability if stage.probability is not None else 100)
        ext.setdefault("useProbability", stage.probability is not None and stage.probability < 100)
        ext.setdefault("depth", stage.depth if isinstance(stage.depth, int) else 4)
        ext.setdefault("selectiveLogic", stage.selective_logic if isinstance(stage.selective_logic, int) else 0)
        ext.setdefault("group", stage.group or "")
        ext.setdefault("group_override", bool(stage.group_override))
        ext.setdefault("group_weight", stage.group_weight if isinstance(stage.group_weight, int) else 0)
        # ST 1.18.0 convertCharacterBook:5535-5537 — role/use_group_scoring/automation_id
        ext.setdefault("role", stage.role if isinstance(stage.role, int) else 0)
        ext.setdefault("use_group_scoring", stage.use_group_scoring)
        ext.setdefault("automation_id", stage.automation_id or "")
        ext.setdefault("scan_depth", stage.scan_depth if isinstance(stage.scan_depth, int) else None)
        ext.setdefault("case_sensitive", bool(stage.case_sensitive) if stage.case_sensitive is not None else None)
        ext.setdefault("match_whole_words", bool(stage.match_whole_words) if stage.match_whole_words is not None else None)
        ext.setdefault("vectorized", bool(stage.vectorized))
        ext.setdefault("sticky", stage.sticky if isinstance(stage.sticky, int) else None)
        ext.setdefault("cooldown", stage.cooldown if isinstance(stage.cooldown, int) else None)
        ext.setdefault("delay", stage.delay if isinstance(stage.delay, int) else None)
        ext.setdefault("match_persona_description", bool(stage.match_persona_description))
        ext.setdefault("match_character_description", bool(stage.match_character_description))
        ext.setdefault("match_character_personality", bool(stage.match_character_personality))
        ext.setdefault("match_character_depth_prompt", bool(stage.match_character_depth_prompt))
        ext.setdefault("match_scenario", bool(stage.match_scenario))
        ext.setdefault("match_creator_notes", bool(stage.match_creator_notes))
        ext.setdefault("triggers", _safe_json_loads(getattr(stage, "triggers", "[]"), []))
        # Bug #6: ST 1.18.0 ignoreBudget — 仅当 stage 显式 True 时写入
        # 避免 False 默认值污染原始 extensions roundtrip
        if getattr(stage, "ignore_budget", False):
            ext.setdefault("ignore_budget", True)

        # position: ST V3 expects 'before_char' or 'after_char', or extensions.position
        pos_int = stage.position if isinstance(stage.position, int) else 4
        pos_str = "before_char" if pos_int == 0 else "after_char"

        entry = {
            "id": i,
            "keys": _safe_json_loads(stage.keys, []),
            "secondary_keys": _safe_json_loads(stage.secondary_keys, []),
            "comment": stage.title or "",
            "content": stage.content or "",
            "constant": bool(stage.constant),
            "selective": bool(stage.selective),
            "insertion_order": stage.order if isinstance(stage.order, int) else (stage.stage_index or 0),
            "position": pos_str,
            "enabled": bool(stage.enabled),
            "extensions": ext,
        }
        entries.append(entry)

    return {
        "name": wb.name,
        "description": wb.description or "",
        "entries": entries,
        "extensions": {},
        "recursive_scanning": False,
    }


def _sync_character_book_to_palink(db: Session, character: Character, character_book: dict[str, Any]) -> None:
    """将 ST 编辑的 character_book 同步回 Palink WorldBook"""
    from ..models import WorldBookStage

    wb = next((item for item in (character.world_books or []) if item.type == "character_book"), None)
    book_name = str(character_book.get("name") or f"{character.name}'s Lorebook")
    book_description = str(character_book.get("description") or "")
    raw_entries = character_book.get("entries") if isinstance(character_book.get("entries"), dict) else {}

    if not wb:
        wb = WorldBook(
            user_id=character.user_id,
            character_id=character.id,
            name=book_name,
            description=book_description,
            type="character_book",
            format="silly_tavern_v2",
        )
        db.add(wb)
        db.flush()
    else:
        wb.name = book_name
        wb.description = book_description

    existing_stages = {str(stage.stage_index): stage for stage in (wb.entries or [])}
    new_stage_indices = set(raw_entries.keys())

    for idx_str, stage in existing_stages.items():
        if idx_str not in new_stage_indices:
            db.delete(stage)

    for idx_str, entry_data in raw_entries.items():
        if not isinstance(entry_data, dict):
            continue
        try:
            stage_index = int(idx_str)
        except (TypeError, ValueError):
            stage_index = 0

        stage = existing_stages.get(idx_str)
        if not stage:
            # 创建时同步传入 content，避免 db.flush() 触发 content NOT NULL 约束
            # （WorldBookStage.content 为 nullable=False，见 models/worldbook.py:43）
            stage = WorldBookStage(
                world_book_id=wb.id,
                stage_index=stage_index,
                content=str(entry_data.get("content") or ""),
            )
            db.add(stage)
            db.flush()

        stage.title = str(entry_data.get("comment") or "")
        stage.content = str(entry_data.get("content") or "")
        stage.keys = _json_dumps(entry_data.get("key") or [])
        stage.secondary_keys = _json_dumps(entry_data.get("keysecondary") or [])
        stage.constant = bool(entry_data.get("constant"))
        stage.selective = bool(entry_data.get("selective"))
        stage.selective_logic = entry_data.get("selectiveLogic") if isinstance(entry_data.get("selectiveLogic"), int) else 0
        stage.position = entry_data.get("position") if isinstance(entry_data.get("position"), int) else 4
        stage.depth = entry_data.get("depth") if isinstance(entry_data.get("depth"), int) else 4
        stage.order = entry_data.get("order") if isinstance(entry_data.get("order"), int) else stage_index
        stage.probability = entry_data.get("probability") if entry_data.get("probability") is not None else 100
        stage.enabled = not bool(entry_data.get("disable"))
        stage.case_sensitive = bool(entry_data.get("caseSensitive"))
        stage.match_whole_words = bool(entry_data.get("matchWholeWords"))
        stage.exclude_recursion = bool(entry_data.get("excludeRecursion"))
        stage.prevent_recursion = bool(entry_data.get("preventRecursion"))
        stage.sticky = entry_data.get("sticky") if isinstance(entry_data.get("sticky"), int) else 0
        stage.cooldown = entry_data.get("cooldown") if isinstance(entry_data.get("cooldown"), int) else 0
        stage.delay = entry_data.get("delay") if isinstance(entry_data.get("delay"), int) else 0
        stage.group = str(entry_data.get("group") or "")
        stage.group_override = bool(entry_data.get("groupOverride"))
        stage.group_weight = entry_data.get("groupWeight") if isinstance(entry_data.get("groupWeight"), int) else 0
        stage.vectorized = bool(entry_data.get("vectorized"))
        stage.add_memo = bool(entry_data.get("addMemo"))
        stage.decorators = _json_dumps(entry_data.get("decorators") or [])
        stage.extensions_json = _json_dumps(entry_data.get("extensions") or {})
        # ST 1.18.0 advanced fields (parity with _create_stage_from_st_entry).
        stage.match_persona_description = bool(entry_data.get("matchPersonaDescription"))
        stage.match_character_description = bool(entry_data.get("matchCharacterDescription"))
        stage.match_character_personality = bool(entry_data.get("matchCharacterPersonality"))
        stage.match_character_depth_prompt = bool(entry_data.get("matchCharacterDepthPrompt"))
        stage.match_scenario = bool(entry_data.get("matchScenario"))
        stage.match_creator_notes = bool(entry_data.get("matchCreatorNotes"))
        stage.min_activations = entry_data.get("minActivations") if isinstance(entry_data.get("minActivations"), int) else 0
        stage.delay_until_recursion = entry_data.get("delayUntilRecursion") if isinstance(entry_data.get("delayUntilRecursion"), int) else 0
        stage.triggers = _json_dumps(entry_data.get("triggers") or [])
        stage.outlet_name = str(entry_data.get("outletName") or "")[:200] or None
        stage.ignore_budget = bool(
            entry_data.get("ignoreBudget")
            or (entry_data.get("extensions") or {}).get("ignore_budget", False)
        )
        stage.role = (
            entry_data.get("role")
            if isinstance(entry_data.get("role"), int)
            else (entry_data.get("extensions") or {}).get("role", 0)
            if isinstance((entry_data.get("extensions") or {}).get("role"), int)
            else 0
        )
        stage.use_group_scoring = _nullable_bool(
            entry_data.get("useGroupScoring")
            if entry_data.get("useGroupScoring") is not None
            else (entry_data.get("extensions") or {}).get("use_group_scoring")
        )
        stage.automation_id = (
            str(
                entry_data.get("automationId")
                if entry_data.get("automationId") is not None
                else (entry_data.get("extensions") or {}).get("automation_id") or ""
            )[:200]
            or None
        )

    db.flush()


def _character_to_st(character: Character, user: User, session: Optional[CharacterChatSession]) -> dict[str, Any]:
    wb = next((item for item in (character.world_books or []) if item.type == "character_book"), None)
    card = convert_character_to_chara_card(character, world_book_data=_worldbook_to_charbook(wb))
    data = card.get("data") if isinstance(card, dict) else {}
    if not isinstance(data, dict):
        data = {}
    extensions = data.get("extensions") if isinstance(data.get("extensions"), dict) else {}
    tags = data.get("tags") if isinstance(data.get("tags"), list) else []
    alternate_greetings = data.get("alternate_greetings") if isinstance(data.get("alternate_greetings"), list) else []
    chat_name = _session_file_name(session.id) if session else f"{character.name} - SillyTavern"
    return {
        **data,
        "id": _avatar_key(character.id),
        "palink_id": character.id,
        "avatar": _avatar_key(character.id),
        "avatar_url": character.avatar or "",
        "chat": chat_name,
        "create_date": int((character.created_at or datetime.now(timezone.utc)).timestamp() * 1000),
        "date_added": int((character.created_at or datetime.now(timezone.utc)).timestamp() * 1000),
        "date_last_chat": int((session.updated_at or session.created_at).timestamp() * 1000) if session else 0,
        "data": data,
        "fav": bool(data.get("fav", False)),
        "tags": tags,
        "alternate_greetings": alternate_greetings,
        "extensions": extensions,
        "spec": card.get("spec") if isinstance(card, dict) else "chara_card_v2",
        "spec_version": card.get("spec_version") if isinstance(card, dict) else (character.raw_card_spec_version or "2.0"),
        "shallow": False,
    }


def _character_to_st_list_item(character: Character, session: Optional[CharacterChatSession]) -> dict[str, Any]:
    chat_name = _session_file_name(session.id) if session else f"{character.name} - SillyTavern"
    created_at = character.created_at or datetime.now(timezone.utc)
    updated_at = character.updated_at or created_at
    return {
        "name": character.name or "",
        "description": "",
        "personality": "",
        "scenario": "",
        "first_mes": "",
        "mes_example": "",
        "creator_notes": "",
        "system_prompt": "",
        "post_history_instructions": "",
        "tags": _safe_json_loads(character.tags, []) if character.tags else [],
        "creator": character.creator or "",
        "character_version": character.character_version or "",
        "alternate_greetings": [],
        "extensions": {},
        "id": _avatar_key(character.id),
        "palink_id": character.id,
        "avatar": _avatar_key(character.id),
        "avatar_url": "",
        "chat": chat_name,
        "create_date": int(created_at.timestamp() * 1000),
        "date_added": int(created_at.timestamp() * 1000),
        "date_last_chat": int((session.updated_at or session.created_at).timestamp() * 1000) if session else int(updated_at.timestamp() * 1000),
        "data": {"name": character.name or ""},
        "fav": False,
        "shallow": True,
        # ST 1.18.0 V3 chara card fields
        "talkativeness": getattr(character, "talkativeness", None) or "0.5",
        "nickname": getattr(character, "nickname", None) or "",
    }


def _boot_session(
    db: Session,
    user: User,
    character: Character,
    session_id: Optional[str],
) -> Optional[CharacterChatSession]:
    if session_id:
        session = db.query(CharacterChatSession).filter(
            CharacterChatSession.id == session_id,
            CharacterChatSession.user_id == user.id,
            CharacterChatSession.character_id == character.id,
        ).first()
        if session:
            return session
    return _latest_session(db, user, character)


def _default_st_settings(db: Session, user: User, setting: UserSetting) -> dict[str, Any]:
    preset = _default_preset(db, user.id)
    model_id = _default_model_id_for_db(db)
    models = _public_models()
    context_length = next((int(m.get("context_length") or 4096) for m in models if m.get("id") == model_id), 4096)
    max_tokens = int(getattr(preset, "max_tokens", 1024) or 1024) if preset else 1024
    # ST 1.18.0 power_user: prefer DB-persisted value (full power_user JSON),
    # fall back to hardcoded defaults when DB has none.
    _power_user_defaults = {
        "auto_scroll_chat_to_bottom": True,
        "message_token_count_enabled": False,
        "trim_spaces": True,
        "collapse_newlines": False,
        "allow_name1_display": True,
        "allow_name2_display": True,
        "charListGrid": False,
        "auto_load_chat": False,
    }
    _power_user = dict(_power_user_defaults)
    raw_power_user = getattr(setting, "power_user", None)
    if isinstance(raw_power_user, str) and raw_power_user.strip():
        try:
            decoded_power_user = json.loads(raw_power_user)
            if isinstance(decoded_power_user, dict):
                _power_user.update(decoded_power_user)
        except (json.JSONDecodeError, TypeError):
            pass
    # ST 1.18.0 ui_settings: prefer DB-persisted value, fall back to {}.
    _ui_settings: dict[str, Any] = {}
    raw_ui_settings = getattr(setting, "ui_settings", None)
    if isinstance(raw_ui_settings, str) and raw_ui_settings.strip():
        try:
            decoded_ui = json.loads(raw_ui_settings)
            if isinstance(decoded_ui, dict):
                _ui_settings.update(decoded_ui)
        except (json.JSONDecodeError, TypeError):
            pass
    settings = {
        "firstRun": False,
        "currentVersion": "Palink:SillyTavernCompat",
        "username": user.username or "User",
        "active_character": "",
        "active_group": "",
        "user_avatar": "User.png",
        "amount_gen": max_tokens,
        "max_context": max(context_length, max_tokens),
        "main_api": "openai",
        "swipes": True,
        "world_info_settings": {},
        "textgenerationwebui_settings": {},
        "horde_settings": {},
        "power_user": _power_user,
        "ui_settings": _ui_settings,
        "extension_settings": {},
        "tags": [],
        "tag_map": {},
        "nai_settings": {},
        "kai_settings": {},
        "oai_settings": {
            "chat_completion_source": _resolve_chat_completion_source(db, user.id, preset, setting),
            "custom_url": "/api/openai/v1",
            "custom_include_body": "",
            "custom_include_headers": "",
            "custom_model": model_id,
            "openai_model": model_id,
            "temp_openai": float(getattr(preset, "temperature", 0.7) or 0.7) if preset else 0.7,
            "top_p_openai": float(getattr(preset, "top_p", 0.95) or 0.95) if preset else 0.95,
            "freq_pen_openai": float(getattr(preset, "frequency_penalty", 0.0) or 0.0) if preset else 0.0,
            "pres_pen_openai": float(getattr(preset, "presence_penalty", 0.0) or 0.0) if preset else 0.0,
            "openai_max_context": max(context_length, max_tokens),
            "openai_max_tokens": max_tokens,
            "stream_openai": True,
        },
        "background": {},
        "proxies": [],
        "selected_proxy": "",
        "palink": {
            "silly_tavern_mode": _normalize_silly_tavern_mode(setting.silly_tavern_mode),
            "silly_tavern_theme": setting.silly_tavern_theme or "palink",
        },
    }
    return settings


def _boot_settings_override(settings_data: dict[str, Any], request: Request, db: Session) -> dict[str, Any]:
    model_id = _model_from_request(request, db=db)
    oai_settings = settings_data.get("oai_settings") if isinstance(settings_data.get("oai_settings"), dict) else {}
    power_user = settings_data.get("power_user") if isinstance(settings_data.get("power_user"), dict) else {}
    settings_data["main_api"] = "openai"
    settings_data["oai_settings"] = {
        **oai_settings,
        "chat_completion_source": _resolve_chat_completion_source_for_request(request, db),
        "custom_url": f"{str(request.base_url).rstrip('/')}/api/openai/v1",
        "custom_model": model_id,
        "openai_model": model_id,
        "bypass_status_check": True,
    }
    settings_data["power_user"] = {**power_user, "auto_load_chat": True}
    settings_data["selected_button"] = "characters"
    settings_data["active_group"] = ""
    native_payload = _st_native_session_payload(request)
    settings_data["enable_extensions"] = bool(native_payload)
    settings_data["enable_extensions_auto_update"] = bool(native_payload)
    settings_data["palink"] = {
        **(settings_data.get("palink") if isinstance(settings_data.get("palink"), dict) else {}),
        "managed_api": True,
        "selected_model": model_id,
        "api_status": _palink_status_text(model_id),
    }
    return settings_data


def _normalize_background_settings(settings_data: dict[str, Any]) -> None:
    background = settings_data.get("background")
    if not isinstance(background, dict):
        settings_data["background"] = {
            "name": "__transparent.png",
            "url": _TRANSPARENT_BACKGROUND_URL,
            "fitting": "classic",
            "animation": False,
        }
        return
    url = str(background.get("url") or "")
    name = str(background.get("name") or "")
    if "__transparent.png" in url or name == "__transparent.png":
        background["name"] = "__transparent.png"
        background["url"] = _TRANSPARENT_BACKGROUND_URL
        background.setdefault("fitting", "classic")
        background.setdefault("animation", False)


def _merge_palink_defaults(base: dict[str, Any], db: Session, user: User, setting: UserSetting) -> dict[str, Any]:
    merged = _default_st_settings(db, user, setting)
    if isinstance(base, dict):
        merged.update(base)
        merged["oai_settings"] = {
            **_default_st_settings(db, user, setting).get("oai_settings", {}),
            **(base.get("oai_settings") if isinstance(base.get("oai_settings"), dict) else {}),
        }
        merged["power_user"] = {
            **_default_st_settings(db, user, setting).get("power_user", {}),
            **(base.get("power_user") if isinstance(base.get("power_user"), dict) else {}),
        }
        merged["ui_settings"] = {
            **_default_st_settings(db, user, setting).get("ui_settings", {}),
            **(base.get("ui_settings") if isinstance(base.get("ui_settings"), dict) else {}),
        }
    merged["username"] = user.username or merged.get("username") or "User"
    _normalize_background_settings(merged)
    return merged


def _apply_settings_to_preset(settings_data: dict[str, Any], db: Session, user: User) -> None:
    oai = settings_data.get("oai_settings") if isinstance(settings_data.get("oai_settings"), dict) else {}
    preset = _user_default_preset_for_update(db, user.id)

    mapping = {
        "temp_openai": "temperature",
        "top_p_openai": "top_p",
        "openai_max_tokens": "max_tokens",
        "freq_pen_openai": "frequency_penalty",
        "pres_pen_openai": "presence_penalty",
    }
    for st_key, preset_key in mapping.items():
        if st_key not in oai:
            continue
        value = oai.get(st_key)
        try:
            if preset_key == "max_tokens":
                setattr(preset, preset_key, max(1, int(value)))
            else:
                setattr(preset, preset_key, float(value))
        except (TypeError, ValueError):
            continue
    preset.updated_at = datetime.now(timezone.utc)


@router.get("/version")
async def st_version():
    return {"agent": "SillyTavern", "pkgVersion": "1.18.0", "gitRevision": "palink", "gitBranch": "palink"}


@router.get("/api/st/version")
async def st_version_api_alias():
    return await st_version()


@router.get("/api/st/native/status")
async def st_native_status(
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    setting = _get_or_create_user_setting(user, db)
    return {
        "available": True,
        "mode": _normalize_silly_tavern_mode(setting.silly_tavern_mode),
        "theme": setting.silly_tavern_theme or "palink",
        "url": _st_native_public_url(request),
        "service_url": app_settings.ST_NATIVE_SERVICE_URL,
        "palink_openai_url": app_settings.ST_NATIVE_PALINK_OPENAI_URL,
        "default_model": app_settings.ST_NATIVE_DEFAULT_MODEL,
        "service_key_configured": bool((app_settings.ST_NATIVE_SERVICE_KEY or "").strip()),
        "version": "1.18.0",
        "data_storage": "sillytavern-data-root",
        "database_topology": "separate",
        "user_isolation": "per-palink-user-st-data-root",
        "access_control": "palink-session-gated",
        "notes": [
            "Official SillyTavern sidecar owns ST Native cards, chats, extensions, and assets.",
            "The public ST Native entry is gated by a Palink-issued session cookie.",
            "ST Native user data is stored under per-Palink-user directories such as data/palink-1.",
            "Fresh ST Native data roots are seeded to use Palink's OpenAI-compatible model endpoint.",
            "Palink DB and ST DATA_ROOT are kept in sync via /api/st/sync/* endpoints.",
            "Palink compatibility bridge remains available at /st/.",
        ],
    }


@router.get("/api/st/native/auth")
async def st_native_auth(
    request: Request,
    token: Optional[str] = Query(None),
    palink_token: Optional[str] = Query(None, alias="palinkToken"),
    db: Session = Depends(get_db),
):
    session_user = _user_from_st_native_session(request, db)
    if session_user:
        return _st_native_auth_response(session_user, _st_native_session_payload(request))

    user = _user_from_request_token(request, db, token or palink_token)
    response = _st_native_auth_response(user)
    _set_st_native_session_cookie(response, request, user)
    return response


@router.get("/api/st/native/login")
async def st_native_login(
    request: Request,
    token: Optional[str] = Query(None),
    palink_token: Optional[str] = Query(None, alias="palinkToken"),
    palink_character_id: Optional[str] = Query(None, alias="palinkCharacterId"),
    palink_session_id: Optional[str] = Query(None, alias="palinkSessionId"),
    palink_branch_id: Optional[str] = Query(None, alias="palinkBranchId"),
    palink_model: Optional[str] = Query(None, alias="palinkModel"),
    next_path: str = Query("/", alias="next"),
    db: Session = Depends(get_db),
):
    user = _user_from_request_token(request, db, token or palink_token)
    # S-5 修复: 签入 cookie 前校验 character/session 归属当前用户。
    # 防止攻击者伪造 palinkCharacterId/palinkSessionId 将他人资源上下文
    # 签入自己的 ST native session（随后 ST 请求携带该上下文访问他人数据）。
    if palink_character_id:
        _character_for_avatar(db, user, palink_character_id)
    if palink_session_id:
        session_owner = (
            db.query(CharacterChatSession)
            .filter(
                CharacterChatSession.id == str(palink_session_id).strip(),
                CharacterChatSession.user_id == user.id,
            )
            .first()
        )
        if session_owner is None:
            raise HTTPException(status_code=404, detail="Session not found")
    safe_next = str(next_path or "/")
    if not safe_next.startswith("/") or safe_next.startswith("//") or "\r" in safe_next or "\n" in safe_next:
        safe_next = "/"
    response = RedirectResponse(url=safe_next, status_code=302)
    _set_st_native_session_cookie(
        response,
        request,
        user,
        palink_character_id,
        palink_session_id,
        palink_branch_id,
        palink_model,
    )
    return response


@router.get("/csrf-token")
async def st_csrf_token():
    return {"token": "palink-csrf"}


@router.get("/api/st/csrf-token")
async def st_csrf_token_api_alias():
    return await st_csrf_token()


@router.post("/api/backends/chat-completions/status")
async def st_chat_completion_status(
    request: Request,
    user: User = Depends(get_st_current_user),
):
    model_id = _model_from_request(request)
    models = _public_models()
    if model_id and not any(str(model.get("id") or "") == model_id for model in models):
        models.insert(0, {"id": model_id, "name": model_id, "context_length": _model_context_length(model_id)})
    return {
        "result": "ok",
        "valid": True,
        "status": _palink_status_text(model_id),
        "model": model_id,
        "bypass": False,
        "data": models,
    }


@router.post("/api/tokenizers/{tokenizer_name}/{operation}")
async def st_tokenizer_compat(
    tokenizer_name: str,
    operation: str,
    payload: Any = Body(None),
    user: User = Depends(get_st_current_user),
):
    """ST tokenizer compat endpoint — uses real tokenizers when available.

    Aligns with ST 1.18.0 ``src/endpoints/tokenizers.js`` endpoints:
    ``/api/tokenizers/{tokenizer_name}/{operation}``

    For ``openai`` tokenizer, the ``model`` field from the request body is
    used to select the tiktoken encoding (e.g., gpt-4o → o200k_base).
    For other tokenizers (llama, mistral, etc.), the tokenizer type from
    the URL path is used directly.

    Response format matches ST:
    - encode: ``{"ids": [...], "tokens": [...], "count": N, "token_count": N, "tokenizer": name}``
    - decode: ``{"text": "...", "tokenizer": name}``
    """
    from ..services.st_tokenizer_service import (
        encode_tokens_by_type,
        decode_tokens_by_type,
        get_token_count_by_type,
        guesstimate,
    )

    text = _extract_tokenizer_text(payload)

    # For "openai" tokenizer, extract model from payload to select tiktoken encoding
    model_override = None
    if tokenizer_name == "openai" and isinstance(payload, dict):
        model_override = payload.get("model")

    if operation == "decode":
        # Decode: payload contains token IDs
        raw_ids = []
        if isinstance(payload, dict):
            raw_ids = payload.get("ids") or payload.get("tokens") or []
        elif isinstance(payload, list):
            raw_ids = payload
        ids = [int(t) for t in raw_ids if isinstance(t, (int, float))] if raw_ids else []
        decoded_text = decode_tokens_by_type(ids, tokenizer_name, model_override)
        return {"text": decoded_text, "tokenizer": tokenizer_name}

    # Encode/count
    ids = encode_tokens_by_type(text, tokenizer_name, model_override)
    count = len(ids)
    return {
        "ids": ids,
        "tokens": ids,
        "count": count,
        "token_count": count,
        "tokenizer": tokenizer_name,
    }


@router.get("/thumbnail")
@router.get("/api/st/thumbnail")
async def st_thumbnail(
    request: Request,
    type: str = Query("avatar"),
    file: str = Query(""),
    token: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    user = _optional_user_from_request(request, db, token)
    if type != "avatar":
        return Response(content=_svg_avatar("AI"), media_type="image/svg+xml")
    if not _character_id_from_avatar(file):
        return Response(content=_svg_avatar("User" if str(file).lower().startswith("user") else "AI"), media_type="image/svg+xml")
    character = _character_for_avatar(db, user, file)
    return _avatar_response(character, token)


@router.get("/characters/{avatar_key:path}")
@router.get("/api/st/characters/{avatar_key:path}")
async def st_character_avatar(
    avatar_key: str,
    request: Request,
    token: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    user = _optional_user_from_request(request, db, token)
    character = _character_for_avatar(db, user, avatar_key)
    return _avatar_response(character, token)


def _normalize_generate_messages(raw_messages: Any) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    if not isinstance(raw_messages, list):
        return messages
    for item in raw_messages:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "user")
        content = item.get("content")
        if content is None:
            content = ""
        messages.append({"role": role, "content": content})
    return messages


def _generate_model_id(payload: dict[str, Any], request: Request) -> str:
    return _model_from_request(request, payload)


def _chat_completion_chunk(completion_id: str, model_id: str, content: str = "", finish_reason: Optional[str] = None, index: int = 0) -> dict[str, Any]:
    delta: dict[str, Any] = {}
    if content:
        delta["content"] = content
    return {
        "id": completion_id,
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model_id,
        "choices": [{"index": index, "delta": delta, "finish_reason": finish_reason}],
    }


@router.post("/api/backends/chat-completions/generate")
async def st_generate_chat_completion(
    payload: dict[str, Any],
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    messages = _normalize_generate_messages(payload.get("messages"))
    if not messages:
        prompt = str(payload.get("prompt") or "").strip()
        if prompt:
            messages = [{"role": "user", "content": prompt}]
    if not messages:
        raise HTTPException(status_code=400, detail="messages cannot be empty")

    model_id = _generate_model_id(payload, request)
    # Resolve chat completion source from preset/user setting so native
    # adapters (claude/google/mistral) can be selected. Defaults to "custom"
    # which preserves the existing Palink-managed OpenAI-compat path.
    chat_completion_source = _resolve_chat_completion_source(db, user.id)
    try:
        ensure_model_available(model_id)
    except ValueError:
        fallback_model = _default_model_id()
        try:
            ensure_model_available(fallback_model)
            model_id = fallback_model
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    temperature = payload.get("temperature") if payload.get("temperature") is not None else 0.7
    top_p = payload.get("top_p")
    max_tokens = payload.get("max_tokens")
    frequency_penalty = payload.get("frequency_penalty") if payload.get("frequency_penalty") is not None else 0.0
    presence_penalty = payload.get("presence_penalty") if payload.get("presence_penalty") is not None else 0.0
    stream = bool(payload.get("stream"))
    # ST 1.18.0 对齐: logit_bias / stop / n (multi-swipe)
    logit_bias = payload.get("logit_bias") if isinstance(payload.get("logit_bias"), dict) else None
    stop_sequences = payload.get("stop") if isinstance(payload.get("stop"), list) else None
    n_swipes = payload.get("n") if isinstance(payload.get("n"), int) and payload.get("n") > 1 else None
    # ST 1.18.0 对齐: json_schema (结构化输出)
    json_schema = payload.get("json_schema") if isinstance(payload.get("json_schema"), dict) else None

    if stream:
        async def stream_generator() -> AsyncGenerator[str, None]:
            result = StreamResult()
            completion_id = f"chatcmpl-{uuid.uuid4().hex[:24]}"
            first_chunk = True
            try:
                palink_stream = stream_text_completion(
                    model_id=model_id,
                    messages=messages,
                    temperature=float(temperature),
                    top_p=float(top_p) if top_p is not None else None,
                    max_tokens=int(max_tokens) if max_tokens is not None else None,
                    frequency_penalty=float(frequency_penalty),
                    presence_penalty=float(presence_penalty),
                    timeout=120.0,
                    chat_completion_source=chat_completion_source,
                    logit_bias=logit_bias,
                    stop=stop_sequences,
                    json_schema=json_schema,
                )
                async for sse_event in stream_chat_deltas(palink_stream, result):
                    try:
                        data = json.loads(sse_event.removeprefix("data: ").strip())
                    except Exception:
                        continue
                    content = ""
                    if isinstance(data.get("content"), str):
                        content += data["content"]
                    if isinstance(data.get("reasoning"), str):
                        content += data["reasoning"]
                    if first_chunk:
                        yield f"data: {json.dumps({'id': completion_id, 'object': 'chat.completion.chunk', 'created': int(time.time()), 'model': model_id, 'choices': [{'index': 0, 'delta': {'role': 'assistant'}, 'finish_reason': None}]}, ensure_ascii=False)}\n\n"
                        first_chunk = False
                    if content:
                        yield f"data: {json.dumps(_chat_completion_chunk(completion_id, model_id, content), ensure_ascii=False)}\n\n"
                yield f"data: {json.dumps(_chat_completion_chunk(completion_id, model_id, '', 'stop'), ensure_ascii=False)}\n\n"

                # C-9 修复: n>1 多 swipe——主流结束后串行生成副 completion
                # （choices[].index = 1..n-1），ST 前端按 index 累积 swipes。
                if n_swipes and n_swipes > 1:
                    for swipe_idx in range(1, n_swipes):
                        swipe_result = StreamResult()
                        try:
                            swipe_stream = stream_text_completion(
                                model_id=model_id,
                                messages=messages,
                                temperature=float(temperature),
                                top_p=float(top_p) if top_p is not None else None,
                                max_tokens=int(max_tokens) if max_tokens is not None else None,
                                frequency_penalty=float(frequency_penalty),
                                presence_penalty=float(presence_penalty),
                                timeout=120.0,
                                chat_completion_source=chat_completion_source,
                                logit_bias=logit_bias,
                                stop=stop_sequences,
                                json_schema=json_schema,
                            )
                            async for sse_event in stream_chat_deltas(swipe_stream, swipe_result):
                                try:
                                    s_data = json.loads(sse_event.removeprefix("data: ").strip())
                                except Exception:
                                    continue
                                s_content = ""
                                if isinstance(s_data.get("content"), str):
                                    s_content += s_data["content"]
                                if isinstance(s_data.get("reasoning"), str):
                                    s_content += s_data["reasoning"]
                                if s_content:
                                    yield f"data: {json.dumps(_chat_completion_chunk(completion_id, model_id, s_content, index=swipe_idx), ensure_ascii=False)}\n\n"
                        except Exception as swipe_exc:
                            logger.warning(
                                "ST multi-swipe #%d generation failed: %s", swipe_idx, swipe_exc
                            )
                yield "data: [DONE]\n\n"
            except Exception as exc:
                # C-8 修复: 以 OpenAI error 格式输出（ST tryParseStreamingError 识别并
                # 弹 toastr 错误提示），不再把错误文本当正常 AI 回复渲染。
                error_text = result.full_content or f"[Palink generation failed: {exc}]"
                yield f"data: {json.dumps({'error': {'message': error_text}}, ensure_ascii=False)}\n\n"
                yield "data: [DONE]\n\n"

        return StreamingResponse(
            stream_generator(),
            media_type="text/event-stream; charset=utf-8",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    result = StreamResult()
    try:
        palink_stream = stream_text_completion(
            model_id=model_id,
            messages=messages,
            temperature=float(temperature),
            top_p=float(top_p) if top_p is not None else None,
            max_tokens=int(max_tokens) if max_tokens is not None else None,
            frequency_penalty=float(frequency_penalty),
            presence_penalty=float(presence_penalty),
            timeout=120.0,
            chat_completion_source=chat_completion_source,
            logit_bias=logit_bias,
            stop=stop_sequences,
            json_schema=json_schema,
        )
        async for _ in stream_chat_deltas(palink_stream, result):
            pass
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Palink generation failed: {exc}") from exc

    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:24]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model_id,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": result.full_content}, "finish_reason": "stop"}],
        "usage": {
            "prompt_tokens": result.prompt_tokens,
            "completion_tokens": result.completion_tokens or result.token_count(),
            "total_tokens": result.total_tokens or (result.prompt_tokens + result.token_count()),
        },
    }


class STTextCompletionRequest(BaseModel):
    """KoboldAI-protocol text completion request body.

    Used by ST `/api/backends/text-completions/generate`. Unlike
    chat-completions, this receives a pre-assembled `prompt` string (not a
    messages array) and returns KoboldAI-style `{"results": [{"text": ...}]}`.
    """

    prompt: str
    max_length: int = 300
    max_context_length: int = 2048
    temperature: float = 0.5
    top_p: float = 0.9
    top_k: int = 0
    rep_pen: float = 1.1
    min_p: float = 0
    tfs: float = 1.0
    typical: float = 1.0
    frmtmultinoise: bool = False
    frmttrimincmpl: bool = False
    sampler_order: Optional[list[int]] = None
    stop_sequence: Optional[list[str]] = None
    stream: bool = False
    model: Optional[str] = None


@router.post("/api/backends/text-completions/generate")
async def st_generate_text_completion(
    payload: STTextCompletionRequest,
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    # KoboldAI text-completions receives a pre-assembled prompt string; do
    # NOT run Palink's assemble_roleplay_prompt here. Convert to OpenAI-style
    # messages for the inference dispatcher.
    prompt = (payload.prompt or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="prompt cannot be empty")
    messages = [{"role": "user", "content": prompt}]

    model_id = payload.model or _model_from_request(request, db=db)
    try:
        ensure_model_available(model_id)
    except ValueError:
        fallback_model = _default_model_id_for_db(db)
        try:
            ensure_model_available(fallback_model)
            model_id = fallback_model
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    chat_completion_source = _resolve_chat_completion_source(db, user.id)

    temperature = payload.temperature
    top_p = payload.top_p
    max_tokens = payload.max_length
    repetition_penalty = payload.rep_pen
    top_k = payload.top_k
    min_p = payload.min_p

    if payload.stream:
        async def stream_generator() -> AsyncGenerator[str, None]:
            result = StreamResult()
            try:
                palink_stream = stream_text_completion(
                    model_id=model_id,
                    messages=messages,
                    temperature=temperature,
                    top_p=top_p,
                    max_tokens=max_tokens,
                    repetition_penalty=repetition_penalty,
                    top_k=top_k,
                    min_p=min_p,
                    timeout=120.0,
                    chat_completion_source=chat_completion_source,
                )
                async for sse_event in stream_chat_deltas(palink_stream, result):
                    try:
                        data = json.loads(sse_event.removeprefix("data: ").strip())
                    except Exception:
                        continue
                    token = ""
                    if isinstance(data.get("content"), str):
                        token += data["content"]
                    if isinstance(data.get("reasoning"), str):
                        token += data["reasoning"]
                    if token:
                        yield f"data: {json.dumps({'token': token}, ensure_ascii=False)}\n\n"
                yield "data: [DONE]\n\n"
            except Exception as exc:
                error_text = result.full_content or f"[Palink generation failed: {exc}]"
                yield f"data: {json.dumps({'token': error_text}, ensure_ascii=False)}\n\n"
                yield "data: [DONE]\n\n"

        return StreamingResponse(
            stream_generator(),
            media_type="text/event-stream; charset=utf-8",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    result = StreamResult()
    try:
        palink_stream = stream_text_completion(
            model_id=model_id,
            messages=messages,
            temperature=temperature,
            top_p=top_p,
            max_tokens=max_tokens,
            repetition_penalty=repetition_penalty,
            top_k=top_k,
            min_p=min_p,
            timeout=120.0,
            chat_completion_source=chat_completion_source,
        )
        async for _ in stream_chat_deltas(palink_stream, result):
            pass
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Palink generation failed: {exc}") from exc

    return {"results": [{"text": result.full_content}]}


_DEFAULT_ST_LOCALES = [
    "en",
    "ar-sa",
    "zh-cn",
    "zh-tw",
    "nl-nl",
    "de-de",
    "es-es",
    "fr-fr",
    "is-is",
    "it-it",
    "ja-jp",
    "ko-kr",
    "pt-pt",
    "ru-ru",
    "th-th",
    "uk-ua",
    "vi-vn",
]


def _load_st_locales() -> list[str]:
    """读取可用的 ST 语言列表。

    优先从 frontend/public/st/locales/lang.json 读取，失败时回退到硬编码默认值。
    返回的列表始终包含 "en"（默认语言）。
    """
    candidate_paths = [
        os.path.join(os.path.dirname(__file__), "..", "..", "..", "frontend", "public", "st", "locales", "lang.json"),
        os.path.join("frontend", "public", "st", "locales", "lang.json"),
    ]
    for path in candidate_paths:
        try:
            real = os.path.realpath(path)
            if not os.path.isfile(real):
                continue
            with open(real, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, list):
                locales = ["en"]
                seen = {"en"}
                for item in data:
                    if isinstance(item, dict) and item.get("lang"):
                        lang = item["lang"]
                        if lang not in seen:
                            locales.append(lang)
                            seen.add(lang)
                return locales
        except (OSError, json.JSONDecodeError):
            continue
    return list(_DEFAULT_ST_LOCALES)


def _resolve_st_locale(settings_data: dict) -> str:
    """从用户 power_user 设置中读取 UI 语言，未配置时默认 "en"。"""
    power_user = settings_data.get("power_user") if isinstance(settings_data.get("power_user"), dict) else {}
    locale = power_user.get("language") if isinstance(power_user, dict) else None
    if not locale or not isinstance(locale, str):
        locale = "en"
    return locale


@router.post("/api/settings/get")
async def st_get_settings(
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    setting = _get_or_create_user_setting(user, db)
    stored = _safe_json_loads(setting.silly_tavern_settings, {})
    settings_data = _merge_palink_defaults(stored if isinstance(stored, dict) else {}, db, user, setting)
    settings_data = _apply_palink_connection_defaults(settings_data, request, db)

    # Fix-7/8/9: 从 Palink DB 回填 extension_settings.themes / note /
    # power_user.personas / persona_description，使 Palink 原生 UI 创建的
    # 主题、Author Note、Persona 在 ST sidecar 中可见。blob 中已有对应字段
    # 时优先使用 blob 数据，不覆盖。
    _backfill_themes_from_db(settings_data, db, user)
    _backfill_author_note_to_extension_settings(settings_data, setting)
    _backfill_personas_to_power_user(settings_data, db, user, setting)

    boot_character_id = request.headers.get("X-Palink-Character-Id")
    if boot_character_id:
        character = db.query(Character).filter(Character.id == boot_character_id, Character.user_id == user.id).first()
        if character:
            settings_data["active_character"] = _avatar_key(character.id)
            settings_data = _boot_settings_override(settings_data, request, db)
            session_id = request.headers.get("X-Palink-Session-Id")
            session = None
            if session_id:
                session = _boot_session(db, user, character, session_id)
            session = session or _latest_session(db, user, character)
            if session:
                settings_data["palink"] = {
                    **(settings_data.get("palink") if isinstance(settings_data.get("palink"), dict) else {}),
                    "boot_session_id": session.id,
                    "boot_chat_file": _session_file_name(session.id),
                }

    return {
        "result": "ok",
        "settings": _json_dumps(settings_data),
        "enable_accounts": False,
        "enable_extensions": bool(_st_native_session_payload(request)),
        "enable_extensions_auto_update": bool(_st_native_session_payload(request)),
        "request_compression": {"enabled": False, "minPayloadSize": 0, "maxPayloadSize": 0, "timeout": 0},
        "koboldai_settings": [],
        "koboldai_setting_names": [],
        "novelai_settings": [],
        "novelai_setting_names": [],
        "textgenerationwebui_presets": [],
        "textgenerationwebui_preset_names": [],
        "openai_settings": [],
        "openai_setting_names": [],
        "world_names": _get_global_world_names(db, user),
        # Fix-7: 从 extension_settings.themes 读取主题列表（非硬编码空数组）
        "themes": _extract_themes_from_settings(settings_data),
        "movingUIPresets": [],
        # Fix-6: 从 extension_settings.quickReplyV2.sets 读取 Quick Reply presets
        "quickReplyPresets": _extract_quick_reply_presets(settings_data),
        "i18n_state": {
            "locale": _resolve_st_locale(settings_data),
            "locales": _load_st_locales(),
        },
    }


@router.post("/api/settings/save")
async def st_save_settings(
    request: Request,
    payload: dict[str, Any],
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    setting = _get_or_create_user_setting(user, db)
    payload_data = payload if isinstance(payload, dict) else {}
    payload_data = _apply_palink_connection_defaults(payload_data, request, db)

    # T3 (ST 插件兼容): extension_settings 增量合并，避免整体覆盖丢失扩展设置。
    # 语义：
    #   1. payload 带 extension_settings → 与旧值做 namespace 级合并
    #      （namespace 内整体替换，与 ST 自身「整 namespace 覆盖」行为一致）；
    #   2. payload 不带 extension_settings 但旧 blob 有 → 保留旧值，
    #      防止旧调用方（或部分保存）意外擦除扩展设置。
    old_stored = _safe_json_loads(setting.silly_tavern_settings, {})
    old_ext = (
        old_stored.get("extension_settings")
        if isinstance(old_stored, dict) and isinstance(old_stored.get("extension_settings"), dict)
        else None
    )
    payload_ext = payload_data.get("extension_settings")
    if isinstance(payload_ext, dict):
        if old_ext:
            payload_data["extension_settings"] = {**old_ext, **payload_ext}
    elif old_ext:
        payload_data["extension_settings"] = old_ext

    setting.silly_tavern_settings = _json_dumps(payload_data)
    # ST 1.18.0 ui_settings: persist separately from silly_tavern_settings
    # so UI-specific preferences survive independently. Default to "{}".
    ui_settings_value = payload_data.get("ui_settings")
    if isinstance(ui_settings_value, dict):
        setting.ui_settings = _json_dumps(ui_settings_value)
    elif isinstance(ui_settings_value, str):
        setting.ui_settings = ui_settings_value

    # Fix-8: 同步 extension_settings.note → UserSetting（Author's Note）
    _sync_author_note_from_extension_settings(payload_data, setting)

    # D1 修复: 同步 power_user.jailbreak / oai_settings jailbreak → UserSetting.jailbreak
    _sync_jailbreak_from_settings(payload_data, setting)

    # Fix-9: 同步 power_user.personas → Persona 表
    _sync_personas_from_power_user(payload_data, user, db, setting)

    # Fix-7: 同步 extension_settings.themes → Theme 表
    _sync_themes_from_extension_settings(payload_data, user, db)

    db.commit()
    return {"result": "ok"}


# ─────────────────────────────────────────────────────────────────────────────
# P1-8 修复: ST 兼容变量端点 — 同步到 Palink DB（GlobalVariable / ChatVariable 表）
# 参考: ST 1.18.0 public/scripts/variables.js
# 端点:
#   POST /api/variables/get         - 获取当前会话的 chat 变量（含 global 回退）
#   POST /api/variables/set         - 设置 chat 变量
#   POST /api/variables/delete      - 删除 chat 变量
#   POST /api/variables/global/get  - 获取所有 global 变量
#   POST /api/variables/global/set  - 设置 global 变量
#   POST /api/variables/global/delete - 删除 global 变量
# 语义对齐 ST:
#   - chat 变量存储在 chat_metadata.variables 中（Palink 用 ChatVariable 表）
#   - global 变量存储在 variables.json 中（Palink 用 GlobalVariable 表）
#   - /api/variables/get 不带 variableName 时返回所有 chat 变量
# ─────────────────────────────────────────────────────────────────────────────


@router.post("/api/variables/global/get")
async def st_get_global_variables(
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """获取所有 global 变量（对齐 ST /api/variables/global/get）。

    Body 可选: { "variableName": "key" } - 获取单个变量
    无 Body 或 variableName 为空 - 获取所有变量
    """
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    var_name = body.get("variableName") if isinstance(body, dict) else None

    items = db.query(GlobalVariable).filter(GlobalVariable.user_id == user.id).all()
    all_vars = {item.key: item.value for item in items if item.value is not None}

    if var_name:
        return {"result": "ok", "value": all_vars.get(var_name, "")}
    return {"result": "ok", "variables": all_vars}


@router.post("/api/variables/global/set")
async def st_set_global_variable(
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """设置 global 变量（对齐 ST /api/variables/global/set）。

    Body: { "variableName": "key", "variableValue": "value" }
    """
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    if not isinstance(body, dict) or not body.get("variableName"):
        raise HTTPException(status_code=400, detail="variableName is required")

    key = str(body["variableName"])
    value = body.get("variableValue", "")

    existing = db.query(GlobalVariable).filter(
        GlobalVariable.user_id == user.id,
        GlobalVariable.key == key,
    ).first()
    if existing:
        existing.value = value
    else:
        db.add(GlobalVariable(user_id=user.id, key=key, value=value))
    db.commit()
    return {"result": "ok"}


@router.post("/api/variables/global/delete")
async def st_delete_global_variable(
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """删除 global 变量（对齐 ST /api/variables/global/delete）。

    Body: { "variableName": "key" }
    """
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    if not isinstance(body, dict) or not body.get("variableName"):
        raise HTTPException(status_code=400, detail="variableName is required")

    key = str(body["variableName"])
    existing = db.query(GlobalVariable).filter(
        GlobalVariable.user_id == user.id,
        GlobalVariable.key == key,
    ).first()
    if existing:
        db.delete(existing)
        db.commit()
    return {"result": "ok"}


def _verify_session_ownership(
    db: Session,
    user: User,
    session_id: str,
) -> Optional[CharacterChatSession]:
    """S-4 修复: 校验 X-Palink-Session-Id 归属当前用户。

    查询 ChatVariable 前解析 session 并校验 user_id，防止水平越权
    （攻击者传他人 session_id 读取/写入他人 chat 变量）。
    找不到 session 时返回 None（调用方决定 404 或忽略）。
    """
    session = (
        db.query(CharacterChatSession)
        .filter(
            CharacterChatSession.id == str(session_id).strip(),
            CharacterChatSession.user_id == user.id,
        )
        .first()
    )
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


@router.post("/api/variables/get")
async def st_get_chat_variable(
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """获取 chat 变量（对齐 ST /api/variables/get）。

    Body 可选: { "variableName": "key" } - 获取单个变量
    无 Body 或 variableName 为空 - 获取当前会话所有变量

    会话通过 X-Palink-Session-Id header 解析。
    """
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    var_name = body.get("variableName") if isinstance(body, dict) else None
    session_id = request.headers.get("X-Palink-Session-Id")

    if not session_id:
        # 无会话上下文: 回退到 global 变量
        items = db.query(GlobalVariable).filter(GlobalVariable.user_id == user.id).all()
        all_vars = {item.key: item.value for item in items if item.value is not None}
        if var_name:
            return {"result": "ok", "value": all_vars.get(var_name, "")}
        return {"result": "ok", "variables": all_vars}

    # S-4 修复: 查询前校验 session 归属当前用户（防止水平越权）
    _verify_session_ownership(db, user, session_id)
    items = db.query(ChatVariable).filter(ChatVariable.session_id == session_id).all()
    chat_vars = {item.key: item.value for item in items if item.value is not None}

    # 合并 global 变量（chat 变量优先）
    global_items = db.query(GlobalVariable).filter(GlobalVariable.user_id == user.id).all()
    global_vars = {item.key: item.value for item in global_items if item.value is not None}
    merged = {**global_vars, **chat_vars}

    if var_name:
        return {"result": "ok", "value": merged.get(var_name, "")}
    return {"result": "ok", "variables": merged}


@router.post("/api/variables/set")
async def st_set_chat_variable(
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """设置 chat 变量（对齐 ST /api/variables/set）。

    Body: { "variableName": "key", "variableValue": "value" }
    会话通过 X-Palink-Session-Id header 解析。
    无会话时回退到 global 变量。
    """
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    if not isinstance(body, dict) or not body.get("variableName"):
        raise HTTPException(status_code=400, detail="variableName is required")

    key = str(body["variableName"])
    value = body.get("variableValue", "")
    session_id = request.headers.get("X-Palink-Session-Id")

    if not session_id:
        # 无会话: 写入 global 变量
        existing = db.query(GlobalVariable).filter(
            GlobalVariable.user_id == user.id,
            GlobalVariable.key == key,
        ).first()
        if existing:
            existing.value = value
        else:
            db.add(GlobalVariable(user_id=user.id, key=key, value=value))
        db.commit()
        return {"result": "ok"}

    # S-4 修复: 查询前校验 session 归属当前用户（防止水平越权）
    _verify_session_ownership(db, user, session_id)
    existing = db.query(ChatVariable).filter(
        ChatVariable.session_id == session_id,
        ChatVariable.key == key,
    ).first()
    if existing:
        existing.value = value
    else:
        db.add(ChatVariable(session_id=session_id, key=key, value=value))
    db.commit()
    return {"result": "ok"}


@router.post("/api/variables/delete")
async def st_delete_chat_variable(
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """删除 chat 变量（对齐 ST /api/variables/delete）。

    Body: { "variableName": "key" }
    """
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    if not isinstance(body, dict) or not body.get("variableName"):
        raise HTTPException(status_code=400, detail="variableName is required")

    key = str(body["variableName"])
    session_id = request.headers.get("X-Palink-Session-Id")

    if session_id:
        # S-4 修复: 校验 session 归属当前用户（防止删除他人变量）
        _verify_session_ownership(db, user, session_id)
        existing = db.query(ChatVariable).filter(
            ChatVariable.session_id == session_id,
            ChatVariable.key == key,
        ).first()
        if existing:
            db.delete(existing)
            db.commit()
    return {"result": "ok"}


@router.post("/api/characters/all")
async def st_all_characters(
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    boot_character_id = request.headers.get("X-Palink-Character-Id")
    boot_session_id = request.headers.get("X-Palink-Session-Id")
    query = db.query(Character).filter(Character.user_id == user.id)
    characters = query.order_by(Character.updated_at.desc(), Character.created_at.desc()).all()
    if boot_character_id:
        characters.sort(key=lambda c: 0 if c.id == boot_character_id else 1)
        characters = characters[:50]

    # E-6 修复: 一次窗口函数查询（ROW_NUMBER() PARTITION BY character_id）
    # 批量取每个角色的最新会话，替代每角色 1 次 _latest_session 查询（N+1）。
    # 窗口函数在 PostgreSQL 与 SQLite(3.25+) 均受支持；排序与原 _latest_session
    # （coalesce(updated_at, created_at) desc, created_at desc 取首条）完全一致。
    character_ids = [c.id for c in characters]
    latest_by_char: dict[str, CharacterChatSession] = {}
    if character_ids:
        _rn = func.row_number().over(
            partition_by=CharacterChatSession.character_id,
            order_by=(
                func.coalesce(CharacterChatSession.updated_at, CharacterChatSession.created_at).desc(),
                CharacterChatSession.created_at.desc(),
            ),
        ).label("_rn")
        _ranked_sub = (
            db.query(CharacterChatSession, _rn)
            .filter(
                CharacterChatSession.user_id == user.id,
                CharacterChatSession.character_id.in_(character_ids),
            )
            .subquery()
        )
        _ranked_alias = aliased(CharacterChatSession, _ranked_sub)
        latest_sessions = (
            db.query(_ranked_alias)
            .filter(_ranked_sub.c._rn == 1)
            .all()
        )
        latest_by_char = {s.character_id: s for s in latest_sessions}

    return [
        _character_to_st_list_item(
            character,
            (
                _boot_session(db, user, character, boot_session_id)
                if boot_character_id and character.id == boot_character_id
                else latest_by_char.get(character.id)
            ),
        )
        for character in characters
    ]


@router.post("/api/characters/get")
async def st_get_character(
    req: AvatarRequest,
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    character = _character_for_avatar(
        db,
        user,
        _request_avatar(req),
        selectinload(Character.world_books).selectinload(WorldBook.entries),
    )
    return _character_to_st(character, user, _boot_session(db, user, character, request.headers.get("X-Palink-Session-Id")))


class CharacterEditRequest(BaseModel):
    avatar_url: Optional[str] = None
    avatar: Optional[str] = None
    name: Optional[str] = None
    description: Optional[str] = None
    personality: Optional[str] = None
    scenario: Optional[str] = None
    first_mes: Optional[str] = None
    mes_example: Optional[str] = None
    system_prompt: Optional[str] = None
    creator: Optional[str] = None
    character_version: Optional[str] = None
    creator_notes: Optional[str] = None
    post_history_instructions: Optional[str] = None
    tags: Optional[list[str]] = None
    alternate_greetings: Optional[list[str]] = None
    extensions: Optional[dict[str, Any]] = None
    data: Optional[dict[str, Any]] = None
    talkativeness: Optional[str] = None
    nickname: Optional[str] = None
    group_only_greetings: Optional[list[str]] = None


@router.post("/api/characters/edit")
async def st_edit_character(
    req: CharacterEditRequest,
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """ST 编辑角色卡回写到 Palink DB"""
    avatar_key = _request_avatar(req) or ""
    character_id = _character_id_from_avatar(avatar_key)
    if not character_id:
        raise HTTPException(status_code=400, detail="Invalid avatar")

    character = (
        db.query(Character)
        .filter(Character.id == character_id, Character.user_id == user.id)
        .first()
    )
    if not character:
        raise HTTPException(status_code=404, detail="Character not found")

    if req.name is not None:
        character.name = req.name.strip() or character.name
    if req.description is not None:
        character.description = req.description
    if req.personality is not None:
        character.personality = req.personality
    if req.scenario is not None:
        character.scenario = req.scenario
    if req.first_mes is not None:
        character.first_mes = req.first_mes
    if req.mes_example is not None:
        character.mes_example = req.mes_example
    if req.system_prompt is not None:
        character.system_prompt = req.system_prompt
    if req.creator is not None:
        character.creator = req.creator
    if req.character_version is not None:
        character.character_version = req.character_version
    if req.creator_notes is not None:
        character.creator_notes = req.creator_notes
    if req.post_history_instructions is not None:
        character.post_history_instructions = req.post_history_instructions
    if req.tags is not None:
        character.tags = _json_dumps(req.tags)
    if req.alternate_greetings is not None:
        character.alternate_greetings = _json_dumps(req.alternate_greetings)
    if req.extensions is not None:
        existing_ext = _safe_json_loads(character.extensions, {})
        if isinstance(existing_ext, dict):
            existing_ext.update(req.extensions)
        else:
            existing_ext = req.extensions
        character.extensions = _json_dumps(existing_ext)

    if req.talkativeness is not None:
        character.talkativeness = req.talkativeness
    if req.nickname is not None:
        character.nickname = req.nickname
    if req.group_only_greetings is not None:
        character.group_only_greetings = _json_dumps(req.group_only_greetings)

    if req.data is not None and isinstance(req.data, dict):
        data_extensions = req.data.get("extensions")
        if isinstance(data_extensions, dict):
            existing_ext = _safe_json_loads(character.extensions, {})
            if isinstance(existing_ext, dict):
                existing_ext.update(data_extensions)
            else:
                existing_ext = data_extensions
            character.extensions = _json_dumps(existing_ext)

        data_ui = req.data.get("extensions", {}).get("palink_ui") if isinstance(req.data.get("extensions"), dict) else None
        if data_ui:
            character.ui_config = _json_dumps(data_ui)

        depth_prompt = req.data.get("depth_prompt")
        if depth_prompt is not None:
            existing_ext = _safe_json_loads(character.extensions, {})
            if isinstance(existing_ext, dict):
                existing_ext["depth_prompt"] = depth_prompt
                character.extensions = _json_dumps(existing_ext)

        character_book = req.data.get("character_book")
        if character_book is not None and isinstance(character_book, dict):
            _sync_character_book_to_palink(db, character, character_book)

        # ST 1.18.0 V3 chara card fields may also arrive inside data block
        data_talkativeness = req.data.get("talkativeness")
        if data_talkativeness is not None:
            character.talkativeness = str(data_talkativeness)
        data_nickname = req.data.get("nickname")
        if data_nickname is not None:
            character.nickname = str(data_nickname)
        data_group_only_greetings = req.data.get("group_only_greetings")
        if data_group_only_greetings is not None:
            character.group_only_greetings = _json_dumps(data_group_only_greetings)

    character.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(character)

    # 触发 ST DATA_ROOT 同步（后台非阻塞）
    try:
        from ..services.st_sync_service import trigger_sync_background
        from ..core import SessionLocal
        trigger_sync_background(SessionLocal, user.id, "character", character_id=character.id)
    except Exception:
        logging.getLogger(__name__).debug("ST sync trigger failed for character edit", exc_info=True)

    return {"result": "ok", "character_id": character.id}


@router.post("/api/characters/create")
async def st_create_character(
    req: CharacterEditRequest,
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """ST 创建角色卡回写到 Palink DB"""
    if not req.name or not req.name.strip():
        raise HTTPException(status_code=400, detail="Character name is required")

    character = Character(
        user_id=user.id,
        name=req.name.strip(),
        description=req.description or "",
        personality=req.personality or "",
        scenario=req.scenario or "",
        first_mes=req.first_mes or "",
        mes_example=req.mes_example or "",
        system_prompt=req.system_prompt or "",
        creator=req.creator or "",
        character_version=req.character_version or "",
        creator_notes=req.creator_notes or "",
        post_history_instructions=req.post_history_instructions or "",
        tags=_json_dumps(req.tags or []),
        alternate_greetings=_json_dumps(req.alternate_greetings or []),
        extensions=_json_dumps(req.extensions or {}),
        talkativeness=req.talkativeness,
        nickname=req.nickname,
        group_only_greetings=_json_dumps(req.group_only_greetings) if req.group_only_greetings is not None else None,
    )
    db.add(character)
    db.commit()
    db.refresh(character)

    return {"result": "ok", "character_id": character.id, "avatar": _avatar_key(character.id)}


class CharacterDeleteRequest(BaseModel):
    avatar_url: Optional[str] = None
    avatar: Optional[str] = None
    delete_file: Optional[bool] = True


@router.post("/api/characters/delete")
async def st_delete_character(
    req: CharacterDeleteRequest,
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """ST 删除角色卡回写到 Palink DB"""
    avatar_key = _request_avatar(req) or ""
    character_id = _character_id_from_avatar(avatar_key)
    if not character_id:
        return {"result": "ok"}

    character = (
        db.query(Character)
        .filter(Character.id == character_id, Character.user_id == user.id)
        .first()
    )
    if not character:
        return {"result": "ok"}

    db.delete(character)
    db.commit()
    return {"result": "ok"}


class CharacterDuplicateRequest(BaseModel):
    avatar_url: Optional[str] = None
    avatar: Optional[str] = None


@router.post("/api/characters/duplicate")
async def st_duplicate_character(
    req: CharacterDuplicateRequest,
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """ST 复制角色卡回写到 Palink DB（script.js:6030 调用）"""
    avatar_key = _request_avatar(req) or ""
    character_id = _character_id_from_avatar(avatar_key)
    if not character_id:
        raise HTTPException(status_code=400, detail="Invalid avatar")

    source = (
        db.query(Character)
        .filter(Character.id == character_id, Character.user_id == user.id)
        .first()
    )
    if not source:
        raise HTTPException(status_code=404, detail="Character not found")

    new_name = f"{source.name} (copy)"
    now = datetime.now(timezone.utc)
    duplicate = Character(
        user_id=user.id,
        name=new_name,
        description=source.description,
        background=source.background,
        personality=source.personality,
        avatar=source.avatar,
        scenario=source.scenario,
        first_mes=source.first_mes,
        mes_example=source.mes_example,
        system_prompt=source.system_prompt,
        tags=source.tags,
        creator=source.creator,
        character_version=source.character_version,
        extensions=source.extensions,
        alternate_greetings=source.alternate_greetings,
        creator_notes=source.creator_notes,
        post_history_instructions=source.post_history_instructions,
        ui_config=source.ui_config,
        raw_card_spec_version=source.raw_card_spec_version,
        preset_data=source.preset_data,
        talkativeness=source.talkativeness,
        nickname=source.nickname,
        group_only_greetings=source.group_only_greetings,
        created_at=now,
        updated_at=now,
    )
    db.add(duplicate)
    db.commit()
    db.refresh(duplicate)

    return {"name": duplicate.name, "avatar": _avatar_key(duplicate.id)}


class CharacterRenameRequest(BaseModel):
    avatar_url: Optional[str] = None
    avatar: Optional[str] = None
    new_name: Optional[str] = None


@router.post("/api/characters/rename")
async def st_rename_character(
    req: CharacterRenameRequest,
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """ST 重命名角色卡回写到 Palink DB（script.js:7177 调用）"""
    avatar_key = _request_avatar(req) or ""
    character_id = _character_id_from_avatar(avatar_key)
    if not character_id:
        raise HTTPException(status_code=400, detail="Invalid avatar")

    character = (
        db.query(Character)
        .filter(Character.id == character_id, Character.user_id == user.id)
        .first()
    )
    if not character:
        raise HTTPException(status_code=404, detail="Character not found")

    new_name = str(req.new_name or "").strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="new_name is required")

    character.name = new_name
    character.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(character)

    # 触发 ST DATA_ROOT 同步（后台非阻塞）
    try:
        from ..services.st_sync_service import trigger_sync_background
        from ..core import SessionLocal
        trigger_sync_background(SessionLocal, user.id, "character", character_id=character.id)
    except Exception:
        logging.getLogger(__name__).debug("ST sync trigger failed for character rename", exc_info=True)

    return {"name": character.name, "avatar": _avatar_key(character.id)}


class CharacterMergeAttributesRequest(BaseModel):
    avatar_url: Optional[str] = None
    avatar: Optional[str] = None
    body: Optional[dict[str, Any]] = None
    data: Optional[dict[str, Any]] = None


@router.post("/api/characters/merge-attributes")
async def st_merge_attributes_character(
    req: CharacterMergeAttributesRequest,
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """ST 合并角色卡属性回写到 Palink DB（script.js:10763 调用）

    body/data 中可包含：description、personality、scenario、first_mes、
    mes_example、system_prompt、post_history_instructions、tags、creator_notes、
    character_book、alternate_greetings、extensions 等字段。
    """
    avatar_key = _request_avatar(req) or ""
    character_id = _character_id_from_avatar(avatar_key)
    if not character_id:
        raise HTTPException(status_code=400, detail="Invalid avatar")

    character = (
        db.query(Character)
        .filter(Character.id == character_id, Character.user_id == user.id)
        .first()
    )
    if not character:
        raise HTTPException(status_code=404, detail="Character not found")

    # 合并 body 与 data 中的属性，data 优先（ST v2 角色卡字段多在 data 内）
    merged: dict[str, Any] = {}
    if isinstance(req.body, dict):
        merged.update(req.body)
    if isinstance(req.data, dict):
        merged.update(req.data)

    if "name" in merged and str(merged.get("name") or "").strip():
        character.name = str(merged.get("name")).strip()
    if "description" in merged and merged.get("description") is not None:
        character.description = str(merged.get("description") or "")
    if "personality" in merged and merged.get("personality") is not None:
        character.personality = str(merged.get("personality") or "")
    if "scenario" in merged and merged.get("scenario") is not None:
        character.scenario = str(merged.get("scenario") or "")
    if "first_mes" in merged and merged.get("first_mes") is not None:
        character.first_mes = str(merged.get("first_mes") or "")
    if "mes_example" in merged and merged.get("mes_example") is not None:
        character.mes_example = str(merged.get("mes_example") or "")
    if "system_prompt" in merged and merged.get("system_prompt") is not None:
        character.system_prompt = str(merged.get("system_prompt") or "")
    if "post_history_instructions" in merged and merged.get("post_history_instructions") is not None:
        character.post_history_instructions = str(merged.get("post_history_instructions") or "")
    if "creator_notes" in merged and merged.get("creator_notes") is not None:
        character.creator_notes = str(merged.get("creator_notes") or "")
    if "creator" in merged and merged.get("creator") is not None:
        character.creator = str(merged.get("creator") or "")
    if "character_version" in merged and merged.get("character_version") is not None:
        character.character_version = str(merged.get("character_version") or "")
    if "tags" in merged and merged.get("tags") is not None:
        tags_value = merged.get("tags")
        if isinstance(tags_value, list):
            character.tags = _json_dumps(tags_value)
        elif isinstance(tags_value, str):
            character.tags = tags_value
    if "alternate_greetings" in merged and merged.get("alternate_greetings") is not None:
        greetings = merged.get("alternate_greetings")
        if isinstance(greetings, list):
            character.alternate_greetings = _json_dumps(greetings)
    if "extensions" in merged and isinstance(merged.get("extensions"), dict):
        existing_ext = _safe_json_loads(character.extensions, {})
        if isinstance(existing_ext, dict):
            existing_ext.update(merged.get("extensions"))
        else:
            existing_ext = merged.get("extensions")
        character.extensions = _json_dumps(existing_ext)

    character_book = merged.get("character_book")
    if character_book is not None and isinstance(character_book, dict):
        _sync_character_book_to_palink(db, character, character_book)

    character.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(character)

    return {
        "name": character.name,
        "avatar": _avatar_key(character.id),
        "character_id": character.id,
    }


@router.post("/api/characters/chats")
async def st_character_chats(
    req: AvatarRequest,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    character = _character_for_avatar(db, user, _request_avatar(req))
    sessions = (
        db.query(CharacterChatSession)
        .filter(
            CharacterChatSession.user_id == user.id,
            CharacterChatSession.character_id == character.id,
        )
        .order_by(
            func.coalesce(CharacterChatSession.updated_at, CharacterChatSession.created_at).desc(),
            CharacterChatSession.created_at.desc(),
        )
        .all()
    )
    return [_chat_info(db, session, character) for session in sessions]


def _chat_info(db: Session, session: CharacterChatSession, character: Character) -> dict[str, Any]:
    branch = _active_branch(db, session)
    message_query = db.query(CharacterChatMessage).filter(CharacterChatMessage.session_id == session.id)
    if branch:
        message_query = message_query.filter(CharacterChatMessage.branch_id == branch.id)
    else:
        message_query = message_query.filter(CharacterChatMessage.branch_id.is_(None))
    count = message_query.count()
    last = message_query.order_by(CharacterChatMessage.created_at.desc(), CharacterChatMessage.id.desc()).first()
    preview = (last.content if last else "") or ""
    return {
        "file_name": _session_file_name(session.id, with_suffix=True),
        "file_id": _session_file_name(session.id),
        "chat_name": session.title or character.name,
        "last_mes": _iso(last.created_at if last else session.updated_at or session.created_at),
        "file_size": "DB",
        "message_count": count,
        "preview_message": preview[:180],
    }


@router.post("/api/chats/get")
async def st_get_chat(
    req: ChatGetRequest,
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    character = _character_for_avatar(db, user, _request_avatar(req))
    file_name = _request_file_name(req)
    session_id = request.headers.get("X-Palink-Session-Id")
    branch_id = request.headers.get("X-Palink-Branch-Id")
    session = _session_for_file(db, user, character, file_name, session_id)
    if not session:
        session = _ensure_session(db, user, character, file_name, session_id)
        branch = _branch_for_context(db, session, branch_id)
        return [_chat_header(db, session, character, user, branch)]
    branch = _branch_for_context(db, session, branch_id)
    messages = _chat_messages(db, session, branch)
    return [
        _chat_header(db, session, character, user, branch),
        *[_message_to_st(message, index, character, user) for index, message in enumerate(messages)],
    ]


@router.post("/api/chats/save")
async def st_save_chat(
    req: ChatSaveRequest,
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    character = _character_for_avatar(db, user, _request_avatar(req))
    file_name = _request_file_name(req)
    session = _ensure_session(db, user, character, file_name, request.headers.get("X-Palink-Session-Id"))
    branch = _branch_for_context(db, session, request.headers.get("X-Palink-Branch-Id"))
    if not branch:
        raise HTTPException(status_code=500, detail="Unable to create branch")

    # Handle ST stringified JSON payload: ST sends chat as JSON.stringify([...])
    raw_chat = req.chat
    if isinstance(raw_chat, str):
        try:
            raw_chat = json.loads(raw_chat)
        except (json.JSONDecodeError, TypeError):
            raw_chat = []
    incoming = raw_chat if isinstance(raw_chat, list) else []
    chat_items = []
    persisted_metadata: dict[str, Any] = {}
    for item in incoming:
        if not isinstance(item, dict):
            continue
        if "chat_metadata" in item and "mes" not in item:
            # ST 1.18.0 sends chat_metadata as a dedicated JSONL entry —
            # persist it on the session instead of discarding it.
            raw_meta = item.get("chat_metadata")
            if isinstance(raw_meta, dict):
                persisted_metadata = raw_meta
            elif isinstance(raw_meta, str):
                try:
                    decoded = json.loads(raw_meta)
                    if isinstance(decoded, dict):
                        persisted_metadata = decoded
                except (json.JSONDecodeError, TypeError):
                    pass
            continue
        chat_items.append(item)

    # Re-inject Palink-internal fields so they round-trip via _chat_header.
    # P0-6 修复: 保留 palink_injections（ST 客户端不回传此字段，整体覆盖会丢失）
    # st_chats_inject (silly_tavern.py:6079-6113) 将注入内容写入此字段，
    # 若不保留，下一次 save 会清空注入，导致 prompt 装配读取时为空
    try:
        existing_meta = json.loads(session.chat_metadata) if session.chat_metadata else {}
    except (json.JSONDecodeError, TypeError):
        existing_meta = {}
    if "palink_injections" in existing_meta and "palink_injections" not in persisted_metadata:
        persisted_metadata["palink_injections"] = existing_meta["palink_injections"]
    persisted_metadata["palink_session_id"] = session.id
    persisted_metadata["palink_character_id"] = character.id
    persisted_metadata["palink_branch_id"] = branch.id if branch else None
    session.chat_metadata = json.dumps(persisted_metadata, ensure_ascii=False)

    # Upsert chat_metadata.variables into the ChatVariable table so the
    # independent variable system stays in sync with ST plugin metadata.
    incoming_variables = persisted_metadata.get("variables")
    if isinstance(incoming_variables, dict):
        for var_key, var_value in incoming_variables.items():
            if var_key is None:
                continue
            serialized_value = _serialize_variable_value(var_value)
            existing_var = db.query(ChatVariable).filter(
                ChatVariable.session_id == session.id,
                ChatVariable.key == var_key,
            ).first()
            if existing_var:
                existing_var.value = serialized_value
            else:
                db.add(ChatVariable(session_id=session.id, key=var_key, value=serialized_value))

    db.query(CharacterChatMessage).filter(
        CharacterChatMessage.session_id == session.id,
        CharacterChatMessage.branch_id == branch.id,
    ).delete(synchronize_session=False)

    now = datetime.now(timezone.utc)
    for index, item in enumerate(chat_items):
        content = _st_message_content(item)
        role = _st_message_role(item)
        swipes = _st_message_swipes(item, content)
        try:
            swipe_id = max(0, min(int(item.get("swipe_id") or 0), len(swipes) - 1))
        except (TypeError, ValueError):
            swipe_id = 0
        # 注：ST 原样保存 swipes，不强制 swipes[swipe_id]=content——
        # Galgame 等插件把"格式化文本"写入非当前 swipe（mes 保持原文），
        # 强制覆盖会破坏其 COT 双版本机制。
        extra = _st_message_extra(item, swipes, swipe_id)
        msg = CharacterChatMessage(
            session_id=session.id,
            branch_id=branch.id,
            role=role,
            content=content,
            name=item.get("name"),
            is_user=bool(item.get("is_user")) if item.get("is_user") is not None else role == "user",
            is_system=bool(item.get("is_system")) if item.get("is_system") is not None else role == "system",
            mesid=int(item.get("mesid", index)) if str(item.get("mesid", index)).isdigit() else index,
            swipe_id=swipe_id,
            swipes=_json_dumps(swipes),
            extra=_json_dumps(extra),
            is_hidden=bool(item.get("is_hidden", False)),
            is_locked=bool(item.get("is_locked", False)),
            created_at=now,
        )
        db.add(msg)

    session.title = req.ch_name or session.title or character.name
    session.updated_at = now
    branch.last_message_at = now
    branch.is_frozen = False
    db.commit()

    # 广播 chat_metadata 更新事件，通知已连接的 WebSocket 客户端刷新元数据
    try:
        await ws_manager.broadcast_to_session(session.id, {
            "type": "chat_metadata_updated",
            "session_id": session.id,
            "chat_metadata": json.loads(session.chat_metadata or "{}"),
        })
    except Exception:
        logging.getLogger(__name__).debug(
            "chat_metadata_updated broadcast failed for session %s", session.id, exc_info=True
        )

    # 触发 ST DATA_ROOT 同步（后台非阻塞）
    try:
        from ..services.st_sync_service import trigger_sync_background
        from ..core import SessionLocal
        trigger_sync_background(
            SessionLocal, user.id, "session",
            character_id=character.id, session_id=session.id,
        )
    except Exception:
        logging.getLogger(__name__).debug("ST sync trigger failed for chat save", exc_info=True)

    # P0-1 修复: ST 1.18.0 (chats.js:511) 期望返回 {ok: true}
    # 原 Palink 返回 {result: "ok"} 导致 ST 前端 saveChat 判断 data.ok 失败
    return {"ok": True}


@router.post("/api/chats/search")
async def st_search_chats(
    req: ChatSearchRequest,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    if req.group_id:
        from ..models import GroupChatSession
        group_id = req.group_id
        if group_id.startswith("palink-group-"):
            group_id = group_id[len("palink-group-"):]
            if group_id.endswith(".png"):
                group_id = group_id[:-4]
        sessions = (
            db.query(GroupChatSession)
            .filter(GroupChatSession.group_id == group_id, GroupChatSession.user_id == user.id)
            .order_by(GroupChatSession.updated_at.desc())
            .all()
        )
        return [
            {
                "file_name": f"palink-group-session-{s.id}.jsonl",
                "file_id": f"palink-group-session-{s.id}",
                "chat_name": s.title or "Group Chat",
                "last_mes": _iso(s.updated_at or s.created_at),
                "file_size": "DB",
                "message_count": 0,
                "preview_message": "",
            }
            for s in sessions
        ]
    _character_for_avatar(db, user, _request_avatar(req))
    query_text = str(req.query or "").strip().lower()
    chats = await st_character_chats(AvatarRequest(avatar_url=_request_avatar(req)), user=user, db=db)
    if not query_text:
        return chats
    return [
        item for item in chats
        if query_text in str(item.get("file_name", "")).lower()
        or query_text in str(item.get("chat_name", "")).lower()
        or query_text in str(item.get("preview_message", "")).lower()
    ]


@router.post("/api/chats/delete")
async def st_delete_chat(
    req: ChatDeleteRequest,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    character = _character_for_avatar(db, user, _request_avatar(req))
    session = _session_for_file(db, user, character, req.chatfile)
    if not session:
        # P0-1: ST 1.18.0 (chats.js:595) 期望 {ok: true}
        return {"ok": True}
    session_id = session.id
    # 清理孤儿记录：模型 FK 未声明 ondelete=CASCADE，需手动删除子表数据，
    # 否则 db.delete(session) 触发 FOREIGN KEY constraint failed。
    # 删除顺序遵循 FK 依赖：messages(branch_id→branches) 先于 branches，
    # branches(parent_branch_id 自引用) 先解除自引用再批量删除，最后删 session。
    db.query(ChatVariable).filter(
        ChatVariable.session_id == session_id
    ).delete(synchronize_session=False)
    db.query(CharacterChatMessage).filter(
        CharacterChatMessage.session_id == session_id
    ).delete(synchronize_session=False)
    db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.session_id == session_id,
        CharacterChatSessionBranch.parent_branch_id.isnot(None),
    ).update({CharacterChatSessionBranch.parent_branch_id: None}, synchronize_session=False)
    db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.session_id == session_id
    ).delete(synchronize_session=False)
    db.delete(session)
    db.commit()

    # 清理 ST DATA_ROOT 中的 JSONL 和变量文件
    try:
        from ..services.st_sync_service import _st_data_root_for_user, _session_file_name
        from pathlib import Path
        data_root = _st_data_root_for_user(user)
        if data_root:
            data_root_path = Path(data_root)
            chat_dir = data_root_path / "chats" / (character.name or "character")
            jsonl_path = chat_dir / _session_file_name(session_id, with_suffix=True)
            if jsonl_path.exists():
                jsonl_path.unlink(missing_ok=True)
            var_path = data_root_path / "variables" / f"{_session_file_name(session_id)}.json"
            if var_path.exists():
                var_path.unlink(missing_ok=True)
    except Exception:
        logging.getLogger(__name__).debug("ST DATA_ROOT cleanup failed for chat delete", exc_info=True)

    # P0-1: ST 1.18.0 (chats.js:595) 期望 {ok: true}
    return {"ok": True}


@router.post("/api/chats/rename")
async def st_rename_chat(
    req: ChatRenameRequest,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    character = _character_for_avatar(db, user, _request_avatar(req))
    source_name = req.original_file or req.old_file_name or ""
    session = _session_for_file(db, user, character, source_name)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    target_name = req.new_file_name or req.renamed_file or ""
    if not target_name:
        raise HTTPException(status_code=400, detail="New chat name is required")
    session.title = re.sub(r"\.jsonl$", "", target_name, flags=re.IGNORECASE) or session.title
    session.updated_at = datetime.now(timezone.utc)
    db.commit()
    # P0-1: ST 1.18.0 (chats.js:569) 期望 {ok: true, sanitizedFileName}
    sanitized = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', target_name)
    return {"ok": True, "sanitizedFileName": sanitized}


# ===========================================================================
# Continue / Regenerate / Swipe endpoints (ST-compatible)
#
# REST 端点，复用 roleplay_prompt_assembly + stream_text_completion 管线，
# 通过 SSE (text/event-stream) 流式返回生成内容。不依赖 WebSocket 生成流程，
# 可独立工作。swipes 数据持久化到 CharacterChatMessage.swipes (JSON 数组)。
# ===========================================================================

_swipe_logger = logging.getLogger("palink.st_swipe")


def _resolve_character_for_generation(
    db: Session, user: User, req: ChatGenerationRequest
) -> Character:
    """优先通过 avatar_url 解析角色（ST 风格），其次按 character_name 查找。"""
    avatar_url = _request_avatar(req)
    if avatar_url:
        return _character_for_avatar(db, user, avatar_url)
    name = (req.character_name or "").strip()
    if name:
        character = db.query(Character).filter(
            Character.user_id == user.id,
            Character.name == name,
        ).first()
        if character:
            return character
    raise HTTPException(status_code=404, detail="Character not found")


def _is_assistant_message(message: CharacterChatMessage) -> bool:
    is_user = bool(message.is_user) if message.is_user is not None else message.role == "user"
    is_system = bool(message.is_system) if message.is_system is not None else message.role == "system"
    return not is_user and not is_system


def _is_user_message(message: CharacterChatMessage) -> bool:
    is_user = bool(message.is_user) if message.is_user is not None else message.role == "user"
    return is_user


def _last_assistant_message(
    messages: list[CharacterChatMessage],
) -> Optional[CharacterChatMessage]:
    for msg in reversed(messages):
        if _is_assistant_message(msg):
            return msg
    return None


def _last_user_message_before(
    messages: list[CharacterChatMessage],
    assistant_msg: CharacterChatMessage,
) -> Optional[CharacterChatMessage]:
    """返回指定 assistant 消息之前最近的一条 user 消息。"""
    found = False
    for msg in reversed(messages):
        if not found:
            if msg.id == assistant_msg.id:
                found = True
            continue
        if _is_user_message(msg):
            return msg
    return None


def _normalize_message_swipes(message: CharacterChatMessage) -> list[str]:
    """返回有效的 swipes 列表；为空时用当前 content 初始化。"""
    swipes = _safe_json_loads(message.swipes, [])
    if isinstance(swipes, list) and swipes:
        return [str(item or "") for item in swipes]
    return [message.content or ""]


def _sse_event(payload: dict[str, Any]) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _message_swipe_summary(
    message: CharacterChatMessage, swipes: list[str], swipe_id: int
) -> dict[str, Any]:
    return {
        "id": message.id,
        "content": message.content or "",
        "swipes": swipes,
        "swipe_id": swipe_id,
    }


async def _run_generation_stream(
    *,
    user: User,
    char: Character,
    session: CharacterChatSession,
    branch: Optional[CharacterChatSessionBranch],
    model: str,
    prompt_message: str,
    is_continue: bool,
    include_user_message: bool,
    temperature: float,
    top_p: Optional[float],
    max_tokens: int,
    persist_fn: Any,
    # D8 修复: 群聊装配路径接通（swipe 场景默认无群聊上下文，传 None）
    group_id: Optional[str] = None,
    current_speaker_id: Optional[str] = None,
    # ST 对齐: 透传生成类型（swipe/continue/regenerate），使 {{lastGenerationType}}
    # 宏正确反映实际操作，而非硬编码 "normal"；1:1 场景仅影响该宏，不改变其它行为。
    generation_type: Optional[str] = None,
) -> AsyncGenerator[str, None]:
    """组装提示词 → 流式生成 → 持久化，全程以 SSE 事件形式 yield。

    persist_fn(full_content: str, db: Session) -> dict 会在生成完成后被调用，
    负责将结果写入 DB 并返回用于 ``done`` 事件的摘要 dict。
    """
    # 延迟导入避免 services ↔ api 循环依赖（与 websocket.py 保持一致）
    from ..api.character_ext import (
        _build_char_system_prompt,
        _replace_placeholders,
        _get_full_branch_history,
        _get_ancestor_branch_ids,
        _contains_chinese,
        _apply_regex_scripts,
        _apply_plugin_regex_scripts,
        _apply_prompt_regex_to_messages,
    )
    from ..core.database import SessionLocal
    from ..services.roleplay_prompt_assembly import (
        PromptAssemblyDeps,
        PromptAssemblyRequest,
        assemble_roleplay_prompt,
    )

    gen_db = SessionLocal()
    try:
        gen_char = gen_db.query(Character).filter(
            Character.id == char.id, Character.user_id == user.id
        ).first()
        gen_user = gen_db.query(User).filter(User.id == user.id).first()
        if not gen_char or not gen_user:
            yield _sse_event({"type": "error", "error": "Character or user not found"})
            yield "data: [DONE]\n\n"
            return

        try:
            assembly = await assemble_roleplay_prompt(
                PromptAssemblyRequest(
                    db=gen_db,
                    user=gen_user,
                    char=gen_char,
                    session_id=session.id,
                    branch_id=branch.id if branch else None,
                    message=prompt_message,
                    model=model,
                    user_nickname=gen_user.username or "User",
                    max_tokens=max_tokens,
                    is_continue=is_continue,
                    include_user_message=include_user_message,
                    # D8 修复: 群聊装配路径接通
                    group_id=group_id,
                    current_speaker_id=current_speaker_id,
                    # ST 对齐: 透传生成类型供 {{lastGenerationType}} 宏使用
                    generation_type=generation_type,
                ),
                PromptAssemblyDeps(
                    build_system_prompt=_build_char_system_prompt,
                    replace_placeholders=_replace_placeholders,
                    get_full_branch_history=_get_full_branch_history,
                    get_ancestor_branch_ids=_get_ancestor_branch_ids,
                    contains_chinese=_contains_chinese,
                    apply_plugin_regex_scripts=_apply_plugin_regex_scripts,
                    apply_regex_scripts=_apply_regex_scripts,
                    apply_prompt_regex_to_messages=_apply_prompt_regex_to_messages,
                ),
            )
        except Exception as exc:
            _swipe_logger.exception("Prompt assembly failed for generation stream")
            yield _sse_event({"type": "error", "error": f"Prompt assembly failed: {exc}"})
            yield "data: [DONE]\n\n"
            return

        result = StreamResult()
        try:
            stream = stream_text_completion(
                model_id=model,
                messages=assembly.messages,
                temperature=temperature,
                top_p=top_p,
                max_tokens=assembly.effective_max_tokens or max_tokens,
                timeout=120.0,
                user_id=user.id,
            )
            async for delta in stream:
                evt_type = delta.get("type")
                if evt_type == "queue":
                    yield _sse_event(delta)
                    continue
                usage = delta.get("usage")
                if usage:
                    result.total_tokens = int(usage.get("total_tokens", 0) or 0)
                    result.completion_tokens = int(usage.get("completion_tokens", 0) or 0)
                    continue
                content = delta.get("content")
                reasoning = delta.get("reasoning")
                if isinstance(reasoning, str) and reasoning:
                    result.full_reasoning += reasoning
                    yield _sse_event({"reasoning": reasoning})
                if isinstance(content, str) and content:
                    result.full_content += content
                    yield _sse_event({"content": content})
        except Exception as exc:
            _swipe_logger.exception("Generation stream failed")
            yield _sse_event({"type": "error", "error": f"Generation failed: {exc}"})
            yield "data: [DONE]\n\n"
            return

        if not result.full_content:
            yield _sse_event({"type": "error", "error": "模型未返回任何内容"})
            yield "data: [DONE]\n\n"
            return

        try:
            updated = persist_fn(result.full_content, gen_db)
            yield _sse_event({"type": "done", "message": updated})
        except Exception as exc:
            _swipe_logger.exception("Persistence failed for generation stream")
            yield _sse_event({"type": "error", "error": f"Persistence failed: {exc}"})
        yield "data: [DONE]\n\n"
    finally:
        gen_db.close()


def _generation_stream_headers() -> dict[str, str]:
    return {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


def _touch_session_branch(
    db: Session, session_id: str, branch_id: Optional[str]
) -> None:
    """在指定 DB session 上更新 session/branch 时间戳（保证与 commit 同库）。"""
    sess = db.query(CharacterChatSession).filter(
        CharacterChatSession.id == session_id
    ).first()
    if sess:
        sess.updated_at = datetime.now(timezone.utc)
    if branch_id:
        br = db.query(CharacterChatSessionBranch).filter(
            CharacterChatSessionBranch.id == branch_id
        ).first()
        if br:
            br.last_message_at = datetime.now(timezone.utc)


@router.post("/api/chats/continue")
async def st_continue_chat(
    req: ChatGenerationRequest,
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """续写最后一条 assistant 消息：以现有内容为前缀继续生成。"""
    character = _resolve_character_for_generation(db, user, req)
    session = _session_for_file(
        db, user, character, req.file_name, request.headers.get("X-Palink-Session-Id")
    )
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    branch = _branch_for_context(db, session, request.headers.get("X-Palink-Branch-Id"))
    messages = _chat_messages(db, session, branch)
    last_assistant = _last_assistant_message(messages)
    if not last_assistant:
        raise HTTPException(status_code=400, detail="No assistant message to continue")

    model = req.model or "local:test-model"
    temperature = float(req.temperature) if req.temperature is not None else 0.7
    top_p = float(req.top_p) if req.top_p is not None else None
    max_tokens = int(req.max_tokens) if req.max_tokens else 2048
    prefix = last_assistant.content or ""
    last_assistant_id = last_assistant.id
    session_id = session.id
    branch_id_val = branch.id if branch else None

    def persist_fn(full_content: str, persist_db: Session) -> dict[str, Any]:
        msg = persist_db.query(CharacterChatMessage).filter(
            CharacterChatMessage.id == last_assistant_id
        ).first()
        if not msg:
            return {"id": last_assistant_id, "content": prefix + full_content}
        new_content = prefix + full_content
        msg.content = new_content
        swipes = _normalize_message_swipes(msg)
        try:
            swipe_id = max(0, min(int(msg.swipe_id or 0), len(swipes) - 1))
        except (TypeError, ValueError):
            swipe_id = 0
        if 0 <= swipe_id < len(swipes):
            swipes[swipe_id] = new_content
        else:
            swipes.append(new_content)
            swipe_id = len(swipes) - 1
        msg.swipes = _json_dumps(swipes)
        msg.swipe_id = swipe_id
        msg.model = model
        _touch_session_branch(persist_db, session_id, branch_id_val)
        persist_db.commit()
        return _message_swipe_summary(msg, swipes, swipe_id)

    return StreamingResponse(
        _run_generation_stream(
            user=user,
            char=character,
            session=session,
            branch=branch,
            model=model,
            prompt_message="",
            is_continue=True,
            include_user_message=False,
            temperature=temperature,
            top_p=top_p,
            max_tokens=max_tokens,
            persist_fn=persist_fn,
            generation_type="continue",
        ),
        media_type="text/event-stream; charset=utf-8",
        headers=_generation_stream_headers(),
    )


@router.post("/api/chats/regenerate")
async def st_regenerate_chat(
    req: ChatGenerationRequest,
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """重新生成最后一条 assistant 消息：旧内容保留为 swipe，新内容替换当前内容。"""
    character = _resolve_character_for_generation(db, user, req)
    session = _session_for_file(
        db, user, character, req.file_name, request.headers.get("X-Palink-Session-Id")
    )
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    branch = _branch_for_context(db, session, request.headers.get("X-Palink-Branch-Id"))
    messages = _chat_messages(db, session, branch)
    last_assistant = _last_assistant_message(messages)
    if not last_assistant:
        raise HTTPException(status_code=400, detail="No assistant message to regenerate")
    last_user = _last_user_message_before(messages, last_assistant)

    model = req.model or "local:test-model"
    temperature = float(req.temperature) if req.temperature is not None else 0.7
    top_p = float(req.top_p) if req.top_p is not None else None
    max_tokens = int(req.max_tokens) if req.max_tokens else 2048
    prompt_message = (last_user.content if last_user else "") or ""
    last_assistant_id = last_assistant.id
    session_id = session.id
    branch_id_val = branch.id if branch else None

    def persist_fn(full_content: str, persist_db: Session) -> dict[str, Any]:
        msg = persist_db.query(CharacterChatMessage).filter(
            CharacterChatMessage.id == last_assistant_id
        ).first()
        if not msg:
            return {"id": last_assistant_id, "content": full_content}
        # 保留当前内容到 swipes（_normalize_message_swipes 已包含当前 content）
        swipes = _normalize_message_swipes(msg)
        # 追加新内容作为一个新 swipe
        swipes.append(full_content)
        new_swipe_id = len(swipes) - 1
        msg.swipes = _json_dumps(swipes)
        msg.swipe_id = new_swipe_id
        msg.content = full_content
        msg.model = model
        _touch_session_branch(persist_db, session_id, branch_id_val)
        persist_db.commit()
        return _message_swipe_summary(msg, swipes, new_swipe_id)

    return StreamingResponse(
        _run_generation_stream(
            user=user,
            char=character,
            session=session,
            branch=branch,
            model=model,
            prompt_message=prompt_message,
            is_continue=False,
            include_user_message=False,
            temperature=temperature,
            top_p=top_p,
            max_tokens=max_tokens,
            persist_fn=persist_fn,
            generation_type="regenerate",
        ),
        media_type="text/event-stream; charset=utf-8",
        headers=_generation_stream_headers(),
    )


@router.post("/api/chats/swipe")
async def st_swipe_chat(
    req: ChatGenerationRequest,
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """生成一个新的 swipe（备用回复），追加到 swipes 数组并切换到新 swipe。"""
    character = _resolve_character_for_generation(db, user, req)
    session = _session_for_file(
        db, user, character, req.file_name, request.headers.get("X-Palink-Session-Id")
    )
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    branch = _branch_for_context(db, session, request.headers.get("X-Palink-Branch-Id"))
    messages = _chat_messages(db, session, branch)
    last_assistant = _last_assistant_message(messages)
    if not last_assistant:
        raise HTTPException(status_code=400, detail="No assistant message to swipe")
    last_user = _last_user_message_before(messages, last_assistant)

    model = req.model or "local:test-model"
    temperature = float(req.temperature) if req.temperature is not None else 0.7
    top_p = float(req.top_p) if req.top_p is not None else None
    max_tokens = int(req.max_tokens) if req.max_tokens else 2048
    prompt_message = (last_user.content if last_user else "") or ""
    last_assistant_id = last_assistant.id
    session_id = session.id
    branch_id_val = branch.id if branch else None

    def persist_fn(full_content: str, persist_db: Session) -> dict[str, Any]:
        msg = persist_db.query(CharacterChatMessage).filter(
            CharacterChatMessage.id == last_assistant_id
        ).first()
        if not msg:
            return {"id": last_assistant_id, "content": full_content}
        swipes = _normalize_message_swipes(msg)
        swipes.append(full_content)
        new_swipe_id = len(swipes) - 1
        msg.swipes = _json_dumps(swipes)
        msg.swipe_id = new_swipe_id
        msg.content = full_content
        msg.model = model
        _touch_session_branch(persist_db, session_id, branch_id_val)
        persist_db.commit()
        return _message_swipe_summary(msg, swipes, new_swipe_id)

    return StreamingResponse(
        _run_generation_stream(
            user=user,
            char=character,
            session=session,
            branch=branch,
            model=model,
            prompt_message=prompt_message,
            is_continue=False,
            include_user_message=False,
            temperature=temperature,
            top_p=top_p,
            max_tokens=max_tokens,
            persist_fn=persist_fn,
            generation_type="swipe",
        ),
        media_type="text/event-stream; charset=utf-8",
        headers=_generation_stream_headers(),
    )


@router.post("/api/chats/swipe/{index}")
async def st_swipe_select(
    index: int,
    req: ChatGenerationRequest,
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """切换到最后一条 assistant 消息的指定 swipe。无需生成。"""
    character = _resolve_character_for_generation(db, user, req)
    session = _session_for_file(
        db, user, character, req.file_name, request.headers.get("X-Palink-Session-Id")
    )
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    branch = _branch_for_context(db, session, request.headers.get("X-Palink-Branch-Id"))
    messages = _chat_messages(db, session, branch)
    last_assistant = _last_assistant_message(messages)
    if not last_assistant:
        raise HTTPException(status_code=400, detail="No assistant message found")

    swipes = _normalize_message_swipes(last_assistant)
    if index < 0 or index >= len(swipes):
        raise HTTPException(
            status_code=400,
            detail=f"Swipe index {index} out of range (0-{len(swipes) - 1})",
        )

    last_assistant.swipe_id = index
    last_assistant.content = swipes[index]
    session.updated_at = datetime.now(timezone.utc)
    if branch:
        branch.last_message_at = datetime.now(timezone.utc)
    db.commit()

    return {
        "result": "ok",
        "message": _message_swipe_summary(last_assistant, swipes, index),
    }


@router.delete("/api/chats/{session_id}/messages/{message_id}/swipes/{swipe_index}")
async def st_delete_swipe(
    session_id: str,
    message_id: int,
    swipe_index: int,
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """P1-5 修复: 删除指定 swipe（对齐 ST swipe 删除语义）。

    语义:
    - 删除指定 index 的 swipe
    - 若删除的是当前激活 swipe，自动切换到剩余的第一个 swipe
    - 若 swipe 列表只剩 1 个，返回 400（不允许删除最后一个）
    - 同步更新 message.content 为切换后的 swipe 内容
    """
    session = db.query(CharacterChatSession).filter(
        CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id,
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    msg = db.query(CharacterChatMessage).filter(
        CharacterChatMessage.id == message_id,
        CharacterChatMessage.session_id == session_id,
    ).first()
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")

    swipes = _normalize_message_swipes(msg)
    if len(swipes) <= 1:
        raise HTTPException(
            status_code=400,
            detail="Cannot delete the only swipe; at least one must remain",
        )
    if swipe_index < 0 or swipe_index >= len(swipes):
        raise HTTPException(
            status_code=400,
            detail=f"Swipe index {swipe_index} out of range (0-{len(swipes) - 1})",
        )

    # 同步删除 swipe_info 中对应项
    try:
        extra_raw = _safe_json_loads(msg.extra, {})
        swipe_info = extra_raw.get("swipe_info") if isinstance(extra_raw, dict) else None
        if isinstance(swipe_info, list) and swipe_index < len(swipe_info):
            swipe_info.pop(swipe_index)
            extra_raw["swipe_info"] = swipe_info
            msg.extra = _json_dumps(extra_raw)
    except Exception:
        pass

    del swipes[swipe_index]
    # 切换激活 swipe: 若删除的是当前激活项，回退到第一个；否则保持原索引（若超界则回退）
    current_swipe_id = int(getattr(msg, "swipe_id", 0) or 0)
    if current_swipe_id == swipe_index:
        new_swipe_id = 0
    elif current_swipe_id > swipe_index:
        new_swipe_id = current_swipe_id - 1
    else:
        new_swipe_id = current_swipe_id
    new_swipe_id = max(0, min(new_swipe_id, len(swipes) - 1))

    msg.swipes = _json_dumps(swipes)
    msg.swipe_id = new_swipe_id
    msg.content = swipes[new_swipe_id]
    session.updated_at = datetime.now(timezone.utc)
    db.commit()

    return {
        "result": "ok",
        "message": _message_swipe_summary(msg, swipes, new_swipe_id),
    }


@router.post("/api/chats/{session_id}/impersonate")
async def st_impersonate(
    session_id: str,
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """P1-4 修复: impersonate 生成（对齐 ST slash-commands.js:1945）。

    语义: 以当前角色身份生成一段"用户可能说的话"，作为用户消息返回。
    不写入 chat history，结果通过 SSE 流返回，前端可作为用户消息插入输入框
    或直接发送（ST 行为: 前端把生成文本放入输入框，用户可编辑后发送）。

    与 /api/chats/continue 类似的流式生成，但:
    - 不装配 chat history 中的最后一条 AI 消息作为前缀
    - 使用专门的 impersonate 系统提示词
    - persist_fn 为 None（不写入 chat history）
    """
    session = db.query(CharacterChatSession).filter(
        CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id,
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    character = session.character
    if not character:
        raise HTTPException(status_code=400, detail="No character bound to session")

    branch = _branch_for_context(db, session, request.headers.get("X-Palink-Branch-Id"))
    body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
    model = body.get("model") or "local:test-model"
    temperature = float(body.get("temperature", 0.7))
    top_p = float(body.get("top_p", 0.95)) if body.get("top_p") is not None else None
    max_tokens = int(body.get("max_tokens", 1024))
    instruction = (body.get("instruction") or body.get("prompt") or "").strip()

    # 构造 impersonate 提示词: 让 LLM 以用户视角回复
    char_name = character.name or "Character"
    user_name = user.username or "User"
    impersonate_system = (
        f"You are now impersonating {user_name}. "
        f"Based on the conversation with {char_name}, "
        f"write a reply as {user_name} would. "
        f"Output only the user's message content, no narration or system notes."
    )
    impersonate_prompt = f"{impersonate_system}\n\n"
    if instruction:
        impersonate_prompt += f"Context hint: {instruction}\n\n"
    impersonate_prompt += f"Write {user_name}'s next message:"

    async def _impersonate_stream():
        try:
            from ..services.inference_dispatcher import complete_text_completion
            completion = await complete_text_completion(
                model_id=model,
                messages=[{"role": "user", "content": impersonate_prompt}],
                temperature=temperature,
                top_p=top_p,
                max_tokens=max_tokens,
                timeout=60.0,
            )
            text = completion.get("content") or ""
            yield _sse_event({
                "type": "impersonate_complete",
                "content": text,
                "role": "user",
                "session_id": session_id,
            })
        except Exception as exc:
            yield _sse_event({
                "type": "error",
                "error": f"Impersonate failed: {exc}",
            })

    return StreamingResponse(
        _impersonate_stream(),
        media_type="text/event-stream; charset=utf-8",
        headers=_generation_stream_headers(),
    )


def _worldbook_entries_for_character(db: Session, character: Character) -> dict[str, dict[str, Any]]:
    wb = db.query(WorldBook).filter(WorldBook.character_id == character.id).first()
    if not wb:
        return {}
    entries: dict[str, dict[str, Any]] = {}
    for stage in wb.entries:
        uid = str(stage.id)[:8]
        entries[uid] = {
            "uid": uid,
            "key": _safe_json_loads(stage.keys, []),
            "keysecondary": _safe_json_loads(stage.secondary_keys, []),
            "content": stage.content or "",
            "comment": stage.title or "",
            "constant": bool(stage.constant),
            "selective": bool(stage.selective),
            "order": stage.order if stage.order is not None else 0,
            "position": stage.position if stage.position is not None else 4,
            "depth": stage.depth if stage.depth is not None else 4,
            "probability": stage.probability if stage.probability is not None else 100,
            "useProbability": (stage.probability if stage.probability is not None else 100) < 100,
            "sticky": stage.sticky if stage.sticky is not None else 0,
            "cooldown": stage.cooldown if stage.cooldown is not None else 0,
            "delay": stage.delay if stage.delay is not None else 0,
            "disabled": not bool(stage.enabled),
            "addMemo": bool(stage.add_memo),
            "displayIndex": stage.stage_index or 0,
            "group": stage.group or "",
            "groupOverride": bool(stage.group_override),
            "groupWeight": stage.group_weight if stage.group_weight is not None else 0,
            "scanDepth": stage.scan_depth if stage.scan_depth is not None else 4,
            "caseSensitive": bool(stage.case_sensitive),
            "matchWholeWords": bool(stage.match_whole_words),
            "excludeRecursion": bool(stage.exclude_recursion),
            "preventRecursion": bool(stage.prevent_recursion),
            "selectiveLogic": stage.selective_logic if stage.selective_logic is not None else 0,
            "useGroups": bool(stage.group) and not bool(stage.group_override),
            "decorators": _safe_json_loads(stage.decorators, []),
            "extensions": _safe_json_loads(stage.extensions_json, {}),
            "token_count": stage.token_count or 0,
        }
    return entries


class WorldInfoNameRequest(BaseModel):
    """ST 1.18.0 世界书端点请求体：以世界书 name 作为标识符。

    对齐 SillyTavern 1.18.0 ``src/endpoints/worldinfo.js`` 的真实契约：
      - /api/worldinfo/get   body = {name}
      - /api/worldinfo/edit  body = {name, data}
      - /api/worldinfo/delete body = {name}
    所有端点均通过全局世界书的 name 定位，不再使用 Palink 早期的 avatar_url。
    """
    name: str = ""


class WorldInfoEditRequest(BaseModel):
    """ST 1.18.0 /api/worldinfo/edit 请求体：{name, data}。

    ``data`` 为完整的 ST 世界书对象（含 entries dict），由端点整体覆盖保存。
    """
    name: str = ""
    data: dict[str, Any] = Field(default_factory=dict)


def _nullable_bool(value: Any) -> Optional[bool]:
    """ST nullable-boolean semantics: None stays None (inherit global), else bool().

    Used for entry fields like useGroupScoring/caseSensitive/matchWholeWords whose
    ST default is null (inherit global setting) rather than False.
    """
    if value is None:
        return None
    return bool(value)


def _create_stage_from_st_entry(
    wb_id: str,
    entry: dict[str, Any],
    stage_index: int,
    now: datetime,
) -> WorldBookStage:
    """从 ST 1.18.0 世界书条目 dict 创建 WorldBookStage（覆盖全部 ST 字段）。

    用于 /api/worldinfo/edit 与 /api/worldinfo/import 的条目持久化，
    确保所有 ST 1.18.0 高级字段（match_*、min_activations、delay_until_recursion、
    triggers、outlet_name 等）均被保留。
    """
    entry_content = str(entry.get("content") or "").strip()
    if not entry_content:
        entry_content = ""
    if len(entry_content) > 50000:
        entry_content = entry_content[:50000]

    def _int_or(key: str, default: int) -> int:
        v = entry.get(key)
        return v if isinstance(v, int) else default

    return WorldBookStage(
        id=str(uuid.uuid4()),
        world_book_id=wb_id,
        stage_index=stage_index,
        title=str(entry.get("comment") or f"Entry {stage_index}")[:200],
        content=entry_content,
        token_count=len(entry_content) // 4,
        keys=_json_dumps(entry_keys(entry)),
        secondary_keys=_json_dumps(entry_secondary_keys(entry)),
        scan_depth=_int_or("scanDepth", 4),
        position=_int_or("position", 4),
        depth=_int_or("depth", 4),
        order=_int_or("order", stage_index),
        selective=bool(entry.get("selective")),
        probability=entry.get("probability") if entry.get("probability") is not None else 100,
        constant=bool(entry.get("constant")),
        enabled=not entry_is_disabled(entry),
        case_sensitive=bool(entry.get("caseSensitive")),
        match_whole_words=bool(entry.get("matchWholeWords")),
        exclude_recursion=bool(entry.get("excludeRecursion")),
        prevent_recursion=bool(entry.get("preventRecursion")),
        selective_logic=_int_or("selectiveLogic", 0),
        sticky=_int_or("sticky", 0),
        cooldown=_int_or("cooldown", 0),
        delay=_int_or("delay", 0),
        group=str(entry.get("group") or "")[:100] or None,
        group_override=bool(entry.get("groupOverride")),
        group_weight=_int_or("groupWeight", 0),
        vectorized=bool(entry.get("vectorized")),
        add_memo=bool(entry.get("addMemo")),
        decorators=_json_dumps(entry.get("decorators") or []),
        extensions_json=_json_dumps(entry.get("extensions") or {}),
        # ST 1.18.0 高级匹配字段
        match_persona_description=bool(entry.get("matchPersonaDescription")),
        match_character_description=bool(entry.get("matchCharacterDescription")),
        match_character_personality=bool(entry.get("matchCharacterPersonality")),
        match_character_depth_prompt=bool(entry.get("matchCharacterDepthPrompt")),
        match_scenario=bool(entry.get("matchScenario")),
        match_creator_notes=bool(entry.get("matchCreatorNotes")),
        # ST 1.18.0 分组与递归控制字段
        min_activations=_int_or("minActivations", 0),
        delay_until_recursion=_int_or("delayUntilRecursion", 0),
        triggers=_json_dumps(entry.get("triggers") or []),
        outlet_name=str(entry.get("outletName") or "")[:200] or None,
        # Bug #6: ST 1.18.0 ignoreBudget — 顶层 ignoreBudget 优先，回退 extensions.ignore_budget
        ignore_budget=bool(
            entry.get("ignoreBudget")
            or (entry.get("extensions") or {}).get("ignore_budget", False)
        ),
        # ST 1.18.0 role/useGroupScoring/automationId（顶层字段，回退 extensions.*）
        # Reference: world-info.js newWorldInfoEntryDefinition:4035-4037, convertCharacterBook:5535-5537
        role=(
            entry.get("role")
            if isinstance(entry.get("role"), int)
            else (entry.get("extensions") or {}).get("role", 0)
            if isinstance((entry.get("extensions") or {}).get("role"), int)
            else 0
        ),
        use_group_scoring=_nullable_bool(
            entry.get("useGroupScoring")
            if entry.get("useGroupScoring") is not None
            else (entry.get("extensions") or {}).get("use_group_scoring")
        ),
        automation_id=(
            str(
                entry.get("automationId")
                if entry.get("automationId") is not None
                else (entry.get("extensions") or {}).get("automation_id") or ""
            )[:200]
            or None
        ),
        created_at=now,
    )


@router.post("/api/worldinfo/get")
async def st_get_worldinfo(
    req: WorldInfoNameRequest,
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """ST 1.18.0 /api/worldinfo/get：按 name 获取全局世界书。

    对齐 ST ``src/endpoints/worldinfo.js`` router.post('/get', ...)：
      - body = {name}，name 为全局世界书名称
      - 找不到时返回 {entries: {}}（ST allowDummy=true 行为）
      - 找到时返回完整世界书对象（含 entries dict）
    """
    if not req.name:
        raise HTTPException(status_code=400, detail="World name is required")
    wb = _resolve_worldbook(db, user, world_id=None, name=req.name)
    if not wb:
        # ST readWorldInfoFile(allowDummy=true) 返回 {entries: {}}
        return {"entries": {}}
    return _worldbook_to_st_world_info(wb, db)


@router.post("/api/worldinfo/edit")
async def st_edit_worldinfo(
    req: WorldInfoEditRequest,
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """ST 1.18.0 /api/worldinfo/edit：按 name 整体保存全局世界书。

    对齐 ST ``src/endpoints/worldinfo.js`` router.post('/edit', ...)：
      - body = {name, data}，data 为完整世界书对象（含 entries dict）
      - data 必须包含 entries 字段，否则返回 400
      - 若世界书不存在则创建，存在则整体覆盖（删除旧条目 + 写入新条目）
      - 成功返回 {ok: true}（与 ST 一致）
    """
    if not req.name:
        raise HTTPException(status_code=400, detail="World name is required")
    if not isinstance(req.data, dict) or "entries" not in req.data:
        raise HTTPException(status_code=400, detail="World info must contain an entries list")

    entries = req.data.get("entries", {})
    if not isinstance(entries, dict):
        entries = {}
    # 过滤非 dict 条目
    entries = {k: v for k, v in entries.items() if isinstance(v, dict)}

    now = datetime.now(timezone.utc)
    wb = _resolve_worldbook(db, user, world_id=None, name=req.name)

    if wb:
        # 整体覆盖：删除旧条目（直接用 query 删除，避免关系缓存陈旧）
        db.query(WorldBookStage).filter(WorldBookStage.world_book_id == wb.id).delete(synchronize_session=False)
        db.flush()
        # 更新描述
        wb.description = str(req.data.get("description") or "")[:5000] or None
        wb.updated_at = now
    else:
        # 创建新的全局世界书
        wb = WorldBook(
            id=str(uuid.uuid4()),
            user_id=user.id,
            character_id=None,
            name=req.name,
            description=str(req.data.get("description") or "")[:5000] or None,
            source_type="online_edit",
            format="silly_tavern_v2",
            tags=_json_dumps(req.data.get("tags", [])),
            is_parsed=False,
            type="world_book",
            created_at=now,
            updated_at=now,
        )
        db.add(wb)
        db.flush()

    # 写入新条目（按 order 排序）
    stage_index = 0
    MAX_EDIT_ENTRIES = 500
    for _key, entry in sorted(
        entries.items(),
        key=lambda x: x[1].get("order", 0) if isinstance(x[1], dict) else 0,
    ):
        if stage_index >= MAX_EDIT_ENTRIES:
            break
        stage = _create_stage_from_st_entry(wb.id, entry, stage_index, now)
        db.add(stage)
        stage_index += 1

    if stage_index > 0:
        wb.is_parsed = True
    db.commit()

    # 触发 ST DATA_ROOT 同步（后台非阻塞）
    try:
        from ..services.st_sync_service import trigger_sync_background
        from ..core import SessionLocal
        trigger_sync_background(SessionLocal, user.id, "worldbook", world_book_id=wb.id)
    except Exception:
        logging.getLogger(__name__).debug("ST sync trigger failed for worldinfo edit", exc_info=True)

    # ST 1.18.0 返回 {ok: true}
    return {"ok": True}


@router.post("/api/worldinfo/delete")
async def st_delete_worldinfo(
    req: WorldInfoNameRequest,
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """ST 1.18.0 /api/worldinfo/delete：按 name 删除整个全局世界书。

    对齐 ST ``src/endpoints/worldinfo.js`` router.post('/delete', ...)：
      - body = {name}，name 为全局世界书名称
      - 删除整个世界书（含所有条目），而非单个条目
      - 成功返回 200（空 body）
    """
    if not req.name:
        raise HTTPException(status_code=400, detail="World name is required")
    wb = _resolve_worldbook(db, user, world_id=None, name=req.name)
    if wb:
        db.delete(wb)
        db.commit()
    # ST 返回 sendStatus(200)，即 200 空响应
    return Response(status_code=200)


# ---------------------------------------------------------------------------
# ST sidecar transparent proxy
# ---------------------------------------------------------------------------

_PROXY_LOGGER = logging.getLogger("palink.st_proxy")

_PROXY_STRIP_HEADERS = frozenset({
    "authorization",
    "cookie",
    "host",
    "content-length",
    "connection",
    "upgrade",
    "transfer-encoding",
})


def _is_proxy_strip_header(name: str) -> bool:
    lower = name.lower()
    if lower in _PROXY_STRIP_HEADERS:
        return True
    if lower.startswith("proxy-"):
        return True
    # S-5 修复: 强制拦截全部 X-Palink-* 业务头，防止客户端伪造
    # X-Palink-User-Id/X-Palink-Session-Id 等头注入 ST sidecar。
    # 转发目标所需的 X-Palink-* 由 _build_proxy_request_headers 依据
    # 服务端验证过的 user/session_payload 重建，客户端提供的值一律丢弃。
    if lower.startswith("x-palink-"):
        return True
    return False


_PROXY_TIMEOUT = httpx.Timeout(
    connect=10.0,
    read=600.0,
    write=600.0,
    pool=30.0,
)


def _validate_proxy_path(path: str) -> None:
    if not path or not path.strip():
        raise HTTPException(status_code=400, detail="Proxy path is empty")
    if ".." in path:
        raise HTTPException(status_code=400, detail="Path traversal is not allowed")
    if "\r" in path or "\n" in path:
        raise HTTPException(status_code=400, detail="CRLF injection is not allowed")
    lower = path.lower().lstrip("/")
    if lower.startswith("http://") or lower.startswith("https://"):
        raise HTTPException(status_code=400, detail="Absolute URLs are not allowed")
    if "api/st/native/proxy" in lower:
        raise HTTPException(status_code=400, detail="Recursive proxy is not allowed")


def _build_proxy_target_url(path: str, query_string: str) -> str:
    base = str(app_settings.ST_NATIVE_SERVICE_URL or "").rstrip("/")
    if not base:
        raise HTTPException(status_code=500, detail="ST_NATIVE_SERVICE_URL is not configured")
    clean_path = path.lstrip("/")
    target = f"{base}/{clean_path}"
    if query_string:
        target = f"{target}?{query_string}"
    return target


def _build_proxy_request_headers(
    request: Request,
    user: User,
    session_payload: dict[str, Any],
) -> dict[str, str]:
    headers: dict[str, str] = {}
    for key, value in request.headers.items():
        if _is_proxy_strip_header(key):
            continue
        headers[key] = value
    headers["X-Palink-User-Id"] = str(user.id)
    # [N-6] 与 X-Palink-User-Id 配套的 HMAC 签名头（openai_compat 校验用）
    service_key = str(app_settings.ST_NATIVE_SERVICE_KEY or "").strip()
    if service_key:
        headers["X-Palink-User-Sig"] = sign_service_user_id(user.id)
    headers["X-Palink-Username"] = quote(str(user.username or ""), safe="")
    headers["X-Palink-Is-Admin"] = "1" if str(user.role or "").lower() == "admin" else "0"
    header_map = {
        "character_id": "X-Palink-Character-Id",
        "session_id": "X-Palink-Session-Id",
        "branch_id": "X-Palink-Branch-Id",
        "model": "X-Palink-Model",
    }
    for key, header in header_map.items():
        value = str(session_payload.get(key) or "").strip()
        if value:
            headers[header] = quote(value, safe="")
    if service_key:
        headers["Authorization"] = f"Bearer {service_key}"
    return headers


@router.api_route(
    "/api/st/native/proxy/{path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
)
async def st_native_proxy(
    path: str,
    request: Request,
    user: User = Depends(get_st_current_user),
):
    _validate_proxy_path(path)
    query_string = str(request.url.query) if request.url.query else ""
    target_url = _build_proxy_target_url(path, query_string)
    session_payload = _st_native_session_payload(request)
    headers = _build_proxy_request_headers(request, user, session_payload)

    body_bytes: Optional[bytes] = None
    if request.method in ("POST", "PUT", "PATCH"):
        body_bytes = await request.body()

    start_ms = time.time() * 1000
    client = httpx.AsyncClient(timeout=_PROXY_TIMEOUT, follow_redirects=False)
    try:
        upstream_response = await client.send(
            client.build_request(
                method=request.method,
                url=target_url,
                headers=headers,
                content=body_bytes,
            ),
            stream=True,
        )
    except httpx.ConnectError as exc:
        await client.aclose()
        _PROXY_LOGGER.warning(
            "st_proxy connect failed method=%s path=%s user=%s err=%s",
            request.method, path, user.id, exc,
        )
        return Response(
            content=json.dumps({"error": "st_proxy_failed", "detail": "connect error"}),
            status_code=502,
            media_type="application/json",
        )
    except httpx.ReadTimeout as exc:
        await client.aclose()
        _PROXY_LOGGER.warning(
            "st_proxy read timeout method=%s path=%s user=%s err=%s",
            request.method, path, user.id, exc,
        )
        return Response(
            content=json.dumps({"error": "st_proxy_failed", "detail": "read timeout"}),
            status_code=502,
            media_type="application/json",
        )
    except httpx.HTTPError as exc:
        await client.aclose()
        _PROXY_LOGGER.warning(
            "st_proxy failed method=%s path=%s user=%s err=%s",
            request.method, path, user.id, exc,
        )
        return Response(
            content=json.dumps({"error": "st_proxy_failed", "detail": str(exc)}),
            status_code=502,
            media_type="application/json",
        )

    duration_ms = time.time() * 1000 - start_ms
    _PROXY_LOGGER.info(
        "st_proxy method=%s path=%s status=%s duration_ms=%.0f user=%s",
        request.method, path, upstream_response.status_code, duration_ms, user.id,
    )

    # 黑名单模式透传上游响应 header：仅剔除 hop-by-hop 与会与分块传输冲突的字段
    response_headers: dict[str, str] = {}
    for key, value in upstream_response.headers.items():
        if key.lower() in ("transfer-encoding", "content-length", "connection"):
            continue
        response_headers[key] = value

    async def _stream_upstream() -> AsyncGenerator[bytes, None]:
        try:
            async for chunk in upstream_response.aiter_raw():
                yield chunk
        finally:
            await upstream_response.aclose()
            await client.aclose()

    return StreamingResponse(
        _stream_upstream(),
        status_code=upstream_response.status_code,
        headers=response_headers,
    )


# ===========================================================================
# ST-compatible import/export & supplementary endpoints
#
# 这些端点弥合 ST 客户端期望与 Palink DB 存储之间的差距，对齐 ST 的公共
# API 形状（script.js 调用点），使 ST 可以导入/导出角色卡、聊天、世界书，
# 并让 provider 扩展面板拿到兼容的空响应而非 404。所有端点都走与桥接器其余
# 部分一致的 get_st_current_user 认证。
# ===========================================================================

_ST_UPLOAD_READ_CHUNK_SIZE = 1024 * 1024
_ST_MAX_CHARACTER_IMPORT_SIZE = 50 * 1024 * 1024
_ST_MAX_CHAT_IMPORT_SIZE = 50 * 1024 * 1024
_ST_MAX_GROUP_IMPORT_SIZE = 50 * 1024 * 1024
_ST_MAX_WORLDINFO_IMPORT_SIZE = 10 * 1024 * 1024
_ST_MAX_IMAGE_UPLOAD_SIZE = 10 * 1024 * 1024
_ST_IMAGES_SUBDIR = "images"

# /api/characters/edit-attribute 允许直接映射到 Character 列的字段名。
_ST_CHARACTER_ATTRIBUTE_FIELDS = {
    "name", "description", "personality", "scenario", "first_mes",
    "mes_example", "system_prompt", "creator", "character_version",
    "creator_notes", "post_history_instructions",
}


def _resolve_upload_field(file: UploadFile | None, avatar: UploadFile | None) -> UploadFile:
    """兼容 ST 前端发 `avatar` 字段与 Palink 前端发 `file` 字段的上传参数。

    ST 1.18.0 全局 multer 用 `avatar` 作为单文件字段名，Palink 此前用 `file`。
    两个字段任选其一；都不提供则 422。
    """
    resolved = file or avatar
    if resolved is None:
        raise HTTPException(status_code=422, detail="No file uploaded (expected 'file' or 'avatar' field)")
    return resolved


async def _st_read_upload(file: UploadFile, max_size: int) -> bytes:
    """读取上传文件，超过 max_size 抛 413。"""
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(_ST_UPLOAD_READ_CHUNK_SIZE)
        if not chunk:
            break
        total += len(chunk)
        if total > max_size:
            raise HTTPException(
                status_code=413,
                detail=f"Uploaded file too large (max {max_size // (1024 * 1024)}MB)",
            )
        chunks.append(chunk)
    return b"".join(chunks)


def _sanitize_relative_path(value: str) -> str:
    """剔除用户提供的子路径中的目录穿越/绝对前缀尝试。"""
    raw = str(value or "").strip().replace("\\", "/")
    parts: list[str] = []
    for part in raw.split("/"):
        if not part or part == ".":
            continue
        if part == "..":
            continue
        parts.append(part)
    return "/".join(parts)


def _placeholder_avatar_png(label: str) -> bytes:
    """生成一张 512x512 带首字母占位 PNG（用于导出时无头像 fallback）。"""
    from PIL import Image, ImageDraw, ImageFont

    initials = (
        "".join(part[:1] for part in re.split(r"\s+", str(label or "AI").strip()) if part)[:2].upper()
        or "AI"
    )
    img = Image.new("RGBA", (512, 512), (37, 99, 235, 255))
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("DejaVuSans-Bold.ttf", 200)
    except OSError:
        font = ImageFont.load_default()
    try:
        bbox = draw.textbbox((0, 0), initials, font=font)
        text_w = bbox[2] - bbox[0]
        text_h = bbox[3] - bbox[1]
    except AttributeError:
        text_w, text_h = font.getsize(initials)
    draw.text(
        ((512 - text_w) // 2, (512 - text_h) // 2 - 40),
        initials,
        fill=(255, 255, 255, 255),
        font=font,
    )
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _avatar_png_bytes(character: Character) -> bytes:
    """返回角色头像的 PNG 字节：解码 data URL 或生成占位图。"""
    avatar = (character.avatar or "").strip()
    if avatar.startswith("data:image/"):
        match = re.match(r"^data:image/[a-zA-Z0-9.+-]+;base64,(.*)$", avatar, flags=re.DOTALL)
        if match:
            try:
                raw = base64.b64decode(match.group(2))
                if raw.startswith(b"\x89PNG\r\n\x1a\n"):
                    return raw
                from PIL import Image
                img = Image.open(io.BytesIO(raw)).convert("RGBA")
                buf = io.BytesIO()
                img.save(buf, format="PNG")
                return buf.getvalue()
            except (ValueError, binascii.Error, OSError):
                pass
    return _placeholder_avatar_png(character.name)


# ---------------------------------------------------------------------------
# Task 1: 角色卡 import / export / edit-avatar / edit-attribute
# ---------------------------------------------------------------------------

@router.post("/api/characters/import")
async def st_import_character(
    file: Optional[UploadFile] = File(None),
    avatar: Optional[UploadFile] = File(None),
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """ST 角色卡导入（PNG 或 JSON）。返回 ST 期望的 {name, filename} 形状。"""
    file = _resolve_upload_field(file, avatar)
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided")
    content = await _st_read_upload(file, _ST_MAX_CHARACTER_IMPORT_SIZE)
    if not content:
        raise HTTPException(status_code=400, detail="Empty file")

    import_service = CharacterImportService(db)
    try:
        result = await import_service.import_from_file(file.filename, content, user.id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Character import failed: {exc}") from exc

    character_id = str(result.get("id") or "")
    character_name = str(result.get("name") or "Imported Character")
    filename = _avatar_key(character_id) if character_id else file.filename
    # [CHAR-LIST-CACHE-FIX] 导入已 commit，但列表接口挂 @cached("character_list")
    # 30s 缓存——不失效会导致前端导入后拉到旧列表：占位卡移除后新卡"闪现即消失"，
    # 刷新也无用（后端缓存仍在 TTL 内），直到缓存过期才出现（2026-08-23 实测）。
    # 对齐 character.py 全部写路径惯例（创建/批量导入均失效 list+detail）。
    invalidate_user_cache("character_list", user.id)
    invalidate_user_cache("character_detail", user.id)
    # 返回形状对齐 character.py:512 老导入端点（前端 handleImportCharacter 读
    # result.character.id / has_character_book / worldbook_entry_count 触发
    # 自动打开对话与世界书提示；name/filename 保留为 ST 形状超集）。
    return {
        "status": "ok",
        "name": character_name,
        "filename": filename,
        "character": result,
        "auto_parsed": False,
    }


class CharacterExportRequest(BaseModel):
    avatar_url: Optional[str] = None
    avatar: Optional[str] = None
    filename: Optional[str] = None
    character_id: Optional[str] = None
    format: Optional[str] = None


@router.post("/api/characters/export")
async def st_export_character(
    req: CharacterExportRequest,
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """ST 角色卡导出（PNG 内嵌 chara 元数据 或 JSON）。"""
    avatar_ref = req.avatar_url or req.avatar or req.filename
    character_id = _character_id_from_avatar(avatar_ref) or req.character_id
    if not character_id:
        raise HTTPException(status_code=400, detail="Character identifier is required")

    character = (
        db.query(Character)
        .filter(Character.id == character_id, Character.user_id == user.id)
        .first()
    )
    if not character:
        raise HTTPException(status_code=404, detail="Character not found")

    wb = next((item for item in (character.world_books or []) if item.type == "character_book"), None)
    chara_card = convert_character_to_chara_card(character, world_book_data=_worldbook_to_charbook(wb))
    fmt = str(req.format or "png").lower()
    safe_name = (
        "".join(c for c in (character.name or "character") if c.isalnum() or c in (" ", "-", "_")).strip()
        or "character"
    )

    if fmt == "json":
        body = json.dumps(chara_card, ensure_ascii=False).encode("utf-8")
        return Response(
            content=body,
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="{safe_name}.json"'},
        )

    try:
        card_png = create_png_with_chara_card(_avatar_png_bytes(character), chara_card)
    except Exception:
        # PIL/嵌入失败 → 回退 JSON，保证导出仍然可用。
        body = json.dumps(chara_card, ensure_ascii=False).encode("utf-8")
        return Response(
            content=body,
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="{safe_name}.json"'},
        )
    return Response(
        content=card_png,
        media_type="image/png",
        headers={"Content-Disposition": f'attachment; filename="{safe_name}.png"'},
    )


@router.post("/api/characters/edit-avatar")
async def st_edit_character_avatar(
    avatar: UploadFile = File(...),
    avatar_url: Optional[str] = Form(None),
    filename: Optional[str] = Form(None),
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """ST 编辑角色头像。返回 {path: avatar_path}。"""
    avatar_ref = avatar_url or filename
    character_id = _character_id_from_avatar(avatar_ref)
    if not character_id:
        raise HTTPException(status_code=400, detail="Invalid avatar reference")
    character = (
        db.query(Character)
        .filter(Character.id == character_id, Character.user_id == user.id)
        .first()
    )
    if not character:
        raise HTTPException(status_code=404, detail="Character not found")

    content = await _st_read_upload(avatar, _ST_MAX_IMAGE_UPLOAD_SIZE)
    if not content:
        raise HTTPException(status_code=400, detail="Empty avatar file")
    mime = (avatar.content_type or "image/png").split(";", 1)[0].strip() or "image/png"
    if mime not in ("image/png", "image/jpeg", "image/webp", "image/gif"):
        mime = "image/png"
    b64 = base64.b64encode(content).decode("ascii")
    character.avatar = f"data:{mime};base64,{b64}"
    character.updated_at = datetime.now(timezone.utc)
    db.commit()
    return {"path": _avatar_key(character.id)}


class CharacterEditAttributeRequest(BaseModel):
    field_name: Optional[str] = None
    value: Any = None
    filename: Optional[str] = None
    avatar_url: Optional[str] = None
    avatar: Optional[str] = None


@router.post("/api/characters/edit-attribute")
async def st_edit_character_attribute(
    req: CharacterEditAttributeRequest,
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """ST 编辑角色卡单个字段。返回更新后的角色数据（同 /api/characters/get 形状）。"""
    avatar_ref = req.filename or req.avatar_url or req.avatar
    character_id = _character_id_from_avatar(avatar_ref)
    if not character_id:
        raise HTTPException(status_code=400, detail="Invalid avatar reference")
    character = (
        db.query(Character)
        .options(selectinload(Character.world_books).selectinload(WorldBook.entries))
        .filter(Character.id == character_id, Character.user_id == user.id)
        .first()
    )
    if not character:
        raise HTTPException(status_code=404, detail="Character not found")

    field_name = str(req.field_name or "").strip()
    if not field_name:
        raise HTTPException(status_code=400, detail="field_name is required")

    if field_name in _ST_CHARACTER_ATTRIBUTE_FIELDS:
        setattr(character, field_name, req.value if req.value is not None else "")
    elif field_name == "tags":
        character.tags = _json_dumps(req.value if isinstance(req.value, list) else [])
    elif field_name == "alternate_greetings":
        character.alternate_greetings = _json_dumps(req.value if isinstance(req.value, list) else [])
    elif field_name == "extensions":
        value = req.value if isinstance(req.value, dict) else {}
        existing = _safe_json_loads(character.extensions, {})
        if isinstance(existing, dict):
            existing.update(value)
        else:
            existing = value
        character.extensions = _json_dumps(existing)
    else:
        raise HTTPException(status_code=400, detail=f"Unsupported field_name: {field_name}")

    character.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(character)
    return _character_to_st(character, user, _latest_session(db, user, character))


# ---------------------------------------------------------------------------
# Task 2: 聊天 import / export / recent
# ---------------------------------------------------------------------------

def _parse_jsonl_chat(content: bytes) -> list[dict[str, Any]]:
    """把 JSONL 字节串解析为 dict 列表（每行一个消息或 metadata 对象）。"""
    items: list[dict[str, Any]] = []
    for raw_line in content.decode("utf-8", errors="replace").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            items.append(obj)
    return items


@router.post("/api/chats/import")
async def st_import_chat(
    file: Optional[UploadFile] = File(None),
    avatar: Optional[UploadFile] = File(None),
    avatar_url: Optional[str] = Form(None),
    ch_name: Optional[str] = Form(None),
    file_type: Optional[str] = Form(None),
    character_name: Optional[str] = Form(None),
    user_name: Optional[str] = Form(None),
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """ST 聊天导入。返回 {name, size}。

    ST 1.18.0 对齐: 支持 file_type 参数:
    - "jsonl" (默认): ST JSONL 格式
    - "json": 多种 JSON 格式自动识别
      * Kobold Lite (savedsettings)
      * CAI Tools (histories，可能含多个独立聊天)
      * Oobabooga (data_visible)
      * Agnai (messages)
      * RisuAI (type === 'risuChat')

    参考: SillyTavern-1.18.0/src/endpoints/chats.js:696-795
    """
    file = _resolve_upload_field(file, avatar)
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided")
    character = _character_for_avatar(db, user, avatar_url)
    content = await _st_read_upload(file, _ST_MAX_CHAT_IMPORT_SIZE)
    if not content:
        raise HTTPException(status_code=400, detail="Empty file")

    # file_type 默认通过文件扩展名判定，回退到 jsonl
    effective_file_type = (file_type or "").lower()
    if not effective_file_type:
        if file.filename.lower().endswith(".json"):
            effective_file_type = "json"
        else:
            effective_file_type = "jsonl"

    # JSON 格式: 转换为消息列表后复用 JSONL 存库逻辑
    if effective_file_type == "json":
        try:
            json_data = json.loads(content.decode("utf-8", errors="replace"))
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="Invalid JSON file")
        if not isinstance(json_data, dict):
            raise HTTPException(status_code=400, detail="JSON must be an object")

        # ST 1.18.0 对齐: character_name / user_name form 参数优先
        # （参考 chats.js:701-702 的 sanitize 后回退逻辑）
        eff_user_name = (user_name or "User").strip() or "User"
        eff_char_name = (character_name or character.name or "Character").strip() or "Character"

        from ..services.chat_import_converters import detect_and_convert
        try:
            converted = detect_and_convert(eff_user_name, eff_char_name, json_data)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

        # CAI Tools 可能返回多个独立聊天，每个创建一个 session
        # 其他格式返回单个聊天列表
        # 检测: list[list[dict]] vs list[dict] —— 第一个元素是否为 list
        is_multi_chat = bool(converted) and isinstance(converted[0], list)
        if is_multi_chat:
            # 多聊天列表: list[list[dict]]
            multi_chats: list[list[dict[str, Any]]] = converted  # type: ignore[assignment]
            results = []
            for idx, chat_items in enumerate(multi_chats):
                # 多聊天时给 chat_name 加索引后缀
                suffix = f" #{idx + 1}" if len(multi_chats) > 1 else ""
                base_name = (
                    ch_name
                    or re.sub(r"\.json$", "", file.filename, flags=re.IGNORECASE)
                    or character.name
                )
                result = _persist_imported_messages(
                    db, user, character, base_name + suffix, chat_items
                )
                results.append(result)
            return {
                "name": results[0]["name"] if results else "",
                "size": sum(r["size"] for r in results),
                "files": results,
            }
        else:
            # 单聊天列表: list[dict]
            items: list[dict[str, Any]] = converted  # type: ignore[assignment]
            chat_name = (
                ch_name
                or re.sub(r"\.json$", "", file.filename, flags=re.IGNORECASE)
                or character.name
            )
            return _persist_imported_messages(db, user, character, chat_name, items)

    # JSONL 格式: 直接解析
    items = _parse_jsonl_chat(content)
    chat_name = (
        ch_name
        or re.sub(r"\.jsonl$", "", file.filename, flags=re.IGNORECASE)
        or character.name
    )
    return _persist_imported_messages(db, user, character, chat_name, items)


def _persist_imported_messages(
    db: Session,
    user: User,
    character: Any,
    chat_name: str,
    items: list[dict[str, Any]],
) -> dict[str, Any]:
    """将转换后的消息列表持久化到新会话。

    抽取自 st_import_chat，供 JSONL / JSON 多格式共用。
    返回 {name, size}。
    """
    now = datetime.now(timezone.utc)
    session = CharacterChatSession(
        character_id=character.id,
        user_id=user.id,
        title=chat_name,
        dialogue_mode="first_person",
        created_at=now,
        updated_at=now,
    )
    db.add(session)
    db.flush()
    branch = CharacterChatSessionBranch(
        session_id=session.id,
        branch_name="Branch 1",
        is_active=True,
        created_at=now,
        last_message_at=now,
    )
    db.add(branch)
    db.flush()

    # 用导入的消息填充新分支。
    db.query(CharacterChatMessage).filter(
        CharacterChatMessage.session_id == session.id,
        CharacterChatMessage.branch_id == branch.id,
    ).delete(synchronize_session=False)

    metadata: dict[str, Any] = {}
    message_count = 0
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        if "chat_metadata" in item and "mes" not in item:
            raw_meta = item.get("chat_metadata")
            if isinstance(raw_meta, dict):
                metadata = raw_meta
            continue
        content_text = _st_message_content(item)
        role = _st_message_role(item)
        swipes = _st_message_swipes(item, content_text)
        try:
            swipe_id = max(0, min(int(item.get("swipe_id") or 0), len(swipes) - 1))
        except (TypeError, ValueError):
            swipe_id = 0
        if swipe_id < len(swipes):
            swipes[swipe_id] = content_text
        extra = _st_message_extra(item, swipes, swipe_id)
        msg = CharacterChatMessage(
            session_id=session.id,
            branch_id=branch.id,
            role=role,
            content=content_text,
            name=item.get("name"),
            is_user=bool(item.get("is_user")) if item.get("is_user") is not None else role == "user",
            is_system=bool(item.get("is_system")) if item.get("is_system") is not None else role == "system",
            mesid=int(item.get("mesid", index)) if str(item.get("mesid", index)).isdigit() else index,
            swipe_id=swipe_id,
            swipes=_json_dumps(swipes),
            extra=_json_dumps(extra),
            created_at=now,
        )
        db.add(msg)
        message_count += 1

    metadata.setdefault("palink_session_id", session.id)
    metadata["palink_character_id"] = character.id
    metadata["palink_branch_id"] = branch.id
    session.chat_metadata = json.dumps(metadata, ensure_ascii=False)
    session.title = chat_name
    session.updated_at = now
    branch.last_message_at = now
    db.commit()
    return {"name": chat_name, "size": message_count}


class ChatExportRequest(ChatGetRequest):
    chat_id: Optional[str] = None
    # ST 1.18.0 兼容字段 (script.js:11447-11453):
    # - format: 'jsonl' (返回原始 JSONL 字符串) 或 'txt'/其他 (返回纯文本)
    # - exportfilename: 用于 success message 的导出文件名
    # - is_group: 是否群聊导出
    # 缺省时 (Palink-native 旧调用) 返回 JSONL 文件下载以保持向后兼容
    format: Optional[str] = None
    exportfilename: Optional[str] = None
    is_group: Optional[bool] = None


@router.post("/api/chats/export")
async def st_export_chat(
    req: ChatExportRequest,
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """ST 聊天导出。

    ST 1.18.0 对齐 (chats.js:604-674 + script.js:11442-11481):
    - 当请求体含 ``format`` 字段时，返回 JSON ``{message, result}``:
      * ``format == 'jsonl'``: result 为原始 JSONL 字符串
      * 其他 (默认 'txt'): result 为纯文本 ``name: message\\n\\n`` (跳过 is_system)
    - 当请求体不含 ``format`` 字段时 (Palink-native 旧调用):
      返回 ``application/jsonl`` 文件下载 (向后兼容)
    """
    character = _character_for_avatar(db, user, _request_avatar(req))
    file_name = req.file_name or req.file or req.chatfile
    session = _session_for_file(db, user, character, file_name, req.chat_id)
    if not session:
        raise HTTPException(status_code=404, detail="Chat session not found")
    branch = _branch_for_context(db, session, request.headers.get("X-Palink-Branch-Id"))
    header = _chat_header(db, session, character, user, branch)
    messages = _chat_messages(db, session, branch)
    # 构建 ST 消息列表 (header + messages)
    st_messages = [header]
    for index, message in enumerate(messages):
        st_messages.append(_message_to_st(message, index, character, user))

    # ST 1.18.0 兼容路径: format 字段存在时返回 JSON {message, result}
    if req.format is not None:
        export_filename = req.exportfilename or f"{(session.title or character.name or 'chat')}.jsonl"
        if req.format.lower() == "jsonl":
            # jsonl 格式: 原始 JSONL 字符串
            result_text = "\n".join(
                json.dumps(msg, ensure_ascii=False) for msg in st_messages
            ) + "\n"
        else:
            # txt/默认格式: 纯文本 (跳过 is_system, 每条 name: message\n\n)
            # 参考 ST 1.18.0 chats.js:645-661
            lines: list[str] = []
            for msg in st_messages[1:]:  # 跳过 header
                if msg.get("is_system"):
                    continue
                mes = msg.get("mes")
                if not mes:
                    continue
                # ST chats.js:658 优先使用 extra.display_text
                extra = msg.get("extra") or {}
                display_text = extra.get("display_text") if isinstance(extra, dict) else None
                text = (display_text or mes).replace("\r\n", "\n").replace("\r", "\n")
                lines.append(f"{msg.get('name')}: {text}\n\n")
            result_text = "".join(lines)
        return JSONResponse({
            "message": f"Chat saved to {export_filename}",
            "result": result_text,
        })

    # Palink-native 旧路径: 返回 JSONL 文件下载 (向后兼容)
    body = ("\n".join(json.dumps(msg, ensure_ascii=False) for msg in st_messages) + "\n").encode("utf-8")
    safe_name = (
        "".join(c for c in (session.title or character.name or "chat") if c.isalnum() or c in (" ", "-", "_")).strip()
        or "chat"
    )
    return Response(
        content=body,
        media_type="application/jsonl",
        headers={"Content-Disposition": f'attachment; filename="{safe_name}.jsonl"'},
    )


@router.post("/api/chats/recent")
async def st_recent_chats(
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """ST 1.18.0 最近聊天列表。

    P0-2 修复: ST 1.18.0 (chats.js:979-1077) 期望返回扁平 ``ChatInfo[]`` 数组，
    每项含 ``file_id/file_name/file_size/chat_items/mes/last_mes/chat_metadata?/avatar``。
    原 Palink 返回 ``{chars: [{name, date, chats: [...]}]}`` 嵌套结构，ST 前端
    无法解析。

    本修复:
    1. 返回扁平数组 (含角色聊天 + 群聊)
    2. 支持 ``max`` 参数限制数量
    3. 支持 ``pinned`` 参数置顶排序
    4. 支持 ``metadata`` 参数控制是否返回 chat_metadata
    5. 字段对齐 ST getChatInfo (chats.js:359-431)
    """
    try:
        body = await request.json()
    except Exception:
        body = {}
    max_count = int(body.get("max") or 100)
    pinned_chats = body.get("pinned") or []
    with_metadata = bool(body.get("metadata"))

    # Pinned 文件名集合 (file_name, avatar/group) 用于置顶判断
    pinned_set = set()
    for p in pinned_chats:
        if isinstance(p, dict):
            fn = p.get("file_name")
            av = p.get("avatar")
            gp = p.get("group")
            if fn:
                pinned_set.add((fn, av, gp))

    all_chats: list[dict[str, Any]] = []

    # 1. 角色聊天
    rows = (
        db.query(CharacterChatSession, Character)
        .join(Character, CharacterChatSession.character_id == Character.id)
        .filter(CharacterChatSession.user_id == user.id)
        .all()
    )
    # E-5 修复: 批量统计每个会话的消息数 + 最新消息 id（2 次 SQL 替代每会话
    # 2 次独立查询 = 2N+1 次）。max(id) 与原 order_by(id.desc()).first() 等价。
    session_ids = [s.id for s, _ in rows]
    msg_stats: dict[str, tuple[int, Optional[int]]] = {}
    last_msgs: dict[int, CharacterChatMessage] = {}
    if session_ids:
        stats_rows = (
            db.query(
                CharacterChatMessage.session_id,
                func.count(CharacterChatMessage.id),
                func.max(CharacterChatMessage.id),
            )
            .filter(CharacterChatMessage.session_id.in_(session_ids))
            .group_by(CharacterChatMessage.session_id)
            .all()
        )
        msg_stats = {sid: (int(cnt), max_id) for sid, cnt, max_id in stats_rows}
        last_ids = [max_id for _, max_id in stats_rows if max_id is not None]
        if last_ids:
            for lm in (
                db.query(CharacterChatMessage)
                .filter(CharacterChatMessage.id.in_(last_ids))
                .all()
            ):
                last_msgs[lm.id] = lm

    for session, character in rows:
        avatar = f"palink-{character.id}.png"
        file_name = _session_file_name(session.id, with_suffix=True)
        file_id = _session_file_name(session.id)
        updated_at = session.updated_at or session.created_at or datetime.now(timezone.utc)

        # 消息计数与最后一条消息（来自批量统计）
        msg_count, _max_id = msg_stats.get(session.id, (0, None))
        last_msg = last_msgs.get(_max_id) if _max_id is not None else None

        # 文件大小估算 (JSONL 行数 * 平均字节)
        file_size = f"{msg_count * 256} B" if msg_count > 0 else "0 B"

        # 最后消息内容
        mes_preview = "[The chat is empty]"
        last_mes_str = _iso(updated_at)
        if last_msg:
            mes_preview = (last_msg.content or "[The message is empty]")[:200]
            last_mes_str = _iso(last_msg.created_at or updated_at)

        chat_info: dict[str, Any] = {
            "match": True,
            "file_id": file_id,
            "file_name": file_name,
            "file_size": file_size,
            "chat_items": msg_count,
            "mes": mes_preview,
            "last_mes": last_mes_str,
            "avatar": avatar,
        }
        if with_metadata:
            try:
                md = json.loads(session.chat_metadata) if session.chat_metadata else {}
            except (json.JSONDecodeError, TypeError):
                md = {}
            chat_info["chat_metadata"] = md

        all_chats.append(chat_info)

    # 2. 群聊 (GroupChatSession)
    try:
        from ..models import GroupChat, GroupChatMessage, GroupChatSession
        group_rows = (
            db.query(GroupChatSession, GroupChat)
            .join(GroupChat, GroupChatSession.group_id == GroupChat.id)
            .filter(GroupChatSession.user_id == user.id)
            .all()
        )
        # E-5 修复: 批量统计群聊消息数 + 最新消息 id（2 次 SQL 替代每会话 2 次）
        gsession_ids = [g.id for g, _ in group_rows]
        gmsg_stats: dict[str, tuple[int, Optional[int]]] = {}
        glast_msgs: dict[int, GroupChatMessage] = {}
        if gsession_ids:
            gstats_rows = (
                db.query(
                    GroupChatMessage.session_id,
                    func.count(GroupChatMessage.id),
                    func.max(GroupChatMessage.id),
                )
                .filter(GroupChatMessage.session_id.in_(gsession_ids))
                .group_by(GroupChatMessage.session_id)
                .all()
            )
            gmsg_stats = {sid: (int(cnt), max_id) for sid, cnt, max_id in gstats_rows}
            glast_ids = [max_id for _, max_id in gstats_rows if max_id is not None]
            if glast_ids:
                for lm in (
                    db.query(GroupChatMessage)
                    .filter(GroupChatMessage.id.in_(glast_ids))
                    .all()
                ):
                    glast_msgs[lm.id] = lm

        for gsession, group in group_rows:
            file_name = f"palink-group-{gsession.id}.jsonl"
            file_id = f"palink-group-{gsession.id}"
            updated_at = gsession.updated_at or gsession.created_at or datetime.now(timezone.utc)
            group_id = f"palink-group-{group.id}"

            # 群聊消息计数与最后一条消息（来自批量统计）
            gmsg_count, _gmax_id = gmsg_stats.get(gsession.id, (0, None))
            last_gmsg = glast_msgs.get(_gmax_id) if _gmax_id is not None else None
            file_size = f"{gmsg_count * 256} B" if gmsg_count > 0 else "0 B"
            mes_preview = (last_gmsg.content if last_gmsg else "[The chat is empty]")[:200]
            last_mes_str = _iso(last_gmsg.created_at or updated_at) if last_gmsg else _iso(updated_at)

            chat_info = {
                "match": True,
                "file_id": file_id,
                "file_name": file_name,
                "file_size": file_size,
                "chat_items": gmsg_count,
                "mes": mes_preview,
                "last_mes": last_mes_str,
                "group": group_id,
            }
            if with_metadata:
                try:
                    md = json.loads(gsession.chat_metadata) if gsession.chat_metadata else {}
                except (json.JSONDecodeError, TypeError):
                    md = {}
                chat_info["chat_metadata"] = md
            all_chats.append(chat_info)
    except Exception:
        logging.getLogger(__name__).debug("GroupChat recent lookup failed", exc_info=True)

    # 排序: pinned 优先 → 按 last_mes 时间倒序
    def _is_pinned(chat: dict) -> bool:
        fn = chat.get("file_name")
        av = chat.get("avatar")
        gp = chat.get("group")
        return (fn, av, gp) in pinned_set or (fn, av, None) in pinned_set or (fn, None, gp) in pinned_set

    # 时间解析为 int (毫秒)
    def _time_key(chat: dict) -> int:
        last_mes = chat.get("last_mes") or ""
        try:
            dt = datetime.fromisoformat(last_mes.replace("Z", "+00:00"))
            return int(dt.timestamp() * 1000)
        except (ValueError, AttributeError):
            return 0

    all_chats.sort(key=lambda c: (not _is_pinned(c), -_time_key(c)))
    return all_chats[:max_count]


# ---------------------------------------------------------------------------
# Task 3: 世界书 list / import
# ---------------------------------------------------------------------------

@router.post("/api/worldinfo/list")
async def st_list_worldinfo(
    request: Request,
    version: Optional[str] = None,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """ST 世界书列表（仅全局世界书）。

    支持两种返回格式：
      - V3（默认）：``{world_id: {name, description, entries: {uid: entry}, order: [uid, ...], originalData: {...}}}``
      - V2：``{world_id: {name, description, entries: {uid: entry}}}``

    V3 兼容性开关：
      - query 参数 ``version=2`` 返回 V2 结构
      - Accept header ``application/vnd.palink.v2+json`` 返回 V2 结构

    Fix-10: ST 1.18.0 updateWorldInfoList 期望 entries 为 dict 格式（{uid: entry}），
    而非数组。_worldbook_to_charbook 返回数组格式（用于 character_book），
    这里转换为 dict 格式用于全局世界书列表。

    Task 1.10: 增加 V3 结构字段 ``order``（按 stage_index 排序的 uid 列表）与
    ``originalData``（保留原始 V2 charbook 结构，便于 ST 编辑器回查原始字段）。
    """
    # V2 兼容性判定：query 参数 version=2 或 Accept header
    accept_header = request.headers.get("accept", "") if request else ""
    want_v2 = (version == "2") or ("vnd.palink.v2" in accept_header)

    worldbooks = (
        db.query(WorldBook)
        .filter(WorldBook.user_id == user.id, WorldBook.character_id.is_(None))
        .all()
    )
    result: dict[str, Any] = {}
    for wb in worldbooks:
        charbook = _worldbook_to_charbook(wb) or {"name": wb.name, "entries": []}
        # 将 entries 数组转换为 {uid: entry} dict 格式
        entries_dict: dict[str, Any] = {}
        order: list[Any] = []
        if isinstance(charbook.get("entries"), list):
            for i, entry in enumerate(charbook["entries"]):
                uid = str(entry.get("id", i))
                entries_dict[uid] = entry
                order.append(uid)
        world_entry: dict[str, Any] = {
            "name": charbook.get("name", wb.name),
            "description": charbook.get("description", ""),
            "entries": entries_dict,
        }
        if not want_v2:
            # Task 1.10: V3 结构追加 order 与 originalData 字段
            # - order: 按 stage_index 排序的 uid 列表（ST 1.18.0 world-info.js 使用此顺序渲染）
            # - originalData: 保留原始 V2 charbook 结构（数组形式 entries），与 ST convertCharacterBook 行为对齐
            world_entry["order"] = order
            world_entry["originalData"] = {
                "name": charbook.get("name", wb.name),
                "description": charbook.get("description", ""),
                "entries": charbook.get("entries") if isinstance(charbook.get("entries"), list) else [],
            }
        result[str(wb.id)] = world_entry
    return result


def _parse_worldinfo_payload(content: bytes, filename: str) -> dict[str, Any]:
    """解析上传的世界书内容（JSON 文件或 PNG 内嵌角色卡）。

    PNG 文件：从 tEXt/zTXt/iTXt chunk 提取角色卡 JSON，再取出
    ``data.character_book`` 或 ``data.world_info`` 字段（兼容 V2/V3）。
    JSON 文件：直接解析为 dict。
    """
    if content[:8] == b"\x89PNG\r\n\x1a\n":
        chara_card = extract_chara_card_from_png(content)
        if not chara_card:
            raise HTTPException(status_code=400, detail="No character card metadata found in PNG")
        card_data = chara_card.get("data", chara_card) if isinstance(chara_card, dict) else {}
        world_info = None
        if isinstance(card_data, dict):
            world_info = card_data.get("character_book") or card_data.get("world_info")
        if not isinstance(world_info, dict):
            raise HTTPException(
                status_code=400,
                detail="No world_info/character_book found in PNG character card",
            )
        return world_info

    try:
        data = json.loads(content.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid JSON file: {exc}") from exc
    return data


def _persist_worldbook_from_data(
    db: Session,
    user: User,
    data: Any,
    raw_filename: str,
) -> str:
    """从解析后的 ST 世界书 dict 创建 WorldBook + WorldBookStage 并提交。

    单文件导入与批量导入共用此逻辑。返回创建的世界书名称。
    """
    entries = data.get("entries", {}) if isinstance(data, dict) else {}
    if not entries and isinstance(data, list):
        entries = {str(i): e for i, e in enumerate(data)}
    if not isinstance(entries, dict):
        entries = {}
    if not entries:
        raise HTTPException(status_code=400, detail="No entries found in world book file")

    if raw_filename.lower().endswith(".json"):
        raw_filename = raw_filename[:-5]
    elif raw_filename.lower().endswith(".png"):
        raw_filename = raw_filename[:-4]
    name = str(data.get("name") or raw_filename or "Imported Worldbook")[:200]
    description = str(data.get("description") or "")[:5000]

    wb = WorldBook(
        id=str(uuid.uuid4()),
        user_id=user.id,
        character_id=None,
        name=name,
        description=description or None,
        source_type="upload",
        format="silly_tavern_v2",
        tags=_json_dumps(data.get("tags", [])),
        is_parsed=False,
        type="world_book",
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )
    db.add(wb)
    db.flush()

    now = datetime.now(timezone.utc)
    MAX_IMPORT_ENTRIES = 500
    stage_index = 0
    for _key, entry in sorted(
        entries.items(),
        key=lambda x: x[1].get("order", 0) if isinstance(x[1], dict) else 0,
    ):
        if stage_index >= MAX_IMPORT_ENTRIES:
            break
        if not isinstance(entry, dict):
            continue
        if entry_is_disabled(entry):
            continue
        entry_content = str(entry.get("content") or "").strip()
        if not entry_content:
            continue
        if len(entry_content) > 50000:
            entry_content = entry_content[:50000]
        stage = WorldBookStage(
            id=str(uuid.uuid4()),
            world_book_id=wb.id,
            stage_index=stage_index,
            title=str(entry.get("comment") or f"Entry {stage_index}")[:200],
            content=entry_content,
            token_count=len(entry_content) // 4,
            keys=_json_dumps(entry_keys(entry)),
            secondary_keys=_json_dumps(entry_secondary_keys(entry)),
            scan_depth=entry.get("scanDepth") if isinstance(entry.get("scanDepth"), int) else 4,
            position=entry.get("position") if isinstance(entry.get("position"), int) else 4,
            depth=entry.get("depth") if isinstance(entry.get("depth"), int) else 4,
            order=entry.get("order") if isinstance(entry.get("order"), int) else stage_index,
            selective=bool(entry.get("selective")),
            probability=entry.get("probability") if entry.get("probability") is not None else 100,
            constant=bool(entry.get("constant")),
            enabled=not entry_is_disabled(entry),
            case_sensitive=bool(entry.get("caseSensitive")),
            match_whole_words=bool(entry.get("matchWholeWords")),
            exclude_recursion=bool(entry.get("excludeRecursion")),
            prevent_recursion=bool(entry.get("preventRecursion")),
            selective_logic=entry.get("selectiveLogic") if isinstance(entry.get("selectiveLogic"), int) else 0,
            sticky=entry.get("sticky") if isinstance(entry.get("sticky"), int) else 0,
            cooldown=entry.get("cooldown") if isinstance(entry.get("cooldown"), int) else 0,
            delay=entry.get("delay") if isinstance(entry.get("delay"), int) else 0,
            group=str(entry.get("group") or "")[:100] or None,
            group_override=bool(entry.get("groupOverride")),
            group_weight=entry.get("groupWeight") if isinstance(entry.get("groupWeight"), int) else 0,
            vectorized=bool(entry.get("vectorized")),
            add_memo=bool(entry.get("addMemo")),
            decorators=_json_dumps(entry.get("decorators") or []),
            extensions_json=_json_dumps(entry.get("extensions") or {}),
            # ST 1.18.0 advanced fields (parity with _create_stage_from_st_entry).
            match_persona_description=bool(entry.get("matchPersonaDescription")),
            match_character_description=bool(entry.get("matchCharacterDescription")),
            match_character_personality=bool(entry.get("matchCharacterPersonality")),
            match_character_depth_prompt=bool(entry.get("matchCharacterDepthPrompt")),
            match_scenario=bool(entry.get("matchScenario")),
            match_creator_notes=bool(entry.get("matchCreatorNotes")),
            min_activations=entry.get("minActivations") if isinstance(entry.get("minActivations"), int) else 0,
            delay_until_recursion=entry.get("delayUntilRecursion") if isinstance(entry.get("delayUntilRecursion"), int) else 0,
            triggers=_json_dumps(entry.get("triggers") or []),
            outlet_name=str(entry.get("outletName") or "")[:200] or None,
            ignore_budget=bool(
                entry.get("ignoreBudget")
                or (entry.get("extensions") or {}).get("ignore_budget", False)
            ),
            role=(
                entry.get("role")
                if isinstance(entry.get("role"), int)
                else (entry.get("extensions") or {}).get("role", 0)
                if isinstance((entry.get("extensions") or {}).get("role"), int)
                else 0
            ),
            use_group_scoring=_nullable_bool(
                entry.get("useGroupScoring")
                if entry.get("useGroupScoring") is not None
                else (entry.get("extensions") or {}).get("use_group_scoring")
            ),
            automation_id=(
                str(
                    entry.get("automationId")
                    if entry.get("automationId") is not None
                    else (entry.get("extensions") or {}).get("automation_id") or ""
                )[:200]
                or None
            ),
            created_at=now,
        )
        db.add(stage)
        stage_index += 1

    if stage_index > 0:
        wb.is_parsed = True
    db.commit()
    return name


def _worldbook_to_st_world_info(wb: WorldBook, db: Optional[Session] = None) -> dict[str, Any]:
    """将 WorldBook DB 对象转换为标准 ST 世界书 JSON 格式（V2 dict entries）。

    输出格式与 ``/api/worldinfo/import`` 接受的输入格式互为逆操作，可直接重新导入。

    若传入 ``db`` session，则直接查询 stages 避免使用可能陈旧的 ORM 关系缓存
    （同一 session 中先 delete 再查询时，``wb.entries`` 可能返回过期数据）。
    """
    if db is not None:
        stages = (
            db.query(WorldBookStage)
            .filter(WorldBookStage.world_book_id == wb.id)
            .order_by(WorldBookStage.stage_index)
            .all()
        )
    else:
        stages = wb.entries or []
    entries: dict[str, Any] = {}
    for i, stage in enumerate(stages):
        entries[str(i)] = {
            "uid": i,
            "key": _safe_json_loads(stage.keys, []),
            "keysecondary": _safe_json_loads(stage.secondary_keys, []),
            "comment": stage.title or "",
            "content": stage.content or "",
            "constant": bool(stage.constant),
            "selective": bool(stage.selective),
            "selectiveLogic": stage.selective_logic if isinstance(stage.selective_logic, int) else 0,
            "position": stage.position if isinstance(stage.position, int) else 4,
            "depth": stage.depth if isinstance(stage.depth, int) else 4,
            "order": stage.order if isinstance(stage.order, int) else (stage.stage_index or 0),
            "probability": stage.probability if stage.probability is not None else 100,
            "disable": not bool(stage.enabled),
            "caseSensitive": bool(stage.case_sensitive),
            "matchWholeWords": bool(stage.match_whole_words),
            "excludeRecursion": bool(stage.exclude_recursion),
            "preventRecursion": bool(stage.prevent_recursion),
            "sticky": stage.sticky if isinstance(stage.sticky, int) else 0,
            "cooldown": stage.cooldown if isinstance(stage.cooldown, int) else 0,
            "delay": stage.delay if isinstance(stage.delay, int) else 0,
            "group": stage.group or "",
            "groupOverride": bool(stage.group_override),
            "groupWeight": stage.group_weight if isinstance(stage.group_weight, int) else 0,
            "vectorized": bool(stage.vectorized),
            "addMemo": bool(stage.add_memo),
            "decorators": _safe_json_loads(stage.decorators, []),
            "extensions": _safe_json_loads(stage.extensions_json, {}),
            "scanDepth": stage.scan_depth if isinstance(stage.scan_depth, int) else 4,
            # ST 1.18.0 entry fields previously dropped on export (round-trip fidelity).
            # Reference: world-info.js newWorldInfoEntryDefinition:4008-4044.
            "useProbability": (stage.probability is not None and stage.probability < 100),
            "ignoreBudget": bool(getattr(stage, "ignore_budget", False)),
            "matchPersonaDescription": bool(stage.match_persona_description),
            "matchCharacterDescription": bool(stage.match_character_description),
            "matchCharacterPersonality": bool(stage.match_character_personality),
            "matchCharacterDepthPrompt": bool(stage.match_character_depth_prompt),
            "matchScenario": bool(stage.match_scenario),
            "matchCreatorNotes": bool(stage.match_creator_notes),
            "delayUntilRecursion": (
                stage.delay_until_recursion if isinstance(stage.delay_until_recursion, int) else 0
            ),
            "outletName": stage.outlet_name or "",
            "triggers": _safe_json_loads(stage.triggers, []),
            "role": stage.role if isinstance(stage.role, int) else 0,
            "useGroupScoring": stage.use_group_scoring,
            "automationId": stage.automation_id or "",
        }
    return {
        "name": wb.name,
        "description": wb.description or "",
        "entries": entries,
    }


def _resolve_worldbook(
    db: Session, user: User, world_id: Optional[str], name: Optional[str],
) -> Optional[WorldBook]:
    """按 ID 或名称查找用户的全局世界书（character_id 为空）。"""
    query = db.query(WorldBook).filter(
        WorldBook.user_id == user.id,
        WorldBook.character_id.is_(None),
    )
    if world_id:
        return query.filter(WorldBook.id == world_id).first()
    if name:
        return query.filter(WorldBook.name == name).first()
    return None


@router.post("/api/worldinfo/import")
async def st_import_worldinfo(
    file: Optional[UploadFile] = File(None),
    avatar: Optional[UploadFile] = File(None),
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """ST 世界书导入（JSON 或 PNG 内嵌角色卡）。保留所有高级字段。返回 {name: world_name}。"""
    file = _resolve_upload_field(file, avatar)
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided")
    content = await _st_read_upload(file, _ST_MAX_WORLDINFO_IMPORT_SIZE)
    if not content:
        raise HTTPException(status_code=400, detail="Empty file")

    data = _parse_worldinfo_payload(content, file.filename)
    name = _persist_worldbook_from_data(db, user, data, file.filename)
    return {"name": name}


class WorldInfoExportRequest(BaseModel):
    id: Optional[str] = None
    name: Optional[str] = None
    format: Optional[str] = "json"


@router.post("/api/worldinfo/export")
async def st_export_worldinfo(
    req: WorldInfoExportRequest,
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """ST 世界书导出（JSON 下载 或 PNG 内嵌）。"""
    wb = _resolve_worldbook(db, user, req.id, req.name)
    if not wb:
        raise HTTPException(status_code=404, detail="World book not found")

    world_info = _worldbook_to_st_world_info(wb, db)
    fmt = str(req.format or "json").lower()
    safe_name = (
        "".join(c for c in (wb.name or "worldbook") if c.isalnum() or c in (" ", "-", "_")).strip()
        or "worldbook"
    )

    if fmt == "png":
        # 将世界书嵌入最小角色卡的 character_book / world_info 字段，再生成 PNG
        chara_card = {
            "spec": "chara_card_v2",
            "spec_version": "2.0",
            "data": {
                "name": wb.name or "Worldbook",
                "description": "",
                "character_book": world_info,
                "world_info": world_info,
            },
        }
        try:
            card_png = create_png_with_chara_card(_placeholder_avatar_png(wb.name), chara_card)
        except Exception:
            # PIL/嵌入失败 → 回退 JSON，保证导出仍然可用。
            body = json.dumps(world_info, ensure_ascii=False).encode("utf-8")
            return Response(
                content=body,
                media_type="application/json",
                headers={"Content-Disposition": f'attachment; filename="{safe_name}.json"'},
            )
        return Response(
            content=card_png,
            media_type="image/png",
            headers={"Content-Disposition": f'attachment; filename="{safe_name}.png"'},
        )

    body = json.dumps(world_info, ensure_ascii=False).encode("utf-8")
    return Response(
        content=body,
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{safe_name}.json"'},
    )


@router.post("/api/worldinfo/batch-import")
async def st_batch_import_worldinfo(
    file: Optional[UploadFile] = File(None),
    avatar: Optional[UploadFile] = File(None),
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """ST 世界书批量导入（ZIP 内含多个 JSON 文件）。返回 {imported, failed, errors}。"""
    file = _resolve_upload_field(file, avatar)
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided")
    content = await _st_read_upload(file, _ST_MAX_WORLDINFO_IMPORT_SIZE)

    try:
        zf = zipfile.ZipFile(io.BytesIO(content))
    except zipfile.BadZipFile as exc:
        raise HTTPException(status_code=400, detail=f"Invalid ZIP file: {exc}") from exc

    imported = 0
    failed = 0
    errors: list[str] = []

    for info in zf.infolist():
        if info.is_dir():
            continue
        member_name = info.filename
        # 防止 Zip Slip：拒绝绝对路径和包含 .. 的路径
        normalized = member_name.replace("\\", "/")
        if normalized.startswith("/") or any(part == ".." for part in normalized.split("/")):
            failed += 1
            errors.append(f"Skipped unsafe path: {member_name}")
            continue
        if not normalized.lower().endswith(".json"):
            continue
        if info.file_size > _ST_MAX_WORLDINFO_IMPORT_SIZE:
            failed += 1
            errors.append(f"{member_name}: File too large")
            continue
        try:
            raw = zf.read(info)
            data = json.loads(raw.decode("utf-8"))
            _persist_worldbook_from_data(db, user, data, member_name)
            imported += 1
        except HTTPException as exc:
            db.rollback()
            failed += 1
            errors.append(f"{member_name}: {exc.detail}")
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            db.rollback()
            failed += 1
            errors.append(f"{member_name}: Invalid JSON - {exc}")
        except Exception as exc:
            db.rollback()
            failed += 1
            errors.append(f"{member_name}: {exc}")

    return {"imported": imported, "failed": failed, "errors": errors}


# ---------------------------------------------------------------------------
# Task 4: 群聊补充端点
# ---------------------------------------------------------------------------

class GroupInfoRequest(BaseModel):
    group_id: Optional[str] = None
    id: Optional[str] = None


def _normalize_group_id(value: Optional[str]) -> Optional[str]:
    """从 ST 传入的 group 标识（可能带 palink-group- 前缀或 .png 后缀）提取原始 id。"""
    raw = str(value or "").strip()
    if not raw:
        return None
    raw = raw.split("?")[0].replace("\\", "/").split("/")[-1]
    # N8 修复: 防御性剥除 palink-group-session- 前缀（误传 chat_id 时）
    if raw.startswith("palink-group-session-"):
        raw = raw[len("palink-group-session-"):]
    elif raw.startswith("palink-group-"):
        raw = raw[len("palink-group-"):]
    if raw.endswith(".png"):
        raw = raw[:-4]
    return raw or None


@router.post("/api/chats/group/info")
async def st_group_info(
    req: GroupInfoRequest,
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """ST 群聊聊天元数据（ChatInfo）。

    N-G1 修复: 对齐 ST 1.18.0 chats.js:808-823 —— 输入 ``{id: chatId}``
    （群聊会话 id，ST getGroupPastChats 遍历 group.chats 逐个调用），返回该
    聊天的元数据（file_id/file_name/chat_items/mes/last_mes 等）。此前实现
    返回群组信息（成员列表/激活策略），且 chatId 被 _normalize_group_id 误
    处理（palink-group-session- 剥成 palink-group-）→ 404，ST 历史聊天列表
    永远为空。

    路由说明（Fix-11）: ``st_groups.py`` 中的重复 ``/api/chats/group/info``
    端点已删除，仅保留本文件实现作为唯一来源；``silly_tavern_router`` 先于
    ``st_groups_router`` 注册，路径无冲突。
    """
    chat_id = str(req.group_id or req.id or "").strip()
    chat_id = chat_id.replace("\\", "/").split("/")[-1]
    if chat_id.endswith(".jsonl"):
        chat_id = chat_id[: -len(".jsonl")]
    if chat_id.startswith("palink-group-session-"):
        chat_id = chat_id[len("palink-group-session-"):]
    if not chat_id:
        raise HTTPException(status_code=400, detail="id is required")

    session = (
        db.query(GroupChatSession)
        .filter(GroupChatSession.id == chat_id, GroupChatSession.user_id == user.id)
        .first()
    )
    if not session:
        raise HTTPException(status_code=404, detail="Group chat session not found")

    messages = _safe_json_loads(session.messages, [])
    if not isinstance(messages, list):
        messages = []
    last_mes = ""
    if messages and isinstance(messages[-1], dict):
        last_mes = str(messages[-1].get("mes") or "")
    last_mes = last_mes or "[The chat is empty]"
    updated = session.updated_at or session.created_at or datetime.now(timezone.utc)
    return {
        "file_id": f"palink-group-session-{session.id}",
        "file_name": f"palink-group-session-{session.id}.jsonl",
        "file_size": "DB",
        "chat_items": len(messages),
        "mes": last_mes,
        "last_mes": int(updated.timestamp() * 1000),
        "chat_name": session.title or "Group Chat",
    }


def _extract_group_member_names(
    metadata: dict[str, Any], messages: list[dict[str, Any]]
) -> list[str]:
    """从导入的群聊数据中提取成员角色 name 列表。

    ST 1.18.0 群聊 JSONL 不直接存储 members 列表；群成员信息以 ``name``
    字段分布在每条消息中。这里优先读取 ``chat_metadata.members``（若存在），
    否则从消息中收集非 user / 非 system 的唯一 name 作为成员角色名。
    """
    ordered: list[str] = []
    seen: set[str] = set()

    # 1. 优先从 chat_metadata.members 读取（部分 ST 分支可能写入）
    raw_members = metadata.get("members") if isinstance(metadata, dict) else None
    if isinstance(raw_members, list):
        for entry in raw_members:
            name = str(entry or "").strip()
            if name and name not in seen:
                ordered.append(name)
                seen.add(name)

    # 2. 从消息 name 字段补充（跳过 user / system 消息）
    for msg in messages:
        if msg.get("is_user") or msg.get("is_system"):
            continue
        name = str(msg.get("name") or "").strip()
        if name and name not in seen:
            ordered.append(name)
            seen.add(name)

    return ordered


def _resolve_group_member_ids(
    db: Session, user: User, member_names: list[str]
) -> list[str]:
    """将角色 name 列表批量映射为 Character.id（按 name + user_id 匹配）。

    Task 4.2.2: ST 1.18.0 群聊文件存的是角色 name 而非 id。这里通过单次
    批量查询（``Character.name.in_(...)``）避免 N+1，未匹配的 name 记录
    warning 日志但不中断导入。返回去重后的 character.id 列表。
    """
    if not member_names:
        return []
    matched = (
        db.query(Character)
        .filter(Character.name.in_(member_names), Character.user_id == user.id)
        .all()
    )
    name_to_id: dict[str, str] = {}
    for ch in matched:
        # 同名角色取第一个匹配（理论上 name 在 user 范围内应唯一）
        if ch.name not in name_to_id:
            name_to_id[ch.name] = ch.id

    member_ids: list[str] = []
    for name in member_names:
        cid = name_to_id.get(name)
        if cid:
            member_ids.append(cid)
        else:
            logging.getLogger(__name__).warning(
                "ST group import: member character not found by name=%r user_id=%s",
                name,
                user.id,
            )
    return member_ids


@router.post("/api/chats/group/import")
async def st_group_import(
    file: Optional[UploadFile] = File(None),
    avatar: Optional[UploadFile] = File(None),
    group_id: Optional[str] = Form(None),
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """ST 群聊 JSONL 导入。返回 {name, size}。"""
    file = _resolve_upload_field(file, avatar)
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided")
    content = await _st_read_upload(file, _ST_MAX_GROUP_IMPORT_SIZE)
    items = _parse_jsonl_chat(content)
    resolved_group_id = _normalize_group_id(group_id)
    chat_name = re.sub(r"\.jsonl$", "", file.filename, flags=re.IGNORECASE) or "Imported Group Chat"

    metadata: dict[str, Any] = {}
    messages: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        if "chat_metadata" in item and "mes" not in item:
            raw_meta = item.get("chat_metadata")
            if isinstance(raw_meta, dict):
                metadata = raw_meta
            continue
        msg_content = _st_message_content(item)
        messages.append({
            "name": item.get("name") or "",
            "is_user": bool(item.get("is_user")),
            "is_system": bool(item.get("is_system")),
            "mes": msg_content,
            "send_date": item.get("send_date") or _iso(datetime.now(timezone.utc)),
            "swipes": _st_message_swipes(item, msg_content),
            "extra": item.get("extra") if isinstance(item.get("extra"), dict) else {},
        })

    # Task 4.2.2: ST 1.18.0 群聊 JSONL 不直接存储 members 列表；成员以
    # name 分布在每条消息中。这里从 metadata/messages 提取角色 name，批量
    # 映射为 Palink Character.id，避免 member_ids 始终为空导致群聊成员丢失。
    member_names = _extract_group_member_names(metadata, messages)
    resolved_member_ids = _resolve_group_member_ids(db, user, member_names)

    group: Optional[GroupChat] = None
    if resolved_group_id:
        group = db.query(GroupChat).filter(
            GroupChat.id == resolved_group_id, GroupChat.user_id == user.id
        ).first()
    if group:
        # 群已存在：将导入解析出的成员合并到现有 member_ids（去重，保留原成员）
        existing_ids = _safe_json_loads(group.member_ids, [])
        if not isinstance(existing_ids, list):
            existing_ids = []
        existing_set = {str(mid) for mid in existing_ids}
        merged = [str(mid) for mid in existing_ids]
        for cid in resolved_member_ids:
            if cid not in existing_set:
                merged.append(cid)
                existing_set.add(cid)
        if merged != [str(mid) for mid in existing_ids]:
            group.member_ids = _json_dumps(merged)
    else:
        group = GroupChat(
            id=str(uuid.uuid4()),
            user_id=user.id,
            name=chat_name,
            member_ids=_json_dumps(resolved_member_ids),
            chat_metadata=_json_dumps(metadata),
        )
        db.add(group)
        db.flush()

    session = GroupChatSession(
        id=str(uuid.uuid4()),
        group_id=group.id,
        user_id=user.id,
        title=chat_name,
        messages=_json_dumps(messages),
        avatars=_json_dumps(metadata.get("avatars") or {}),
    )
    db.add(session)
    db.commit()
    return {"name": chat_name, "size": len(messages)}


# ---------------------------------------------------------------------------
# Task 5: Quick replies + Images
# ---------------------------------------------------------------------------

class QuickReplySaveRequest(BaseModel):
    set_name: Optional[str] = None
    name: Optional[str] = None
    label: Optional[str] = None
    text: Optional[str] = None
    data: Optional[dict[str, Any]] = None


class QuickReplyDeleteRequest(BaseModel):
    set_name: Optional[str] = None


@router.post("/api/quick-replies/save")
async def st_quick_replies_save(
    req: QuickReplySaveRequest,
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """ST 保存 quick reply set。最小实现：持久化到 silly_tavern_settings.extension_settings.quickReply。"""
    set_name = str(req.set_name or req.name or "").strip()
    if not set_name:
        raise HTTPException(status_code=400, detail="set_name is required")
    setting = _get_or_create_user_setting(user, db)
    settings_data = _safe_json_loads(setting.silly_tavern_settings, {})
    if not isinstance(settings_data, dict):
        settings_data = {}
    extension_settings = settings_data.get("extension_settings")
    if not isinstance(extension_settings, dict):
        extension_settings = {}
    quick_reply = extension_settings.get("quickReply")
    if not isinstance(quick_reply, dict):
        quick_reply = {}
    sets = quick_reply.get("sets")
    if not isinstance(sets, list):
        sets = []
    payload = req.data if isinstance(req.data, dict) else {
        "name": set_name,
        "label": req.label,
        "text": req.text,
    }
    replaced = False
    for i, existing in enumerate(sets):
        if isinstance(existing, dict) and str(existing.get("name") or "") == set_name:
            sets[i] = {**existing, **payload, "name": set_name}
            replaced = True
            break
    if not replaced:
        sets.append({**payload, "name": set_name})
    quick_reply["sets"] = sets
    extension_settings["quickReply"] = quick_reply
    settings_data["extension_settings"] = extension_settings
    setting.silly_tavern_settings = _json_dumps(settings_data)
    db.commit()
    return {"ok": True}


@router.post("/api/quick-replies/delete")
async def st_quick_replies_delete(
    req: QuickReplyDeleteRequest,
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """ST 删除 quick reply set。"""
    set_name = str(req.set_name or "").strip()
    setting = _get_or_create_user_setting(user, db)
    settings_data = _safe_json_loads(setting.silly_tavern_settings, {})
    if isinstance(settings_data, dict):
        extension_settings = settings_data.get("extension_settings")
        if isinstance(extension_settings, dict):
            quick_reply = extension_settings.get("quickReply")
            if isinstance(quick_reply, dict):
                sets = quick_reply.get("sets")
                if isinstance(sets, list) and set_name:
                    quick_reply["sets"] = [
                        s for s in sets
                        if not (isinstance(s, dict) and str(s.get("name") or "") == set_name)
                    ]
                setting.silly_tavern_settings = _json_dumps(settings_data)
                db.commit()
    return {"ok": True}


def _images_dir(subdir: str = "") -> str:
    base = os.path.join(app_settings.DATA_DIR, _ST_IMAGES_SUBDIR)
    if subdir:
        base = os.path.join(base, subdir)
    return base


# S-10 修复: ST 图片上传扩展名/魔数白名单。仅允许位图类图片，
# 拒绝 .html/.svg/.js 等可执行/可脚本文件，防止存储型 XSS。
_ST_IMAGE_EXTENSION_ALLOWLIST = {
    ".png": b"\x89PNG\r\n\x1a\n",
    ".jpg": b"\xff\xd8\xff",
    ".jpeg": b"\xff\xd8\xff",
    ".gif": (b"GIF87a", b"GIF89a"),
    ".webp": b"RIFF",  # WEBP: RIFF....WEBP（长度 >= 12 且偏移 8 为 WEBP）
}


def _st_validate_image_content(filename: str, content: bytes) -> None:
    """S-10 修复: 校验扩展名白名单 + 魔数，阻止非图片文件上传。"""
    ext = os.path.splitext(str(filename or ""))[1].lower()
    if ext not in _ST_IMAGE_EXTENSION_ALLOWLIST:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported image type: {ext or 'none'} (allowed: png/jpg/jpeg/gif/webp)",
        )
    magic = _ST_IMAGE_EXTENSION_ALLOWLIST[ext]
    if not content:
        raise HTTPException(status_code=400, detail="Empty file")
    if isinstance(magic, tuple):
        if not any(content.startswith(m) for m in magic):
            raise HTTPException(status_code=400, detail="Invalid image content (magic bytes mismatch)")
    elif ext == ".webp":
        if not content.startswith(b"RIFF") or len(content) < 12 or content[8:12] != b"WEBP":
            raise HTTPException(status_code=400, detail="Invalid image content (WEBP signature mismatch)")
    else:
        if not content.startswith(magic):
            raise HTTPException(status_code=400, detail="Invalid image content (magic bytes mismatch)")


@router.post("/api/images/upload")
async def st_upload_image(
    file: Optional[UploadFile] = File(None),
    avatar: Optional[UploadFile] = File(None),
    path: Optional[str] = Form(None),
    user: User = Depends(get_st_current_user),
):
    """ST 图片上传。保存到 data/images/{path}/，返回 {path, url}。"""
    file = _resolve_upload_field(file, avatar)
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided")
    safe_subdir = _sanitize_relative_path(path or "")
    safe_filename = os.path.basename(file.filename).replace("..", "")
    if not safe_filename:
        raise HTTPException(status_code=400, detail="Invalid filename")
    content = await _st_read_upload(file, _ST_MAX_IMAGE_UPLOAD_SIZE)
    if not content:
        raise HTTPException(status_code=400, detail="Empty file")
    # S-10 修复: 扩展名白名单 + 魔数校验（防 .html/.svg/.js 存储型 XSS）
    _st_validate_image_content(safe_filename, content)

    target_dir = _images_dir(safe_subdir)
    try:
        os.makedirs(target_dir, exist_ok=True)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to create image directory: {exc}") from exc
    target_path = os.path.join(target_dir, safe_filename)
    try:
        with open(target_path, "wb") as fp:
            fp.write(content)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to save image: {exc}") from exc

    rel_path = "/".join([_ST_IMAGES_SUBDIR, safe_subdir, safe_filename]) if safe_subdir else "/".join([_ST_IMAGES_SUBDIR, safe_filename])
    url_path = rel_path[len(_ST_IMAGES_SUBDIR) + 1:]
    return {"path": rel_path, "url": f"/api/st/images/{url_path}"}


@router.post("/api/images/list/{folder}")
async def st_list_images(
    folder: str,
    request: Request,
    user: User = Depends(get_st_current_user),
):
    """ST 列出指定文件夹下的图片。返回 {files: [...]}。"""
    safe_folder = _sanitize_relative_path(folder)
    target_dir = _images_dir(safe_folder)
    files: list[dict[str, Any]] = []
    if os.path.isdir(target_dir):
        for name in sorted(os.listdir(target_dir)):
            full = os.path.join(target_dir, name)
            if not os.path.isfile(full):
                continue
            ext = os.path.splitext(name)[1].lower()
            if ext not in (".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".bmp"):
                continue
            rel = "/".join([_ST_IMAGES_SUBDIR, safe_folder, name]) if safe_folder else "/".join([_ST_IMAGES_SUBDIR, name])
            url_path = "/".join([safe_folder, name]) if safe_folder else name
            try:
                size = os.path.getsize(full)
            except OSError:
                size = 0
            files.append({
                "name": name,
                "path": rel,
                "url": f"/api/st/images/{url_path}",
                "size": size,
            })
    return {"files": files}


# ---------------------------------------------------------------------------
# Task 6: Provider stubs (speech / openai voice+image / vector / translate / search)
#
# 返回 ST 兼容的空/错误响应形状，避免 ST 扩展面板收到 404，同时不暴露
# Palink 内部 provider 密钥。ST 在这些返回空结果时会优雅降级。
# ---------------------------------------------------------------------------

@router.post("/api/speech/list")
async def st_speech_list(
    user: User = Depends(get_st_current_user),
):
    return {"voices": []}


@router.post("/api/speech/get")
async def st_speech_get(
    user: User = Depends(get_st_current_user),
):
    return {"voice": None}


@router.post("/api/speech/preview")
async def st_speech_preview(
    user: User = Depends(get_st_current_user),
):
    return {"audio": None}


@router.post("/api/speech/generate")
async def st_speech_generate(
    text: str = Form(...),
    voice: Optional[str] = Form(None),
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """ST 1.18.0 兼容的语音生成端点。

    接受 form-encoded `text`/`voice`，委托给 Palink 原生 TTS 服务层合成，
    返回二进制音频流 (audio/mpeg)。合成失败时返回 503。
    """
    try:
        clean = clean_text_for_tts(text)
        if not clean:
            raise ValueError("No text to synthesize")
        binding_override: Optional[dict] = None
        if voice:
            binding_override = {"voice_id": voice}
        _content_type, audio_bytes = await tts_service.synthesize_audio(
            text=clean,
            db=db,
            user=user,
            binding_override=binding_override,
        )
        return Response(
            content=audio_bytes,
            media_type="audio/mpeg",
            headers={"Content-Disposition": "inline; filename=tts.mp3", "Cache-Control": "no-cache"},
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception:
        logging.getLogger("palink.st_speech").exception("ST-compatible speech generation failed")
        raise HTTPException(status_code=503, detail="TTS speech generation is not available")


class STOpenAIVoiceRequest(BaseModel):
    """OpenAI TTS / ST openai.js 兼容的语音生成请求体。

    ST 1.18.0 的 openai.js 实际发送 `text` 字段（由服务端映射到 OpenAI 的 `input`），
    这里同时接受 `input` 与 `text`，兼容 OpenAI 客户端与 ST 客户端。
    """
    input: Optional[str] = None
    text: Optional[str] = None
    voice: Optional[str] = None
    response_format: str = "mp3"
    speed: float = 1.0
    model: Optional[str] = None
    instructions: Optional[str] = None


@router.post("/api/openai/generate-voice")
async def st_openai_generate_voice(
    payload: STOpenAIVoiceRequest,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """ST 1.18.0 兼容的 OpenAI TTS 语音生成端点。

    接受 OpenAI TTS JSON 请求体（input/voice/response_format/speed/model）或
    ST 内部 `text` 字段，委托给 Palink 原生 TTS 服务层合成，以 StreamingResponse
    返回二进制音频流。浏览器内置 provider 无法在后端合成时返回 400。
    """
    raw_text = (payload.input or payload.text or "").strip()
    if not raw_text:
        raise HTTPException(status_code=400, detail="Text to synthesize is required")

    try:
        clean = clean_text_for_tts(raw_text)
        if not clean:
            raise ValueError("No text to synthesize after cleaning")

        binding_override: Optional[dict] = None
        if payload.voice:
            binding_override = {"voice_id": payload.voice}
        if payload.speed and payload.speed != 1.0:
            binding_override = binding_override or {}
            binding_override["speed"] = float(payload.speed)

        content_type, audio_bytes = await tts_service.synthesize_audio(
            text=clean,
            db=db,
            user=user,
            binding_override=binding_override,
        )

        async def _audio_stream():
            yield audio_bytes

        media_type = content_type or "audio/mpeg"
        return StreamingResponse(
            _audio_stream(),
            media_type=media_type,
            headers={
                "Content-Disposition": "inline; filename=tts.mp3",
                "Cache-Control": "no-cache",
            },
        )
    except HTTPException:
        raise
    except ValueError as e:
        msg = str(e)
        if "不支持后端音频生成" in msg:
            raise HTTPException(
                status_code=400,
                detail="浏览器内置 TTS 无法在后端合成音频，请在模型管理→语音中切换至其他 TTS 服务商",
            )
        if "未配置" in msg or "已禁用" in msg or "未安装" in msg:
            raise HTTPException(status_code=503, detail=f"TTS 服务不可用：{msg}")
        raise HTTPException(status_code=400, detail=msg)
    except httpx.HTTPStatusError as e:
        logging.getLogger("palink.st_speech").exception("Upstream TTS service HTTP error")
        upstream_status = e.response.status_code if e.response is not None else "unknown"
        raise HTTPException(status_code=502, detail=f"上游 TTS 服务返回错误 (HTTP {upstream_status})")
    except httpx.HTTPError as e:
        logging.getLogger("palink.st_speech").exception("Upstream TTS service network error")
        raise HTTPException(status_code=502, detail=f"上游 TTS 服务网络错误：{e}")
    except Exception:
        logging.getLogger("palink.st_speech").exception("ST OpenAI voice generation failed")
        raise HTTPException(status_code=503, detail="TTS speech generation is not available")


# ===========================================================================
# P1 Batch 4: 扩展端点（P1-9 classify / P1-10 gallery / P1-11 summarize /
#              P1-12 caption / P1-13 elevenlabs）
#
# 实现策略：
# - classify / caption / elevenlabs: 透明代理到 ST sidecar（ST 自带端点）
# - gallery list/folders: Palink 原生实现（图片存储在 Palink 数据目录）
# - summarize: Palink 原生实现（调用 LLM 做文本总结，替代 Extras 服务）
# ===========================================================================

# --- P1-13: ElevenLabs TTS 端点（代理到 ST sidecar） ----------------------
# ST 1.18.0 speech.js:177-432 实现 7 个 ElevenLabs 端点，全部 POST。
# API key 存储在 ST sidecar 的 secrets 中，Palink 不持有。

@router.post("/api/speech/elevenlabs/voices")
async def st_elevenlabs_voices(
    request: Request,
    user: User = Depends(get_st_current_user),
):
    """列出 ElevenLabs 可用 voices（代理到 ST sidecar）。"""
    return await _forward_extensions_to_st_native(request, user, "api/speech/elevenlabs/voices")


@router.post("/api/speech/elevenlabs/voice-settings")
async def st_elevenlabs_voice_settings(
    request: Request,
    user: User = Depends(get_st_current_user),
):
    """获取 ElevenLabs 默认 voice 设置（代理到 ST sidecar）。"""
    return await _forward_extensions_to_st_native(request, user, "api/speech/elevenlabs/voice-settings")


@router.post("/api/speech/elevenlabs/synthesize")
async def st_elevenlabs_synthesize(
    request: Request,
    user: User = Depends(get_st_current_user),
):
    """ElevenLabs 语音合成（代理到 ST sidecar，返回 audio/mpeg 二进制流）。"""
    return await _forward_extensions_to_st_native(request, user, "api/speech/elevenlabs/synthesize")


@router.post("/api/speech/elevenlabs/history")
async def st_elevenlabs_history(
    request: Request,
    user: User = Depends(get_st_current_user),
):
    """获取 ElevenLabs 合成历史（代理到 ST sidecar）。"""
    return await _forward_extensions_to_st_native(request, user, "api/speech/elevenlabs/history")


@router.post("/api/speech/elevenlabs/history-audio")
async def st_elevenlabs_history_audio(
    request: Request,
    user: User = Depends(get_st_current_user),
):
    """获取 ElevenLabs 历史音频（代理到 ST sidecar，返回 audio/mpeg）。"""
    return await _forward_extensions_to_st_native(request, user, "api/speech/elevenlabs/history-audio")


@router.post("/api/speech/elevenlabs/voices/add")
async def st_elevenlabs_voices_add(
    request: Request,
    user: User = Depends(get_st_current_user),
):
    """ElevenLabs 语音克隆（代理到 ST sidecar）。"""
    return await _forward_extensions_to_st_native(request, user, "api/speech/elevenlabs/voices/add")


@router.post("/api/speech/elevenlabs/recognize")
async def st_elevenlabs_recognize(
    request: Request,
    user: User = Depends(get_st_current_user),
):
    """ElevenLabs Speech-to-Text（代理到 ST sidecar，multipart/form-data）。"""
    return await _forward_extensions_to_st_native(request, user, "api/speech/elevenlabs/recognize")


# --- P1-9: Expressions 情感分类端点（代理到 ST sidecar + 降级） ----------

# GoEmotions 28 类标签（ST 1.18.0 classify.js 使用的默认标签集）
_GO_EMOTIONS_LABELS: list[str] = [
    "admiration", "amusement", "anger", "annoyance", "approval", "caring",
    "confusion", "curiosity", "desire", "disappointment", "disapproval",
    "disgust", "embarrassment", "excitement", "fear", "gratitude", "grief",
    "joy", "love", "nervousness", "neutral", "optimism", "pride",
    "realization", "relief", "remorse", "sadness", "surprise",
]


@router.post("/api/extra/classify/labels")
async def st_classify_labels(
    user: User = Depends(get_st_current_user),
):
    """P1-9: 返回 GoEmotions 28 类标签（对齐 ST 1.18.0 classify.js）。

    ST 前端 expressions 扩展在 local 模式下启动时调用此端点获取可用标签。
    返回静态标签列表，不需要代理到 ST sidecar。
    """
    return {"labels": list(_GO_EMOTIONS_LABELS)}


@router.post("/api/extra/classify")
async def st_classify(
    request: Request,
    user: User = Depends(get_st_current_user),
):
    """P1-9: 文本情感分类（对齐 ST 1.18.0 POST /api/extra/classify）。

    优先代理到 ST sidecar（使用 transformers.js 本地 DistilBERT 模型）。
    sidecar 不可用时降级到 Palink 关键词匹配，返回 top-1 结果 + 低分填充。

    请求体: {"text": "<待分类文本>"}
    响应: {"classification": [{"label": "joy", "score": 0.87}, ...]}  (top 5)
    """
    # 先尝试代理到 ST sidecar（有完整的 ML 模型）
    response = await _forward_extensions_to_st_native(request, user, "api/extra/classify")
    if response.status_code != 502:
        return response

    # 降级: 使用 Palink 关键词匹配
    try:
        body = await request.json()
    except Exception:
        body = {}
    text = str(body.get("text") or "").strip()
    if not text:
        return JSONResponse(
            status_code=200,
            content={"classification": [
                {"label": "neutral", "score": 1.0},
            ]},
        )

    # 复用 Palink ExpressionService 做关键词匹配
    try:
        from .expressions import ExpressionService
        result = ExpressionService.analyze_expression(text)
        label = result.get("expression", "neutral") if isinstance(result, dict) else "neutral"
        # Palink 返回的标签可能是 ST 默认表情名（15 类），映射到 GoEmotions 子集
        _LABEL_MAP = {
            "neutral": "neutral", "happy": "joy", "sad": "sadness",
            "angry": "anger", "surprised": "surprise", "disgusted": "disgust",
            "fearful": "fear", "excited": "excitement", "embarrassed": "embarrassment",
            "thinking": "confusion", "love": "love", "amused": "amusement",
            "tired": "sadness", "sleepy": "sadness", "bored": "disapproval",
        }
        mapped = _LABEL_MAP.get(label, "neutral")
    except Exception:
        mapped = "neutral"

    # 构造 top-5 响应（主标签高分，其余低分填充）
    classification = [{"label": mapped, "score": 0.85}]
    for fallback_label in ("neutral", "joy", "optimism", "amusement"):
        if fallback_label != mapped:
            classification.append({"label": fallback_label, "score": 0.05})
        if len(classification) >= 5:
            break
    return JSONResponse(status_code=200, content={"classification": classification})


# --- P1-12: Caption 端点（代理到 ST sidecar） ---------------------------

@router.post("/api/extra/caption")
async def st_caption(
    request: Request,
    user: User = Depends(get_st_current_user),
):
    """P1-12: 图片描述生成（对齐 ST 1.18.0 POST /api/extra/caption）。

    代理到 ST sidecar（使用 transformers.js 本地 image-to-text pipeline）。
    sidecar 不可用时返回 502。

    请求体: {"image": "<base64-encoded-image-without-data-uri-prefix>"}
    响应: {"caption": "<图片描述文本>"}
    """
    return await _forward_extensions_to_st_native(request, user, "api/extra/caption")


# --- P1-11: Memory Extras summarize 端点（Palink 原生 LLM） -------------

@router.get("/api/modules")
async def st_modules(
    user: User = Depends(get_st_current_user),
):
    """P1-11: 返回可用模块列表（对齐 ST Extras /api/modules）。

    ST memory 扩展在 source=extras 模式下，启动时调用此端点检查
    'summarize' 模块是否可用。Palink 原生实现 summarize，因此始终返回可用。
    """
    return {"modules": ["summarize"]}


class STSummarizeRequest(BaseModel):
    """ST Extras /api/summarize 请求体。"""
    text: str
    params: dict = {}


@router.post("/api/summarize")
async def st_summarize(
    payload: STSummarizeRequest,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """P1-11: 文本总结（对齐 ST Extras POST /api/summarize）。

    Palink 原生实现：调用默认 LLM 对文本做摘要，替代 Extras 服务。
    ST memory 扩展在 source=extras 模式下调用此端点生成对话摘要。

    请求体: {"text": "<待总结文本>", "params": {}}
    响应: {"summary": "<总结文本>"}
    """
    text = (payload.text or "").strip()
    if not text:
        return JSONResponse(status_code=200, content={"summary": ""})

    # 获取默认模型
    try:
        from ..utils import get_default_ai_model
        model_id = get_default_ai_model(db)
    except Exception:
        raise HTTPException(status_code=503, detail="No AI model configured for summarization")

    # 构造总结提示词（对齐 ST Extras summarize 的行为）
    summarize_prompt = (
        "Summarize the following conversation in 2-3 sentences. "
        "Focus on key events, character actions, and important context. "
        "Write in the same language as the conversation.\n\n"
        f"Conversation:\n{text[:8000]}"
    )

    try:
        from ..services.inference_dispatcher import complete_text_completion
        completion = await complete_text_completion(
            model_id=model_id,
            messages=[{"role": "user", "content": summarize_prompt}],
            temperature=0.3,
            max_tokens=256,
            timeout=60.0,
        )
        summary = (completion.get("content") or "").strip()
        if not summary:
            summary = text[:200] + "..." if len(text) > 200 else text
    except Exception as exc:
        logging.getLogger("palink.st_summarize").warning("Summarize failed: %s", exc)
        # 降级: 返回截断的原文作为摘要
        summary = text[:200] + "..." if len(text) > 200 else text

    return JSONResponse(status_code=200, content={"summary": summary})


# --- P1-10: Gallery list/folders 端点对齐（Palink 原生） ----------------

class STImagesListRequest(BaseModel):
    """ST 1.18.0 gallery 扩展 POST /api/images/list 请求体（folder 改在处理器内校验）。"""
    folder: Optional[str] = None
    sortField: str = "date"   # ST 1.18.0 默认 'date'（非 'name'）
    sortOrder: str = "asc"
    type: int = 1             # ST MEDIA_REQUEST_TYPE 位掩码：1=IMAGE, 2=VIDEO, 4=AUDIO


# ST 1.18.0 constants.js MEDIA_REQUEST_TYPE 位掩码
_ST_MEDIA_TYPE_IMAGE = 0b001
_ST_MEDIA_TYPE_VIDEO = 0b010
_ST_MEDIA_TYPE_AUDIO = 0b100

# 各媒体类别后缀集合（对齐 ST getImages 按 MIME 前缀过滤的等价实现）
_ST_IMAGE_EXTS = frozenset({
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".bmp", ".jfif", ".ico", ".tiff", ".tif",
})
_ST_VIDEO_EXTS = frozenset({
    ".mp4", ".webm", ".mov", ".avi", ".mkv", ".wmv", ".flv", ".3gp", ".mpg", ".mpeg",
})
_ST_AUDIO_EXTS = frozenset({
    ".mp3", ".wav", ".ogg", ".flac", ".aac", ".m4a", ".aiff",
})


def _st_filter_media_by_type(names: list[str], type_mask: int) -> list[str]:
    """按 ST MEDIA_REQUEST_TYPE 位掩码筛选媒体文件（等价 ST getImages 的 MIME 前缀逻辑）。"""
    want_image = bool(type_mask & _ST_MEDIA_TYPE_IMAGE)
    want_video = bool(type_mask & _ST_MEDIA_TYPE_VIDEO)
    want_audio = bool(type_mask & _ST_MEDIA_TYPE_AUDIO)
    result: list[str] = []
    for name in names:
        ext = os.path.splitext(name)[1].lower()
        if want_image and ext in _ST_IMAGE_EXTS:
            result.append(name)
        elif want_video and ext in _ST_VIDEO_EXTS:
            result.append(name)
        elif want_audio and ext in _ST_AUDIO_EXTS:
            result.append(name)
    return result


@router.post("/api/images/list")
async def st_images_list_body(
    payload: STImagesListRequest,
    user: User = Depends(get_st_current_user),
):
    """P1-10: 列出指定文件夹下的图片/视频/音频（对齐 ST 1.18.0 POST /api/images/list）。

    与现有 POST /api/images/list/{folder} 不同，此端点从请求体读取 folder，
    返回纯字符串数组（仅文件名），对齐 ST gallery 扩展前端契约。

    请求体: {"folder": "<文件夹名>", "sortField": "name"|"date", "sortOrder": "asc"|"desc", "type": 1}
    响应: ["file1.png", "file2.jpg", ...]  (纯字符串数组)
    错误: 400 {"error": "No folder specified"} / 500 {"error": "Unable to retrieve files"}
    """
    # 对齐 ST：folder 缺失返回 400 {"error": "No folder specified"}
    if not payload.folder or not str(payload.folder).strip():
        return JSONResponse(status_code=400, content={"error": "No folder specified"})

    safe_folder = _sanitize_relative_path(str(payload.folder).strip())
    target_dir = _images_dir(safe_folder)

    try:
        names: list[str] = []
        if os.path.isdir(target_dir):
            names = [n for n in os.listdir(target_dir) if os.path.isfile(os.path.join(target_dir, n))]
        # 按 ST MEDIA_REQUEST_TYPE 位掩码过滤（默认仅 IMAGE）
        files = _st_filter_media_by_type(names, payload.type)

        # 排序：对齐 ST getImages（'name'→字典序，'date'→按 mtime 升序）
        reverse = payload.sortOrder == "desc"
        if payload.sortField == "date":
            files.sort(
                key=lambda n: os.path.getmtime(os.path.join(target_dir, n)) if os.path.exists(os.path.join(target_dir, n)) else 0,
                reverse=reverse,
            )
        else:
            files.sort(reverse=reverse)

        return JSONResponse(status_code=200, content=files)
    except Exception:
        logging.getLogger("palink.st_images").exception("Failed to list images for folder=%s", safe_folder)
        return JSONResponse(status_code=500, content={"error": "Unable to retrieve files"})


@router.post("/api/images/folders")
async def st_images_folders(
    user: User = Depends(get_st_current_user),
):
    """P1-10: 列出图片目录下的所有子文件夹（对齐 ST 1.18.0 POST /api/images/folders）。

    无请求体。
    响应: ["folder1", "folder2", ...]  (纯字符串数组)
    """
    base_dir = _images_dir()
    folders: list[str] = []
    if os.path.isdir(base_dir):
        for name in os.listdir(base_dir):
            if os.path.isdir(os.path.join(base_dir, name)):
                folders.append(name)
    folders.sort()
    return JSONResponse(status_code=200, content=folders)


class STGenerateImageRequest(BaseModel):
    """OpenAI Images API 兼容请求体（ST 1.18.0 stable-diffusion 扩展使用）。"""

    prompt: str
    n: int = 1
    size: str = "1024x1024"
    response_format: str = "url"
    model: Optional[str] = None


def _read_generated_image_as_base64(image_url: str, user_id: int) -> str:
    """从本地存储读取已生成的图片并返回 base64 字符串。

    图片由 `image_generation_service.generate_image` 保存为
    `/api/uploads/generated-images/{filename}`，对应磁盘路径
    `{UPLOAD_DIR}/{user_id}/generated-images/{filename}`。
    """
    if not image_url:
        raise HTTPException(status_code=500, detail="Image URL is empty")
    filename = image_url.rsplit("/", 1)[-1]
    if not filename:
        raise HTTPException(status_code=500, detail="Invalid image URL")
    user_root = os.path.realpath(os.path.join(app_settings.UPLOAD_DIR, str(user_id)))
    file_path = os.path.realpath(os.path.join(user_root, "generated-images", filename))
    if not file_path.startswith(user_root):
        raise HTTPException(status_code=500, detail="Invalid image storage path")
    if not os.path.exists(file_path):
        raise HTTPException(status_code=500, detail="Generated image not found")
    with open(file_path, "rb") as handle:
        return base64.b64encode(handle.read()).decode("ascii")


@router.post("/api/openai/generate-image")
async def st_openai_generate_image(
    req: STGenerateImageRequest,
    request: Request,
    user: User = Depends(get_st_current_user),
):
    """ST 1.18.0 兼容的图片生成端点。

    接受 OpenAI Images API 格式请求，委托给 Palink 原生图片生成服务，
    返回 OpenAI 标准响应格式 ``{"created": ..., "data": [{"url": ...}|{"b64_json": ...}]}``。
    服务未配置/未启用时返回 503，上游错误返回 502。

    注意：
    - Palink 当前仅支持单张图片生成，``n`` 字段被忽略，始终返回 1 张。
    - 图片尺寸由服务商配置决定，``size`` 字段不会覆盖服务商配置。
    - ``model`` 字段不会覆盖服务商配置（Palink 通过管理后台切换 active provider）。
    """
    st_image_logger = logging.getLogger("palink.st_image")
    try:
        result = await generate_image(prompt=req.prompt, user_id=user.id)
    except HTTPException as exc:
        # 400 表示服务未启用或未配置完整 -> 映射为 503
        if exc.status_code == 400:
            raise HTTPException(
                status_code=503,
                detail=str(exc.detail) or "图片生成服务未配置",
            ) from exc
        # 502 及其他状态原样透传
        raise
    except Exception as exc:
        st_image_logger.exception("Image generation failed")
        raise HTTPException(status_code=502, detail="图片生成请求失败") from exc

    image_dict = image_result_to_dict(result)
    image_url = image_dict.get("image_url", "")

    response_format = (req.response_format or "url").lower()
    if response_format == "b64_json":
        try:
            b64_data = _read_generated_image_as_base64(image_url, user.id)
        except HTTPException:
            raise
        except Exception as exc:
            st_image_logger.exception("Failed to encode image as base64")
            raise HTTPException(status_code=502, detail="图片编码失败") from exc
        data_item: dict[str, Any] = {"b64_json": b64_data}
    else:
        if image_url.startswith(("http://", "https://")):
            absolute_url = image_url
        elif image_url.startswith("/"):
            base = str(request.base_url) if request is not None else ""
            absolute_url = base.rstrip("/") + image_url
        else:
            absolute_url = image_url
        data_item = {"url": absolute_url}

    return {
        "created": int(time.time()),
        "data": [data_item],
    }


# ============================================================
# Task 4.4: /api/vector/* 路由（向量记忆）
#
# 接入 Palink 已有的 memory_module 服务，为 ST 向量插件提供
# 索引创建、查询、插入、删除能力。
# ============================================================


class VectorIndexRequest(BaseModel):
    name: str
    hash: Optional[str] = None


class VectorQueryRequest(BaseModel):
    # Palink 自有格式
    query: Optional[str] = None
    top_k: int = Field(default=5, ge=1, le=50)
    source: Optional[str] = None
    # ST 1.18.0 vectors.js 格式（collectionId 存在时按 ST 语义处理）
    collectionId: Optional[str] = None
    searchText: Optional[str] = None
    topK: Optional[int] = Field(default=None, ge=1, le=100)
    threshold: Optional[float] = None


class VectorInsertItem(BaseModel):
    text: str
    metadata: dict[str, Any] = Field(default_factory=dict)
    # ST 格式：客户端 cyrb53(getStringHash) 计算的内容 hash 与消息索引
    hash: Optional[int] = None
    index: Optional[int] = None


class VectorInsertRequest(BaseModel):
    items: list[VectorInsertItem] = Field(default_factory=list)
    source: Optional[str] = None
    collectionId: Optional[str] = None


class VectorDeleteRequest(BaseModel):
    ids: Optional[list[int]] = None
    source: Optional[str] = None
    collectionId: Optional[str] = None
    hashes: Optional[list[int]] = None


class VectorListRequest(BaseModel):
    collectionId: str
    source: Optional[str] = None


class VectorQueryMultiRequest(BaseModel):
    collectionIds: list[str] = Field(default_factory=list)
    searchText: str = ""
    topK: int = Field(default=10, ge=1, le=100)
    threshold: Optional[float] = None
    source: Optional[str] = None


class VectorPurgeRequest(BaseModel):
    collectionId: str


# ST 向量集合在 conversation_memories 中的 session_id 前缀。
# 带前缀隔离：/purge、/purge-all 只会删除该前缀数据，不影响正常会话记忆。
_ST_VEC_PREFIX = "st-vec::"


def _st_vec_session(collection_id: str) -> str:
    return f"{_ST_VEC_PREFIX}{collection_id}"


def _st_vec_topics(memory) -> dict:
    """从 memory.topics 中提取 ST 元数据（dict 形态）；兼容 list 旧数据。"""
    topics = getattr(memory, "topics", None)
    return topics if isinstance(topics, dict) else {}


def _st_vec_list_hashes(db: Session, user_id: int, collection_id: str) -> list[int]:
    """返回集合内已存的 ST hash 列表（对应 ST /api/vector/list 语义）。"""
    from sqlalchemy import text as sa_text

    rows = db.execute(
        sa_text(
            "SELECT topics FROM conversation_memories "
            "WHERE user_id = :user_id AND session_id = :session_id"
        ),
        {"user_id": user_id, "session_id": _st_vec_session(collection_id)},
    ).fetchall()
    hashes: list[int] = []
    for row in rows:
        try:
            topics = json.loads(row[0]) if isinstance(row[0], str) else row[0]
        except Exception:
            continue
        if isinstance(topics, dict) and isinstance(topics.get("st_hash"), int):
            hashes.append(topics["st_hash"])
    return hashes


def _st_vec_query_collection(
    db: Session,
    user_id: int,
    collection_id: str,
    search_text: str,
    top_k: int,
    threshold: Optional[float],
) -> dict:
    """查询单个 ST 集合，返回 ST 形状 {"metadata": [...], "hashes": [...]}。

    不复用 ``MemoryStorage.semantic_search``：其内部将行转为
    ``MemoryEntry``（pydantic，``topics: List[str]``），而 ST 集合的
    topics 是 dict（{"st_hash", "st_index", "st_source"}），校验失败会被
    静默跳过导致查询永远为空。此处改用原始 SQL + 余弦相似度。
    """
    import numpy as np
    from sqlalchemy import text as sa_text

    from ..memory_module.embedder import embed_text

    embedding = embed_text(search_text)
    query_vec = np.asarray(embedding, dtype=np.float32).reshape(-1)
    min_similarity = threshold if threshold is not None else 0.0

    rows = db.execute(
        sa_text(
            "SELECT content, topics, embedding FROM conversation_memories "
            "WHERE user_id = :user_id AND session_id = :session_id "
            "AND embedding IS NOT NULL "
            "ORDER BY created_at DESC LIMIT 500"
        ),
        {"user_id": user_id, "session_id": _st_vec_session(collection_id)},
    ).fetchall()

    scored: list[tuple[float, str, dict]] = []
    norm_query = float(np.linalg.norm(query_vec))
    for row in rows:
        try:
            emb_raw = row[2]
            emb_list = json.loads(emb_raw) if isinstance(emb_raw, str) else emb_raw
            if not emb_list:
                continue
            memory_vec = np.asarray(emb_list, dtype=np.float32).reshape(-1)
            norm_memory = float(np.linalg.norm(memory_vec))
            if norm_query > 0 and norm_memory > 0:
                score = float(np.dot(query_vec, memory_vec) / (norm_query * norm_memory))
            else:
                score = 0.0
            if score < min_similarity:
                continue
            topics_raw = row[1]
            topics = json.loads(topics_raw) if isinstance(topics_raw, str) else topics_raw
            st_meta = topics if isinstance(topics, dict) else {}
            scored.append((score, row[0], st_meta))
        except Exception:
            continue

    scored.sort(key=lambda x: x[0], reverse=True)
    scored = scored[:top_k]

    metadata: list[dict] = []
    hashes: list[int] = []
    for score, content, st_meta in scored:
        item_hash = st_meta.get("st_hash")
        metadata.append(
            {
                "hash": item_hash,
                "text": content,
                "index": st_meta.get("st_index"),
                "score": round(score, 4),
            }
        )
        if isinstance(item_hash, int):
            hashes.append(item_hash)
    return {"metadata": metadata, "hashes": hashes}


@router.post("/api/vector/index")
async def st_vector_index(
    body: VectorIndexRequest,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """创建或获取向量索引（ST 向量插件格式）。

    memory_module 没有“索引”概念，使用 session_id 作为集合标识；
    存储层在首次写入时会自动建表/建索引，因此“创建”是幂等的。
    """
    from ..memory_module.service import MemoryService

    service = MemoryService(db)
    if not service.is_available():
        return {"ok": False, "error": "memory module disabled"}

    index_hash = body.hash or f"palink-vector-{user.id}-{body.name}"
    return {
        "ok": True,
        "index": {
            "name": body.name,
            "hash": index_hash,
        },
    }


@router.post("/api/vector/query")
async def st_vector_query(
    body: VectorQueryRequest,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """查询相似文档。

    双格式：body 含 collectionId 时按 ST 1.18.0 vectors.js 语义处理，
    返回 {"metadata": [...], "hashes": [...]}；否则维持 Palink 自有格式。
    """
    from ..memory_module.embedder import embed_text
    from ..memory_module.service import MemoryService
    from ..memory_module.storage import MemoryStorage

    service = MemoryService(db)
    if not service.is_available():
        if body.collectionId is not None:
            return JSONResponse(
                status_code=503, content={"error": "memory module disabled"}
            )
        return {"results": [], "ok": False, "error": "memory module disabled"}

    # ---- ST 格式分支 ----
    if body.collectionId is not None:
        try:
            return _st_vec_query_collection(
                db=db,
                user_id=user.id,
                collection_id=body.collectionId,
                search_text=body.searchText or "",
                top_k=body.topK or 10,
                threshold=body.threshold,
            )
        except Exception:
            logging.getLogger("palink.st_vector").exception("st vector query failed")
            return {"metadata": [], "hashes": []}

    # ---- Palink 自有格式分支 ----
    if not body.query:
        return {"results": []}

    try:
        embedding = embed_text(body.query)
        embedding_list = (
            embedding.tolist()[0] if len(embedding.shape) > 1 else embedding.tolist()
        )
        storage = MemoryStorage(db)
        results = storage.semantic_search(
            user_id=user.id,
            query_embedding=embedding_list,
            limit=body.top_k,
        )
    except Exception:
        logging.getLogger("palink.st_vector").exception("vector query failed")
        return {"results": []}

    items = []
    for memory, score in results:
        items.append({
            "id": memory.id,
            "text": memory.content,
            "score": round(float(score), 4),
            "metadata": {
                "role": memory.role,
                "importance": memory.importance_score,
                "topics": memory.topics,
                "session_id": memory.session_id,
                "created_at": memory.created_at.isoformat() if memory.created_at else None,
            },
        })
    return {"results": items}


@router.post("/api/vector/insert")
async def st_vector_insert(
    body: VectorInsertRequest,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """批量插入向量文档。单个条目失败不中断整批操作。

    双格式：body 含 collectionId 时按 ST 语义处理——
    hash 由 ST 客户端（cyrb53/getStringHash）计算并随 items[].hash 上传，
    服务端仅存储（topics.st_hash）并按 hash 去重。
    """
    from ..memory_module.service import MemoryService

    service = MemoryService(db)
    if not service.is_available():
        if body.collectionId is not None:
            return JSONResponse(
                status_code=503, content={"error": "memory module disabled"}
            )
        return {"inserted": 0, "ok": False, "error": "memory module disabled"}

    # ---- ST 格式分支 ----
    if body.collectionId is not None:
        existing = set(_st_vec_list_hashes(db, user.id, body.collectionId))
        session_id = _st_vec_session(body.collectionId)
        inserted = 0
        for item in body.items:
            if isinstance(item.hash, int) and item.hash in existing:
                continue
            try:
                memory_id = service.store_memory(
                    user_id=user.id,
                    session_id=session_id,
                    role="system",
                    content=item.text,
                    importance_score=0.5,
                    topics={
                        "st_hash": item.hash,
                        "st_index": item.index,
                        "st_source": body.source,
                    },
                )
                if memory_id is not None:
                    inserted += 1
                    if isinstance(item.hash, int):
                        existing.add(item.hash)
            except Exception:
                logging.getLogger("palink.st_vector").exception(
                    "st vector insert item failed: text_len=%d", len(item.text)
                )
                continue
        # ST 客户端只检查 response.ok，返回 200 即可
        return {"ok": True, "inserted": inserted}

    # ---- Palink 自有格式分支 ----
    inserted = 0
    session_id = body.source or f"vector-api-{user.id}"
    for item in body.items:
        metadata = item.metadata or {}
        try:
            memory_id = service.store_memory(
                user_id=user.id,
                session_id=session_id,
                role=metadata.get("role", "system"),
                content=item.text,
                importance_score=float(metadata.get("importance", 0.5)),
                topics=metadata.get("topics", []),
            )
            if memory_id is not None:
                inserted += 1
        except Exception:
            logging.getLogger("palink.st_vector").exception(
                "vector insert item failed: text_len=%d", len(item.text)
            )
            continue
    return {"inserted": inserted}


@router.post("/api/vector/delete")
async def st_vector_delete(
    body: VectorDeleteRequest,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """删除向量文档：支持按 id 列表、按 source 批量删除，或 ST 格式按 hashes 删除。"""
    from sqlalchemy import bindparam, text as sa_text

    from ..memory_module.service import MemoryService

    service = MemoryService(db)
    if not service.is_available():
        if body.collectionId is not None:
            return JSONResponse(
                status_code=503, content={"error": "memory module disabled"}
            )
        return {"deleted": 0, "ok": False, "error": "memory module disabled"}

    # ---- ST 格式分支：按 collectionId + hashes 删除 ----
    if body.collectionId is not None:
        deleted = 0
        target_hashes = set(h for h in (body.hashes or []) if isinstance(h, int))
        if target_hashes:
            try:
                rows = db.execute(
                    sa_text(
                        "SELECT id, topics FROM conversation_memories "
                        "WHERE user_id = :user_id AND session_id = :session_id"
                    ),
                    {
                        "user_id": user.id,
                        "session_id": _st_vec_session(body.collectionId),
                    },
                ).fetchall()
                ids_to_delete = []
                for row in rows:
                    try:
                        topics = json.loads(row[1]) if isinstance(row[1], str) else row[1]
                    except Exception:
                        continue
                    if (
                        isinstance(topics, dict)
                        and topics.get("st_hash") in target_hashes
                    ):
                        ids_to_delete.append(row[0])
                if ids_to_delete:
                    delete_sql = sa_text(
                        "DELETE FROM conversation_memories "
                        "WHERE id IN :ids AND user_id = :user_id"
                    ).bindparams(bindparam("ids", expanding=True))
                    result = db.execute(
                        delete_sql, {"ids": ids_to_delete, "user_id": user.id}
                    )
                    deleted = result.rowcount or 0
                db.commit()
            except Exception:
                logging.getLogger("palink.st_vector").exception(
                    "st vector delete by hashes failed"
                )
                db.rollback()
        return {"ok": True, "deleted": deleted}

    # ---- Palink 自有格式分支 ----
    deleted = 0
    try:
        if body.ids:
            try:
                delete_sql = sa_text(
                    "DELETE FROM conversation_memories WHERE id IN :ids AND user_id = :user_id"
                ).bindparams(bindparam("ids", expanding=True))
                result = db.execute(delete_sql, {"ids": body.ids, "user_id": user.id})
                deleted = result.rowcount or 0
            except Exception:
                logging.getLogger("palink.st_vector").exception("vector delete by ids failed")
                db.rollback()
        elif body.source:
            try:
                delete_sql = sa_text(
                    "DELETE FROM conversation_memories WHERE session_id = :source AND user_id = :user_id"
                )
                result = db.execute(delete_sql, {"source": body.source, "user_id": user.id})
                deleted = result.rowcount or 0
            except Exception:
                logging.getLogger("palink.st_vector").exception("vector delete by source failed")
                db.rollback()
        db.commit()
    except Exception:
        logging.getLogger("palink.st_vector").exception("vector delete failed")
        db.rollback()
    return {"deleted": deleted}


@router.post("/api/vector/list")
async def st_vector_list(
    body: VectorListRequest,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """ST vectors.js /list：返回集合内已存 hash 的裸数组 number[]。

    注意：ST 客户端 `await response.json()` 后直接当数组用，
    不能包 {data:...} 信封。
    """
    from ..memory_module.service import MemoryService

    service = MemoryService(db)
    if not service.is_available():
        return JSONResponse(status_code=503, content={"error": "memory module disabled"})

    try:
        return _st_vec_list_hashes(db, user.id, body.collectionId)
    except Exception:
        logging.getLogger("palink.st_vector").exception("st vector list failed")
        return []


@router.post("/api/vector/query-multi")
async def st_vector_query_multi(
    body: VectorQueryMultiRequest,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """ST vectors.js /query-multi：多集合查询。

    返回 Record<collectionId, {metadata, hashes}>。
    """
    from ..memory_module.service import MemoryService

    service = MemoryService(db)
    if not service.is_available():
        return JSONResponse(status_code=503, content={"error": "memory module disabled"})

    results: dict[str, dict] = {}
    for collection_id in body.collectionIds:
        try:
            results[collection_id] = _st_vec_query_collection(
                db=db,
                user_id=user.id,
                collection_id=collection_id,
                search_text=body.searchText,
                top_k=body.topK,
                threshold=body.threshold,
            )
        except Exception:
            logging.getLogger("palink.st_vector").exception(
                "st vector query-multi failed for collection %s", collection_id
            )
            results[collection_id] = {"metadata": [], "hashes": []}
    return results


@router.post("/api/vector/purge")
async def st_vector_purge(
    body: VectorPurgeRequest,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """ST vectors.js /purge：删除单个集合的全部向量。

    仅删除 st-vec:: 前缀会话，不会触碰正常会话记忆。
    """
    from sqlalchemy import text as sa_text

    from ..memory_module.service import MemoryService

    service = MemoryService(db)
    if not service.is_available():
        return JSONResponse(status_code=503, content={"error": "memory module disabled"})

    deleted = 0
    try:
        result = db.execute(
            sa_text(
                "DELETE FROM conversation_memories "
                "WHERE user_id = :user_id AND session_id = :session_id"
            ),
            {"user_id": user.id, "session_id": _st_vec_session(body.collectionId)},
        )
        deleted = result.rowcount or 0
        db.commit()
    except Exception:
        logging.getLogger("palink.st_vector").exception("st vector purge failed")
        db.rollback()
    return {"ok": True, "deleted": deleted}


@router.post("/api/vector/purge-all")
async def st_vector_purge_all(
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """ST vectors.js /purge-all：删除当前用户全部 ST 向量集合。

    通过 st-vec:: 前缀精确圈定范围，正常会话记忆不受影响。
    """
    from sqlalchemy import text as sa_text

    from ..memory_module.service import MemoryService

    service = MemoryService(db)
    if not service.is_available():
        return JSONResponse(status_code=503, content={"error": "memory module disabled"})

    deleted = 0
    try:
        result = db.execute(
            sa_text(
                "DELETE FROM conversation_memories "
                "WHERE user_id = :user_id AND session_id LIKE :prefix"
            ),
            {"user_id": user.id, "prefix": f"{_ST_VEC_PREFIX}%"},
        )
        deleted = result.rowcount or 0
        db.commit()
    except Exception:
        logging.getLogger("palink.st_vector").exception("st vector purge-all failed")
        db.rollback()
    return {"ok": True, "deleted": deleted}


@router.post("/api/translate")
async def st_translate(
    user: User = Depends(get_st_current_user),
):
    return {"translated": "", "detected": "en"}


# 批次5: ST translate 插件调用的 provider 子路径（translate/index.js:254-413）
_TRANSLATE_PROVIDERS = {"onering", "libre", "google", "lingva", "deepl", "deeplx", "bing", "yandex"}


async def _llm_translate_text(text: str, lang: str) -> str:
    """translate 子路径的 Palink 兜底实现：用默认 LLM 翻译文本。

    输出纯译文文本（ST 插件 response.text() 读取）。
    """
    if not text or not text.strip():
        return ""
    try:
        model_id = _default_model_id()
        ensure_model_available(model_id)
        target = lang or "English"
        system = (
            "You are a translation engine. Translate the user's text to "
            f"{target}. Preserve meaning, tone and formatting. Output ONLY the "
            "translated text with no explanations, quotes or commentary."
        )
        result = StreamResult()
        stream = stream_text_completion(
            model_id=model_id,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": text}],
            temperature=0.2,
            max_tokens=None,
            timeout=60.0,
        )
        async for _ in stream_chat_deltas(stream, result):
            pass
        return (result.full_content or "").strip()
    except Exception as exc:
        logging.getLogger("palink.st_translate").warning("translate failed: %s", exc)
        return ""


@router.post("/api/translate/{provider}")
async def st_translate_provider(
    provider: str,
    request: Request,
    user: User = Depends(get_st_current_user),
):
    """批次5: ST translate 插件 provider 子路径（onering/libre/google/lingva/
    deepl/deeplx/bing/yandex）。统一经 Palink LLM 翻译并返回纯文本，
    消除此前全部 404（翻译功能不可用）。"""
    if provider not in _TRANSLATE_PROVIDERS:
        return JSONResponse(status_code=404, content={"error": f"unknown translate provider: {provider}"})
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    text = body.get("text") or ""
    lang = body.get("to_lang") or body.get("lang") or body.get("to") or ""
    translated = await _llm_translate_text(str(text), str(lang))
    return Response(content=translated, media_type="text/plain")


@router.post("/api/backends/kobold/embed")
async def st_backends_kobold_embed(
    request: Request,
    user: User = Depends(get_st_current_user),
):
    """批次5: ST vectors 插件的 KoboldCpp 嵌入端点（vectors/index.js:1455）。

    用 Palink 记忆嵌入器计算 items 的向量，返回 {embeddings, model}。
    """
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    items = body.get("items") or []
    if not isinstance(items, list):
        items = []
    if not items:
        return JSONResponse({"embeddings": [], "model": "palink-embed"})
    try:
        from ..memory_module.embedder import embed_text
        arr = await asyncio.to_thread(embed_text, [str(i) for i in items])
        vecs = arr.tolist() if hasattr(arr, "tolist") else arr
        if not isinstance(vecs, list):
            vecs = []
        return JSONResponse({"embeddings": vecs, "model": "palink-embed"})
    except Exception as exc:
        logging.getLogger("palink.st_vector").warning("kobold embed failed: %s", exc)
        return JSONResponse(status_code=503, content={"error": "embedding service unavailable"})


@router.post("/api/search")
async def st_search(
    user: User = Depends(get_st_current_user),
):
    return {"results": []}


# ===========================================================================
# Task 25: Slash command backend endpoints (ST 1.18.0 compatible)
#
# 这些端点为前端 SlashCommandEngine 提供 ST 兼容的 REST 入口，处理那些
# 具有后端副作用（修改消息可见性 / 删除消息 / 重命名会话 / 注入 prompt）
# 的斜杠命令。前端纯展示类命令（/popup, /buttons, /messages）返回 200 stub。
# ===========================================================================


class ChatMessageTargetRequest(AvatarRequest):
    """针对单条消息的斜杠命令请求体（/hide, /unhide, /delchat 单条）。

    ST 1.18.0 SlashCommandEngine 通过 file_name 或 avatar_url 定位会话，
    通过 mesid（消息在会话中的索引）定位具体消息。
    """

    file_name: Optional[str] = None
    mesid: Optional[int] = None


class ChatRenameSessionRequest(AvatarRequest):
    """重命名会话标题（/renamechat）。"""

    file_name: Optional[str] = None
    new_name: Optional[str] = None


class ChatFindRequest(AvatarRequest):
    """在会话内搜索消息（/find）。"""

    file_name: Optional[str] = None
    query: Optional[str] = None


class ChatInjectRequest(AvatarRequest):
    """注入 prompt 内容到会话（/inject）。

    position 值：
      0 = in-chat（按 depth 插入到消息历史中）
      1 = after system prompt（追加到 system_prompt 末尾）
      2 = before author note（作为 system 消息插在 author note 之前）
    """

    file_name: Optional[str] = None
    content: Optional[str] = None
    position: int = 0
    depth: int = 4


class ChatTriggerRequest(AvatarRequest):
    """触发生成（/trigger）。前端实际发起生成，后端只记录意图。"""

    file_name: Optional[str] = None
    message: Optional[str] = None


def _resolve_session_from_target(
    db: Session,
    user: User,
    req: ChatMessageTargetRequest,
    request: Request,
) -> tuple[Optional[CharacterChatSession], Optional[CharacterChatSessionBranch]]:
    """根据 file_name / avatar_url 解析会话与活动分支。

    找不到会话时返回 (None, None)，由调用方决定是否抛 404。
    """
    avatar_url = _request_avatar(req)
    file_name = req.file_name
    if not avatar_url and not file_name:
        return None, None
    character = _character_for_avatar(db, user, avatar_url) if avatar_url else None
    if character is None:
        return None, None
    session_id_hint = request.headers.get("X-Palink-Session-Id") if request else None
    session = _session_for_file(db, user, character, file_name, session_id_hint)
    if session is None:
        return None, None
    branch_id = request.headers.get("X-Palink-Branch-Id") if request else None
    branch = _branch_for_context(db, session, branch_id) if branch_id else _active_branch(db, session)
    return session, branch


def _find_message_by_mesid(
    db: Session,
    session: CharacterChatSession,
    branch: Optional[CharacterChatSessionBranch],
    mesid: Optional[int],
) -> Optional[CharacterChatMessage]:
    """根据 mesid 在会话分支中查找消息。

    ST 的 mesid 是消息在会话中的索引（按 created_at, id 升序）。
    """
    messages = _chat_messages(db, session, branch)
    if mesid is None:
        return messages[-1] if messages else None
    if mesid < 0 or mesid >= len(messages):
        return None
    return messages[mesid]


@router.post("/api/chats/hide")
async def st_chats_hide(
    req: ChatMessageTargetRequest,
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """设置消息 is_hidden=True（/hide 命令后端入口）。"""
    session, branch = _resolve_session_from_target(db, user, req, request)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    message = _find_message_by_mesid(db, session, branch, req.mesid)
    if not message:
        raise HTTPException(status_code=404, detail="Message not found")
    message.is_hidden = True
    db.commit()
    return {"result": "ok"}


@router.post("/api/chats/unhide")
async def st_chats_unhide(
    req: ChatMessageTargetRequest,
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """设置消息 is_hidden=False（/unhide 命令后端入口）。"""
    session, branch = _resolve_session_from_target(db, user, req, request)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    message = _find_message_by_mesid(db, session, branch, req.mesid)
    if not message:
        raise HTTPException(status_code=404, detail="Message not found")
    message.is_hidden = False
    db.commit()
    return {"result": "ok"}


@router.post("/api/chats/delete-message")
async def st_chats_delete_message(
    req: ChatMessageTargetRequest,
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """删除会话中的单条消息（/delchat 单条目标）。

    删除后，后续消息的 mesid 会因索引重排而改变，与 ST 1.18.0 行为一致。
    """
    session, branch = _resolve_session_from_target(db, user, req, request)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    message = _find_message_by_mesid(db, session, branch, req.mesid)
    if not message:
        raise HTTPException(status_code=404, detail="Message not found")
    db.delete(message)
    db.commit()
    return {"result": "ok"}


@router.post("/api/chats/rename-session")
async def st_chats_rename_session(
    req: ChatRenameSessionRequest,
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """重命名会话标题（/renamechat 命令后端入口）。"""
    avatar_url = _request_avatar(req)
    file_name = req.file_name
    if not avatar_url and not file_name:
        raise HTTPException(status_code=400, detail="file_name or avatar_url is required")
    character = _character_for_avatar(db, user, avatar_url) if avatar_url else None
    if character is None:
        raise HTTPException(status_code=404, detail="Character not found")
    session_id_hint = request.headers.get("X-Palink-Session-Id") if request else None
    session = _session_for_file(db, user, character, file_name, session_id_hint)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    new_name = (req.new_name or "").strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="new_name is required")
    session.title = re.sub(r"\.jsonl$", "", new_name, flags=re.IGNORECASE) or session.title
    session.updated_at = datetime.now(timezone.utc)
    db.commit()
    return {"result": "ok"}


@router.post("/api/chats/find")
async def st_chats_find(
    req: ChatFindRequest,
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """在会话内搜索消息（/find 命令后端入口）。

    返回匹配消息的 mesid 与内容片段（前 200 字符）。
    """
    session, branch = _resolve_session_from_target(db, user, req, request)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    query = (req.query or "").strip()
    if not query:
        return {"results": []}
    messages = _chat_messages(db, session, branch)
    results: list[dict[str, Any]] = []
    for index, message in enumerate(messages):
        content = message.content or ""
        if query.lower() in content.lower():
            results.append({
                "mesid": index,
                "id": message.id,
                "snippet": content[:200],
                "is_user": bool(message.is_user) if message.is_user is not None else message.role == "user",
            })
    return {"results": results}


@router.post("/api/chats/set-input")
async def st_chats_set_input(
    user: User = Depends(get_st_current_user),
):
    """设置输入框内容（/setinput）—— 前端纯展示操作，后端返回 200 stub。"""
    return {"result": "ok"}


@router.post("/api/chats/inject")
async def st_chats_inject(
    req: ChatInjectRequest,
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """注入 prompt 内容到会话（/inject 命令后端入口）。

    注入内容存入 session.chat_metadata["palink_injections"] 数组，
    roleplay_prompt_assembly.assemble_roleplay_prompt 在组装时读取并按
    position/depth 插入到对应位置。flush-inject 端点清空该数组。
    """
    session, _branch = _resolve_session_from_target(db, user, req, request)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    content = (req.content or "").strip()
    if not content:
        return {"result": "ok"}
    metadata = _safe_json_loads(session.chat_metadata, {})
    if not isinstance(metadata, dict):
        metadata = {}
    injections = metadata.get("palink_injections")
    if not isinstance(injections, list):
        injections = []
    injections.append({
        "content": content,
        "position": int(req.position or 0),
        "depth": int(req.depth if req.depth is not None else 4),
    })
    metadata["palink_injections"] = injections
    session.chat_metadata = _json_dumps(metadata)
    session.updated_at = datetime.now(timezone.utc)
    db.commit()
    return {"result": "ok"}


@router.post("/api/chats/flush-inject")
async def st_chats_flush_inject(
    req: ChatMessageTargetRequest,
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """清空会话的所有注入（/flushinject 命令后端入口）。"""
    session, _branch = _resolve_session_from_target(db, user, req, request)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    metadata = _safe_json_loads(session.chat_metadata, {})
    if isinstance(metadata, dict) and isinstance(metadata.get("palink_injections"), list):
        metadata["palink_injections"] = []
        session.chat_metadata = _json_dumps(metadata)
        session.updated_at = datetime.now(timezone.utc)
        db.commit()
    return {"result": "ok"}


@router.post("/api/chats/trigger")
async def st_chats_trigger(
    req: ChatTriggerRequest,
    user: User = Depends(get_st_current_user),
):
    """触发生成（/trigger）—— 前端实际发起生成，后端返回 200 stub。"""
    return {"result": "ok"}


@router.post("/api/chats/popup")
async def st_chats_popup(
    user: User = Depends(get_st_current_user),
):
    """显示弹窗（/popup）—— 前端纯展示操作，后端返回 200 stub。"""
    return {"result": "ok"}


@router.post("/api/chats/buttons")
async def st_chats_buttons(
    user: User = Depends(get_st_current_user),
):
    """创建按钮（/buttons）—— 前端纯展示操作，后端返回 200 stub。"""
    return {"result": "ok"}


@router.post("/api/chats/messages")
async def st_chats_messages(
    user: User = Depends(get_st_current_user),
):
    """显示消息（/messages）—— 前端纯展示操作，后端返回 200 stub。"""
    return {"result": "ok"}


# ===========================================================================
# Task 26: Quick Reply command endpoints (ST 1.18.0 compatible)
#
# ST 的 Quick Reply 斜杠命令（/qr, /qr1-/qr5, /quickreply 等）在前端执行，
# 但可能调用后端端点查询 / 创建 / 更新 / 执行 QR。这里提供最小 ST 兼容
# 实现：QR 数据存储在 user_settings.silly_tavern_settings.extension_settings
# .quickReply.sets（与 /api/quick-replies/save 复用同一存储）。
# ===========================================================================


def _read_qr_sets(user: User, db: Session) -> list[dict[str, Any]]:
    """读取当前用户的 Quick Reply sets 列表。"""
    setting = _get_or_create_user_setting(user, db)
    settings_data = _safe_json_loads(setting.silly_tavern_settings, {})
    if not isinstance(settings_data, dict):
        return []
    extension_settings = settings_data.get("extension_settings")
    if not isinstance(extension_settings, dict):
        return []
    quick_reply = extension_settings.get("quickReply")
    if not isinstance(quick_reply, dict):
        return []
    sets = quick_reply.get("sets")
    if not isinstance(sets, list):
        return []
    return [s for s in sets if isinstance(s, dict)]


def _write_qr_sets(user: User, db: Session, sets: list[dict[str, Any]]) -> None:
    """持久化 Quick Reply sets 列表。"""
    setting = _get_or_create_user_setting(user, db)
    settings_data = _safe_json_loads(setting.silly_tavern_settings, {})
    if not isinstance(settings_data, dict):
        settings_data = {}
    extension_settings = settings_data.get("extension_settings")
    if not isinstance(extension_settings, dict):
        extension_settings = {}
    quick_reply = extension_settings.get("quickReply")
    if not isinstance(quick_reply, dict):
        quick_reply = {}
    quick_reply["sets"] = sets
    extension_settings["quickReply"] = quick_reply
    settings_data["extension_settings"] = extension_settings
    setting.silly_tavern_settings = _json_dumps(settings_data)
    db.commit()


@router.get("/api/quick-replies/list")
async def st_quick_replies_list(
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """列出当前用户的所有 Quick Reply sets（/qr list 后端入口）。"""
    sets = _read_qr_sets(user, db)
    return {"sets": sets}


class QuickReplyExecuteRequest(BaseModel):
    set: Optional[str] = None
    label: Optional[str] = None


@router.post("/api/quick-replies/execute")
async def st_quick_replies_execute(
    req: QuickReplyExecuteRequest,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """按 label 查找并返回 Quick Reply 配置（/qr execute 后端入口）。

    实际命令执行由前端 SlashCommandEngine 完成，后端只返回 QR 配置。
    """
    set_name = (req.set or "").strip()
    label = (req.label or "").strip()
    if not set_name or not label:
        raise HTTPException(status_code=400, detail="set and label are required")
    sets = _read_qr_sets(user, db)
    for s in sets:
        if str(s.get("name") or "") != set_name:
            continue
        # QuickReply set 内部可能包含 quickReplies 数组（ST 1.18.0 结构）
        entries = s.get("quickReplies")
        if isinstance(entries, list):
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                if str(entry.get("label") or "") == label:
                    return {"result": "ok", "quick_reply": entry, "set": s}
        # 兼容旧结构：直接在 set 上找 label 字段
        if str(s.get("label") or "") == label:
            return {"result": "ok", "quick_reply": s, "set": s}
    raise HTTPException(status_code=404, detail="Quick reply not found")


class QuickReplyCreateRequest(BaseModel):
    set_name: Optional[str] = None
    name: Optional[str] = None
    label: Optional[str] = None
    text: Optional[str] = None
    data: Optional[dict[str, Any]] = None


@router.post("/api/quick-replies/create")
async def st_quick_replies_create(
    req: QuickReplyCreateRequest,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """创建新的 Quick Reply（/qr create 后端入口）。

    若 set_name 不存在则创建新 set；若已存在则在该 set 内追加一条
    quickReply 条目（label 唯一）。
    """
    set_name = str(req.set_name or req.name or "").strip()
    if not set_name:
        raise HTTPException(status_code=400, detail="set_name is required")
    label = str(req.label or "").strip()
    sets = _read_qr_sets(user, db)
    target_set: Optional[dict[str, Any]] = None
    for s in sets:
        if str(s.get("name") or "") == set_name:
            target_set = s
            break
    if target_set is None:
        target_set = {"name": set_name, "quickReplies": []}
        sets.append(target_set)
    if not isinstance(target_set.get("quickReplies"), list):
        target_set["quickReplies"] = []
    if label:
        # 若 label 已存在则覆盖，避免重复
        existing = None
        for entry in target_set["quickReplies"]:
            if isinstance(entry, dict) and str(entry.get("label") or "") == label:
                existing = entry
                break
        payload = req.data if isinstance(req.data, dict) else {
            "label": label,
            "text": req.text or "",
        }
        if existing is None:
            target_set["quickReplies"].append({**payload, "label": label})
        else:
            existing.update(payload)
            existing["label"] = label
    _write_qr_sets(user, db, sets)
    return {"ok": True, "set": target_set}


class QuickReplyUpdateRequest(BaseModel):
    set_name: Optional[str] = None
    name: Optional[str] = None
    label: Optional[str] = None
    text: Optional[str] = None
    data: Optional[dict[str, Any]] = None


@router.post("/api/quick-replies/update")
async def st_quick_replies_update(
    req: QuickReplyUpdateRequest,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """更新已存在的 Quick Reply（/qr update 后端入口）。

    若 set 不存在则 404；若 label 在 set 中不存在则追加（与 create 行为一致，
    避免 ST 端在更新未保存 QR 时丢失数据）。
    """
    set_name = str(req.set_name or req.name or "").strip()
    if not set_name:
        raise HTTPException(status_code=400, detail="set_name is required")
    label = str(req.label or "").strip()
    sets = _read_qr_sets(user, db)
    target_set: Optional[dict[str, Any]] = None
    for s in sets:
        if str(s.get("name") or "") == set_name:
            target_set = s
            break
    if target_set is None:
        raise HTTPException(status_code=404, detail="Quick reply set not found")
    if not isinstance(target_set.get("quickReplies"), list):
        target_set["quickReplies"] = []
    payload = req.data if isinstance(req.data, dict) else {
        "label": label,
        "text": req.text or "",
    }
    if label:
        for entry in target_set["quickReplies"]:
            if isinstance(entry, dict) and str(entry.get("label") or "") == label:
                entry.update(payload)
                entry["label"] = label
                _write_qr_sets(user, db, sets)
                return {"ok": True, "set": target_set}
        target_set["quickReplies"].append({**payload, "label": label})
    _write_qr_sets(user, db, sets)
    return {"ok": True, "set": target_set}


# ===========================================================================
# Task 37: /api/secrets/* 安全 stub
#
# SillyTavern 插件（如 Secret Manager）会调用 /api/secrets/* 系列端点管理
# API key 等敏感信息。Palink 自身使用 ConnectionProfiles 体系托管连接配置与
# 凭证，不需要也不应通过 ST 的 secrets 接口写入。这里返回 ST 兼容的安全空
# 形状（HTTP 200），避免插件因 404/500 崩溃，同时通过 error 字段提示用户
# 使用 Palink ConnectionProfiles API。
# ===========================================================================


@router.post("/api/themes/save")
async def st_themes_save(
    payload: Any = Body(None),
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """C-7 修复: ST 主题保存（power-user.js:2499），不再依赖 ST sidecar。

    将 ST theme JSON 持久化到 UserSetting.power_user.themes（同名覆盖），
    前端 reload 后经 /api/settings/get 读回。
    """
    if not isinstance(payload, dict) or not payload.get("name"):
        return JSONResponse({"ok": False, "error": "theme name required"}, status_code=400)
    from ..models.user_setting import UserSetting
    setting = db.query(UserSetting).filter(UserSetting.user_id == user.id).first()
    if setting is None:
        setting = UserSetting(user_id=user.id)
        db.add(setting)
    pu: dict = {}
    if setting.power_user:
        try:
            pu = json.loads(setting.power_user) if isinstance(setting.power_user, str) else setting.power_user
        except (json.JSONDecodeError, TypeError, ValueError):
            pu = {}
    if not isinstance(pu, dict):
        pu = {}
    themes = pu.get("themes")
    if not isinstance(themes, list):
        themes = []
    themes = [t for t in themes if not (isinstance(t, dict) and t.get("name") == payload["name"])]
    themes.append(payload)
    pu["themes"] = themes
    setting.power_user = json.dumps(pu, ensure_ascii=False)
    db.commit()
    return {"ok": True, "name": payload["name"]}


@router.post("/api/stats/get")
async def st_stats_get(
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """C-7 修复: ST 使用统计（stats.js:179），不再依赖 ST sidecar。

    按角色聚合 Palink 消息统计，结构对齐 ST charStats:
    {character_id: {user_msg_count, non_user_msg_count, user_word_count,
    non_user_word_count, total_swipe_count, date_first_chat, date_last_chat,
    total_gen_time}}。total_gen_time Palink 无计费耗时数据，恒为 0。
    """
    from ..models.user_setting import UserSetting
    import sqlalchemy as _sa

    stats_rows = (
        db.query(
            CharacterChatSession.character_id,
            CharacterChatMessage.role,
            func.count(CharacterChatMessage.id),
            func.sum(_sa.func.length(CharacterChatMessage.content)),
        )
        .join(CharacterChatMessage, CharacterChatMessage.session_id == CharacterChatSession.id)
        .filter(CharacterChatSession.user_id == user.id)
        .group_by(CharacterChatSession.character_id, CharacterChatMessage.role)
        .all()
    )
    char_stats: dict[str, dict[str, Any]] = {}
    for chid, role, cnt, word_len in stats_rows:
        entry = char_stats.setdefault(str(chid), {
            "total_gen_time": 0,
            "user_msg_count": 0,
            "non_user_msg_count": 0,
            "user_word_count": 0,
            "non_user_word_count": 0,
            "total_swipe_count": 0,
            "date_last_chat": 0,
            "date_first_chat": 0,
        })
        cnt = int(cnt or 0)
        word_len = int(word_len or 0)
        if role == "user":
            entry["user_msg_count"] += cnt
            entry["user_word_count"] += word_len
        else:
            entry["non_user_msg_count"] += cnt
            entry["non_user_word_count"] += word_len
    # 时间范围
    time_rows = (
        db.query(
            CharacterChatSession.character_id,
            func.min(CharacterChatMessage.created_at),
            func.max(CharacterChatMessage.created_at),
        )
        .join(CharacterChatMessage, CharacterChatMessage.session_id == CharacterChatSession.id)
        .filter(CharacterChatSession.user_id == user.id)
        .group_by(CharacterChatSession.character_id)
        .all()
    )
    for chid, first_at, last_at in time_rows:
        entry = char_stats.setdefault(str(chid), {
            "total_gen_time": 0,
            "user_msg_count": 0,
            "non_user_msg_count": 0,
            "user_word_count": 0,
            "non_user_word_count": 0,
            "total_swipe_count": 0,
            "date_last_chat": 0,
            "date_first_chat": 0,
        })
        if first_at:
            entry["date_first_chat"] = int(first_at.timestamp() * 1000)
        if last_at:
            entry["date_last_chat"] = int(last_at.timestamp() * 1000)
    return char_stats


@router.post("/api/secrets/settings")
async def st_secrets_settings(
    user: User = Depends(get_st_current_user),
):
    """C-6 修复: ST /api/secrets/settings（secrets.js:291）。

    返回 allowKeysExposure=false（Palink 不通过 ST secrets 暴露密钥，
    凭证由 ConnectionProfiles 管理），避免 ST 前端读取到 undefined。
    """
    return {"allowKeysExposure": False}


@router.post("/api/secrets/write")
async def st_secrets_write(
    payload: Any = Body(None),
    user: User = Depends(get_st_current_user),
):
    """ST secrets write stub。Palink 凭证由 ConnectionProfiles 管理。"""
    return {"result": False, "error": "Secret management is handled by Palink ConnectionProfiles"}


@router.post("/api/secrets/read")
async def st_secrets_read(
    payload: Any = Body(None),
    user: User = Depends(get_st_current_user),
):
    """ST secrets read stub。返回空值，提示使用 ConnectionProfiles API。"""
    return {"result": "", "error": "Use Palink ConnectionProfiles API"}


@router.post("/api/secrets/view")
async def st_secrets_view(
    payload: Any = Body(None),
    user: User = Depends(get_st_current_user),
):
    """ST secrets view stub。返回空列表避免泄露任何已存凭证。"""
    return {"secrets": [], "values": []}


@router.post("/api/secrets/find")
async def st_secrets_find(
    payload: Any = Body(None),
    user: User = Depends(get_st_current_user),
):
    """ST secrets find stub。始终返回空值。"""
    return {"value": ""}


@router.post("/api/secrets/delete")
async def st_secrets_delete(
    payload: Any = Body(None),
    user: User = Depends(get_st_current_user),
):
    """ST secrets delete stub。Palink 凭证由 ConnectionProfiles 管理。"""
    return {"result": False, "error": "Use Palink ConnectionProfiles API"}


@router.post("/api/secrets/rotate")
async def st_secrets_rotate(
    payload: Any = Body(None),
    user: User = Depends(get_st_current_user),
):
    """ST secrets rotate stub。Palink 凭证轮换由 ConnectionProfiles 管理。"""
    return {"result": False, "error": "Use Palink ConnectionProfiles API"}


@router.post("/api/secrets/rename")
async def st_secrets_rename(
    payload: Any = Body(None),
    user: User = Depends(get_st_current_user),
):
    """ST secrets rename stub。Palink 凭证由 ConnectionProfiles 管理。"""
    return {"result": False, "error": "Use Palink ConnectionProfiles API"}


# ===========================================================================
# Task 38 → T4 (ST 插件兼容): /api/extensions/* 真实代理
#
# SillyTavern 的扩展管理（安装/更新/删除/发现）会调用 /api/extensions/*。
# 扩展文件系统由 ST sidecar 持有，因此这些操作转发到
# app_settings.ST_NATIVE_SERVICE_URL 对应的 sidecar。
# sidecar 不可用时：
#   - install/update/delete → 502 + 明确 JSON 错误（不再假成功）
#   - discover → 降级返回 []（ST 前端启动即调用，502 会刷屏）
# ===========================================================================


async def _forward_extensions_to_st_native(
    request: Request,
    user: User,
    path: str,
) -> Response:
    """非流式转发 /api/extensions/* 到 ST sidecar，返回上游响应。"""
    base = str(app_settings.ST_NATIVE_SERVICE_URL or "").rstrip("/")
    if not base:
        return JSONResponse(
            status_code=502,
            content={
                "error": "ST native service unavailable",
                "detail": "ST_NATIVE_SERVICE_URL is not configured",
            },
        )
    target_url = f"{base}/{path.lstrip('/')}"
    query_string = str(request.url.query) if request.url.query else ""
    if query_string:
        target_url = f"{target_url}?{query_string}"
    session_payload = _st_native_session_payload(request)
    headers = _build_proxy_request_headers(request, user, session_payload)
    body_bytes: Optional[bytes] = None
    if request.method in ("POST", "PUT", "PATCH"):
        body_bytes = await request.body()

    try:
        async with httpx.AsyncClient(timeout=_PROXY_TIMEOUT, follow_redirects=False) as client:
            upstream = await client.request(
                method=request.method,
                url=target_url,
                headers=headers,
                content=body_bytes,
            )
    except httpx.HTTPError as exc:
        _PROXY_LOGGER.warning(
            "st_extensions proxy failed method=%s path=%s user=%s err=%s",
            request.method, path, user.id, exc,
        )
        return JSONResponse(
            status_code=502,
            content={"error": "ST native service unavailable", "detail": str(exc)},
        )

    response_headers = {
        key: value
        for key, value in upstream.headers.items()
        if key.lower() not in ("transfer-encoding", "content-length", "connection")
    }
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=response_headers,
    )


@router.post("/api/extensions/install")
async def st_extensions_install(
    request: Request,
    user: User = Depends(get_st_current_user),
):
    """代理到 ST sidecar 执行扩展安装。"""
    return await _forward_extensions_to_st_native(request, user, "api/extensions/install")


@router.post("/api/extensions/update")
async def st_extensions_update(
    request: Request,
    user: User = Depends(get_st_current_user),
):
    """代理到 ST sidecar 执行扩展更新。"""
    return await _forward_extensions_to_st_native(request, user, "api/extensions/update")


@router.post("/api/extensions/delete")
async def st_extensions_delete(
    request: Request,
    user: User = Depends(get_st_current_user),
):
    """代理到 ST sidecar 执行扩展删除。"""
    return await _forward_extensions_to_st_native(request, user, "api/extensions/delete")


@router.get("/api/extensions/discover")
async def st_extensions_discover(
    request: Request,
    user: User = Depends(get_st_current_user),
):
    """代理到 ST sidecar 发现第三方扩展；sidecar 不可用时降级返回空列表。"""
    response = await _forward_extensions_to_st_native(request, user, "api/extensions/discover")
    if response.status_code == 502:
        # 安全降级：无第三方扩展（ST 前端启动即调 discover，502 会刷屏）
        return JSONResponse(status_code=200, content=[])
    return response
