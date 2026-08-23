"""P1-D-1 修复验证: 世界书 delay 条目死锁 + exclude_recursion RECURSION 轮跳过。

ST 权威（frontend/public/st/scripts/world-info.js）:
- :665-676 ``#checkDelayEffect`` — entry.delay > 0 且 chat.length < entry.delay
  → 本轮抑制；无状态、无计数器，随聊天消息数增长自动解除。
- :4758-4760 — scanState === RECURSION && entry.excludeRecursion && !isSticky
  → 跳过（RECURSION 轮不激活 exclude_recursion 条目，sticky 激活期豁免）。

旧实现缺陷: can_activate 对无状态行的 delay 条目一律拒绝，而状态行唯一
创建点 record_activation 在激活之后 → delay 条目整个会话生命周期静默失效。
"""

import json
import os
import sys
import uuid

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.models.character import Character, CharacterChatSession  # noqa: E402
from app.models.worldbook import WorldBook, WorldBookStage  # noqa: E402
from app.services.worldbook_service import (  # noqa: E402
    TimedEffectsManager,
    WorldbookEntryReport,
    _scan_entries,
)

WI_POS_AT_DEPTH = 4


def _mk_db_parents(db_session, user_id: int, sess_id: str, entry_id: str) -> None:
    """创建满足 FK 约束的真实父行（world_books / character_chat_sessions / world_book_stages）。"""
    character = Character(
        id=str(uuid.uuid4()),
        user_id=user_id,
        name="p1-delay-test-char",
    )
    db_session.add(character)
    db_session.flush()
    db_session.add(
        CharacterChatSession(
            id=sess_id,
            user_id=user_id,
            character_id=character.id,
            title="p1-delay-test",
        )
    )
    db_session.add(WorldBook(id="wb", user_id=user_id, name="p1-delay-test-book"))
    stage = _mk_entry(entry_id)
    db_session.add(stage)
    db_session.commit()


def _mk_entry(
    eid: str,
    delay: int = 0,
    exclude_recursion: bool = False,
    key: str = "dragon",
    content: str = "Dragon lore",
    sticky: int = 0,
) -> WorldBookStage:
    return WorldBookStage(
        id=eid,
        world_book_id="wb",
        stage_index=0,
        title=eid,
        content=content,
        keys=json.dumps([key]),
        secondary_keys=json.dumps([]),
        position=WI_POS_AT_DEPTH,
        depth=4,
        selective=False,
        selective_logic=0,
        probability=100,
        constant=False,
        enabled=True,
        sticky=sticky,
        cooldown=0,
        delay=delay,
        exclude_recursion=exclude_recursion,
        prevent_recursion=False,
        scan_depth=None,
    )


class TestDelayAbsoluteSemantics:
    """D-1: delay 对齐 ST chat_length 绝对语义。"""

    def test_delay_suppressed_only_within_first_n_messages(self, db_session):
        """delay=2: chat_length<2 抑制；>=2 可激活（无需任何前置状态行）。"""
        mgr = TimedEffectsManager(db_session, "sess-delay-abs")
        entry = _mk_entry("d1", delay=2)
        assert mgr.can_activate(entry, message_index=0, chat_length=1) is False
        assert mgr.can_activate(entry, message_index=1, chat_length=2) is True
        assert mgr.can_activate(entry, message_index=5, chat_length=6) is True

    def test_delay_entry_activates_after_chat_grows_without_state_row(self, db_session):
        """死锁复现: 无状态行 + delay>0 的条目在聊天增长后应能关键词激活。

        旧行为: can_activate 永久拒绝（无状态行 + delay>0 → False），
        record_activation 永远不可达 → 断言失败（红）。
        """
        entries = [_mk_entry("d1", delay=1)]
        msgs = [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "I saw a dragon."},
            {"role": "user", "content": "tell me more"},
        ]
        report: list[WorldbookEntryReport] = []
        activated = _scan_entries(
            entries,
            msgs,
            None,
            TimedEffectsManager(db_session, "sess-delay-e2e"),
            message_index=2,
            visited=set(),
            recursion_depth=0,
            report=report,
            chat_length=3,
        )
        assert "d1" in {e.id for e in activated}, (
            "delay 条目应在 chat_length >= delay 后正常激活"
        )

    def test_zero_delay_entry_never_blocked(self, db_session):
        """delay=0/None 条目不受影响（开局即可激活）。"""
        mgr = TimedEffectsManager(db_session, "sess-delay-zero")
        entry = _mk_entry("d0", delay=0)
        assert mgr.can_activate(entry, message_index=0, chat_length=1) is True

    def test_sticky_cooldown_counter_model_unaffected(self, db_session, test_user):
        """回归保护: sticky/cooldown 计数器模型保持不变。"""
        from app.models.worldbook import SessionWorldBookEntryState

        sess = "sess-cd-regression"
        _mk_db_parents(db_session, test_user.id, sess, "c1")
        db_session.add(
            SessionWorldBookEntryState(
                session_id=sess,
                entry_id="c1",
                sticky_remaining=0,
                cooldown_remaining=3,
                delay_remaining=0,
                last_activated_message_index=0,
            )
        )
        db_session.commit()
        mgr = TimedEffectsManager(db_session, sess)
        entry = _mk_entry("c1", delay=0)
        # cooldown 计数中 → 抑制
        assert mgr.can_activate(entry, message_index=1, chat_length=10) is False


class TestExcludeRecursionRoundSkip:
    """P3: RECURSION 轮跳过 exclude_recursion 条目（ST world-info.js:4758-4760）。"""

    def test_skipped_in_recursion_round(self, db_session):
        entries = [
            _mk_entry("x1", exclude_recursion=True),
            _mk_entry("x2", exclude_recursion=False, key="griffin", content="Griffin lore"),
        ]
        msgs = [{"role": "user", "content": "A dragon and a griffin appear."}]
        report: list[WorldbookEntryReport] = []
        activated = _scan_entries(
            entries,
            msgs,
            None,
            None,
            message_index=0,
            visited=set(),
            recursion_depth=1,
            report=report,
            recurse_buffer=["dragon"],
            chat_length=1,
        )
        ids = {e.id for e in activated}
        assert "x1" not in ids, "RECURSION 轮应跳过 exclude_recursion 条目"
        assert "x2" in ids, "普通条目在 RECURSION 轮正常激活"

    def test_active_in_initial_round(self, db_session):
        """INITIAL 轮（recursion_depth=0）不跳过 exclude_recursion 条目。"""
        entries = [_mk_entry("x1", exclude_recursion=True)]
        msgs = [{"role": "user", "content": "A dragon appears."}]
        report: list[WorldbookEntryReport] = []
        activated = _scan_entries(
            entries,
            msgs,
            None,
            None,
            message_index=0,
            visited=set(),
            recursion_depth=0,
            report=report,
            chat_length=1,
        )
        assert "x1" in {e.id for e in activated}

    def test_sticky_activation_exempts_from_recursion_skip(self, db_session, test_user):
        """sticky 激活期豁免（ST :4758 的 && !isSticky）。"""
        from app.models.worldbook import SessionWorldBookEntryState

        sess = "sess-exc-sticky"
        _mk_db_parents(db_session, test_user.id, sess, "s1")
        db_session.add(
            SessionWorldBookEntryState(
                session_id=sess,
                entry_id="s1",
                sticky_remaining=2,
                cooldown_remaining=0,
                delay_remaining=0,
                last_activated_message_index=0,
            )
        )
        db_session.commit()
        entries = [_mk_entry("s1", exclude_recursion=True, sticky=2)]
        msgs = [{"role": "user", "content": "A dragon appears."}]
        report: list[WorldbookEntryReport] = []
        activated = _scan_entries(
            entries,
            msgs,
            None,
            TimedEffectsManager(db_session, sess),
            message_index=0,
            visited=set(),
            recursion_depth=1,
            report=report,
            recurse_buffer=["dragon"],
            chat_length=1,
        )
        assert "s1" in {e.id for e in activated}, (
            "sticky 激活期的 exclude_recursion 条目在 RECURSION 轮仍应激活"
        )
