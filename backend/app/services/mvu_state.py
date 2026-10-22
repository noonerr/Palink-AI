"""MVU 状态取值 —— 带「视点」的唯一出口（2026-10-22 批次 MS-1）。

## 为什么要有这个模块

老板 2026-10-22 的验收线：**切换故事线、或看不同楼层时，变量的「显示」与「注入」
都必须是那一条故事线、那一楼层的状态。**

取证（`docs/_active/report/REPORT_变量清理与故事线回跳_取证_2026-10-22.md` §3）确认了三件事：

1. 装配侧 `_load_effective_stat_data` 没有「读到哪一楼」这个入参，按 `created_at DESC`
   取最近 30 行里第一条非空 `stat_data` ⇒ 永远返回该分支**最新**那份。
2. 当分支内取不到时，旧实现静默回落到 `chat_metadata.variables`（会话级）。
   实测库里那份会话级值与**全库 48 条消息级 `stat_data` 中的 0 条**相等（md5 比对）
   ⇒ 回落值不是任何一层的真实状态，模型拿到的是「无来源的当前值」。
3. `branch_id` 为空时旧实现过滤 `branch_id IS NULL`，而实测 233 条消息**全部**带非空
   `branch_id` ⇒ 该过滤恒命中 0 行 ⇒ 任何不带分支号的调用**必然**走回落。

## 三条硬规则

- **绝不**读 `chat_metadata.variables` 作为「某楼 / 某分支」的历史值。会话级那份是
  「上一条故事线最后写入」的缓存，切分支不重置（`character_ext.py:3704-3735` 实证），
  拿它当历史值就是老板看到的「回跳第 2 条显示第 100 条数据」。
- 明细被自动清理摘掉时，**按补丁重演**算出该视点应有的状态（原料是落库时留存的
  `extra["mvu_patch"]`，见 `mvu_cleanup.py:14-20` 与 §上游差异）。重演不是回落，
  它算的是「这一条故事线到这一楼」的增量末态。
- 重演也凑不齐（中间有楼层既无 `stat_data` 又无 `mvu_patch`）⇒ 返回**降级标记**并留痕，
  由调用方决定显示"不可还原"，**不得**改成会话级顶上。

## 有效楼层序列 = 父链到分叉点 + 本分支到视点

⚠️ 已知数据缺陷（不在本模块职责内修）：库里 32 行分支的 `parent_branch_id` /
`parent_message_id` **全为 NULL**（`create_branch` 的「同级分支」路径照抄当前分支的父指针，
从根分叉即得 NULL，`character_ext.py:3574-3578`）。⇒ 对这类分支，本模块只能把它当作
**独立新故事线**（序列=它自己的楼层），不会把别的分支状态并进来 —— 这正是「宁缺勿错」的
行为：宁可少带祖先楼层，也绝不跨故事线取值。父指针落库的修法另立批次。

## 上游四项参数一律不动

`启用=true / 快照保留间隔=50 / 保留最近楼层=20 / 触发恢复楼层=10` 由老板裁定保持上游默认值，
本模块只改**读**的一侧，不改清理的一侧。
"""

from __future__ import annotations

import copy
import json
import logging
from dataclasses import dataclass
from typing import Any, Optional

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

PATCH_EXTRA_KEY = "mvu_patch"

# 留痕稳定标记（本仓纪律：静默失败必须可被 grep 到）
MARK_UNAVAILABLE = "[MVU-STATE-UNAVAILABLE]"


@dataclass(frozen=True)
class ResolvedState:
    """一次「带视点的状态取值」的结果。

    `stat_data` 为 None 表示**取不到**（调用方不得回落会话级）；
    `reason` 为机器可读码，`missing_floors` 是重演原料缺失的楼层号列表。
    """

    stat_data: Optional[dict]
    reason: str
    floors_scanned: int = 0
    missing_floors: tuple[int, ...] = ()

    @property
    def available(self) -> bool:
        return isinstance(self.stat_data, dict) and bool(self.stat_data)


def _parse_json_dict(raw: Any) -> dict:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
        except (TypeError, ValueError):
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _branch_ancestry(db: Session, branch_id: Optional[str]) -> list:
    """返回 ``[(branch_id, up_to_message_id), ...]``，root → self。

    与 `character_ext._get_ancestor_branch_scopes` 同语义，但**在 service 层自取**，
    避免 services→api 的反向依赖。父指针缺失（现库的常态）时只回本分支自己。
    """
    from ..models import CharacterChatSessionBranch

    if not branch_id:
        return []

    scopes: list[tuple[str, Optional[int]]] = []
    seen: set[str] = set()
    cur_id: Optional[str] = branch_id
    up_to: Optional[int] = None

    while cur_id and cur_id not in seen:
        seen.add(cur_id)
        scopes.append((cur_id, up_to))
        branch = (
            db.query(CharacterChatSessionBranch)
            .filter(CharacterChatSessionBranch.id == cur_id)
            .first()
        )
        if branch is None:
            break
        parent_id = getattr(branch, "parent_branch_id", None)
        # 祖先分支被本层的分叉点截断
        up_to = getattr(branch, "parent_message_id", None)
        cur_id = parent_id

    scopes.reverse()
    return scopes


def _effective_rows(
    db: Session,
    session_id: str,
    branch_id: Optional[str],
    as_of_message_id: Optional[int],
) -> list:
    """本分支（含可确认的祖先链）到视点为止的消息，按楼层顺序。

    `branch_id` 为空 ⇒ 取**无分支归属的主干线**（`branch_id IS NULL`），这是旧实现的本意。
    但旧代码把这条过滤同时当作「取不到就回落会话级」的开关，而实测 233 条消息全部带
    非空 `branch_id` ⇒ 该路恒 0 行 ⇒ 任何不带分支号的调用必然静默回落
    （取证报告 §3 病因 2）。本模块保留主干线语义，**取消回落**。
    """
    from ..models import CharacterChatMessage

    scopes = _branch_ancestry(db, branch_id) or [(None, None)]
    rows: list = []
    for bid, scope_up_to in scopes:
        q = db.query(CharacterChatMessage).filter(
            CharacterChatMessage.session_id == session_id,
        )
        if bid is None:
            q = q.filter(CharacterChatMessage.branch_id.is_(None))
        else:
            q = q.filter(CharacterChatMessage.branch_id == bid)
        stop = scope_up_to
        if bid == branch_id and as_of_message_id is not None:
            # 本分支被视点截断；若同时有分叉点，取更靠前的那个
            stop = (
                min(scope_up_to, as_of_message_id)
                if scope_up_to is not None
                else as_of_message_id
            )
        if stop is not None:
            q = q.filter(CharacterChatMessage.id <= int(stop))
        rows.extend(q.order_by(CharacterChatMessage.id).all())
    return rows


def _trunk_live_fallback_allowed(
    db: Session, session_id: str, branch_id: Optional[str], as_of_message_id: Optional[int]
) -> bool:
    """是否允许「会话级实时值」这一条兜底路径 —— 三个条件缺一不可。

    允许条件（缺一不可）：**该会话最多一条分支** + **视点就是最新一楼**
    （`as_of_message_id is None`）。此时 `chat_metadata.variables` 就是这条线自己的实时 store，
    与上游「chat 级单一 store」同义 —— 单分支会话不存在"别的故事线"可串味，
    实测 31 个会话里 30 个只有一条分支，这条兜底覆盖的正是绝大多数日常场景
    （`test_memory_entity_card_gate.py` 那批用例依赖的也是它）。

    反之，**一旦会话有多条分支**，或**视点被指到某一楼**，一律禁止：实测 32 行分支的父指针全为
    NULL、切分支不重置会话级（`character_ext.py:3704-3735`），那份值既不属于当前分支、
    也不属于任何楼层（与全库 48 条消息级 `stat_data` 哈希比对相等 0 条）——
    拿它当历史值就是老板的反例「回跳第 2 条显示的却是第 100 条的变量数据」。
    """
    from sqlalchemy import func

    from ..models import CharacterChatSessionBranch

    if as_of_message_id is not None:
        return False
    count = (
        db.query(func.count(CharacterChatSessionBranch.id))
        .filter(CharacterChatSessionBranch.session_id == session_id)
        .scalar()
    )
    return (count or 0) <= 1


def _session_live_stat_data(db: Session, session_id: str) -> Optional[dict]:
    """主干会话的实时 store。**仅**供 `_trunk_live_fallback_allowed` 为真时调用。"""
    from ..models import CharacterChatSession

    row = (
        db.query(CharacterChatSession)
        .filter(CharacterChatSession.id == session_id)
        .first()
    )
    if row is None:
        return None
    meta = _parse_json_dict(getattr(row, "chat_metadata", None))
    variables = meta.get("variables")
    if not isinstance(variables, dict):
        return None
    stat = variables.get("stat_data")
    return copy.deepcopy(stat) if isinstance(stat, dict) and stat else None


def _trunk_or_none(
    db: Session,
    session_id: str,
    branch_id: Optional[str],
    as_of_message_id: Optional[int],
    *,
    reason: str,
    floors_scanned: int,
    missing: tuple[int, ...],
) -> ResolvedState:
    """楼层侧取不到时的唯一出口：主干会话允许实时 store 兜底，其余情形返回不可得。"""
    if _trunk_live_fallback_allowed(db, session_id, branch_id, as_of_message_id):
        live = _session_live_stat_data(db, session_id)
        if live:
            return ResolvedState(live, "trunk_live", floors_scanned, missing)
    return ResolvedState(None, reason, floors_scanned, missing)


def resolve_stat_data_as_of(
    db: Session,
    session_id: str,
    branch_id: Optional[str],
    *,
    as_of_message_id: Optional[int] = None,
) -> ResolvedState:
    """取「这条故事线、到这一楼」的 `stat_data`。

    取值顺序（严格，不做任何会话级回落）：

    1. 逐楼向前推进状态：该楼有非空 `stat_data` ⇒ 以它为权威基线；
       否则有 `mvu_patch` ⇒ 把补丁应用到当前状态；
       两者都无 ⇒ 记入 `missing_floors`（重演原料缺口）。
    2. 视点那层自己有非空 `stat_data` ⇒ 直接返回（`reason=floor`）。
    3. 否则返回重演末态（`reason=replay` 或 `replay_partial`）。
    4. 全程什么都没有 ⇒ `stat_data=None`（`reason=empty`）。

    ⚠️ 参数如实打印：`as_of_message_id` 为 None 表示「分支最新一楼」，
    调用方若要看历史某楼**必须**传值，否则语义就是最新态（离线探针必须打印实收参数，
    见本仓 2026-10-05 的假阳性教训）。
    """
    rows = _effective_rows(db, session_id, branch_id, as_of_message_id)
    if not rows:
        logger.warning(
            "%s 无可用楼层 session_id=%s branch_id=%r as_of_message_id=%r",
            MARK_UNAVAILABLE, session_id, branch_id, as_of_message_id,
        )
        return _trunk_or_none(
            db, session_id, branch_id, as_of_message_id,
            reason="no_rows", floors_scanned=0, missing=(),
        )

    from .mvu_engine import apply_patches

    # ⚠️ 形状：`apply_patches` 吃的是**包裹层** `{"stat_data": {...}}`，返回也带包裹层
    # （`mvu_engine.py:653-655` —— `result["stat_data"] = target`）。
    # 直接传内层 dict 会被塞出一个自指的 `stat_data` 键，故全程按包裹层推进。
    state: dict = {"stat_data": {}}
    have_any = False
    missing: list[int] = []
    last_is_authoritative = False

    for idx, msg in enumerate(rows, start=1):
        extra = _parse_json_dict(getattr(msg, "extra", None))
        variables = extra.get("variables")
        if not isinstance(variables, dict):
            # 该楼完全没有变量对象（用户消息/开场白属正常形态，不算缺口）
            continue

        stat = variables.get("stat_data")
        patch = extra.get(PATCH_EXTRA_KEY)
        if isinstance(stat, dict) and stat:
            state = {"stat_data": copy.deepcopy(stat)}
            have_any = True
            last_is_authoritative = True
            continue
        last_is_authoritative = False
        if isinstance(patch, list) and patch:
            try:
                state, _logs = apply_patches(state, patch)
                have_any = True
            except Exception:  # noqa: BLE001 - 单楼补丁失败不阻断整条重演，但必须留痕
                logger.warning(
                    "%s 重演第 %d 楼补丁失败 session_id=%s branch_id=%r msg_id=%s",
                    MARK_UNAVAILABLE, idx, session_id, branch_id,
                    getattr(msg, "id", None), exc_info=True,
                )
                missing.append(idx)
            continue
        # 有变量对象、但明细与补丁都没有 ⇒ 该楼的状态无法推进
        missing.append(idx)

    if not have_any:
        logger.warning(
            "%s 重演全程无原料 session_id=%s branch_id=%r 扫描=%d 楼 缺口=%d 楼",
            MARK_UNAVAILABLE, session_id, branch_id, len(rows), len(missing),
        )
        return _trunk_or_none(
            db, session_id, branch_id, as_of_message_id,
            reason="empty", floors_scanned=len(rows), missing=tuple(missing),
        )

    if last_is_authoritative:
        reason = "floor"
    elif missing:
        reason = "replay_partial"
        logger.warning(
            "%s 重演原料缺口 %d 处（状态可能偏旧，未回落会话级）"
            " session_id=%s branch_id=%r 扫描=%d 楼",
            MARK_UNAVAILABLE, len(missing), session_id, branch_id, len(rows),
        )
    else:
        reason = "replay"

    resolved = state.get("stat_data") if isinstance(state, dict) else None
    if not isinstance(resolved, dict) or not resolved:
        logger.warning(
            "%s 重演后仍无有效状态 session_id=%s branch_id=%r 扫描=%d 楼 缺口=%d 楼",
            MARK_UNAVAILABLE, session_id, branch_id, len(rows), len(missing),
        )
        return _trunk_or_none(
            db, session_id, branch_id, as_of_message_id,
            reason="empty", floors_scanned=len(rows), missing=tuple(missing),
        )

    return ResolvedState(copy.deepcopy(resolved), reason, len(rows), tuple(missing))


def resolve_stat_data_by_message_ids(
    db: Session,
    session_id: str,
    branch_id: Optional[str],
    message_ids: list,
) -> dict:
    """一趟扫描同时算出多个楼层的 `stat_data`（给"整页消息"下发用，避免每楼各扫一遍）。

    用途：卡片状态栏是**逐楼**渲染的。清理摘掉明细的楼层，前端拿不到该楼自己的值，
    于是退回会话级 ⇒ 老板看到的「回跳第 2 条显示的却是第 100 条的变量数据」。
    这里按请求的楼层逐个返回重演结果，让下发侧能把**该楼的**值补进去，而不是喂一份共享值。

    返回 ``{message_id: ResolvedState}``；扫不到的 id 不出现。视点=该楼本身，
    因此**不做**主干会话的实时值兜底（那是"看当前"的语义，与"看这一楼"冲突）。
    """
    wanted = {int(i) for i in message_ids if i is not None}
    if not wanted:
        return {}

    rows = _effective_rows(db, session_id, branch_id, max(wanted))
    if not rows:
        return {}

    from .mvu_engine import apply_patches

    state: dict = {"stat_data": {}}
    have_any = False
    missing: list[int] = []
    last_is_authoritative = False
    out: dict = {}

    for idx, msg in enumerate(rows, start=1):
        extra = _parse_json_dict(getattr(msg, "extra", None))
        variables = extra.get("variables")
        if isinstance(variables, dict):
            stat = variables.get("stat_data")
            patch = extra.get(PATCH_EXTRA_KEY)
            if isinstance(stat, dict) and stat:
                state = {"stat_data": copy.deepcopy(stat)}
                have_any = True
                last_is_authoritative = True
            else:
                last_is_authoritative = False
                if isinstance(patch, list) and patch:
                    try:
                        state, _logs = apply_patches(state, patch)
                        have_any = True
                    except Exception:  # noqa: BLE001 - 单楼失败不阻断整趟扫描
                        logger.warning(
                            "%s 批量重演第 %d 楼补丁失败 session_id=%s msg_id=%s",
                            MARK_UNAVAILABLE, idx, session_id,
                            getattr(msg, "id", None), exc_info=True,
                        )
                        missing.append(idx)
                else:
                    missing.append(idx)

        mid = getattr(msg, "id", None)
        if mid is not None and int(mid) in wanted:
            inner = state.get("stat_data") if isinstance(state, dict) else None
            if have_any and isinstance(inner, dict) and inner:
                reason = (
                    "floor"
                    if last_is_authoritative
                    else ("replay_partial" if missing else "replay")
                )
                out[int(mid)] = ResolvedState(
                    copy.deepcopy(inner), reason, idx, tuple(missing)
                )
            else:
                out[int(mid)] = ResolvedState(None, "empty", idx, tuple(missing))

    return out
