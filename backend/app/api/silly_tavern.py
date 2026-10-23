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
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, aliased, selectinload

from ..core import get_db, settings as app_settings
from ..core.cache import invalidate_user_cache
# [PLUGIN-ON-DEMAND] 角色卡导入后的插件识别（实现在 api/plugins.py）
from .plugins import detect_required_plugins
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
# [批次P2 P2-1 2026-10-21] 内部簿记键前缀的**唯一来源**。此前这里是手写的前缀字符串，
# 与 services/preset_overlay.py 的常量各写一份 ⇒ 改一处漏一处。
from ..services.preset_overlay import INTERNAL_KEY_PREFIX
# [批次D1b 2026-10-21] ST 1.18.0 power_user 运行时默认状态（133 键，只含配置事实）。
from ..services.st_power_user_defaults import build_st_power_user_defaults
from ..services.inference_dispatcher import ensure_model_available, stream_text_completion
from ..services.local_model_registry import list_enabled_chat_models
from ..services.model_listing import list_provider_models
from ..services.provider_registry import get_providers
from ..services.stream_builder import StreamResult, stream_chat_deltas
from ..services.image_generation_service import generate_image, image_result_to_dict
from ..services.worldbook_import_utils import (
    entry_is_disabled,
    entry_keys,
    entry_secondary_keys,
)
from ..services.tts_service import clean_text_for_tts, tts_service, audio_mime_ext
from ..services.websocket_manager import ws_manager
from ..utils import get_default_ai_model

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
        try:
            db.flush()
        except IntegrityError:
            # 反向验证修复（批次 F）: 并发首建竞态防护——另一请求已创建同
            # user_id 行时回滚改读既有行。注意 flush 等锁期间无法被本异常
            # 打断（等待对方事务收场），配合 DB 层 idle_in_transaction_
            # session_timeout 兜底自愈 + 注册时预建行消除竞态源头。
            db.rollback()
            setting = db.query(UserSetting).filter(UserSetting.user_id == user.id).first()
            if setting is None:
                raise
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
    """Fix-6: 从 extension_settings 读取 Quick Reply presets。

    ST 1.18.0 期望 /api/settings/get 返回 quickReplyPresets 数组，
    之前缺失，导致 ST Quick Reply 扩展无法加载用户保存的 sets。

    [批次QR 2026-10-21] 取数优先级（三档，从高到低）：
      1. `quickReplySets.sets` —— **Palink 自有命名空间**，由
         `POST /api/quick-replies/save|delete` 写（插件的写侧只打那两个地址，
         见 `st-plugins/quick-reply/src/QuickReplySet.js:377/:392`）。
         放这里而不是放 V2 里，是因为 `settings/save` 的 namespace 内整体替换语义
         会让插件自己那次不含 sets 的 `quickReplyV2` 保存把集合擦掉
         （`src/QuickReplySettings.js:72`）。
      2. `quickReplyV2.sets` / 3. `quickReply.sets` —— 历史兼容，
         任何在本批之前就往这两个键写过东西的数据仍然读得到。
    """
    if not isinstance(settings_data, dict):
        return []
    ext = settings_data.get("extension_settings")
    if not isinstance(ext, dict):
        return []
    # 1) Palink 自有命名空间（本批新增的写侧落点）
    #    ⚠️ **只在非空时才短路**：删光所有集以后这里会是 `sets: []`，
    #    若照原样返回就把下面两档历史键**遮蔽**掉了（用户会看到"数据又冒出来"或相反，
    #    取决于哪一档先命中）。空列表在这里的语义是"这一档没东西"，不是"最终答案"。
    palink_ns = ext.get(_QR_SETS_NAMESPACE)
    if isinstance(palink_ns, dict):
        sets = palink_ns.get("sets")
        if isinstance(sets, list) and sets:
            return sets
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


# silly_tavern_mode 已于 2026-09-04 A1 全链删除（模型列/补列行/schema/API，alembic 0062）。


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
    """providers + 本地启用模型的朴素投影。

    实现已搬到 ``services/model_listing.list_provider_models``（2026-10-23 收口），
    此处只保留函数名以维持 60+ 个 ST 端点的调用点不变。
    """
    return list_provider_models()


def _default_model_id() -> str:
    return _default_model_id_for_db(None)


def _default_model_id_for_db(db: Optional[Session]) -> str:
    """ST 面的默认模型：与原生链路走同一解析（2026-10-23 L2-1 对齐）。

    原实现自己扫一遍 ``_public_models`` 并优先读系统设置，与
    ``utils.get_default_ai_model`` 各自算一份 ⇒ 同一用户可能拿到两个默认模型。
    现在统一委托给 utils；唯一差异是兜底值：原生链路无可用模型时抛 400，
    ST 面历史上返回 ``"palink-default"``，此处保留以不破坏 ST 客户端。
    """
    try:
        return get_default_ai_model(db)
    except HTTPException:
        return "palink-default"


def _model_from_request(request: Request, payload: Optional[dict[str, Any]] = None, db: Optional[Session] = None) -> str:
    requested = str(
        request.headers.get("X-Palink-Model")
        or request.headers.get("X-Palink-Selected-Model")
        or ""
    ).strip()
    if not requested and isinstance(payload, dict):
        requested = str(payload.get("model") or payload.get("custom_model") or payload.get("openai_model") or "").strip()
    return requested or _default_model_id_for_db(db)


def _palink_status_text(model_id: str) -> str:
    return f"Palink API: {model_id}" if model_id else "Palink API"


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
        # [包AI P-1 2026-10-20] 内部簿记行（会话级预设覆盖层等）不进卡可见的变量表。
        # [批次P2 P2-1 2026-10-21] 前缀判定改用常量 INTERNAL_KEY_PREFIX（唯一来源），
        # 不再手写字符串。此前该表只存卡/插件变量，故"全部合入"是对的；加了宿主
        # 自己的行之后必须按前缀让路，否则 `__palink_internal_preset_overlay_v1`
        # 会作为变量出现在 getContext() 里。
        if v.key.startswith(INTERNAL_KEY_PREFIX):
            continue
        db_variables[v.key] = _parse_variable_value(v.value)
    if db_variables or base_variables:
        # [MVU-READ-PRIORITY 2026-10-05] chat_metadata.variables 是 MVU 引擎写的**真源**，
        # ChatVariable 表行只能补它里面**没有**的键，不能反客为主。
        #
        # 旧实现是 merged = dict(base); merged.update(db_variables) —— ChatVariable 行
        # 「后写覆盖」，优先级反而更高。后果：只要历史上任何一次 saveChat 带着 variables
        # 落过一行 ChatVariable(key="stat_data")，那行的值就**永久遮蔽**此后 MVU 引擎对
        # chat_metadata.variables 的全部更新。现场表现就是「变量明明更新了，但面板/读接口
        # 拿到的仍是旧值」。下面把顺序倒过来，让 base（chat_metadata）最终胜出。
        merged_variables = dict(db_variables)
        merged_variables.update(base_variables)
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

        # G3 导出侧保真（批次 F）: ST 数值位置 2-7（ANTop/ANBottom/EMTop/EMBottom/
        # atDepth/outlet）按 ST 惯例仅存于 extensions.position（world-info.js:5512
        # entry.extensions?.position 优先读取）；0/1 由顶层 before_char/after_char
        # 字符串承载，不写 null 污染。此前 2-7 被折叠成 after_char 且不写
        # extensions.position，ST 端再导入时位置全部降级。
        _pos_int_export = stage.position if isinstance(stage.position, int) else 4
        if _pos_int_export not in (0, 1):
            ext.setdefault("position", _pos_int_export)

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
    # fall back to the 133-key runtime default object of public/scripts/power-user.js.
    # [批次D1 2026-10-21] 默认值独立到 services/st_power_user_defaults.py：
    # 原实现只硬编码 8 键，第三方插件读 power_user.<其它键> 全部拿到 undefined。
    # [批次D1b 2026-10-21] 口径从 settings.json 保存态 83 键改为运行时对象 133 键。
    _power_user = build_st_power_user_defaults()
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
            # silly_tavern_mode/theme 已于 2026-09-04 A1 删除（alembic 0062）
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


@router.get("/version")
async def st_version():
    return {"agent": "SillyTavern", "pkgVersion": "1.18.0", "gitRevision": "palink", "gitBranch": "palink"}


# /csrf-token 与 /api/st/csrf-token 已于 2026-09-04 删除（T5 评估：零消费方；
# palink_csrf cookie 由登录响应 auth.py 双 Set-Cookie 建立，CSRF 守卫机制不受影响）。
# 旧客户端如携带 X-CSRF-Token: palink-csrf 头仍被 csrf_guard 静态分支正常放行。


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

    # [批次P2 P2-2 2026-10-21] Palink 自己的命名空间（"用户选中哪份预设"）也要**增量保护**。
    # 这条链路是"整块替换"（下面一行直接覆盖 silly_tavern_settings），而 ST 前端的
    # saveSettings 只回传它认识的字段 ⇒ 不保护的话，用户在 ST 设置界面点一次保存，
    # 选中的预设名就被静默抹掉（表现成"下次进卡回到了最近更新那份"）。
    # 语义与 extension_settings 同源：payload 带了就按 payload，没带就保留旧值。
    from ..services.preset_overlay import SELECTION_NAMESPACE as _PRESET_SELECTION_NS

    old_ns = (
        old_stored.get(_PRESET_SELECTION_NS)
        if isinstance(old_stored, dict) and isinstance(old_stored.get(_PRESET_SELECTION_NS), dict)
        else None
    )
    payload_ns = payload_data.get(_PRESET_SELECTION_NS)
    if isinstance(payload_ns, dict):
        if old_ns:
            payload_data[_PRESET_SELECTION_NS] = {**old_ns, **payload_ns}
    elif old_ns:
        payload_data[_PRESET_SELECTION_NS] = old_ns

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
    except Exception as _body_exc:
        logging.getLogger(__name__).warning(
            "variables/global/get 请求体解析失败，按无 body 处理 (user_id=%s): %s",
            user.id, _body_exc)
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
    except Exception as _body_exc:
        logging.getLogger(__name__).warning(
            "variables/global/set 请求体解析失败，按无 body 处理 (user_id=%s): %s",
            user.id, _body_exc)
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
    except Exception as _body_exc:
        logging.getLogger(__name__).warning(
            "variables/global/delete 请求体解析失败，按无 body 处理 (user_id=%s): %s",
            user.id, _body_exc)
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

    # [ORPHAN-FIX] 删角色前手工清理 ORM 级联覆盖不到的表。
    # `db.delete(character)` 只能靠关系上的 cascade 带走 sessions/messages，
    # 以下三张表都没有从 Character 出发的关系，不手工清就留孤儿：
    #   - conversation_memories（session_id 裸 TEXT 无外键，永不召回 + 隐私残留）
    #   - character_chat_session_branches（session 关系无 back_populates/cascade）
    #   - chat_variables（无关系，2026-09-23 一并补齐）
    # 顺序必须自底向上：messages 引用 branch_id，先删 messages；branches 有
    # parent_branch_id 自引用，先解引用再删。与 character_service.delete_character
    # 的清理面保持一致。
    try:
        from sqlalchemy import text as sa_text
        from ..memory_module.storage import delete_memories_by_session
        _cs_rows = db.execute(
            sa_text("SELECT id FROM character_chat_sessions WHERE character_id = :cid"),
            {"cid": character_id},
        ).fetchall()
        _cs_ids = [r[0] for r in _cs_rows]
        if _cs_ids:
            _ph = ", ".join(f":s{i}" for i in range(len(_cs_ids)))
            _pp = {f"s{i}": sid for i, sid in enumerate(_cs_ids)}
            db.execute(sa_text(
                f"DELETE FROM character_chat_messages WHERE session_id IN ({_ph})"), _pp)
            db.execute(sa_text(
                f"UPDATE character_chat_session_branches SET parent_branch_id = NULL "
                f"WHERE session_id IN ({_ph}) AND parent_branch_id IS NOT NULL"), _pp)
            db.execute(sa_text(
                f"DELETE FROM character_chat_session_branches WHERE session_id IN ({_ph})"), _pp)
            db.execute(sa_text(
                f"DELETE FROM chat_variables WHERE session_id IN ({_ph})"), _pp)
            delete_memories_by_session(db, _cs_ids)
    except Exception as _orphan_exc:
        logging.getLogger(__name__).warning(
            "characters/delete 孤儿清理失败 (character=%s): %s", character_id, _orphan_exc)

    db.delete(character)
    db.commit()
    return {"result": "ok"}


class CharacterDuplicateRequest(BaseModel):
    avatar_url: Optional[str] = None
    avatar: Optional[str] = None


class CharacterRenameRequest(BaseModel):
    avatar_url: Optional[str] = None
    avatar: Optional[str] = None
    new_name: Optional[str] = None


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
    has_incoming_metadata = False
    for item in incoming:
        if not isinstance(item, dict):
            continue
        if "chat_metadata" in item and "mes" not in item:
            # ST 1.18.0 sends chat_metadata as a dedicated JSONL entry —
            # persist it on the session instead of discarding it.
            has_incoming_metadata = True
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
    # [MVU-SAVE-GATE 2026-10-05] payload 没带 chat_metadata 条目 = 客户端**不是**在做整包
    # 覆盖（插件的 setChatMessages 走 slice(1) 把 header 切掉，天然不带该条目）。
    # 旧实现此时 persisted_metadata 仍是 {}，只回填 palink_* 后整份写回 ——
    # variables / note_prompt / hidden_bots 被**静默清空**。这是插件热路径，
    # 一次调用就能抹掉整份 stat_data。没带就不碰 metadata。
    if not has_incoming_metadata:
        try:
            restored_meta = json.loads(session.chat_metadata) if session.chat_metadata else {}
        except (json.JSONDecodeError, TypeError):
            restored_meta = {}
        persisted_metadata.update(restored_meta if isinstance(restored_meta, dict) else {})
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
    # [ORPHAN-MEM-FIX] 级联清理向量记忆（conversation_memories.session_id 为
    # 裸 TEXT 无外键，不删则成孤儿：永不召回、持续占存储、且是隐私残留）。
    # 2026-09-22 定位：本端点是 93 条孤儿记忆的直接来源。08-24 的排查把本文件
    # 的 DELETE 一律当成"ST vectors 插件手动 purge 端点非级联"而排除，漏掉了
    # 这个以 `db.delete(session)` 删会话的路径（它清了 variables/messages/
    # branches 三张表，唯独漏了 memories——与实测残留形态完全吻合）。
    db.query(ChatVariable).filter(
        ChatVariable.session_id == session_id
    ).delete(synchronize_session=False)
    try:
        from ..memory_module.storage import delete_memories_by_session
        delete_memories_by_session(db, [session_id])
    except Exception as _mem_exc:
        logging.getLogger(__name__).warning(
            "chats/delete 记忆级联清理失败 (session=%s): %s", session_id, _mem_exc)
    db.query(CharacterChatMessage).filter(
        CharacterChatMessage.session_id == session_id
    ).delete(synchronize_session=False)
    # ↓ 此分支清理属于 ST 会话删除（非 st_delete_character）
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


# ===========================================================================
# Continue / Regenerate / Swipe endpoints (ST-compatible)
#
# REST 端点，复用 roleplay_prompt_assembly + stream_text_completion 管线，
# 通过 SSE (text/event-stream) 流式返回生成内容。不依赖 WebSocket 生成流程，
# 可独立工作。swipes 数据持久化到 CharacterChatMessage.swipes (JSON 数组)。
# ===========================================================================

_swipe_logger = logging.getLogger("palink.st_swipe")


def _normalize_message_swipes(message: CharacterChatMessage) -> list[str]:
    """返回有效的 swipes 列表；为空时用当前 content 初始化。"""
    swipes = _safe_json_loads(message.swipes, [])
    if isinstance(swipes, list) and swipes:
        return [str(item or "") for item in swipes]
    return [message.content or ""]


def _message_swipe_summary(
    message: CharacterChatMessage, swipes: list[str], swipe_id: int
) -> dict[str, Any]:
    return {
        "id": message.id,
        "content": message.content or "",
        "swipes": swipes,
        "swipe_id": swipe_id,
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


class WorldInfoNameRequest(BaseModel):
    """ST 1.18.0 世界书端点请求体：以世界书 name 作为标识符。

    对齐 SillyTavern 1.18.0 ``src/endpoints/worldinfo.js`` 的真实契约：
      - /api/worldinfo/get   body = {name}
      - /api/worldinfo/edit  body = {name, data}
      - /api/worldinfo/delete body = {name}
    所有端点均通过全局世界书的 name 定位，不再使用 Palink 早期的 avatar_url。

    ``characterId`` 可选（仅 /get 消费，/delete 忽略）：同名书去重提示，见
    _resolve_worldbook 的 prefer_character_id 说明。
    """
    name: str = ""
    characterId: Optional[str] = None


class WorldInfoEditRequest(BaseModel):
    """ST 1.18.0 /api/worldinfo/edit 请求体：{name, data}。

    ``data`` 为完整的 ST 世界书对象（含 entries dict），由端点整体覆盖保存。

    ``characterId`` 可选：ST 侧世界书是用户手动勾选的全局集，没有角色维度。
    Palink 的注入是按角色隔离的（未绑定的书不注入任何角色），故这里接受可选绑定，
    让插件面写入的书也能挂到具体角色上；不传则保持 None = 未绑定（不再注入、记告警）。
    """
    name: str = ""
    data: dict[str, Any] = Field(default_factory=dict)
    characterId: Optional[str] = None


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
        # C4b 修复（批次 C）: ST useProbability 映射（此前契约路径漏映射，
        # useProbability=false 的条目被静默回退列默认 true 而参与掷骰）。
        # 写法对齐 UI 导入路径 worldbook.py 的 use_probability 映射；
        # 缺省回退 True（ST 默认）。
        use_probability=(
            entry["useProbability"]
            if isinstance(entry.get("useProbability"), bool)
            else True
        ),
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
    # [WB-GET-CHAR 2026-10-05] 读端点放宽到「任意书」：ST 的 /get 按名字取，不分全局/绑定。
    # 详见 _resolve_worldbook 的 include_character_bound 说明。
    wb = _resolve_worldbook(
        db, user, world_id=None, name=req.name, include_character_bound=True,
        # [WB-NAME-AMBIG 2026-10-06] 同名书不止一本时，优先取当前角色绑定的那本。
        prefer_character_id=req.characterId,
    )
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

    # 角色绑定校验：越权绑到别人角色上等于把书送到他人会话，等同不绑。
    char_id = _resolve_owned_character_id(db, user, getattr(req, "characterId", None))

    if wb:
        # 整体覆盖：删除旧条目（直接用 query 删除，避免关系缓存陈旧）
        db.query(WorldBookStage).filter(WorldBookStage.world_book_id == wb.id).delete(synchronize_session=False)
        db.flush()
        # 更新描述
        wb.description = str(req.data.get("description") or "")[:5000] or None
        # 显式传了绑定才改；没传保持原绑定，避免插件整页覆盖时把绑定悄悄抹掉
        if req.characterId is not None:
            wb.character_id = char_id
        wb.updated_at = now
    else:
        # 创建：带上了 characterId 就挂到该角色，否则为未绑定（不再注入 + 记告警）
        wb = WorldBook(
            id=str(uuid.uuid4()),
            user_id=user.id,
            character_id=char_id,
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
    """读取上传文件，超过 max_size 抛 413。

    分块循环收口到 utils.read_upload_with_limit（与其余 7 个端点同一实现）；
    此处只保留 ST 面的限额与 413 文案。
    """
    from ..utils import format_upload_limit_mb, read_upload_with_limit

    return await read_upload_with_limit(
        file,
        max_size,
        detail=f"Uploaded file too large (max {format_upload_limit_mb(max_size)}MB)",
        chunk_size=_ST_UPLOAD_READ_CHUNK_SIZE,
    )


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

    # [PLUGIN-ON-DEMAND] 识别这张卡可能需要哪些插件，供导入完成弹窗让用户勾选。
    # 本端点是实际生效的导入路由（返回 character.py 老端点的超集），故必须在此也返回，
    # 否则前端读不到建议、勾选步骤不会插入。识别失败静默降级，绝不影响导入结果。
    plugin_suggestions: list = []
    try:
        if character_id:
            new_char = db.query(Character).filter(Character.id == character_id).first()
            if new_char is not None:
                plugin_suggestions = detect_required_plugins(db, new_char)
    except Exception as exc:
        logger.warning("[PLUGIN-ON-DEMAND] 导入后识别插件失败（不影响导入）: %s", exc)

    # 返回形状对齐 character.py:512 老导入端点（前端 handleImportCharacter 读
    # result.character.id / has_character_book / worldbook_entry_count 触发
    # 自动打开对话与世界书提示；name/filename 保留为 ST 形状超集）。
    return {
        "status": "ok",
        "name": character_name,
        "filename": filename,
        "character": result,
        "auto_parsed": False,
        "plugin_suggestions": plugin_suggestions,
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


class CharacterEditAttributeRequest(BaseModel):
    field_name: Optional[str] = None
    value: Any = None
    filename: Optional[str] = None
    avatar_url: Optional[str] = None
    avatar: Optional[str] = None


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


def _resolve_owned_character_id(db: Session, user: User, character_id: Optional[str]) -> Optional[str]:
    """把外部传入的角色 ID 校成「确属本用户的角色」，否则返回 None。

    绑定语义是「本用户的这本书给这张卡」：不校验归属等于允许把世界书挂到
    他人角色上，也等于把内容送到别人的会话里。ST 侧无此维度（世界书是全局勾选集），
    故这一层校验只能由 Palink 自己兜。
    """
    cid = (character_id or "").strip() or None
    if not cid:
        return None
    owned = db.query(Character.id).filter(
        Character.id == cid, Character.user_id == user.id
    ).first()
    return cid if owned else None


def _persist_worldbook_from_data(
    db: Session,
    user: User,
    data: Any,
    raw_filename: str,
    character_id: Optional[str] = None,
) -> str:
    """从解析后的 ST 世界书 dict 创建 WorldBook + WorldBookStage 并提交。

    单文件导入与批量导入共用此逻辑。返回创建的世界书名称。

    ``character_id`` 由调用方传入并自行校验归属（见各调用点）；None = 未绑定。
    未绑定的书在 Palink 的按角色注入契约下**不注入任何角色**，只会记 [WB-UNBOUND] 告警。
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
        character_id=character_id,
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
    *,
    include_character_bound: bool = False,
    prefer_character_id: Optional[str] = None,
) -> Optional[WorldBook]:
    """按 ID 或名称查找用户的**全局**世界书（character_id 为空）。

    ``include_character_bound=True`` 时放宽到「任意书」（全局 + 绑定到某张卡的）。

    ``prefer_character_id`` 只在**按名字查找且同名书不止一本**时生效：把绑定到该
    角色的那本排到最前。

    [WB-NAME-AMBIG 2026-10-06] 为什么需要它：世界书名字不是唯一键 —— 同一用户可以有
    多本同名的书（实测：两张不同角色的卡各绑了一本「露缇雅1.2」，各 19 条）。
    放宽到「任意书」之前，按名查找天然只会在全局书里命中，撞名概率低；放宽之后
    ``filter(name).first()`` 会在多本同名书里**随机**挑一本（SQL 无 ORDER BY 时顺序
    不保证），两张卡的插件于是互相读到对方的书 —— 内容与当前角色对不上，且症状
    沉默（条目数恰好一样时完全看不出来）。
    这里**只调整优先级、不缩小候选集**：仍然按 ST 语义在用户书库里按名取，
    只是撞名时优先当前角色那本；没撞名或没传 characterId 时行为与之前完全一致。

    [WB-GET-CHAR 2026-10-05] 此前**读**端点（``/api/worldinfo/get``）也走默认的
    「只查全局书」，于是按名取书对**角色绑定书**一律返回 ``{entries: {}}``。ST 侧不是
    这样：``src/endpoints/worldinfo.js:71`` 的 ``/get`` 走 ``readWorldInfoFile(dirs, name)``，
    按名字从用户书库里取，不区分全局/角色绑定。

    实测后果（真机）：卡 ``c44f2ae6…`` 的世界书「露缇雅1.2」是绑定书（19 条 stage）。
    ⚠️ 订正 2026-10-06：此处原写「185 条」，与库里实际条数不符（实测 ``world_book_stages``
    按 world_book_id 计数 = 19）已改。引用该数字前请自己数一遍。
    ``POST /api/worldinfo/get {name:'露缇雅1.2'}`` 返回 ``{"entries":{}}`` →
    前端桥 ``worldbookGetEntries`` 拿到 0 条 →
    ``getLorebookEntries`` / ``getWorldbook`` 对该卡恒空 →
    MVU 初始化读不到角色世界书内容，抛
    ``TypeError: Cannot read properties of undefined (reading 'length')``。

    ⚠️ 只给**读**端点开这个开关：``/edit``（:3420）与 ``/delete``（:3499）保持默认的
    全局语义，否则会顺带把「删角色绑定书」变成可达操作 —— 那不是本轮要修的东西。
    越权口径两条路径一致：都按 ``user_id == user.id`` 过滤。
    """
    query = db.query(WorldBook).filter(WorldBook.user_id == user.id)
    if not include_character_bound:
        query = query.filter(WorldBook.character_id.is_(None))
    if world_id:
        return query.filter(WorldBook.id == world_id).first()
    if name:
        matches = query.filter(WorldBook.name == name).all()
        if not matches:
            return None
        if len(matches) > 1:
            if prefer_character_id:
                wanted = str(prefer_character_id)
                for m in matches:
                    if m.character_id and str(m.character_id) == wanted:
                        return m
            logging.getLogger(__name__).warning(
                "[WB-NAME-AMBIG] 用户 %s 有 %d 本同名世界书 %r（prefer=%s），"
                "按名查找取到的可能不是当前角色那本",
                user.id, len(matches), name, prefer_character_id,
            )
        return matches[0]
    return None


@router.post("/api/worldinfo/import")
async def st_import_worldinfo(
    file: Optional[UploadFile] = File(None),
    avatar: Optional[UploadFile] = File(None),
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
    characterId: Optional[str] = Form(None),
):
    """ST 世界书导入（JSON 或 PNG 内嵌角色卡）。保留所有高级字段。返回 {name: world_name}。

    ``characterId``（camelCase，与 ST 请求体字段风格一致）把导入的书挂到指定角色，
    这样它只在该角色的会话里注入。不传 = 未绑定 → 不注入任何角色，仅记 [WB-UNBOUND] 告警。
    """
    file = _resolve_upload_field(file, avatar)
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided")
    content = await _st_read_upload(file, _ST_MAX_WORLDINFO_IMPORT_SIZE)
    if not content:
        raise HTTPException(status_code=400, detail="Empty file")

    data = _parse_worldinfo_payload(content, file.filename)
    name = _persist_worldbook_from_data(
        db, user, data, file.filename,
        character_id=_resolve_owned_character_id(db, user, characterId),
    )
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
    characterId: Optional[str] = Form(None),
):
    """ST 世界书批量导入（ZIP 内含多个 JSON 文件）。返回 {imported, failed, errors}。

    ``characterId`` 语义同单文件导入：把 ZIP 内所有书统一挂到该角色。
    """
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
    batch_character_id = _resolve_owned_character_id(db, user, characterId)

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
            _persist_worldbook_from_data(
                db, user, data, member_name,
                character_id=batch_character_id,
            )
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


# S-10 修复: ST 图片上传扩展名/魔数白名单。仅允许位图类图片，
# 拒绝 .html/.svg/.js 等可执行/可脚本文件，防止存储型 XSS。
_ST_IMAGE_EXTENSION_ALLOWLIST = {
    ".png": b"\x89PNG\r\n\x1a\n",
    ".jpg": b"\xff\xd8\xff",
    ".jpeg": b"\xff\xd8\xff",
    ".gif": (b"GIF87a", b"GIF89a"),
    ".webp": b"RIFF",  # WEBP: RIFF....WEBP（长度 >= 12 且偏移 8 为 WEBP）
}


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
    返回二进制音频流。合成失败时返回 503。
    """
    try:
        clean = clean_text_for_tts(text)
        if not clean:
            raise ValueError("No text to synthesize")
        binding_override: Optional[dict] = None
        if voice:
            binding_override = {"voice_id": voice}
        # 此前恒贴 audio/mpeg（上游回 WAV 时 Safari/iOS 失声），按服务层
        # 推断的真实类型声明，文件名扩展名一并跟随。
        content_type, audio_bytes = await tts_service.synthesize_audio(
            text=clean,
            db=db,
            user=user,
            binding_override=binding_override,
        )
        return Response(
            content=audio_bytes,
            media_type=content_type,
            headers={"Content-Disposition": f"inline; filename=tts{audio_mime_ext(content_type)}", "Cache-Control": "no-cache"},
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


# --- P1-12: Caption 端点（代理到 ST sidecar） ---------------------------

# --- P1-11: Memory Extras summarize 端点（Palink 原生 LLM） -------------

class STSummarizeRequest(BaseModel):
    """ST Extras /api/summarize 请求体。"""
    text: str
    params: dict = {}


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


class STGenerateImageRequest(BaseModel):
    """OpenAI Images API 兼容请求体（ST 1.18.0 stable-diffusion 扩展使用）。"""

    prompt: str
    n: int = 1
    size: str = "1024x1024"
    response_format: str = "url"
    model: Optional[str] = None


# ============================================================
# 【2026-10-18 包 C】/api/summarize 与 /api/translate* 已迁到 api/st_extras.py
#
# 迁走的原因：这四条路由原先转发到 ST sidecar（_forward_extensions_to_st_native），
# 而 sidecar 已随 st-native 双轨删除（2026-09-03）、容器里 ST_NATIVE_SERVICE_URL
# 实测为空串 ⇒ 无论怎么请求都是 502，插件侧等价于不可用。新实现在 st_extras.py
# 里走「原生上游优先 + LLM 兜底」，是真实能力而不是死转发。
#
# ⚠️ 不要在这里重新注册同名路由：Starlette 按注册顺序取第一个命中，
# 重复注册会让先注册的那条静默胜出（本文件 2026-09-05 已经踩过一次）。
# ============================================================


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
    # [XCHAR-MEM-SCOPE 2026-10-03] 检索范围（Palink 自有分支用）。不传 = 用户级全量，
    # 会跨角色召回。插件能拿到就带上。
    sessionId: Optional[str] = None
    characterId: Optional[str] = None


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
            # [XCHAR-MEM-SCOPE 2026-10-03] Palink 自有分支（collectionId 为空时走这里）
            # 原本不传任何范围 → 退化成用户级全量 → 跨角色召回。ST 插件能拿到
            # sessionId/characterId 的就带上；都没有时保持旧行为，由 semantic_search
            # 打 [MEM-SCOPE] 告警而不是静默。
            session_id=getattr(body, "sessionId", None),
            character_id=getattr(body, "characterId", None),
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


# 批次5: ST translate 插件调用的 provider 子路径（translate/index.js:254-413）
_TRANSLATE_PROVIDERS = {"onering", "libre", "google", "lingva", "deepl", "deeplx", "bing", "yandex"}


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


# ── [ST-COMPAT-HONEST-FAIL] 2026-10-11 ──────────────────────────────────────
# 下面 5 个路径（set-input / trigger / popup / buttons / messages）
# 在 **SillyTavern 1.18.0 里根本不存在**，不是兼容层，是本仓自造的：
#   取证① ST 全仓 grep "chats/popup|chats/buttons|chats/messages|chats/set-input|
#          chats/trigger"（含 public/ 与 src/）= 零命中；
#   取证② ST 官方 src/endpoints/chats.js 的实名只有
#          save / get / rename / delete / export / import / group.* / search / recent。
# ST 侧对应的是**客户端斜杠命令**（public/scripts/slash-commands.js），不是 HTTP 接口。
# 而 Palink 这边第一方也不调它们：grep frontend/src 与 st-plugins/ 全部 = 0。
#
# 原实现返回 200 {"result":"ok"} 且什么都不做。**危害不是"功能缺失"**
# （缺失只是少个功能），而是**任何做 ST 兼容度盘点的人，在路由表里看到
# /api/chats/popup 就会打勾** —— 它把"没做"伪装成"做了"，
# 兼容性百分比就是这么被喂高的。详见
# docs/_active/report/REPORT_悲观刻薄审计_第三次独立全仓体检_2026-10-11.md §F2。
#
# 现改为**明确失败**并指名 ST 侧的真实去处，让调用方拿到可行动的信号，
# 而不是拿到成功码后无事发生。
#
# ⚠️ 状态码选 404 而不是语义更贴切的 501，是被实测逼出来的修正：
#   app/main.py:572-586 的 HTTPException 处理器对 **status_code >= 500** 一律
#   把 detail 换成 "Internal server error"（只留 request_id，真消息进服务端日志）。
#   实测证据：改成 501 后调用方收到的是 `501 {"detail":"Internal server error"}`
#   —— 说明文字被吞，"让插件作者知道该用什么"这个目的就落空了。
#   404 ①低于 500，detail 原样送达；②**恰好等于真 ST 对这些不存在路径的响应**，
#   所以兼容性上零失真。真 501 反而是 Palink 独有的差异。
# 路由仍保留注册：test_st_contract.TestSTEndpointNo404.test_no_known_404 断言的是
# "已注册"（`ep not in registered`），**不是**"返回 200"，故本改动不连带弄红测试。
_ST_PATHS_NOT_IN_SILLYTAVERN = {
    "set-input": "setinput",
    "trigger": "trigger",
    "popup": "popup",
    "buttons": "buttons",
    "messages": "messages",
}


def _st_path_not_in_sillytavern(path_key: str):
    """这 5 个路径在 ST 1.18.0 中不存在；诚实拒绝而不是伪成功。"""
    raise HTTPException(
        status_code=404,
        detail=(
            f"POST /api/chats/{path_key} is not a SillyTavern 1.18.0 endpoint. "
            f"In ST this is implemented client-side as the slash command "
            f"/{_ST_PATHS_NOT_IN_SILLYTAVERN[path_key]}, so there is no server-side "
            f"equivalent to call. Palink does not implement it either."
        ),
    )


@router.post("/api/chats/set-input")
async def st_chats_set_input(
    user: User = Depends(get_st_current_user),
):
    """设置输入框内容 —— **ST 1.18.0 无此 HTTP 端点**，见上方说明。"""
    _st_path_not_in_sillytavern("set-input")


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
    """触发生成 —— **ST 1.18.0 无此 HTTP 端点**（Palink 侧 /trigger 是自有斜杠命令）。"""
    _st_path_not_in_sillytavern("trigger")


@router.post("/api/chats/popup")
async def st_chats_popup(
    user: User = Depends(get_st_current_user),
):
    """显示弹窗 —— **ST 1.18.0 无此 HTTP 端点**，见 §ST-COMPAT-HONEST-FAIL 说明。"""
    _st_path_not_in_sillytavern("popup")


@router.post("/api/chats/buttons")
async def st_chats_buttons(
    user: User = Depends(get_st_current_user),
):
    """创建按钮 —— **ST 1.18.0 无此 HTTP 端点**，见 §ST-COMPAT-HONEST-FAIL 说明。"""
    _st_path_not_in_sillytavern("buttons")


@router.post("/api/chats/messages")
async def st_chats_messages(
    user: User = Depends(get_st_current_user),
):
    """显示消息 —— **ST 1.18.0 无此 HTTP 端点**，见 §ST-COMPAT-HONEST-FAIL 说明。"""
    _st_path_not_in_sillytavern("messages")


# ===========================================================================
# Task 26: Quick Reply command endpoints (ST 1.18.0 compatible)
#
# ST 的 Quick Reply 斜杠命令（/qr, /qr1-/qr5, /quickreply 等）在前端执行，
# 但可能调用后端端点查询 / 创建 / 更新 / 执行 QR。这里提供最小 ST 兼容
# 实现：QR 数据存储在 user_settings.silly_tavern_settings.extension_settings
# .quickReply.sets（与 /api/quick-replies/save 复用同一存储）。
# ===========================================================================


class QuickReplyExecuteRequest(BaseModel):
    set: Optional[str] = None
    label: Optional[str] = None


class QuickReplyCreateRequest(BaseModel):
    set_name: Optional[str] = None
    name: Optional[str] = None
    label: Optional[str] = None
    text: Optional[str] = None
    data: Optional[dict[str, Any]] = None


class QuickReplyUpdateRequest(BaseModel):
    set_name: Optional[str] = None
    name: Optional[str] = None
    label: Optional[str] = None
    text: Optional[str] = None
    data: Optional[dict[str, Any]] = None


# ===========================================================================
# [批次QR 2026-10-21] /api/quick-replies/save|delete —— 补齐 quick-reply 扩展的
# 唯一**写侧**通道（用户批准："可以，根据你调研的来"）
#
# ST 侧一手依据：
#   - `src/endpoints/quick-replies.js:9` `POST /save`：`body.name` 必填否则 400，
#     整份 body 落盘成 `quickreplies/<sanitize(name)>.json`；`:22` `POST /delete` 按 name 删文件。
#   - `src/server-startup.js:146` 把它挂到 `/api/quick-replies`。
#   - `src/endpoints/settings.js:261` 把该目录读回来塞进 settings/get 的
#     `quickReplyPresets`（:281）⇒ **ST 的读侧也在这套文件上**。
# 插件侧一手依据（本仓 vendored 源码，行号为证）：
#   - 写：`st-plugins/quick-reply/src/QuickReplySet.js:377` POST `/api/quick-replies/save`，
#     `:392` POST `/api/quick-replies/delete`，body 都是 `JSON.stringify(this)`
#     （= `toJSON()`：`{version:2, name, disableSend, placeBeforeInput, injectInput,
#        color, onlyBorderColor, qrList, idIndex}`）。
#   - 读：`st-plugins/quick-reply/index.js:47-55` `loadSets()` 只认
#     settings/get 响应里的 `quickReplyPresets`，逐条 `QuickReplySet.from(...)` 进
#     `QuickReplySet.list`（:92）。
#
# 为什么此前"sets 永远是空"（真机读数 `[QR2] sets: []`）：
#   读侧 Fix-6 已经在 `extension_settings.quickReplyV2.sets` 取数
#   （本文件 `_extract_quick_reply_presets`），**但全仓没有任何写侧往那个键写过东西**
#   ——插件自己的 `QuickReplySettings.toJSON()`（`src/QuickReplySettings.js:89-102`）
#   只写 isEnabled/isCombined/isPopout/showPopoutButton/config/characterConfigs，
#   **不含 sets**。写侧又正是这两条 404。⇒ 两侧永久错位，用户的快捷回复集存不下来。
#
# 落点选择（以及为什么不用 ST 的文件语义、也不用插件自己的命名空间）：
#   写进 **`extension_settings.quickReplySets`（Palink 自有命名空间）**，
#   读侧 `_extract_quick_reply_presets` 把它放在**最优先**一档，
#   再回退 `quickReplyV2.sets` / `quickReply.sets`（兼容任何早已写过这两处的数据）。
#   ⚠️ 为什么不直接写 `quickReplyV2.sets`：本文件 `settings/save` 的 T3 语义是
#   **namespace 内整体替换**，而插件自己的 `QuickReplySettings.save()`
#   （`src/QuickReplySettings.js:72`）会把整个 `quickReplyV2` 重写一遍且**不含 sets**
#   ⇒ 写在那个键里的集会被插件下一次保存设置**静默擦掉**。
#   放到插件不拥有的命名空间，才谈得上"存得下来"。（同一形状由测试
#   `test_save_preserves_other_extension_settings_namespaces` 的反向段钉住。）
#   不落地成文件：本仓后端不持有 ST 的 per-user 目录树，写进 DB 的用户设置 blob
#   与既有 `settings/save` 同一份数据，天然跟着账号走、不引入新文件系统面。
#
# ⛔ 三条边界：
#   1. **只动 `quickReplySets.sets` 这一个子键**，其余 namespace 原样保留。
#   2. 作用域 = 当前登录用户（`get_st_current_user`），与 `/api/themes/save` 同一入口，
#      不给跨用户可达面；本端点不返回任何他人的数据。
#   3. 上限护栏：sets 条数与 name 长度有界 —— 这是用户设置里的单个 JSON 列，
#      不能让一个循环 save 的插件把它撑爆（ST 落文件系统时由磁盘兜着，我们没有）。
# ===========================================================================

_QR_SETS_NAMESPACE = "quickReplySets"
_QR_SETS_MAX_NAME_LEN = 200
_QR_SETS_MAX_COUNT = 500


def _qr_sets_read(ext: dict[str, Any]) -> tuple[dict[str, Any], list[Any]]:
    """取 `extension_settings.quickReplyV2`（含其 `sets` 列表）。

    形状不对时**新建而不是改写**：quickReplyV2 也可能是 None 或非 dict
    （老用户从没碰过这个扩展），但绝不能是 list —— 那种脏值按"没有"处理。
    """
    ns = ext.get(_QR_SETS_NAMESPACE)
    if not isinstance(ns, dict):
        ns = {}
    sets = ns.get("sets")
    if not isinstance(sets, list):
        sets = []
    return ns, sets


def _qr_sets_write(
    setting: UserSetting,
    ext_patch: dict[str, Any],
    db: Session,
) -> None:
    """把改好的 `extension_settings` 写回用户设置 blob（其余键原样保留）。"""
    stored = _safe_json_loads(setting.silly_tavern_settings, {})
    if not isinstance(stored, dict):
        stored = {}
    stored["extension_settings"] = ext_patch
    setting.silly_tavern_settings = _json_dumps(stored)
    db.commit()


@router.post("/api/quick-replies/save")
async def st_quick_replies_save(
    payload: Any = Body(None),
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """ST 兼容：保存一个 Quick Reply 集（`quick-replies.js:9` 的 POST /save）。

    与 ST 同语义的三点：`name` 必填（否则 400）、整份 body 原样存、同名覆盖。
    与 ST 不同的一点：落 DB 用户设置而不是落文件（见上方落点说明）。
    """
    if not isinstance(payload, dict):
        return JSONResponse({"ok": False, "error": "payload required"}, status_code=400)
    name = payload.get("name")
    if not isinstance(name, str) or not name.strip():
        # ST: `if (!request.body || !request.body.name) return response.sendStatus(400)`
        return JSONResponse({"ok": False, "error": "set name required"}, status_code=400)
    if len(name) > _QR_SETS_MAX_NAME_LEN:
        return JSONResponse({"ok": False, "error": "set name too long"}, status_code=400)

    setting = _get_or_create_user_setting(user, db)
    stored = _safe_json_loads(setting.silly_tavern_settings, {})
    ext_old = stored.get("extension_settings") if isinstance(stored, dict) else None
    ext: dict[str, Any] = ext_old if isinstance(ext_old, dict) else {}
    ns, sets = _qr_sets_read(ext)

    replaced = any(
        isinstance(item, dict) and item.get("name") == name for item in sets
    )
    sets = [
        item
        for item in sets
        if not (isinstance(item, dict) and item.get("name") == name)
    ]
    sets.append(payload)
    if len(sets) > _QR_SETS_MAX_COUNT:
        # 越界时拒绝而不是静默丢弃最早的一条：丢用户数据比报一次错严重得多
        return JSONResponse(
            {"ok": False, "error": f"quick reply set limit {_QR_SETS_MAX_COUNT} reached"},
            status_code=409,
        )

    ns["sets"] = sets
    ext[_QR_SETS_NAMESPACE] = ns
    _qr_sets_write(setting, ext, db)
    # ST 成功侧是 `sendStatus(200)`（无 body）；这里回一个 ST 插件不读的 ok 形状，
    # 便于 Palink 自己的探针判据（插件只看 response.ok）。
    return {"ok": True, "name": name, "replaced": replaced, "count": len(sets)}


@router.post("/api/quick-replies/delete")
async def st_quick_replies_delete(
    payload: Any = Body(None),
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """ST 兼容：删除一个 Quick Reply 集（`quick-replies.js:22` 的 POST /delete）。

    ST 语义同样是 `name` 必填否则 400；文件不存在时不报错（`fs.existsSync` 后才 unlink），
    这里对应"名单里没有该 name 也照样回 200"。
    """
    if not isinstance(payload, dict):
        return JSONResponse({"ok": False, "error": "payload required"}, status_code=400)
    name = payload.get("name")
    if not isinstance(name, str) or not name.strip():
        return JSONResponse({"ok": False, "error": "set name required"}, status_code=400)

    setting = _get_or_create_user_setting(user, db)
    stored = _safe_json_loads(setting.silly_tavern_settings, {})
    ext_old = stored.get("extension_settings") if isinstance(stored, dict) else None
    ext: dict[str, Any] = ext_old if isinstance(ext_old, dict) else {}
    ns, sets = _qr_sets_read(ext)

    before = len(sets)
    sets = [
        item
        for item in sets
        if not (isinstance(item, dict) and item.get("name") == name)
    ]
    removed = before - len(sets)
    ns["sets"] = sets
    ext[_QR_SETS_NAMESPACE] = ns
    _qr_sets_write(setting, ext, db)
    return {"ok": True, "name": name, "removed": removed, "count": len(sets)}



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
    # 2026-10-03：此处原本是 `from ..models.user_setting import UserSetting` +
    # 手写 get-or-create。UserSetting 已在模块顶层导入（见文件头 models 导入块），
    # 那个模块路径并不存在，会在请求时直接 500；手写段也没有 _get_or_create_user_setting
    # 的并发首建竞态防护。改为复用现成助手。
    setting = _get_or_create_user_setting(user, db)
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
    # 2026-10-03：删掉此处 `from ..models.user_setting import UserSetting`——
    # 该模块不存在（UserSetting 在 ..models.system，已在文件头导入），会直接 500。
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
# ST sidecar 代理基建（2026-09-05 起仅 /api/speech/elevenlabs/* 三端点消费）
#
# _forward_extensions_to_st_native 原为 /api/extensions/* 四端点（install/
# update/delete/discover）与 elevenlabs 语音三端点的公共转发器。extensions
# 四端点已随 2026-09-05 端点瘦身删除：sidecar 容器随 st-native 双轨删除
# （2026-09-03）后它们对上游无条件 502；前端插件管理器「URL 安装/卸载」
# 已改走原生 /api/plugins/import-url 与 DELETE /api/plugins/{id}。
# elevenlabs 端点保留（st-plugins/tts 插件消费），sidecar 缺位时仍返回 502。
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
