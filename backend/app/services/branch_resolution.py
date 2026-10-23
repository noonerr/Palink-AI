"""故事线分支的「该用哪一条」唯一判定规则（批次 BRANCH-1）。

## 为什么要有这个模块

同一个问题 —— 「这个会话现在该显示哪条分支」 —— 在修之前有 **三套互不相同的答案**，
外加一个隐性写库动作：

- 后端消息端点：`created_at.desc()` 取最新建的分支；
- 前端 `CharacterView.loadBranches`：`max(last_message_at || created_at)`；
- 分支树：谁都没标 ⇒ `active_branch_id = None`；
- `delete_branch` 的重新激活：`first()`，**无 ORDER BY** ⇒「第一个」由数据库心情决定；
- `api/silly_tavern.py::_active_branch()` 没人标 active 时把**最新建的**分支
  `is_active = True` 并 `flush()`。

## 本模块的唯一规则

1. 有 `is_active=true` ⇒ 就用它（库里 31/31 会话的常态，行为不变）。
2. 一条都没标 ⇒ 用 **装着最新一条消息的那条分支**（消息按 `created_at DESC NULLS LAST, id DESC`）。
3. 连消息都没有 ⇒ 用 **`created_at` 最新建的分支**（同样 `NULLS LAST` + `id DESC` 决胜）。
4. 分支表为空 ⇒ 返回 `None`。

## 读写纪律（硬的）

本模块的判定函数**永不写库**：没有属性赋值，没有 `add`/`flush`/`commit`。
需要建分支的写路径由调用方显式调用 `ensure_branch(...)`，且只允许出现在
显式写入口（`POST /api/chats/save`、`GET /branches` 的 auto-create-main）。

## 留痕

走到规则 2/3/4（= 库里真的没有 active 标记）时，通过 `core/silent_failure.record()`
留一条可检索记录，**按 session id 去重**（每进程每条会话最多一条）：
读路径会被列表接口按会话循环调用，不去重就是刷屏。
"""

from __future__ import annotations

import contextlib
import logging
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy.orm import Session

from ..models import CharacterChatMessage, CharacterChatSessionBranch

logger = logging.getLogger("PalinkAI.branch_resolution")

FALLBACK_SCOPE = "branch_resolution.no_active_flag_fallback"

# 判定结果来源（同时作为响应里 `active_branch_source` 的取值）
SOURCE_FLAGGED_ACTIVE = "flagged_active"
SOURCE_NEWEST_MESSAGE = "newest_message"
SOURCE_NEWEST_CREATED = "newest_created"
SOURCE_NONE = "none"

# 只有「库里没有 active 标记」才是需要留痕的异常态
_FALLBACK_SOURCES = frozenset({SOURCE_NEWEST_MESSAGE, SOURCE_NEWEST_CREATED, SOURCE_NONE})

# ── 留痕去重：每进程每个 session id 最多一条（镜像 silent_failure 的 once 思路，
#    但键是 session id 而不是 scope —— 否则全进程只能记到一个会话）。 ──
_MAX_TRACKED_SESSIONS = 4096
_trace_lock = threading.Lock()
_trace_seen: set[str] = set()

_BRANCH_ORDER_NEWEST = (
    CharacterChatSessionBranch.created_at.desc().nulls_last(),
    CharacterChatSessionBranch.id.desc(),
)
_BRANCH_ORDER_OLDEST = (
    CharacterChatSessionBranch.created_at.asc().nulls_last(),
    CharacterChatSessionBranch.id.asc(),
)


@dataclass(frozen=True)
class BranchResolution:
    """一次纯判定的结果：选中的分支 + 它是按哪条规则被选中的。"""

    branch: Optional[CharacterChatSessionBranch]
    source: str

    @property
    def is_fallback(self) -> bool:
        return self.source in _FALLBACK_SOURCES

    @property
    def branch_id(self) -> Optional[str]:
        return self.branch.id if self.branch else None


def _record_fallback(session_id: str, resolution: BranchResolution) -> None:
    """给「没有 active 标记 ⇒ 走回落规则」留一条痕。永不抛异常。"""
    try:
        sid = str(session_id or "")[:120]
        if not sid:
            return
        with _trace_lock:
            if sid in _trace_seen:
                return
            if len(_trace_seen) < _MAX_TRACKED_SESSIONS:
                _trace_seen.add(sid)
        from ..core.silent_failure import record

        record(
            FALLBACK_SCOPE,
            None,
            level=logging.WARNING,
            session_id=sid,
            rule=resolution.source,
            chosen_branch_id=resolution.branch_id,
        )
    except Exception:  # noqa: BLE001 - 留痕失败绝不能影响调用方
        with contextlib.suppress(Exception):
            logger.error("[BRANCH-RESOLUTION] trace_record_failed", exc_info=True)


def resolve_active_branch_detail(db: Session, session_id: str) -> BranchResolution:
    """按唯一规则判定「该用哪条分支」。**纯读，不写库。**

    `source` 说明命中了哪一条规则，调用方应把它透传给前端
    （`active_branch_source`），而不是让前端自己再猜一遍。
    """
    sid = str(session_id or "")
    if not sid:
        return BranchResolution(None, SOURCE_NONE)

    # 规则 1：有 active 标记就用它。多条同时被标（脏数据）时按创建时间决胜。
    flagged = (
        db.query(CharacterChatSessionBranch)
        .filter(
            CharacterChatSessionBranch.session_id == sid,
            CharacterChatSessionBranch.is_active.is_(True),
        )
        .order_by(*_BRANCH_ORDER_NEWEST)
        .first()
    )
    if flagged is not None:
        return BranchResolution(flagged, SOURCE_FLAGGED_ACTIVE)

    # 规则 2：没人标 ⇒ 用「装着最新一条消息」的那条分支。
    newest = (
        db.query(CharacterChatMessage.branch_id)
        .filter(
            CharacterChatMessage.session_id == sid,
            CharacterChatMessage.branch_id.isnot(None),
        )
        .order_by(
            CharacterChatMessage.created_at.desc().nulls_last(),
            CharacterChatMessage.id.desc(),
        )
        .first()
    )
    if newest and newest[0]:
        latest_branch = (
            db.query(CharacterChatSessionBranch)
            .filter(
                CharacterChatSessionBranch.id == newest[0],
                CharacterChatSessionBranch.session_id == sid,
            )
            .first()
        )
        if latest_branch is not None:
            res = BranchResolution(latest_branch, SOURCE_NEWEST_MESSAGE)
            _record_fallback(sid, res)
            return res

    # 规则 3：一条消息都没有 ⇒ 最新建的分支（决胜键确定）。
    any_branch = (
        db.query(CharacterChatSessionBranch)
        .filter(CharacterChatSessionBranch.session_id == sid)
        .order_by(*_BRANCH_ORDER_NEWEST)
        .first()
    )
    if any_branch is not None:
        res = BranchResolution(any_branch, SOURCE_NEWEST_CREATED)
        _record_fallback(sid, res)
        return res

    # 规则 4：压根没有分支行 ⇒ None。创建它不是判定函数的职责。
    res = BranchResolution(None, SOURCE_NONE)
    _record_fallback(sid, res)
    return res


def resolve_active_branch(db: Session, session_id: str) -> Optional[CharacterChatSessionBranch]:
    """只要分支对象的便捷入口（规则同 `resolve_active_branch_detail`）。"""
    return resolve_active_branch_detail(db, session_id).branch


def active_branch_id(db: Session, session_id: str) -> Optional[str]:
    """给响应体用的 `active_branch_id` 字段（纯读）。"""
    return resolve_active_branch_detail(db, session_id).branch_id


def list_session_branches_deterministic(
    db: Session, session_id: str
) -> list[CharacterChatSessionBranch]:
    """按**确定顺序**（最早建优先，`created_at ASC NULLS LAST, id ASC`）列出分支。

    禁止再用无 ORDER BY 的 `.all()` / `.first()` —— 「第一个」必须由我们定义。
    """
    return (
        db.query(CharacterChatSessionBranch)
        .filter(CharacterChatSessionBranch.session_id == str(session_id or ""))
        .order_by(*_BRANCH_ORDER_OLDEST)
        .all()
    )


def ensure_branch(
    db: Session,
    session_id: str,
    *,
    branch_name: str = "Branch 1",
) -> CharacterChatSessionBranch:
    """**显式写路径**：会话连一条分支都没有时建一条并标 active。

    只允许从显式写入口调用（`chats/save`）。读路径禁止调用本函数 ——
    这是「读不写库」红线唯一的例外出口，且必须由调用方签名声明。
    """
    now = datetime.now(timezone.utc)
    branch = CharacterChatSessionBranch(
        session_id=session_id,
        branch_name=branch_name,
        is_active=True,
        created_at=now,
        last_message_at=now,
    )
    db.add(branch)
    db.flush()
    return branch


def reset_fallback_trace_state() -> None:
    """清空「每会话只记一次」的去重集合。仅供测试使用。"""
    with _trace_lock:
        _trace_seen.clear()
