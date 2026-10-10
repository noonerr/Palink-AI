"""MVU 变量自动清理服务 —— 等价复刻 MVU 插件（MagVarUpdate）的「自动清理变量」。

## 权威来源

卡脚本 bundle `backend/data/smart_card_assets/0c646fb31a…js`（307,179 B）内的：

- ``Za(start, end, interval)`` —— 清理（抽稀 + 减重）
- ``Ya()`` —— 恢复（删楼后从锚点重演补回）
- zod schema 默认值 —— ``启用=true / 快照保留间隔=50 / 要保留变量的最近楼层数=20 /
  触发恢复变量的最近楼层数=10``

逐条对照见 ``docs/SPEC_变量自动清理_MVU对齐_2026-10-05.md`` §1。

## 与插件的两处必要差异（行为等价，非功能打折）

1. **重演的原料不同**：插件重演靠 ``Tn(chat[t].mes, u)`` —— 重新解析楼层**正文**里的
   变量指令；而我们的正文在后端落库前已剥掉 ``<UpdateVariable>``（且不留原文）。
   因此我们在落库时把**解析出的补丁**存进 ``msg.extra["mvu_patch"]``，重演时直接应用补丁。
   **结果完全等价**（同一份补丁，确定性更高），且 prune 只动 ``extra["variables"]``，
   天然不会碰到补丁。
2. **楼层编号基准**：插件用 ``SillyTavern.chat`` 的数组下标（其 0 号位是伪消息头），
   我们用 1 起算的楼层号。锚点落点因此可能相差 1 楼 —— 功能上无差别（都是"每 interval 楼一个锚点"）。

## 设置来源：与插件**同源**

插件把这几项存在 ``SillyTavern.extensionSettings.mvu_settings.自动清理变量``，
而 Palink 的 ``SillyTavern.extensionSettings`` 落在
``UserSetting.silly_tavern_settings.plugin_extension_settings_by_character[<卡>]``。
本模块**直接读同一格** —— 也就是说，插件设置面板里改这几项，会直接驱动我们的清理，
与在 ST 里改的行为一致。读不到时回落到插件默认值。
"""

from __future__ import annotations

import copy
import json
import logging
from dataclasses import dataclass
from typing import Any, Optional

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

# ── 插件 zod schema 的默认值（实测原文，勿改） ──────────────────────────────
DEFAULT_ENABLED = True
DEFAULT_SNAPSHOT_INTERVAL = 50
DEFAULT_KEEP_RECENT_FLOORS = 20
DEFAULT_RESTORE_FLOORS = 10

# 插件 Za() 里 `_.omit(...)` 的字段清单（原文顺序，勿增勿减）
PRUNED_FIELDS: tuple[str, ...] = (
    "initialized_lorebooks",
    "stat_data",
    "display_data",
    "delta_data",
    "schema",
)

# 锚点标记键（插件原文 `_.set(msg, ['variables', i, 'snapshot'], true)`）
SNAPSHOT_FLAG = "snapshot"

# 落库时留存补丁的键（支撑重演；插件靠正文原文，我们靠这个）
PATCH_EXTRA_KEY = "mvu_patch"

# 参数合法区间（防御脏设置；插件 zod 未夹，我们夹到合理范围）
_INTERVAL_RANGE = (1, 10_000)
_KEEP_RECENT_RANGE = (0, 10_000)
_RESTORE_FLOORS_RANGE = (0, 10_000)

_SETTINGS_NS = "mvu_settings"
_CLEANUP_NS = "自动清理变量"
_CARD_SETTINGS_KEY = "plugin_extension_settings_by_character"


@dataclass(frozen=True)
class CleanupSettings:
    """一次清理所用的四项参数（与插件同名同义）。"""

    enabled: bool = DEFAULT_ENABLED
    snapshot_interval: int = DEFAULT_SNAPSHOT_INTERVAL
    keep_recent_floors: int = DEFAULT_KEEP_RECENT_FLOORS
    restore_floors: int = DEFAULT_RESTORE_FLOORS


def _clamp_int(value: Any, lo: int, hi: int, fallback: int) -> int:
    """把外部来的值夹到区间内；不可解析时回落到默认值。"""
    try:
        num = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(lo, min(hi, num))


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


def resolve_cleanup_settings(
    db: Session,
    user_id: Optional[int],
    character_id: Optional[str],
) -> CleanupSettings:
    """读取「自动清理变量」四项参数。

    来源与插件同源：``plugin_extension_settings_by_character[<卡>].mvu_settings.自动清理变量``。
    读不到（用户没开过插件面板 / 没有那张卡 / 结构不对）→ 回落插件默认值。
    任何异常都不抛 —— 清理是后台行为，宁缺勿错。
    """
    if not user_id:
        return CleanupSettings()
    try:
        from ..models import UserSetting

        setting = (
            db.query(UserSetting).filter(UserSetting.user_id == user_id).first()
        )
        if setting is None:
            return CleanupSettings()
        st = _parse_json_dict(getattr(setting, "silly_tavern_settings", None))
        by_char = st.get(_CARD_SETTINGS_KEY)
        if not (isinstance(by_char, dict) and character_id):
            return CleanupSettings()
        bucket = by_char.get(str(character_id))
        if not isinstance(bucket, dict):
            return CleanupSettings()
        mvu = bucket.get(_SETTINGS_NS)
        if not isinstance(mvu, dict):
            return CleanupSettings()
        raw = mvu.get(_CLEANUP_NS)
        if not isinstance(raw, dict):
            return CleanupSettings()

        enabled = raw.get("启用", DEFAULT_ENABLED)
        return CleanupSettings(
            enabled=bool(enabled) if isinstance(enabled, bool) else DEFAULT_ENABLED,
            snapshot_interval=_clamp_int(
                raw.get("快照保留间隔"),
                *_INTERVAL_RANGE,
                fallback=DEFAULT_SNAPSHOT_INTERVAL,
            ),
            keep_recent_floors=_clamp_int(
                raw.get("要保留变量的最近楼层数"),
                *_KEEP_RECENT_RANGE,
                fallback=DEFAULT_KEEP_RECENT_FLOORS,
            ),
            restore_floors=_clamp_int(
                raw.get("触发恢复变量的最近楼层数"),
                *_RESTORE_FLOORS_RANGE,
                fallback=DEFAULT_RESTORE_FLOORS,
            ),
        )
    except Exception:  # noqa: BLE001 - 后台行为，任何异常都回落默认值
        logger.warning("[MVU-CLEANUP] 读取清理设置失败，回落默认值", exc_info=True)
        return CleanupSettings()


# ─────────────────────────────────────────────────────────────────────────────
# 清理（等价插件 Za）
# ─────────────────────────────────────────────────────────────────────────────


def prune_variables(
    variables: Optional[dict],
    floor_number: int,
    interval: int,
) -> tuple[Optional[dict], bool, bool]:
    """对单楼变量做插件 ``Za()`` 的同款处理。

    返回 ``(处理后的 variables, 是否发生变化, 是否计入「减重」计数)``。

    **两个布尔值的分工**（踩过一次坑，别合并）：

    - ``changed``：对象是否真的变了 —— 决定**要不要写库**。
      已清理过的楼层再走一遍不会变（幂等），不该产生无谓写。
    - ``pruned``：是否真的摘掉了字段 —— 决定**要不要计入 cleaned 计数**。
      打锚点会 ``changed=True`` 但 ``pruned=False``（插件也只统计减重楼，锚点不计）。

    判定顺序严格对齐插件原文：

    1. 变量为空 → 原样返回（插件 `if (msg.variables === undefined) return`）
    2. 已是锚点（``snapshot is True``）→ **原样保留，永不再清**
    3. ``floor_number % interval == 0`` → **打锚点**，保留完整
    4. 其余 → **摘掉 PRUNED_FIELDS**，只留轻量信息
    """
    if not isinstance(variables, dict) or not variables:
        return variables, False, False

    if variables.get(SNAPSHOT_FLAG) is True:
        return variables, False, False

    if interval > 0 and floor_number % interval == 0:
        out = dict(variables)
        out[SNAPSHOT_FLAG] = True
        return out, True, False

    removed_any = any(field in variables for field in PRUNED_FIELDS)
    out = {k: v for k, v in variables.items() if k not in PRUNED_FIELDS}
    if removed_any:
        # 减重后留个可判断的痕迹（插件也会留下 snapshot 之外的轻量键；
        # 若原本就只有被摘的字段，则留一个显式标记，避免变成空对象而"看起来没有变量"）
        out.setdefault("pruned", True)
    # 没摘掉任何字段（如已被清过）→ 视为未变化，不写库、不计数
    return (out, True, True) if removed_any else (out, False, False)


def prune_floor_window(
    extras: dict[int, dict],
    start: int,
    end: int,
    interval: int,
) -> tuple[int, list[int]]:
    """对楼层区间 ``[start, end]``（**1 基楼层号，闭区间**）执行清理。

    ``extras`` 是 ``{楼层号: extra dict}``（原地修改）。
    返回 ``(被减重的楼层数, 发生改动的楼层号列表)``。

    ⚠️ ``changed`` 与 ``cleaned`` 不是一回事：**打锚点也属于改动**（要写库），
    但不计入 cleaned（插件同样只统计减重楼）。早期实现只把 ``pruned`` 当改动，
    导致锚点标记被丢弃 —— 恢复功能随即失效。
    """
    changed: list[int] = []
    cleaned = 0
    if end < start:
        return 0, changed
    for floor_no in range(start, end + 1):
        extra = extras.get(floor_no)
        if not isinstance(extra, dict):
            continue
        new_vars, is_changed, is_pruned = prune_variables(
            extra.get("variables"), floor_no, interval
        )
        if is_changed:
            extra["variables"] = new_vars
            changed.append(floor_no)
            if is_pruned:
                cleaned += 1
    return cleaned, changed


def auto_prune_window(
    current_floor: int,
    keep_recent_floors: int,
) -> Optional[tuple[int, int]]:
    """自动（增量）清理的窗口，对齐插件 ``MESSAGE_RECEIVED`` 分支。

    插件原文：

    ```js
    const n = 收到消息的楼层号 - 要保留变量的最近楼层数;
    if (n > 0) Za(Math.max(1, n - 2 - 2 * 要保留变量的最近楼层数), n, 快照保留间隔);
    ```

    即：**只清"当前楼 - 保留楼层"往前数 ``2 + 2×保留楼层`` 的一段**，
    随聊天增长逐段滚动覆盖，不做全表扫描。
    """
    n = current_floor - keep_recent_floors
    if n <= 0:
        return None
    start = max(1, n - 2 - 2 * keep_recent_floors)
    return (start, n)


def should_auto_prune(floor_count: int) -> bool:
    """插件触发条件：每 5 楼一次（``chat.length % 5 === 0``）。"""
    return floor_count > 0 and floor_count % 5 == 0


# ─────────────────────────────────────────────────────────────────────────────
# 恢复（等价插件 Ya）
# ─────────────────────────────────────────────────────────────────────────────


def _has_full_snapshot(extra: Any) -> bool:
    """插件判定：该楼同时有 ``stat_data`` 与 ``schema`` 才算"完整"。"""
    if not isinstance(extra, dict):
        return False
    variables = extra.get("variables")
    if not isinstance(variables, dict):
        return False
    return isinstance(variables.get("stat_data"), dict) and ("schema" in variables)


def find_anchor_floor(
    floors: list[tuple[int, dict]],
    from_floor: int,
) -> Optional[int]:
    """从 ``from_floor`` 往前找最近一个锚点楼层（``variables.snapshot is True``）。

    对齐插件 ``gn(i)``。找不到返回 ``None``。
    """
    best: Optional[int] = None
    for floor_no, extra in floors:
        if floor_no > from_floor:
            continue
        variables = extra.get("variables") if isinstance(extra, dict) else None
        if isinstance(variables, dict) and variables.get(SNAPSHOT_FLAG) is True:
            if best is None or floor_no > best:
                best = floor_no
    return best


def replay_patches(
    base_variables: dict,
    patches_by_floor: list[Optional[list]],
) -> dict:
    """从 ``base_variables`` 出发，按楼层顺序逐个应用补丁，返回末态。

    这是插件 ``Tn(mes, u)`` 的等价物 —— 插件重新解析楼层正文拿到补丁，
    我们直接取落库时留存的补丁。两者都是"把该楼的变量增量应用到当前状态上"。
    缺补丁的楼层视为"该轮无变量变化"，状态不变（与插件一致）。
    """
    from .mvu_engine import apply_patches

    state = copy.deepcopy(base_variables) if isinstance(base_variables, dict) else {}
    for patches in patches_by_floor:
        if not isinstance(patches, list) or not patches:
            continue
        try:
            state, _logs = apply_patches(state, patches)
        except Exception:  # noqa: BLE001 - 单楼补丁失败不阻断整条重演
            logger.warning(
                "[MVU-CLEANUP] 重演时应用补丁失败，跳过该楼", exc_info=True
            )
    return state


# ─────────────────────────────────────────────────────────────────────────────
# DB 编排（读楼层 → 清理 / 恢复 → 写回）
# ─────────────────────────────────────────────────────────────────────────────

# 恢复时从锚点搬回目标楼层的字段（对齐插件 updateVariablesWith 里逐个赋值的清单）
_RESTORE_FIELDS: tuple[str, ...] = (
    "initialized_lorebooks",
    "stat_data",
    "schema",
    "display_data",
    "delta_data",
)


def _load_branch_floors(
    db: Session,
    session_id: str,
    branch_id: Optional[str],
) -> list[tuple[Any, int, dict]]:
    """按楼层序加载本分支消息，返回 ``[(msg, 楼层号(1基), extra)]``。"""
    from ..models import CharacterChatMessage

    query = db.query(CharacterChatMessage).filter(
        CharacterChatMessage.session_id == session_id
    )
    if branch_id:
        query = query.filter(CharacterChatMessage.branch_id == branch_id)
    else:
        query = query.filter(CharacterChatMessage.branch_id.is_(None))
    rows = query.order_by(CharacterChatMessage.id).all()
    return [
        (msg, idx + 1, _parse_json_dict(getattr(msg, "extra", None)))
        for idx, msg in enumerate(rows)
    ]


def _save_extra(msg: Any, extra: dict) -> None:
    msg.extra = json.dumps(extra, ensure_ascii=False)


def _floor_variables(floors: list[tuple[Any, int, dict]], floor_no: int) -> dict:
    for _msg, no, extra in floors:
        if no == floor_no:
            variables = extra.get("variables")
            return variables if isinstance(variables, dict) else {}
    return {}


def _resolve_session_scope(
    db: Session,
    session_id: str,
) -> Optional[tuple[Optional[str], Optional[str], Optional[int]]]:
    """从会话反查 ``(character_id, branch_id, user_id)``。

    让调用点只传 ``session_id``（接线点越少越不易漏），也保证作用域不会传错。
    """
    from ..models import CharacterChatSession, CharacterChatSessionBranch

    session = (
        db.query(CharacterChatSession)
        .filter(CharacterChatSession.id == session_id)
        .first()
    )
    if session is None:
        return None
    branch = (
        db.query(CharacterChatSessionBranch)
        .filter(
            CharacterChatSessionBranch.session_id == session_id,
            CharacterChatSessionBranch.is_active == True,  # noqa: E712
        )
        .first()
    )
    return (
        getattr(session, "character_id", None),
        getattr(branch, "id", None) if branch is not None else None,
        getattr(session, "user_id", None),
    )


def run_auto_cleanup_for_session(db: Session, session_id: str) -> int:
    """自动（增量）清理的**接线入口**：只需 ``session_id``。

    调用时机：**每次生成落库并提交之后**（对应插件"收到一条消息"）。
    """
    scope = _resolve_session_scope(db, session_id)
    if scope is None:
        return 0
    character_id, branch_id, user_id = scope
    return run_auto_cleanup(
        db,
        session_id=session_id,
        branch_id=branch_id,
        character_id=character_id,
        user_id=user_id,
    )


def run_restore_for_session(db: Session, session_id: str) -> int:
    """恢复的**接线入口**：只需 ``session_id``。

    调用时机：**删除消息之后**（对应插件 ``MESSAGE_DELETED``）。
    """
    scope = _resolve_session_scope(db, session_id)
    if scope is None:
        return 0
    character_id, branch_id, user_id = scope
    return run_restore(
        db,
        session_id=session_id,
        branch_id=branch_id,
        character_id=character_id,
        user_id=user_id,
    )


def run_auto_cleanup(
    db: Session,
    *,
    session_id: str,
    branch_id: Optional[str],
    character_id: Optional[str],
    user_id: Optional[int],
) -> int:
    """自动（增量）清理 —— 等价插件 ``MESSAGE_RECEIVED`` 分支。返回清理的楼层数。

    调用时机：**每次生成落库之后**（对应插件"收到一条消息"）。
    触发条件：楼层数为 5 的倍数（插件 ``chat.length % 5 === 0``）。
    清理窗口：``[max(1, n - 2 - 2*保留楼层), n]``，``n = 当前楼 - 保留楼层``。
    """
    try:
        settings = resolve_cleanup_settings(db, user_id, character_id)
        if not settings.enabled:
            return 0
        floors = _load_branch_floors(db, session_id, branch_id)
        floor_count = len(floors)
        if not should_auto_prune(floor_count):
            return 0
        window = auto_prune_window(floor_count, settings.keep_recent_floors)
        if window is None:
            return 0
        start, end = window

        extras = {no: extra for _msg, no, extra in floors}
        cleaned, changed = prune_floor_window(
            extras, start, end, settings.snapshot_interval
        )
        if not changed:
            return 0
        changed_set = set(changed)
        for msg, no, _extra in floors:
            if no in changed_set:
                _save_extra(msg, extras[no])
        logger.info(
            "[MVU-CLEANUP] 自动清理 %d 楼（窗口 %d-%d，间隔 %d）",
            cleaned,
            start,
            end,
            settings.snapshot_interval,
        )
        return cleaned
    except Exception:  # noqa: BLE001 - 后台行为，绝不因清理失败影响生成主流程
        logger.warning("[MVU-CLEANUP] 自动清理失败（不影响主流程）", exc_info=True)
        return 0


def run_manual_cleanup(
    db: Session,
    *,
    session_id: str,
    branch_id: Optional[str],
    character_id: Optional[str],
    user_id: Optional[int],
    depth: int,
) -> int:
    """手动清理 —— 等价插件「清除旧楼层变量」按钮。

    插件原文：弹窗问深度 ``n`` → ``Za(1, chat.length - 1 - n, 快照保留间隔)``。
    **不看 enabled 开关**（插件的手动按钮同样不检查）。
    """
    settings = resolve_cleanup_settings(db, user_id, character_id)
    floors = _load_branch_floors(db, session_id, branch_id)
    floor_count = len(floors)
    end = floor_count - max(0, int(depth))
    if end < 1:
        return 0
    extras = {no: extra for _msg, no, extra in floors}
    cleaned, changed = prune_floor_window(
        extras, 1, end, settings.snapshot_interval
    )
    if not changed:
        return 0
    changed_set = set(changed)
    for msg, no, _extra in floors:
        if no in changed_set:
            _save_extra(msg, extras[no])
    logger.info(
        "[MVU-CLEANUP] 手动清理 %d 楼（1-%d，间隔 %d）",
        cleaned,
        end,
        settings.snapshot_interval,
    )
    return cleaned


def run_restore(
    db: Session,
    *,
    session_id: str,
    branch_id: Optional[str],
    character_id: Optional[str],
    user_id: Optional[int],
) -> int:
    """恢复 —— 等价插件 ``Ya()``：删楼后把滑进窗口的被清楼层补回来。

    调用时机：**删除消息之后**（插件在 ``MESSAGE_DELETED`` 上 debounce 2s）。
    返回被补回的楼层数。找不到锚点时记 WARNING（等价插件 ``toastr.warning('无法恢复')``）。
    """
    try:
        settings = resolve_cleanup_settings(db, user_id, character_id)
        if not settings.enabled:
            return 0
        floors = _load_branch_floors(db, session_id, branch_id)
        last = len(floors)
        if last == 0:
            return 0

        # o = 最后一个"不完整"的楼层（插件 findLastIndex 的语义）
        o = None
        for _msg, no, extra in floors:
            if not _has_full_snapshot(extra):
                o = no
        if o is None:
            return 0
        r = max(1, last - settings.restore_floors)
        if r > o:
            return 0  # 最近若干楼没有被动过 → 无需恢复

        i = max(1, last - settings.keep_recent_floors)
        anchor = find_anchor_floor(
            [(no, extra) for _msg, no, extra in floors], i
        )
        if anchor is None:
            logger.warning(
                "[MVU-CLEANUP] 恢复失败：%d 楼之前找不到锚点（等价插件「无法恢复」提示）",
                i,
            )
            return 0

        anchor_idx = next(
            idx for idx, (_m, no, _e) in enumerate(floors) if no == anchor
        )
        o_idx = next(idx for idx, (_m, no, _e) in enumerate(floors) if no == o)

        state = copy.deepcopy(_floor_variables(floors, anchor))
        restored = 0
        from .mvu_engine import apply_patches

        for idx in range(anchor_idx + 1, o_idx + 1):
            msg, no, extra = floors[idx]
            # 等价插件 Tn(chat[t].mes, u)：把该楼的变量增量应用到当前状态
            patch = extra.get(PATCH_EXTRA_KEY)
            if isinstance(patch, list) and patch:
                try:
                    state, _logs = apply_patches(state, patch)
                except Exception:  # noqa: BLE001
                    logger.warning(
                        "[MVU-CLEANUP] 重演第 %d 楼补丁失败，跳过", no, exc_info=True
                    )
            if no >= i and not _has_full_snapshot(extra):
                target = extra.get("variables")
                target = dict(target) if isinstance(target, dict) else {}
                for key in _RESTORE_FIELDS:
                    if key in state:
                        target[key] = copy.deepcopy(state[key])
                    else:
                        target.pop(key, None)
                target.pop("pruned", None)
                extra["variables"] = target
                _save_extra(msg, extra)
                restored += 1

        if restored:
            logger.info(
                "[MVU-CLEANUP] 恢复 %d 楼（锚点 %d → 至 %d 楼）", restored, anchor, o
            )
        return restored
    except Exception:  # noqa: BLE001 - 后台行为，绝不因恢复失败影响删除主流程
        logger.warning("[MVU-CLEANUP] 恢复失败（不影响主流程）", exc_info=True)
        return 0
