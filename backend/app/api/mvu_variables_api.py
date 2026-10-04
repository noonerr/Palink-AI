"""MVU 会话变量补丁写入端点（2026-10-05，MVU 补齐第二波）。

## 为什么单独一个文件

`docs/PROMPT_MVU兼容补齐_交给Agent_2026-10-05.md` 的 P2 原定把这个端点加进
`backend/app/api/character_ext.py`。但开工时该文件**正被并行 agent 改动且未提交**
（同批还有 `mvu_engine.py` / `websocket.py` / `character_message_builder.py`），
叠加编辑会互相覆盖。故本端点落在新文件、经 `api/__init__.py` 注册 ——
**路径是全新的 `POST /api/character-sessions/{session_id}/variables/patch`，
与任何既有路由不冲突，也不需要碰被占用的文件。**

## 它做什么

把 MVU 的 JSON Patch 应用到会话的 `chat_metadata.variables`，支持
`replace / add / insert / remove / move / delta`，`_` 前缀路径只读跳过。

## 它刻意不做什么

- **不做 init 兜底**：`apply_mvu_reply_to_session` 会在 variables 为空时用角色卡
  `<initvar>` 兜底初始化。本端点是「用户/面板主动改值」，会话没初始化过就
  **不该**凭空造一份 —— 直接 409 让调用方先初始化。
- **不解析正文**：不复用 `apply_mvu_reply_to_session` 整函数（它会强制走 init
  兜底并解析 AI 回复正文），只复用 `mvu_engine.apply_patches` 这一个纯函数。

## 前置依赖

**P0-1（读优先级倒挂）必须先修** —— 否则写进去的值会被 `ChatVariable` 表行反向遮蔽，
「改了读不回来」。该修复已随第一波落地（`silly_tavern.py` `_chat_header`）。
"""
from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..core import get_db
from ..api.dependencies import get_current_user
from ..models import User
from ..models.character import CharacterChatSession

logger = logging.getLogger(__name__)

router = APIRouter(tags=["mvu-variables"])


class MvuVariablesPatchRequest(BaseModel):
    """一组按序应用的 JSON Patch。

    结构与后端 ``mvu_engine.apply_patches`` 接受的补丁一致
    （``{"op": "replace", "path": "/stat_data/角色/好感度", "value": 5}``）。
    """

    patches: List[Dict[str, Any]] = Field(default_factory=list)


def _load_session_metadata(session: CharacterChatSession) -> Dict[str, Any]:
    """把 session.chat_metadata 解成 dict。列类型是 Text，取出来是 str。"""
    raw = getattr(session, "chat_metadata", None)
    if not raw:
        return {}
    if isinstance(raw, dict):
        return dict(raw)
    try:
        decoded = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return {}
    return decoded if isinstance(decoded, dict) else {}


@router.post("/api/character-sessions/{session_id}/variables/patch")
def patch_session_variables(
    session_id: str,
    req: MvuVariablesPatchRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """对会话的 chat_metadata.variables 应用一组补丁并回写。

    返回 ``{ok, variables, logs, skipped}``：
      - ``variables`` 应用后的完整变量表（面板可直接拿去刷新，不必再读一次）
      - ``logs``     apply_patches 的变更日志
      - ``skipped``  被只读前缀（``_``）跳过的补丁数
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
        # 归属校验：不存在或不属于当前用户一律 404（与 variables.py 同口径，防水平越权）
        raise HTTPException(status_code=404, detail="Session not found")

    metadata = _load_session_metadata(session)
    cur_vars = metadata.get("variables")
    if not isinstance(cur_vars, dict) or not cur_vars:
        # 刻意不兜底初始化 —— 见本文件头「它刻意不做什么」。
        raise HTTPException(
            status_code=409,
            detail="Session variables are not initialized; run MVU init first",
        )

    patches = [p for p in (req.patches or []) if isinstance(p, dict)]
    if not patches:
        return {"ok": True, "variables": cur_vars, "logs": [], "skipped": 0}

    # 延迟导入：mvu_engine 是被并行 agent 占用的文件之一，这里**只读**它的纯函数，
    # 不做任何改动；放在函数内导入也避免启动时就把该模块拉进来。
    from ..services.mvu_engine import apply_patches

    new_vars, logs = apply_patches(cur_vars, patches, readonly_prefix="_")

    skipped = len(patches) - len(logs) if len(logs) < len(patches) else 0
    metadata["variables"] = new_vars
    session.chat_metadata = json.dumps(metadata, ensure_ascii=False)
    db.commit()

    logger.info(
        "MVU manual variable patch applied: session=%s patches=%d logs=%d",
        session_id, len(patches), len(logs),
    )
    return {"ok": True, "variables": new_vars, "logs": logs, "skipped": skipped}
