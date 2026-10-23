"""Extension Prompts API routes — persistence for injected prompt entries."""
import logging
import re
from typing import Any, Dict, List, Optional, Union

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..core import get_db
from ..api.dependencies import get_current_user
from ..models.base import utc_now as _utc_now
from ..models import User, Character
from ..models.extension_prompt import (
    ExtensionPrompt,
    EXTENSION_PROMPT_POSITION_MAX,
    EXTENSION_PROMPT_POSITION_MIN,
)

_logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/extension-prompts", tags=["extension-prompts"])

def _normalize_role(role_val) -> str:
    """ST extension_prompt_roles: 0=SYSTEM, 1=USER, 2=ASSISTANT。接受 int 或 str。"""
    if isinstance(role_val, bool):
        # bool 是 int 的子类，先排除避免误判
        return "system"
    if isinstance(role_val, int):
        return {0: "system", 1: "user", 2: "assistant"}.get(role_val, "system")
    val = str(role_val or "system").strip().lower()
    if val not in ("system", "user", "assistant"):
        return "system"
    return val


class ExtensionPromptRequest(BaseModel):
    session_id: Optional[str] = None
    content: str = ""
    position: int = -1
    depth: int = 4
    role: Union[int, str] = "system"
    enabled: bool = True
    order: Optional[int] = None
    scan: Optional[bool] = None
    marker: Optional[str] = None
    # filter 支持 dict（新格式 {"character_ids":[...], "session_ids":[...]}）
    # 或 list（旧格式，仅 character_ids）。None 表示无过滤。
    filter: Optional[Any] = None


def _entry_to_dict(e: ExtensionPrompt) -> dict:
    # P2-7 修复: 返回 scan 字段，对齐 ST 1.18.0 extension_prompt.scan 语义
    return {
        "identifier": e.identifier,
        "content": e.content or "",
        "position": e.position if e.position is not None else -1,
        "depth": e.depth if e.depth is not None else 4,
        "role": e.role or "system",
        "enabled": bool(e.enabled),
        "session_id": e.session_id,
        "order": 0,
        "scan": bool(getattr(e, "scan", False)),
        "filter": e.get_filter() if hasattr(e, "get_filter") else None,
    }


@router.get("")
def list_extension_prompts(
    session_id: Optional[str] = Query(default=None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    query = db.query(ExtensionPrompt).filter(ExtensionPrompt.user_id == user.id)
    if session_id is not None:
        query = query.filter(ExtensionPrompt.session_id == session_id)
    else:
        query = query.filter(ExtensionPrompt.session_id.is_(None))
    items = query.order_by(ExtensionPrompt.identifier).all()
    return [_entry_to_dict(e) for e in items]


@router.put("/{identifier}")
def set_extension_prompt(
    identifier: str,
    req: ExtensionPromptRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # Pydantic 已确保 position 是 int；这里做一次范围校验，与模型 @validates 对齐。
    if req.position is not None and (req.position < EXTENSION_PROMPT_POSITION_MIN or req.position > EXTENSION_PROMPT_POSITION_MAX):
        raise HTTPException(
            status_code=400,
            detail=f"position must be in [{EXTENSION_PROMPT_POSITION_MIN}, {EXTENSION_PROMPT_POSITION_MAX}]",
        )

    # role 归一化：ST 插件可能发 int（0/1/2），统一转为 str 存入 DB
    normalized_role = _normalize_role(req.role)

    query = db.query(ExtensionPrompt).filter(
        ExtensionPrompt.user_id == user.id,
        ExtensionPrompt.identifier == identifier,
    )
    if req.session_id is not None:
        query = query.filter(ExtensionPrompt.session_id == req.session_id)
    else:
        query = query.filter(ExtensionPrompt.session_id.is_(None))

    existing = query.first()
    if existing:
        existing.content = req.content
        existing.position = req.position
        existing.depth = req.depth
        existing.role = normalized_role
        existing.enabled = req.enabled
        # P2-7 修复: 持久化 scan 字段（None 时保留默认 False）
        if hasattr(existing, "scan"):
            existing.scan = bool(req.scan) if req.scan is not None else False
        existing.set_filter(req.filter) if hasattr(existing, "set_filter") else None
        existing.updated_at = _utc_now()
    else:
        existing = ExtensionPrompt(
            user_id=user.id,
            session_id=req.session_id,
            identifier=identifier,
            content=req.content,
            position=req.position,
            depth=req.depth,
            role=normalized_role,
            enabled=req.enabled,
            created_at=_utc_now(),
            updated_at=_utc_now(),
        )
        # P2-7 修复: 持久化 scan 字段
        if hasattr(existing, "scan"):
            existing.scan = bool(req.scan) if req.scan is not None else False
        if hasattr(existing, "set_filter"):
            existing.set_filter(req.filter)
        db.add(existing)
    db.commit()
    db.refresh(existing)
    return _entry_to_dict(existing)


@router.delete("/{identifier}")
def delete_extension_prompt(
    identifier: str,
    session_id: Optional[str] = Query(default=None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    query = db.query(ExtensionPrompt).filter(
        ExtensionPrompt.user_id == user.id,
        ExtensionPrompt.identifier == identifier,
    )
    if session_id is not None:
        query = query.filter(ExtensionPrompt.session_id == session_id)
    else:
        query = query.filter(ExtensionPrompt.session_id.is_(None))
    existing = query.first()
    if existing:
        db.delete(existing)
        db.commit()
    return {"ok": True}


# ── [PROMPT-EVERY-TURN 2026-10-02] 卡脚本上报快照落库 ──────────────────────
#
# 背景：卡插件经 setExtensionPrompt 注册的格式规范随 iframe 生命周期起伏
# （开场卡卸载后规范缺席 → AI 回复失去排版框，docs/PROMPT_格式规范每轮必到
# 与历史擦标签例外_2026-10-02.md）。主方案（用户拍板）：帧上报时同步持久化到
# extension_prompts 表，装配层每轮无条件带上；前端实时上报通道保留，按
# identifier 高优覆盖（_collect_extension_prompts 既有语义，零改动）。
#
# 键设计（用户拍板 b）：source_key = 插件脚本包内容的稳定哈希，由前端计算——
# 内容变了键就变；卡名、角色 id 都不进键：重导入换 char id 不失效，
# 同名不同卡不串。归属卡由 filter.character_ids 维护（本端点负责挂/摘）。

_SOURCE_KEY_RE = re.compile(r"^[A-Za-z0-9_.:-]{8,128}$")
_UNRESOLVED_MACRO_RE = re.compile(r"\{\{[^{}]{1,64}\}\}")


class ExtensionPromptPersistItem(BaseModel):
    content: str = ""
    position: int = -1
    depth: int = 4
    role: Union[int, str] = "system"
    scan: Optional[bool] = None


class ExtensionPromptPersistRequest(BaseModel):
    # characters.id 是 UUID 字符串（非自增 int）
    character_id: str
    source_key: str
    prompts: Dict[str, ExtensionPromptPersistItem]


@router.post("/persist")
def persist_extension_prompts(
    req: ExtensionPromptPersistRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """持久化卡脚本上报的扩展提示词快照（幂等 upsert）。

    - 行唯一键 (user_id, session_id=NULL, identifier, source_key)；
    - 同 (user, identifier) 下其他 source_key 的快照行若声称归属本角色
      （filter.character_ids 含本角色），摘除本角色；摘空即删——卡脚本内容
      变更后旧快照不再注入本卡，也不影响共享同键的其他卡；
    - source_key 为 NULL 的手动行永不触碰。
    """
    if not _SOURCE_KEY_RE.match(req.source_key or ""):
        raise HTTPException(status_code=400, detail="source_key must match ^[A-Za-z0-9_.:-]{8,128}$")

    char = (
        db.query(Character)
        .filter(Character.id == req.character_id, Character.user_id == user.id)
        .first()
    )
    if char is None:
        raise HTTPException(status_code=404, detail="character not found")

    char_id_str = str(req.character_id)
    upserted = 0
    detached = 0
    for identifier, item in (req.prompts or {}).items():
        identifier = (identifier or "").strip()
        if not identifier:
            continue
        content = (item.content or "").strip()
        if not content:
            continue
        if _UNRESOLVED_MACRO_RE.search(content):
            # 动工前确认 (a)：v7.1 唯一宏 {{mood_groups}} 在脚本内注入前必被替换，
            # 正常上报不含宏；此处兜底告警——宏进 prompt = 模板段变空话。
            _logger.warning(
                "[EXT-PROMPT-PERSIST] unresolved macro in identifier=%r (user=%s, char=%s): "
                "content may contain an unrendered template placeholder",
                identifier, user.id, req.character_id,
            )
        normalized_role = _normalize_role(item.role)

        # 1) 摘除：同 identifier、其他 source_key、声称归属本角色的旧快照
        stale_rows = (
            db.query(ExtensionPrompt)
            .filter(
                ExtensionPrompt.user_id == user.id,
                ExtensionPrompt.session_id.is_(None),
                ExtensionPrompt.identifier == identifier,
                ExtensionPrompt.source_key.isnot(None),
                ExtensionPrompt.source_key != req.source_key,
            )
            .all()
        )
        for row in stale_rows:
            flt = row.get_filter()
            ids = [str(x) for x in (flt.get("character_ids") or []) if str(x) != char_id_str]
            if len(ids) == len(flt.get("character_ids") or []):
                continue  # 不归属本角色，不动
            if ids:
                flt["character_ids"] = ids
                row.set_filter(flt)
            else:
                db.delete(row)
            detached += 1

        # 2) 幂等 upsert：本 (identifier, source_key) 快照行，挂上本角色
        row = (
            db.query(ExtensionPrompt)
            .filter(
                ExtensionPrompt.user_id == user.id,
                ExtensionPrompt.session_id.is_(None),
                ExtensionPrompt.identifier == identifier,
                ExtensionPrompt.source_key == req.source_key,
            )
            .first()
        )
        if row is None:
            row = ExtensionPrompt(
                user_id=user.id,
                session_id=None,
                identifier=identifier,
                source_key=req.source_key,
                created_at=_utc_now(),
                updated_at=_utc_now(),
            )
            db.add(row)
        row.content = content
        row.position = item.position
        row.depth = item.depth
        row.role = normalized_role
        row.enabled = True
        if hasattr(row, "scan"):
            row.scan = bool(item.scan) if item.scan is not None else False
        flt = row.get_filter()
        ids = [str(x) for x in (flt.get("character_ids") or [])]
        if char_id_str not in ids:
            ids.append(char_id_str)
        flt["character_ids"] = ids
        row.set_filter(flt)
        row.updated_at = _utc_now()
        upserted += 1

    db.commit()
    return {"ok": True, "upserted": upserted, "detached": detached, "source_key": req.source_key}
