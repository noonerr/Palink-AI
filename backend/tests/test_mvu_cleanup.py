"""MVU 变量自动清理的契约测试（2026-10-05 立）。

钉住的是**与 MVU 插件（MagVarUpdate）行为等价**这一条，不是"我们自己的实现细节"。
插件权威实现在卡脚本 bundle
``backend/data/smart_card_assets/0c646fb31a…js`` 的 ``Za()``（清理）与 ``Ya()``（恢复），
逐条对照见 ``docs/SPEC_变量自动清理_MVU对齐_2026-10-05.md`` §1。

五组断言：

1. **清理语义**：摘大字段、每 interval 楼留锚点、锚点永不再清、空变量不动
2. **窗口语义**：自动窗口 ``[max(1, n-2-2*keep), n]``、触发条件每 5 楼
3. **设置来源**：与插件同源（``extension_settings.mvu_settings.自动清理变量``）+ 缺省回落插件默认值
4. **恢复语义**：从最近锚点重演，把滑进窗口的被清楼层补回来
5. **反证**：关掉开关必须一楼都不清

运行: py -3 -m pytest tests/test_mvu_cleanup.py -q
"""
from __future__ import annotations

import json
import uuid

import pytest

from app.services.mvu_cleanup import (
    DEFAULT_KEEP_RECENT_FLOORS,
    DEFAULT_RESTORE_FLOORS,
    DEFAULT_SNAPSHOT_INTERVAL,
    PATCH_EXTRA_KEY,
    PRUNED_FIELDS,
    SNAPSHOT_FLAG,
    CleanupSettings,
    auto_prune_window,
    find_anchor_floor,
    prune_floor_window,
    prune_variables,
    replay_patches,
    resolve_cleanup_settings,
    run_auto_cleanup_for_session,
    run_manual_cleanup,
    run_restore_for_session,
    should_auto_prune,
)


# ---------------------------------------------------------------------------
# 建世界
# ---------------------------------------------------------------------------


def _full_vars(value: int = 1) -> dict:
    """一份"完整"的 variables（含 stat_data + schema，插件判定完整的两个键）。"""
    return {
        "stat_data": {"好感度": value},
        "schema": {"好感度": 0},
        "initialized_lorebooks": {"wb": []},
    }


def _make_world(db_session, *, floors: int = 0):
    """建 user + 角色 + 会话 + ``floors`` 层楼（每层带完整 variables）。"""
    from app.models import (
        Character,
        CharacterChatMessage,
        CharacterChatSession,
        User,
    )

    user = User(
        username=f"mvu_cleanup_{uuid.uuid4().hex[:8]}",
        hashed_password="dummy",
        role="user",
        is_active=True,
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)

    char = Character(
        user_id=user.id,
        name="清理测试卡",
        description="d",
        personality="",
        scenario="",
        first_mes="",
        mes_example="",
        system_prompt="",
        post_history_instructions="",
        alternate_greetings="[]",
        tags="[]",
        creator_notes="",
        creator="test",
        character_version="1.0",
        extensions="{}",
    )
    db_session.add(char)
    db_session.commit()
    db_session.refresh(char)

    session = CharacterChatSession(
        id=f"mvu-clean-{uuid.uuid4().hex[:8]}",
        user_id=user.id,
        character_id=char.id,
        title="cleanup session",
        chat_metadata="{}",
    )
    db_session.add(session)
    db_session.commit()
    db_session.refresh(session)

    for i in range(floors):
        db_session.add(
            CharacterChatMessage(
                session_id=session.id,
                branch_id=None,
                role="assistant",
                content=f"floor {i + 1}",
                extra=json.dumps({"variables": _full_vars(i + 1)}, ensure_ascii=False),
            )
        )
    db_session.commit()
    return user, char, session


def _set_plugin_settings(db_session, user_id: int, cleanup: dict | None, *, character_id=None):
    """把清理设置写进**插件同源的那一格**（按卡）。``cleanup=None`` = 整格不写。"""
    from app.models import UserSetting

    setting = db_session.query(UserSetting).filter(UserSetting.user_id == user_id).first()
    if setting is None:
        setting = UserSetting(user_id=user_id)
        db_session.add(setting)
    payload: dict = {"plugin_extension_settings_by_character": {}}
    if cleanup is not None:
        key = str(character_id) if character_id else "any"
        payload["plugin_extension_settings_by_character"][key] = {
            "mvu_settings": {"自动清理变量": cleanup}
        }
    setting.silly_tavern_settings = json.dumps(payload, ensure_ascii=False)
    db_session.commit()


def _floors_of(db_session, session_id: str) -> list[dict]:
    from app.models import CharacterChatMessage

    rows = (
        db_session.query(CharacterChatMessage)
        .filter(CharacterChatMessage.session_id == session_id)
        .order_by(CharacterChatMessage.id)
        .all()
    )
    return [json.loads(r.extra or "{}") for r in rows]


# ---------------------------------------------------------------------------
# 1. 清理语义（等价插件 Za）
# ---------------------------------------------------------------------------


class TestPruneSemantics:
    def test_removes_big_fields_and_keeps_light_marker(self):
        variables, changed, pruned = prune_variables(_full_vars(7), 7, 50)
        assert (changed, pruned) == (True, True)
        for field in PRUNED_FIELDS:
            assert field not in variables, f"{field} 应被摘掉"
        assert variables.get("pruned") is True

    def test_anchor_floor_is_kept_intact(self):
        """``floor % interval == 0`` 的楼层保留完整，并打上 snapshot 标记。"""
        variables, changed, pruned = prune_variables(_full_vars(7), 50, 50)
        assert (changed, pruned) == (True, False), "打锚点算改动、但不算减重"
        assert variables[SNAPSHOT_FLAG] is True
        assert variables["stat_data"] == {"好感度": 7}, "锚点不得丢 stat_data"

    def test_anchor_is_never_pruned_again(self):
        """已是锚点的楼层，即使楼层号不再整除 interval 也不动它（插件第 2 条判定）。"""
        anchored = dict(_full_vars(3))
        anchored[SNAPSHOT_FLAG] = True
        variables, changed, pruned = prune_variables(anchored, 7, 50)
        assert (changed, pruned) == (False, False)
        assert variables["stat_data"] == {"好感度": 3}

    def test_empty_variables_untouched(self):
        for empty in ({}, None):
            variables, changed, pruned = prune_variables(empty, 7, 50)
            assert (changed, pruned) == (False, False)
            assert variables == empty

    def test_prune_is_idempotent(self):
        """已清过的楼层再走一遍：不变化、不计数（否则会产生无谓写库）。"""
        once, changed1, pruned1 = prune_variables(_full_vars(1), 7, 50)
        twice, changed2, pruned2 = prune_variables(once, 7, 50)
        assert (changed1, pruned1) == (True, True)
        assert (changed2, pruned2) == (False, False), "第二次不得再报变化"
        assert twice == once

    def test_window_only_touches_inside(self):
        extras = {i: {"variables": _full_vars(i)} for i in range(1, 11)}
        cleaned, changed = prune_floor_window(extras, start=3, end=6, interval=50)
        assert cleaned == 4
        assert sorted(changed) == [3, 4, 5, 6]
        # 窗口外的原样
        assert extras[2]["variables"]["stat_data"] == {"好感度": 2}
        assert extras[7]["variables"]["stat_data"] == {"好感度": 7}

    def test_window_writes_back_anchor_marking(self):
        """锚点标记必须写回（早期实现把它当"无变化"丢掉，恢复功能因此失效）。"""
        extras = {i: {"variables": _full_vars(i)} for i in range(1, 7)}
        cleaned, changed = prune_floor_window(extras, start=1, end=5, interval=3)
        assert 3 in changed, "3 楼打了锚点，必须进 changed 列表"
        assert extras[3]["variables"][SNAPSHOT_FLAG] is True
        assert cleaned == 4, "锚点不计入 cleaned（插件同口径）"

    def test_empty_window_returns_zero(self):
        extras = {1: {"variables": _full_vars(1)}}
        assert prune_floor_window(extras, start=5, end=1, interval=50) == (0, [])


# ---------------------------------------------------------------------------
# 2. 窗口语义（等价插件 MESSAGE_RECEIVED 分支）
# ---------------------------------------------------------------------------


class TestWindowSemantics:
    def test_auto_window_matches_plugin_formula(self):
        # n = 100 - 20 = 80；start = max(1, 80 - 2 - 40) = 38
        assert auto_prune_window(100, 20) == (38, 80)

    def test_auto_window_none_when_not_past_keep(self):
        assert auto_prune_window(20, 20) is None
        assert auto_prune_window(5, 20) is None

    def test_auto_window_start_never_below_one(self):
        start, end = auto_prune_window(25, 20)
        assert start == 1
        assert end == 5

    def test_trigger_is_every_five_floors(self):
        assert should_auto_prune(5) is True
        assert should_auto_prune(10) is True
        assert should_auto_prune(0) is False
        assert should_auto_prune(7) is False


# ---------------------------------------------------------------------------
# 3. 设置来源（与插件同源）
# ---------------------------------------------------------------------------


class TestSettingsSource:
    def test_defaults_match_plugin_schema(self):
        """插件 zod 默认值：启用 true / 间隔 50 / 保留 20 / 恢复 10。"""
        s = CleanupSettings()
        assert s.enabled is True
        assert s.snapshot_interval == DEFAULT_SNAPSHOT_INTERVAL == 50
        assert s.keep_recent_floors == DEFAULT_KEEP_RECENT_FLOORS == 20
        assert s.restore_floors == DEFAULT_RESTORE_FLOORS == 10

    def test_reads_from_plugin_same_namespace(self, db_session):
        user, char, _session = _make_world(db_session)
        _set_plugin_settings(
            db_session,
            user.id,
            {
                "启用": False,
                "快照保留间隔": 12,
                "要保留变量的最近楼层数": 7,
                "触发恢复变量的最近楼层数": 3,
            },
            character_id=char.id,
        )
        s = resolve_cleanup_settings(db_session, user.id, char.id)
        assert (s.enabled, s.snapshot_interval, s.keep_recent_floors, s.restore_floors) == (
            False,
            12,
            7,
            3,
        )

    def test_falls_back_to_defaults_when_absent(self, db_session):
        user, char, _session = _make_world(db_session)
        _set_plugin_settings(db_session, user.id, None)
        assert resolve_cleanup_settings(db_session, user.id, char.id) == CleanupSettings()

    def test_dirty_values_clamped_not_crashed(self, db_session):
        user, char, _session = _make_world(db_session)
        _set_plugin_settings(
            db_session,
            user.id,
            {"启用": "yes", "快照保留间隔": "abc", "要保留变量的最近楼层数": -5},
            character_id=char.id,
        )
        s = resolve_cleanup_settings(db_session, user.id, char.id)
        assert s.snapshot_interval == DEFAULT_SNAPSHOT_INTERVAL, "不可解析 → 回落默认"
        assert s.keep_recent_floors == 0, "负数夹到 0"

    def test_no_user_id_returns_defaults(self, db_session):
        assert resolve_cleanup_settings(db_session, None, "x") == CleanupSettings()


# ---------------------------------------------------------------------------
# 4. 端到端：自动清理 / 恢复 / 手动
# ---------------------------------------------------------------------------


class TestEndToEnd:
    def test_auto_cleanup_prunes_old_keeps_recent(self, db_session):
        """10 层楼（触发每 5 楼），保留最近 2 楼不动，老楼层被摘。"""
        user, char, session = _make_world(db_session, floors=10)
        _set_plugin_settings(
            db_session,
            user.id,
            {"启用": True, "快照保留间隔": 50, "要保留变量的最近楼层数": 2},
            character_id=char.id,
        )
        cleaned = run_auto_cleanup_for_session(db_session, session.id)
        db_session.commit()
        # n = 10 - 2 = 8；start = max(1, 8-2-4) = 2 → 清 2..8
        assert cleaned == 7

        floors = _floors_of(db_session, session.id)
        assert floors[0]["variables"].get("stat_data") is not None, "1 楼在窗口外，不动"
        assert floors[1]["variables"].get("stat_data") is None, "2 楼被摘"
        assert floors[9]["variables"].get("stat_data") is not None, "10 楼是最近楼，不动"
        assert floors[9]["variables"]["stat_data"] == {"好感度": 10}

    def test_disabled_cleans_nothing(self, db_session):
        """反证：关掉开关必须一楼都不清。"""
        user, char, session = _make_world(db_session, floors=10)
        _set_plugin_settings(
            db_session,
            user.id,
            {"启用": False, "要保留变量的最近楼层数": 2},
            character_id=char.id,
        )
        assert run_auto_cleanup_for_session(db_session, session.id) == 0
        db_session.commit()
        for extra in _floors_of(db_session, session.id):
            assert extra["variables"]["stat_data"] is not None

    def test_not_multiple_of_five_skips(self, db_session):
        user, char, session = _make_world(db_session, floors=7)
        _set_plugin_settings(
            db_session, user.id, {"启用": True, "要保留变量的最近楼层数": 2}, character_id=char.id
        )
        assert run_auto_cleanup_for_session(db_session, session.id) == 0

    def test_manual_cleanup_respects_depth(self, db_session):
        """等价插件「清除旧楼层变量」：保留末尾 depth 楼，其余进清理窗口。"""
        user, char, session = _make_world(db_session, floors=8)
        _set_plugin_settings(db_session, user.id, None, character_id=char.id)
        cleaned = run_manual_cleanup(
            db_session,
            session_id=session.id,
            branch_id=None,
            character_id=char.id,
            user_id=user.id,
            depth=3,
        )
        db_session.commit()
        assert cleaned == 5, "1..5 楼被摘（8 - 3）"
        floors = _floors_of(db_session, session.id)
        assert floors[4]["variables"].get("stat_data") is None
        assert floors[7]["variables"]["stat_data"] == {"好感度": 8}, "末尾 3 楼不动"

    def test_manual_cleanup_ignores_enabled_flag(self, db_session):
        """插件的手动按钮不检查「启用自动清理」开关。"""
        user, char, session = _make_world(db_session, floors=6)
        _set_plugin_settings(
            db_session, user.id, {"启用": False}, character_id=char.id
        )
        cleaned = run_manual_cleanup(
            db_session,
            session_id=session.id,
            branch_id=None,
            character_id=char.id,
            user_id=user.id,
            depth=1,
        )
        assert cleaned == 5

    def test_restore_rebuilds_pruned_floors_from_anchor(self, db_session):
        """恢复：从最近锚点重演，把被清楼层补回来（等价插件 Ya）。"""
        user, char, session = _make_world(db_session, floors=6)
        # 每 3 楼一个锚点；先手动清掉 1..5（保留末尾 1 楼）
        _set_plugin_settings(
            db_session,
            user.id,
            {
                "启用": True,
                "快照保留间隔": 3,
                "要保留变量的最近楼层数": 1,
                "触发恢复变量的最近楼层数": 10,
            },
            character_id=char.id,
        )
        run_manual_cleanup(
            db_session,
            session_id=session.id,
            branch_id=None,
            character_id=char.id,
            user_id=user.id,
            depth=1,
        )
        db_session.commit()

        floors = _floors_of(db_session, session.id)
        assert floors[2]["variables"][SNAPSHOT_FLAG] is True, "3 楼是锚点"
        assert floors[3]["variables"].get("stat_data") is None, "4 楼被摘"

        # 给被摘的楼层留补丁（真实链路由落库时的 extra["mvu_patch"] 提供）
        from app.models import CharacterChatMessage

        rows = (
            db_session.query(CharacterChatMessage)
            .filter(CharacterChatMessage.session_id == session.id)
            .order_by(CharacterChatMessage.id)
            .all()
        )
        for idx, row in enumerate(rows):
            extra = json.loads(row.extra or "{}")
            extra[PATCH_EXTRA_KEY] = [
                {"op": "replace", "path": "/好感度", "value": idx + 1}
            ]
            row.extra = json.dumps(extra, ensure_ascii=False)
        db_session.commit()

        restored = run_restore_for_session(db_session, session.id)
        db_session.commit()
        # 插件只补 ``t >= i`` 的楼层（i = last - keep_recent = 6 - 1 = 5），
        # 即"落在保留窗口里、却因为删楼/窗口回滑而被清过"的那些楼。
        assert restored == 1, "只应补回 5 楼"
        floors = _floors_of(db_session, session.id)
        assert floors[4]["variables"].get("stat_data") is not None, "5 楼被重建"
        assert floors[4]["variables"]["stat_data"] == {"好感度": 5}, "重演结果正确"
        assert floors[3]["variables"].get("stat_data") is None, (
            "4 楼在保留窗口之外，插件语义下不补（保持被清状态）"
        )

    def test_restore_noop_when_nothing_pruned(self, db_session):
        user, char, session = _make_world(db_session, floors=6)
        _set_plugin_settings(db_session, user.id, None, character_id=char.id)
        assert run_restore_for_session(db_session, session.id) == 0


# ---------------------------------------------------------------------------
# 5. 重演原语
# ---------------------------------------------------------------------------


class TestReplay:
    def test_applies_patches_in_order(self):
        state = replay_patches(
            {"stat_data": {"好感度": 1}},
            [
                [{"op": "replace", "path": "/好感度", "value": 5}],
                [{"op": "delta", "path": "/好感度", "value": 3}],
            ],
        )
        assert state["stat_data"]["好感度"] == 8

    def test_missing_patch_leaves_state_unchanged(self):
        state = replay_patches(
            {"stat_data": {"好感度": 1}},
            [None, [], None],
        )
        assert state["stat_data"]["好感度"] == 1

    def test_bad_patch_does_not_abort(self):
        state = replay_patches(
            {"stat_data": {"好感度": 1}},
            ["not-a-list", [{"op": "replace", "path": "/好感度", "value": 9}]],
        )
        assert state["stat_data"]["好感度"] == 9

    def test_anchor_lookup_prefers_nearest_at_or_before(self):
        floors = [
            (1, {"variables": {SNAPSHOT_FLAG: True}}),
            (5, {"variables": {SNAPSHOT_FLAG: True}}),
            (9, {"variables": {SNAPSHOT_FLAG: True}}),
            (12, {"variables": {}}),
        ]
        assert find_anchor_floor(floors, 12) == 9
        assert find_anchor_floor(floors, 9) == 9
        assert find_anchor_floor(floors, 4) == 1
        assert find_anchor_floor([(1, {"variables": {}})], 3) is None
