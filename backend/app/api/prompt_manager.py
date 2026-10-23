"""Prompt Manager API routes — CRUD for prompt presets."""
import json
from typing import Any, Dict, List, Optional, Union

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..core import get_db
from ..api.dependencies import get_current_user
from ..models.base import utc_now as _utc_now
from ..models import User
from ..models.prompt_preset import PromptPreset
from ..services.preset_overlay import (
    PRESET_STORE,
    PresetOverlayError,
    build_preset_snapshot,
    drop_overlay,
    effective_preset,
    get_selected_preset_name,
    require_owned_session,
    resolve_global_preset,
    resolve_global_preset_source,
    set_selected_preset_name,
    write_overlay,
)

router = APIRouter(prefix="/api/prompt-manager", tags=["prompt-manager"])

class PresetCreateRequest(BaseModel):
    name: str = Field(..., max_length=200)
    entries: List[Dict[str, Any]] = []
    config: Optional[Dict[str, Any]] = None


class PresetUpdateRequest(BaseModel):
    name: Optional[str] = Field(default=None, max_length=200)
    entries: Optional[List[Dict[str, Any]]] = None
    config: Optional[Dict[str, Any]] = None


def _preset_to_dict(p: PromptPreset) -> dict:
    entries_data = []
    if p.entries:
        try:
            entries_data = json.loads(p.entries)
        except (json.JSONDecodeError, TypeError):
            entries_data = []
    config_data = None
    if p.config:
        try:
            config_data = json.loads(p.config)
        except (json.JSONDecodeError, TypeError):
            config_data = None
    return {
        "id": p.id,
        "name": p.name,
        "entries": entries_data,
        "config": config_data,
        "created_at": p.created_at.isoformat() if p.created_at else None,
        "updated_at": p.updated_at.isoformat() if p.updated_at else None,
    }


@router.get("/presets")
def list_presets(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    presets = (
        db.query(PromptPreset)
        .filter(PromptPreset.user_id == user.id)
        .order_by(PromptPreset.updated_at.desc())
        .all()
    )
    return [_preset_to_dict(p) for p in presets]


# ── 全局"选中哪份预设"（P2-2，零迁移）───────────────────────────────────────
# [批次P2 P2-2 2026-10-21] ST 把选中名记在全局 settings（openai.js:404/4509/4728），
# 本仓落点是 UserSetting.silly_tavern_settings 的 `palink_prompt_preset.selected_name`
# —— **不加列、不建表、不写 alembic**（`prompt_presets` 至今没有 `is_default` 列）。
#
# ⚠️ 路由顺序有意义：这两个必须声明在 `PUT /presets/{preset_id}` **之前**，
# 否则 FastAPI 会把 "selection" 当成 preset_id 吃掉。
class PresetSelectionRequest(BaseModel):
    name: Optional[str] = Field(default=None, max_length=200)


@router.get("/presets/selection")
def get_preset_selection(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """查询"用户选中的预设名" + 它现在解析到哪份（回落口径见 preset_overlay）。

    [批次P3 P3-B 2026-10-21] 解析的**表**由 `prompt_presets` 改指 `generation_presets`
    （本路由的键位、字段、三层回落语义都不变，只换数据源）。
    """
    selected = get_selected_preset_name(db, user.id)
    effective = resolve_global_preset(db, user.id)
    return {
        "selected_name": selected,
        "resolved_name": effective.name if effective else None,
        "resolved_id": effective.id if effective else None,
        # selected = 命中选中名；fallback = 选中名缺失/失效后回落最近更新；none = 一份都没有
        "source": resolve_global_preset_source(db, user.id),
    }


@router.put("/presets/selection")
def put_preset_selection(
    req: PresetSelectionRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """记住/清除选中的预设名。只写 UserSetting 的既有 JSON 列。

    `{"name": null}` 或空串 ⇒ 清除选择（回到"从未选过"的回落口径）。
    选一份不存在或不属于自己的预设 ⇒ 404（不静默接受一个解析不到的名字）。

    [批次P3 P3-B 2026-10-21] "存在"现在按 `generation_presets` 判；
    `user_id IS NULL` 的共享行**不可选**（404）—— 共享行不属任何人。
    """
    try:
        selected = set_selected_preset_name(db, user.id, req.name)
    except PresetOverlayError as exc:
        raise _overlay_http_error(exc) from exc
    effective = resolve_global_preset(db, user.id)
    return {
        "selected_name": selected,
        "resolved_name": effective.name if effective else None,
        "resolved_id": effective.id if effective else None,
        "source": resolve_global_preset_source(db, user.id),
    }


# ── 帧内三键的预设快照（批次P3 / P3-A，只读）───────────────────────────────
# [批次P3 2026-10-21] ST 的预设三键是**同步**的（`preset.d.ts:150`），而帧内唯一的
# 数据通道 requestParent 是异步的 ⇒ 帧里不可能"同步等到"真值。解法是宿主在 ctx 里
# 带一份快照，三键同步读它；这里的端点就是那份快照的**唯一服务端算出口**
# （名单 + 当前生效份 + 按名索引一次给全，避免帧内多次往返与名单/按名不同源）。
#
# ⚠️ 路由顺序同样有意义：`/presets/snapshot` 必须声明在 `PUT /presets/{preset_id}`
# **之前**，否则 FastAPI 会把 "snapshot" 当成 preset_id 吃掉。
@router.get("/presets/snapshot")
def get_preset_snapshot(
    session_id: Optional[str] = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """帧内预设三键的快照（只读，永不写库）。

    `session_id` 给了 ⇒ `in_use` 算"本对话当前生效那份"（他人会话 404）；
    没给 ⇒ 按全局选中份算。名单与按名索引一律**只含本人**的
    `generation_presets` 行（共享行红线，见 preset_overlay 文件头）。
    """
    try:
        snapshot = build_preset_snapshot(db, user.id, session_id or None)
    except PresetOverlayError as exc:
        raise _overlay_http_error(exc) from exc
    # 可读性字段：让读响应的人一眼知道 `presets`/`in_use` 来自哪张表
    snapshot["store"] = PRESET_STORE
    return snapshot


@router.post("/presets")
def create_preset(
    req: PresetCreateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    p = PromptPreset(
        user_id=user.id,
        name=req.name,
        entries=json.dumps(req.entries, ensure_ascii=False) if req.entries else None,
        config=json.dumps(req.config, ensure_ascii=False) if req.config else None,
        created_at=_utc_now(),
        updated_at=_utc_now(),
    )
    db.add(p)
    db.commit()
    db.refresh(p)
    return _preset_to_dict(p)


@router.put("/presets/{preset_id}")
def update_preset(
    preset_id: str,
    req: PresetUpdateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    p = db.query(PromptPreset).filter(
        PromptPreset.id == preset_id,
        PromptPreset.user_id == user.id,
    ).first()
    if not p:
        raise HTTPException(404, "Preset not found")

    if req.name is not None:
        p.name = req.name
    if req.entries is not None:
        p.entries = json.dumps(req.entries, ensure_ascii=False) if req.entries else None
    if req.config is not None:
        p.config = json.dumps(req.config, ensure_ascii=False) if req.config else None
    p.updated_at = _utc_now()
    db.commit()
    db.refresh(p)
    return _preset_to_dict(p)


@router.delete("/presets/{preset_id}")
def delete_preset(
    preset_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    p = db.query(PromptPreset).filter(
        PromptPreset.id == preset_id,
        PromptPreset.user_id == user.id,
    ).first()
    if not p:
        raise HTTPException(404, "Preset not found")
    db.delete(p)
    db.commit()
    return {"ok": True}


# ── 会话级预设覆盖层（写时复制）─────────────────────────────────────────────
# [包AI P-1 2026-10-20] 用户裁定：预设改成"每对话一份分身"，卡片改的是本对话这份，
# **改了不回写全局**，卡片只能读写自己这份。ST 侧是"全局内容 + 全局选择"
# （`openai.js:4750` 内容、`:404/4509/4728` 选中），本条属**有意偏离**，见
# `services/preset_overlay.py` 模块 docstring 与台账 `preset_prompt` 行。
#
# 落点**不动表结构**：复用既有 `chat_variables`（session_id + key 唯一）存一行 JSON。
# 未改动 ⇒ 无行 ⇒ 读全局（不产生副本）；改一次 ⇒ 生成本对话私有行。


class SessionPresetWriteRequest(BaseModel):
    name: Optional[str] = Field(default=None, max_length=200)
    entries: Optional[List[Dict[str, Any]]] = None
    config: Optional[Dict[str, Any]] = None
    # 显式换基：把另一份全局预设**复制**进本对话（不是引用）
    # [批次P3 P3-B 2026-10-21] 指向 `GenerationPreset.id`（**整数主键**，与旧表
    # `PromptPreset.id` 的字符串主键不同）。两种写法都收，避免前端传数字被 422 挡掉；
    # 服务层 `_coerce_generation_preset_id` 统一解析成 int。
    base_preset_id: Optional[Union[int, str]] = None
    base_name: Optional[str] = None


def _overlay_http_error(exc: PresetOverlayError) -> HTTPException:
    status = 404 if exc.code in ("session_not_found", "preset_not_found") else 400
    return HTTPException(status, exc.message)


@router.get("/sessions/{session_id}/preset")
def get_session_preset(
    session_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """本对话当前生效的预设 + 来源（`global` / `session`）。

    `source` 就是 P-3 的可见性字段：卡片设置据此显示"用的是全局默认还是本对话副本"。
    """
    try:
        require_owned_session(db, session_id, user.id)
    except PresetOverlayError as exc:
        raise _overlay_http_error(exc) from exc
    return effective_preset(db, user.id, session_id)


@router.put("/sessions/{session_id}/preset")
def put_session_preset(
    session_id: str,
    req: SessionPresetWriteRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """写本对话副本（首次写触发写时复制）。

    [批次P3 P3-B 2026-10-21] **永不写 `generation_presets`**（原口径为 `prompt_presets`，
    随数据源改指一起换；"改了不回写全局"这条语义不变）。
    `base_preset_id` 现在指向 `GenerationPreset.id`；指向共享行（`user_id IS NULL`）
    或别人那份 ⇒ 404（响应里的 `base_store` 标明它属于 `generation_presets`）。
    """
    try:
        require_owned_session(db, session_id, user.id)
        return write_overlay(
            db,
            user.id,
            session_id,
            name=req.name,
            entries=req.entries,
            config=req.config,
            base_preset_id=req.base_preset_id,
            base_name=req.base_name,
        )
    except PresetOverlayError as exc:
        raise _overlay_http_error(exc) from exc


@router.delete("/sessions/{session_id}/preset")
def delete_session_preset(
    session_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """丢弃本对话副本 ⇒ 回到全局默认。全局预设本身不受影响。"""
    try:
        require_owned_session(db, session_id, user.id)
    except PresetOverlayError as exc:
        raise _overlay_http_error(exc) from exc
    result = drop_overlay(db, session_id)
    result.update(effective_preset(db, user.id, session_id))
    return result
