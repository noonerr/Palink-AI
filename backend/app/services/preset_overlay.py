"""会话级提示词预设覆盖层（写时复制 / copy-on-write）。

用户 2026-10-20 裁定（覆盖"与 ST 冲突以 ST 为准"总则）：
预设改成**每对话一份分身** —— 进卡时默认取全局那份；卡片改的是"本对话这份"；
改了**不回写全局**；卡片只能读写自己这份。

ST 侧语义（一手核对，`_reference/sillytavern-1.18.0`）：
- 内容：全局对象表 `openai_settings[openai_setting_names[name]]`（`public/scripts/openai.js:4750`）
- 选中：全局字段 `oai_settings.preset_settings_openai`（`:404` 默认 'Default'、`:4509`/`:4728` 写入）
⇒ ST 是"全局内容 + 全局选择"，**没有** per-chat 维度。本模块是**有意偏离**，别被后人当 bug 修回去。

落点（**不动表结构**）：
复用既有 `chat_variables`（`session_id` + `key` 唯一，`models/chat_variable.py`）存一行覆盖层 JSON。
- 未改动 ⇒ 无行 ⇒ 读全局（不产生副本，这就是"写时复制"的"写时才复制"）
- 改一次 ⇒ 生成本对话私有行（`base_*` 记"我在哪份之上改的"）
- 删除覆盖层 ⇒ 回到全局

覆盖层行的 key 带 `__palink_internal_` 前缀，ST 兼容层把 ChatVariable 合进
`chat_metadata.variables` 时会跳过该前缀（`api/silly_tavern.py` 的合并循环），
避免内部簿记出现在卡可见的变量表里。
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from ..models import ChatSession, ChatVariable
from ..models.prompt_preset import PromptPreset

# 覆盖层行在 chat_variables 里的 key（前缀是内部簿记约定，见模块 docstring）
OVERLAY_KEY = "__palink_internal_preset_overlay_v1"
INTERNAL_KEY_PREFIX = "__palink_internal_"


class PresetOverlayError(Exception):
    """覆盖层操作的业务错误（路由层翻成 HTTP 状态码）。"""

    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code
        self.message = message or code


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _loads(raw: Optional[str]) -> Any:
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None


def require_owned_session(db: Session, session_id: str, user_id: int) -> ChatSession:
    """只认当前登录用户自己的会话；他人会话一律 404（不泄露存在性）。"""
    session = (
        db.query(ChatSession)
        .filter(ChatSession.id == session_id, ChatSession.user_id == user_id)
        .first()
    )
    if session is None:
        raise PresetOverlayError("session_not_found", "Session not found")
    return session


def get_overlay_row(db: Session, session_id: str) -> Optional[ChatVariable]:
    return (
        db.query(ChatVariable)
        .filter(ChatVariable.session_id == session_id, ChatVariable.key == OVERLAY_KEY)
        .first()
    )


def get_overlay(db: Session, session_id: str) -> Optional[Dict[str, Any]]:
    row = get_overlay_row(db, session_id)
    if row is None:
        return None
    data = _loads(row.value)
    return data if isinstance(data, dict) else None


def resolve_global_preset(db: Session, user_id: int) -> Optional[PromptPreset]:
    """"全局默认那份"。

    ST 把选中名记在全局 settings 里；本仓 `prompt_presets` 目前**没有**"选中"字段，
    故取用户最近更新的那份作为全局默认（与 `/api/prompt-manager/presets` 的排序同源）。
    这是已知偏差：等"全局选中名"有落点时只改这一处。
    """
    return (
        db.query(PromptPreset)
        .filter(PromptPreset.user_id == user_id)
        .order_by(PromptPreset.updated_at.desc())
        .first()
    )


def _preset_view(preset: Optional[PromptPreset]) -> Optional[Dict[str, Any]]:
    if preset is None:
        return None
    return {
        "id": preset.id,
        "name": preset.name,
        "entries": _loads(preset.entries) or [],
        "config": _loads(preset.config),
    }


def effective_preset(db: Session, user_id: int, session_id: str) -> Dict[str, Any]:
    """本对话当前生效的预设（读路径，永不写库）。

    返回 `source`：`session`（本对话有覆盖层）或 `global`（未改动，读全局默认）。
    `base` 是覆盖层所基于的全局预设名（`source=global` 时为 null）。
    """
    overlay = get_overlay(db, session_id)
    if overlay is not None:
        return {
            "source": "session",
            "name": overlay.get("name"),
            "base_preset_id": overlay.get("base_preset_id"),
            "base_name": overlay.get("base_name"),
            "entries": overlay.get("entries") or [],
            "config": overlay.get("config"),
            "updated_at": overlay.get("updated_at"),
            # 可见性（P-3）：卡片设置里据此显示"本对话副本"
            "is_session_copy": True,
        }
    global_preset = resolve_global_preset(db, user_id)
    view = _preset_view(global_preset)
    return {
        "source": "global",
        "name": view["name"] if view else None,
        "base_preset_id": view["id"] if view else None,
        "base_name": view["name"] if view else None,
        "entries": view["entries"] if view else [],
        "config": view["config"] if view else None,
        "updated_at": None,
        "is_session_copy": False,
    }


def _write_overlay(db: Session, session_id: str, overlay: Dict[str, Any]) -> Dict[str, Any]:
    row = get_overlay_row(db, session_id)
    payload = json.dumps(overlay, ensure_ascii=False)
    if row is None:
        row = ChatVariable(session_id=session_id, key=OVERLAY_KEY, value=payload)
        db.add(row)
    else:
        row.value = payload
    db.commit()
    return overlay


def write_overlay(
    db: Session,
    user_id: int,
    session_id: str,
    *,
    name: Optional[str] = None,
    entries: Optional[list] = None,
    config: Optional[dict] = None,
    base_preset_id: Optional[str] = None,
    base_name: Optional[str] = None,
) -> Dict[str, Any]:
    """写时复制：**首次写**才把全局那份复制成本对话私有份。

    之后的写只落在本对话这一行上；`prompt_presets` 表一行都不动（越权面与
    "回写全局"面都由这一点兜住，测试 `test_preset_overlay_no_global_writeback` 钉死）。
    """
    overlay = get_overlay(db, session_id)
    if overlay is None:
        # —— 写时复制发生在这里 ——
        if base_preset_id is not None or base_name is not None:
            base = None
            if base_preset_id:
                base = (
                    db.query(PromptPreset)
                    .filter(PromptPreset.id == base_preset_id, PromptPreset.user_id == user_id)
                    .first()
                )
                if base is None:
                    raise PresetOverlayError("preset_not_found", "Preset not found")
            elif base_name:
                base = (
                    db.query(PromptPreset)
                    .filter(PromptPreset.name == base_name, PromptPreset.user_id == user_id)
                    .order_by(PromptPreset.updated_at.desc())
                    .first()
                )
                if base is None:
                    raise PresetOverlayError("preset_not_found", "Preset not found")
            base_view = _preset_view(base)
        else:
            base_view = _preset_view(resolve_global_preset(db, user_id))
        overlay = {
            "name": name or (base_view["name"] if base_view else None),
            "base_preset_id": base_view["id"] if base_view else None,
            "base_name": base_view["name"] if base_view else None,
            "entries": (base_view["entries"] if base_view else []) if entries is None else entries,
            "config": (base_view["config"] if base_view else None) if config is None else config,
            "created_at": _utc_now_iso(),
        }
    else:
        if name is not None:
            overlay["name"] = name
        if entries is not None:
            overlay["entries"] = entries
        if config is not None:
            overlay["config"] = config
        if base_preset_id is not None or base_name is not None:
            # 显式换基：把另一份全局预设复制进本对话（仍是复制，不是引用）
            base = None
            if base_preset_id:
                base = (
                    db.query(PromptPreset)
                    .filter(PromptPreset.id == base_preset_id, PromptPreset.user_id == user_id)
                    .first()
                )
            elif base_name:
                base = (
                    db.query(PromptPreset)
                    .filter(PromptPreset.name == base_name, PromptPreset.user_id == user_id)
                    .order_by(PromptPreset.updated_at.desc())
                    .first()
                )
            if base is None:
                raise PresetOverlayError("preset_not_found", "Preset not found")
            base_view = _preset_view(base)
            overlay["base_preset_id"] = base_view["id"]
            overlay["base_name"] = base_view["name"]
            overlay["name"] = base_view["name"]
            overlay["entries"] = base_view["entries"]
            overlay["config"] = base_view["config"]
    overlay["updated_at"] = _utc_now_iso()
    _write_overlay(db, session_id, overlay)
    return effective_preset(db, user_id, session_id)


def drop_overlay(db: Session, session_id: str) -> Dict[str, Any]:
    """丢弃本对话副本 ⇒ 回到全局默认（"未改动"状态）。"""
    row = get_overlay_row(db, session_id)
    if row is not None:
        db.delete(row)
        db.commit()
    return {"ok": True, "dropped": row is not None}
