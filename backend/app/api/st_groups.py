"""ST 群组聊天兼容 API - 实现 SillyTavern 群组聊天功能"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Request, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..core import get_db
from ..models import Character, GroupChat, GroupChatSession, User
from ..services.st_sync_service import convert_jsonl_to_group_chat
from .silly_tavern import _user_from_request_token, get_st_current_user

router = APIRouter(tags=["st-groups"])


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_json_loads(value: Any, default: Any) -> Any:
    if value is None or value == "":
        return default
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except (json.JSONDecodeError, TypeError):
        return default


def _safe_json_dumps(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        return "null"


def _group_avatar_key(group_id: str) -> str:
    return f"palink-group-{str(group_id).strip()}.png"


def _group_to_st(group: GroupChat, members: list[Character]) -> dict[str, Any]:
    member_profiles = _safe_json_loads(group.member_profiles, {})
    if not isinstance(member_profiles, dict):
        member_profiles = {}
    chat_metadata = _safe_json_loads(group.chat_metadata, {})
    if not isinstance(chat_metadata, dict):
        chat_metadata = {}
    # Phase D 修复 (F6/F7): 顶层字段回写 chat_metadata.meta 以保持 ST 兼容
    meta = chat_metadata.get("meta", {}) if isinstance(chat_metadata.get("meta"), dict) else {}
    if getattr(group, "generation_mode_join_prefix", None):
        meta["generation_mode_join_prefix"] = group.generation_mode_join_prefix
    if getattr(group, "generation_mode_join_suffix", None):
        meta["generation_mode_join_suffix"] = group.generation_mode_join_suffix
    if getattr(group, "auto_mode_delay", None) is not None:
        meta["auto_mode_delay"] = group.auto_mode_delay
    if meta:
        chat_metadata["meta"] = meta
    return {
        "id": _group_avatar_key(group.id),
        "group_id": group.id,
        "name": group.name,
        "members": [_member_to_st(m) for m in members],
        "avatar_url": group.avatar or "",
        "disabled_members": _safe_json_loads(group.disabled_members, []),
        "allow_self_responses": bool(group.allow_self_responses),
        "activation_strategy": group.activation_strategy or 0,
        "generation_mode": group.generation_mode or 0,
        "chat_metadata": chat_metadata,
        "member_profiles": member_profiles,
        # Phase D 修复 (F6): ST 1.18.0 群聊合并卡顶层字段
        "generation_mode_join_prefix": getattr(group, "generation_mode_join_prefix", None) or "",
        "generation_mode_join_suffix": getattr(group, "generation_mode_join_suffix", None) or "",
        "auto_mode_delay": getattr(group, "auto_mode_delay", None),
        "fav": False,
        "create_date": int((group.created_at or datetime.now(timezone.utc)).timestamp() * 1000),
        "date_added": int((group.created_at or datetime.now(timezone.utc)).timestamp() * 1000),
    }


def _group_to_st_format(group: GroupChat, db: Session) -> dict[str, Any]:
    """将 Palink GroupChat 模型转换为 ST 兼容的群聊对象格式。

    返回 ST group-chats.js 期望的群聊对象形状：
    - id: 群聊 ID（ST avatar key 格式 palink-group-{id}.png）
    - name: 群聊名称
    - members: 成员角色 ID 列表（字符串，avatar key 格式 palink-{cid}.png）
    - avatar_url: 群聊头像
    - chat_id: 当前聊天 ID（最新会话的 file_id）
    - chats: 聊天历史列表
    - activation_strategy: 激活策略
        0 = NATURAL (round-robin 轮询)
        1 = LIST (manual order 按顺序)
        2 = MANUAL (user picks 用户手动选择)
        3 = POOLED (random from not-yet-spoken members 从未发言成员中随机)
        4 = TALKATIVE (Palink 扩展: weighted random 加权随机; st-compat 回退 NATURAL)
        5 = VOTING (Palink 扩展: LLM voting 投票; st-compat 回退 NATURAL)
    - generation_mode: 生成模式
    - disabled_members: 禁用成员列表（avatar key 格式）
    - allow_self_responses: 是否允许自我回复
    - metadata: 群聊元数据

    注意：与 _group_to_st 不同，members 返回字符串 ID 列表（ST 约定），
    而非完整角色对象。chat_metadata 同时作为 metadata 和 chat_metadata 返回，
    确保 ST 与 Palink 双向兼容。
    """
    raw_member_ids = _safe_json_loads(group.member_ids, [])
    if not isinstance(raw_member_ids, list):
        raw_member_ids = []
    # ST members 字段为 avatar key 字符串列表（如 "palink-{id}.png"）
    members = [f"palink-{str(mid)}.png" for mid in raw_member_ids]

    raw_disabled = _safe_json_loads(group.disabled_members, [])
    if not isinstance(raw_disabled, list):
        raw_disabled = []
    # ST disabled_members 同样使用 avatar key 格式
    disabled_members = [
        str(mid) if str(mid).endswith(".png") else f"palink-{str(mid)}.png"
        for mid in raw_disabled
    ]

    chat_metadata = _safe_json_loads(group.chat_metadata, {})
    if not isinstance(chat_metadata, dict):
        chat_metadata = {}

    # Phase D 修复 (F6/F7): 顶层字段回写 chat_metadata.meta 以保持 ST 兼容
    _meta = chat_metadata.get("meta", {}) if isinstance(chat_metadata.get("meta"), dict) else {}
    if getattr(group, "generation_mode_join_prefix", None):
        _meta["generation_mode_join_prefix"] = group.generation_mode_join_prefix
    if getattr(group, "generation_mode_join_suffix", None):
        _meta["generation_mode_join_suffix"] = group.generation_mode_join_suffix
    if getattr(group, "auto_mode_delay", None) is not None:
        _meta["auto_mode_delay"] = group.auto_mode_delay
    if _meta:
        chat_metadata["meta"] = _meta

    # 查询群聊会话列表（按更新时间倒序）
    sessions = (
        db.query(GroupChatSession)
        .filter(GroupChatSession.group_id == group.id, GroupChatSession.user_id == group.user_id)
        .order_by(GroupChatSession.updated_at.desc())
        .all()
    )

    # N9 修复: ST 期望 chats 为 chat 文件名（chatId）字符串数组（无 .jsonl 后缀，
    # groups.js:121-141 用 path.parse(chat).name 比对；group-chats.js 直接 push
    # chatId 并用于 loadGroupChat/saveGroupChat 的 {id}）。此前对象数组导致 ST
    # getGroups 后 group.chats 类型不符、历史聊天无法匹配。
    chats: list[str] = [f"{_GROUP_SESSION_PREFIX}{s.id}" for s in sessions]

    # 当前聊天 ID：使用最新会话（ST 约定 chat_id 为当前激活会话标识）
    chat_id = chats[0] if chats else ""

    return {
        "id": _group_avatar_key(group.id),
        "group_id": group.id,
        "name": group.name,
        "members": members,
        "avatar_url": group.avatar or "",
        "chat_id": chat_id,
        "chats": chats,
        "activation_strategy": group.activation_strategy or 0,
        "generation_mode": group.generation_mode or 0,
        "disabled_members": disabled_members,
        "allow_self_responses": bool(group.allow_self_responses),
        "metadata": chat_metadata,
        # 保留 chat_metadata 字段用于 ST 内部兼容（ST 读取 chat_metadata）
        "chat_metadata": chat_metadata,
        # Phase D 修复 (F6): ST 1.18.0 群聊合并卡顶层字段
        "generation_mode_join_prefix": getattr(group, "generation_mode_join_prefix", None) or "",
        "generation_mode_join_suffix": getattr(group, "generation_mode_join_suffix", None) or "",
        "auto_mode_delay": getattr(group, "auto_mode_delay", None),
        "fav": False,
        "create_date": int((group.created_at or datetime.now(timezone.utc)).timestamp() * 1000),
        "date_added": int((group.created_at or datetime.now(timezone.utc)).timestamp() * 1000),
    }


def _member_to_st(character: Character) -> dict[str, Any]:
    return {
        "id": f"palink-{character.id}.png",
        "palink_id": character.id,
        "name": character.name,
        "avatar": character.avatar or "",
        "description": character.description or "",
        "personality": character.personality or "",
        "scenario": character.scenario or "",
        "first_mes": character.first_mes or "",
        "mes_example": character.mes_example or "",
        "creator_notes": character.creator_notes or "",
        "system_prompt": character.system_prompt or "",
        "tags": _safe_json_loads(character.tags, []),
        "creator": character.creator or "",
        "character_version": character.character_version or "",
        "extensions": _safe_json_loads(character.extensions, {}),
        "alternate_greetings": _safe_json_loads(character.alternate_greetings, []),
        "post_history_instructions": character.post_history_instructions or "",
        "spec": "chara_card_v2",
        "spec_version": character.raw_card_spec_version or "2.0",
    }


def _get_group_members(db: Session, group: GroupChat) -> list[Character]:
    member_ids = _safe_json_loads(group.member_ids, [])
    if not isinstance(member_ids, list) or not member_ids:
        return []
    return (
        db.query(Character)
        .filter(Character.id.in_([str(mid) for mid in member_ids]))
        .all()
    )


class GroupCreateRequest(BaseModel):
    name: str
    description: Optional[str] = None
    members: list[str] = []
    allow_self_responses: bool = False
    activation_strategy: int = 0
    generation_mode: int = 0
    member_profiles: Optional[dict] = None
    # Phase D 修复 (F6): ST 1.18.0 群聊合并卡顶层字段
    generation_mode_join_prefix: Optional[str] = None
    generation_mode_join_suffix: Optional[str] = None
    auto_mode_delay: Optional[int] = None


class GroupEditRequest(BaseModel):
    id: str
    name: Optional[str] = None
    description: Optional[str] = None
    avatar: Optional[str] = None
    members: Optional[list[str]] = None
    allow_self_responses: Optional[bool] = None
    activation_strategy: Optional[int] = None
    generation_mode: Optional[int] = None
    disabled_members: Optional[list[str]] = None
    chat_metadata: Optional[dict] = None
    member_profiles: Optional[dict] = None
    # Phase D 修复 (F6): ST 1.18.0 群聊合并卡顶层字段
    generation_mode_join_prefix: Optional[str] = None
    generation_mode_join_suffix: Optional[str] = None
    auto_mode_delay: Optional[int] = None


class GroupDeleteRequest(BaseModel):
    id: str


class GroupMemberRequest(BaseModel):
    group_id: str
    character_id: str


@router.post("/api/groups/get")
async def st_groups_get(
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """获取用户所有群组（ST 兼容格式）"""
    groups = (
        db.query(GroupChat)
        .filter(GroupChat.user_id == user.id)
        .order_by(GroupChat.updated_at.desc(), GroupChat.created_at.desc())
        .all()
    )
    return [_group_to_st_format(g, db) for g in groups]


@router.post("/api/groups/all")
async def st_groups_all(
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """获取用户所有群组（ST group-chats.js:759 调用，复用 /api/groups/get 逻辑）"""
    return await st_groups_get(request, user, db)


@router.post("/api/groups/create")
async def st_groups_create(
    req: GroupCreateRequest,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """创建群组"""
    if not req.name.strip():
        raise HTTPException(status_code=400, detail="Group name is required")

    group = GroupChat(
        user_id=user.id,
        name=req.name.strip(),
        description=req.description or "",
        member_ids=_safe_json_dumps(req.members or []),
        allow_self_responses=bool(req.allow_self_responses),
        activation_strategy=int(req.activation_strategy or 0),
        generation_mode=int(req.generation_mode or 0),
        member_profiles=_safe_json_dumps(req.member_profiles) if req.member_profiles is not None else None,
        # Phase D 修复 (F6): ST 1.18.0 群聊合并卡顶层字段
        generation_mode_join_prefix=req.generation_mode_join_prefix,
        generation_mode_join_suffix=req.generation_mode_join_suffix,
        auto_mode_delay=req.auto_mode_delay,
    )
    db.add(group)
    db.commit()
    db.refresh(group)

    # 触发 ST DATA_ROOT 同步（后台非阻塞）
    try:
        from ..services.st_sync_service import trigger_async_sync
        from ..core.database import SessionLocal
        await trigger_async_sync(SessionLocal, user.id, "group", group_id=group.id)
    except Exception:
        import logging
        logging.getLogger(__name__).debug(
            "ST sync trigger failed for group create", exc_info=True,
        )

    members = _get_group_members(db, group)
    return _group_to_st(group, members)


@router.post("/api/groups/edit")
async def st_groups_edit(
    req: GroupEditRequest,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """编辑群组"""
    group_id = _normalize_group_id(req.id)
    if not group_id:
        raise HTTPException(status_code=400, detail="id is required")
    group = (
        db.query(GroupChat)
        .filter(GroupChat.id == group_id, GroupChat.user_id == user.id)
        .first()
    )
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")

    if req.name is not None:
        group.name = req.name.strip() or group.name
    if req.description is not None:
        group.description = req.description
    if req.avatar is not None:
        group.avatar = req.avatar
    if req.members is not None:
        group.member_ids = _safe_json_dumps(req.members)
    if req.allow_self_responses is not None:
        group.allow_self_responses = bool(req.allow_self_responses)
    if req.activation_strategy is not None:
        group.activation_strategy = int(req.activation_strategy)
    if req.generation_mode is not None:
        group.generation_mode = int(req.generation_mode)
    if req.disabled_members is not None:
        group.disabled_members = _safe_json_dumps(req.disabled_members)
    if req.chat_metadata is not None:
        group.chat_metadata = _safe_json_dumps(req.chat_metadata)
    if req.member_profiles is not None:
        group.member_profiles = _safe_json_dumps(req.member_profiles)
    # Phase D 修复 (F6): ST 1.18.0 群聊合并卡顶层字段
    if req.generation_mode_join_prefix is not None:
        group.generation_mode_join_prefix = req.generation_mode_join_prefix
    if req.generation_mode_join_suffix is not None:
        group.generation_mode_join_suffix = req.generation_mode_join_suffix
    if req.auto_mode_delay is not None:
        group.auto_mode_delay = req.auto_mode_delay

    group.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(group)

    # 触发 ST DATA_ROOT 同步（后台非阻塞）
    try:
        from ..services.st_sync_service import trigger_async_sync
        from ..core.database import SessionLocal
        await trigger_async_sync(SessionLocal, user.id, "group", group_id=group.id)
    except Exception:
        import logging
        logging.getLogger(__name__).debug(
            "ST sync trigger failed for group edit", exc_info=True,
        )

    members = _get_group_members(db, group)
    return _group_to_st(group, members)


@router.post("/api/groups/delete")
async def st_groups_delete(
    req: GroupDeleteRequest,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """删除群组"""
    group_id = _normalize_group_id(req.id)
    if not group_id:
        return {"result": "ok"}
    group = (
        db.query(GroupChat)
        .filter(GroupChat.id == group_id, GroupChat.user_id == user.id)
        .first()
    )
    if not group:
        return {"result": "ok"}

    # 缓存群组名用于后续 ST DATA_ROOT 文件清理
    group_name = group.name or "Group Chat"

    # 级联清理 GroupChatSession 表中引用的 session
    db.query(GroupChatSession).filter(GroupChatSession.group_id == group.id).delete()
    db.delete(group)
    db.commit()

    # 级联清理 sidecar DATA_ROOT 的 chats/<group_name>/ 目录
    # （群聊消息主要存储在 DB，但 ST sidecar 可能缓存了 JSONL 文件）
    try:
        import shutil
        from pathlib import Path
        from ..services.st_sync_service import _st_data_root_for_user
        data_root = _st_data_root_for_user(user)
        if data_root:
            group_chat_dir = Path(data_root) / "chats" / group_name
            if group_chat_dir.exists():
                shutil.rmtree(group_chat_dir, ignore_errors=True)
    except Exception:
        import logging
        logging.getLogger(__name__).debug(
            "ST DATA_ROOT cleanup failed for group delete", exc_info=True,
        )

    return {"result": "ok"}


@router.post("/api/groups/member-get")
async def st_groups_member_get(
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """获取可添加为群组成员的角色列表"""
    characters = (
        db.query(Character)
        .filter(Character.user_id == user.id)
        .order_by(Character.updated_at.desc(), Character.created_at.desc())
        .all()
    )
    return [_member_to_st(c) for c in characters]


@router.post("/api/groups/member-add")
async def st_groups_member_add(
    req: GroupMemberRequest,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """向群组添加成员"""
    group = (
        db.query(GroupChat)
        .filter(GroupChat.id == _normalize_group_id(req.group_id), GroupChat.user_id == user.id)
        .first()
    )
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")

    character = (
        db.query(Character)
        .filter(Character.id == req.character_id, Character.user_id == user.id)
        .first()
    )
    if not character:
        raise HTTPException(status_code=404, detail="Character not found")

    member_ids = _safe_json_loads(group.member_ids, [])
    if req.character_id not in member_ids:
        member_ids.append(req.character_id)
        group.member_ids = _safe_json_dumps(member_ids)
        group.updated_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(group)

    members = _get_group_members(db, group)
    return _group_to_st(group, members)


@router.post("/api/groups/member-remove")
async def st_groups_member_remove(
    req: GroupMemberRequest,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """从群组移除成员"""
    group = (
        db.query(GroupChat)
        .filter(GroupChat.id == _normalize_group_id(req.group_id), GroupChat.user_id == user.id)
        .first()
    )
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")

    member_ids = _safe_json_loads(group.member_ids, [])
    if req.character_id in member_ids:
        member_ids.remove(req.character_id)
        group.member_ids = _safe_json_dumps(member_ids)
        group.updated_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(group)

    members = _get_group_members(db, group)
    return _group_to_st(group, members)


@router.post("/api/groups/chats")
async def st_groups_chats(
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """获取群组会话列表"""
    body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
    group_id = _normalize_group_id(body.get("group_id") or body.get("id") or "")

    if not group_id:
        return []

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
            "last_mes": _utc_now_iso(),
            "file_size": "DB",
            "message_count": 0,
            "preview_message": "",
        }
        for s in sessions
    ]


_GROUP_SESSION_PREFIX = "palink-group-session-"
_GROUP_SESSION_SUFFIX = ".jsonl"


def _group_session_id_from_file(file_name: Optional[str]) -> Optional[str]:
    """将 ST 传入的群聊会话标识规范化为 Palink GroupChatSession.id。

    N7 修复: 此前只处理 file_name（含 .jsonl 后缀与 palink-group-session- 前缀），
    而 ST 前端 saveGroupChat/loadGroupChat 通过 ``{id: chat_id}`` 发送 chat_id
    （``palink-group-session-{id}``，无 .jsonl），chat_id 路径未剥前缀导致查库
    失败（get 404 / delete 失效 / save 每次新建重复 session）。现在统一处理：
    basename → 去 .jsonl → 剥 palink-group-session- 前缀。
    """
    raw = str(file_name or "").strip()
    if not raw:
        return None
    raw = raw.replace("\\", "/").split("/")[-1]
    if raw.endswith(_GROUP_SESSION_SUFFIX):
        raw = raw[: -len(_GROUP_SESSION_SUFFIX)]
    if raw.startswith(_GROUP_SESSION_PREFIX):
        raw = raw[len(_GROUP_SESSION_PREFIX):]
    return raw or None


@router.post("/api/chats/group/get")
async def st_group_chat_get(
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """获取群组聊天会话内容（ST group-chats.js:196 调用）"""
    body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
    file_name = body.get("file_name") or body.get("file") or body.get("chatfile") or ""
    chat_id = str(body.get("id") or "").strip()
    session_id = _group_session_id_from_file(file_name) or _group_session_id_from_file(chat_id)
    if not session_id:
        raise HTTPException(status_code=400, detail="file_name or id is required")

    session = (
        db.query(GroupChatSession)
        .filter(GroupChatSession.id == session_id, GroupChatSession.user_id == user.id)
        .first()
    )
    if not session:
        raise HTTPException(status_code=404, detail="Group chat session not found")

    chat = _safe_json_loads(session.messages, [])
    if not isinstance(chat, list):
        chat = []
    # N10 修复: ST loadGroupChat（group-chats.js:204-207）用 Array.isArray 判定，
    # 期望返回裸消息数组（首项可能为 chat_metadata header，ST getGroupChat 会
    # data.shift() 移除）。此前返回 {file_name, chat, ...} 对象被当成空数组，
    # 群聊消息永远加载为空。
    return chat


@router.post("/api/chats/group/save")
async def st_group_chat_save(
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """保存群组聊天会话内容（ST group-chats.js:642 调用）

    ST body 包含 ``avtors``（拼写如此），与 ``avatars`` 互为兼容。
    """
    body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
    file_name = body.get("file_name") or body.get("file") or body.get("chatfile") or ""
    chat_id = str(body.get("id") or "").strip()
    session_id = _group_session_id_from_file(file_name) or _group_session_id_from_file(chat_id)

    chat = body.get("chat")
    if not isinstance(chat, list):
        chat = []
    avatars = body.get("avtors") if body.get("avtors") is not None else body.get("avatars")
    if not isinstance(avatars, list):
        avatars = []
    chat_name = body.get("chat_name") or body.get("name") or ""

    now = datetime.now(timezone.utc)
    session: Optional[GroupChatSession] = None
    if session_id:
        session = (
            db.query(GroupChatSession)
            .filter(GroupChatSession.id == session_id, GroupChatSession.user_id == user.id)
            .first()
        )

    if not session:
        group_id = _normalize_group_id(body.get("group_id") or "")
        session = GroupChatSession(
            user_id=user.id,
            group_id=group_id or None,
            title=chat_name or "Group Chat",
            messages=_safe_json_dumps(chat),
            avatars=_safe_json_dumps(avatars),
            created_at=now,
            updated_at=now,
        )
        db.add(session)
    else:
        session.messages = _safe_json_dumps(chat)
        session.avatars = _safe_json_dumps(avatars)
        if chat_name:
            session.title = chat_name
        session.updated_at = now

    db.commit()
    db.refresh(session)

    return {
        "file_name": f"{_GROUP_SESSION_PREFIX}{session.id}{_GROUP_SESSION_SUFFIX}",
    }


@router.post("/api/chats/group/delete")
async def st_group_chat_delete(
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """删除群组聊天会话（ST group-chats.js:2249 调用）"""
    body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
    file_name = body.get("file_name") or body.get("file") or body.get("chatfile") or ""
    chat_id = str(body.get("chat_id") or body.get("id") or "").strip()
    session_id = _group_session_id_from_file(file_name) or _group_session_id_from_file(chat_id)
    if not session_id:
        raise HTTPException(status_code=400, detail="file_name or chat_id is required")

    session = (
        db.query(GroupChatSession)
        .filter(GroupChatSession.id == session_id, GroupChatSession.user_id == user.id)
        .first()
    )
    if session:
        db.delete(session)
        db.commit()

    return {"ok": True}


def _normalize_group_id(raw_id: str) -> str:
    """将 ST 格式的群聊 ID 规范化为 Palink 内部 GroupChat.id。

    N8 修复: 统一处理路径 basename、``palink-group-{id}.png`` 头像 key 与
    ``palink-group-session-{id}`` 前缀（误传 chat_id 时防御性剥除），
    与 silly_tavern.py:_normalize_group_id 语义保持一致。
    """
    group_id = str(raw_id or "").strip()
    if not group_id:
        return ""
    group_id = group_id.split("?")[0].replace("\\", "/").split("/")[-1]
    if group_id.startswith("palink-group-session-"):
        group_id = group_id[len("palink-group-session-"):]
    elif group_id.startswith("palink-group-"):
        group_id = group_id[len("palink-group-"):]
    if group_id.endswith(".png"):
        group_id = group_id[:-4]
    return group_id


# Fix-11: /api/chats/group/info 路由冲突已解决。
# 此端点已在 silly_tavern.py:st_group_info 中实现（silly_tavern_router 先注册），
# 删除此处的重复端点避免路由冲突和返回格式不一致。


@router.post("/api/chats/group/import")
async def st_group_chat_import(
    request: Request,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """导入群聊 JSONL 文件，创建 GroupChat 和消息

    接受 multipart/form-data：
    - file: JSONL 文件（ST 群聊消息格式）
    - avatar_url: 群聊名称（ST 约定字段名，实际作为群名使用）

    用 convert_jsonl_to_group_chat 转换 JSONL 为消息列表，
    创建 GroupChat 记录和 GroupChatSession（含消息）。
    若 JSONL 首行含 chat_metadata header，提取并存储到 GroupChat.chat_metadata。

    返回 {"name": group_name}
    """
    form = await request.form()
    file = form.get("file")
    # ST 约定：avatar_url 字段实际承载群聊名称
    group_name = str(form.get("avatar_url") or form.get("name") or "Imported Group").strip()

    if not isinstance(file, UploadFile):
        raise HTTPException(status_code=400, detail="file is required")

    raw_bytes = await file.read()
    try:
        jsonl_content = raw_bytes.decode("utf-8") if isinstance(raw_bytes, (bytes, bytearray)) else str(raw_bytes)
    except (UnicodeDecodeError, AttributeError):
        jsonl_content = str(raw_bytes or "")

    messages = convert_jsonl_to_group_chat(jsonl_content)

    # 提取 chat_metadata header（若存在），保留 variables 等元数据
    chat_metadata: dict[str, Any] = {}
    for raw_line in jsonl_content.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict) and "chat_metadata" in item and "mes" not in item:
            raw_meta = item.get("chat_metadata")
            if isinstance(raw_meta, dict):
                chat_metadata = dict(raw_meta)
            elif isinstance(raw_meta, str):
                try:
                    decoded = json.loads(raw_meta)
                    if isinstance(decoded, dict):
                        chat_metadata = decoded
                except (json.JSONDecodeError, TypeError):
                    pass
            break

    now = datetime.now(timezone.utc)

    # 创建 GroupChat 记录
    group = GroupChat(
        user_id=user.id,
        name=group_name,
        member_ids="[]",
        allow_self_responses=False,
        activation_strategy=0,
        generation_mode=0,
        chat_metadata=_safe_json_dumps(chat_metadata) if chat_metadata else "{}",
        created_at=now,
        updated_at=now,
    )
    db.add(group)
    db.flush()

    # 创建 GroupChatSession 并存储消息
    session = GroupChatSession(
        user_id=user.id,
        group_id=group.id,
        title=group_name,
        messages=_safe_json_dumps(messages),
        avatars="[]",
        created_at=now,
        updated_at=now,
    )
    db.add(session)
    db.commit()
    db.refresh(group)

    return {"name": group.name}
