"""ST 群聊发言者解析函数契约测试。

覆盖 T5 混入的群聊重构代码（resolve_group_speaker_queue / _enabled_member_ids），
这些函数在分支上被 websocket.py 直接调用但无测试覆盖。

对齐 ST 1.18.0 group-chats.js generateGroupWrapper (1006-1031)：
- swipe/continue/impersonate/quiet 走单发言者路径（返回 None）
- LIST(1) 返回全部启用成员按名册顺序
- MANUAL(2) 无指定发言者返回空队列 []
- 其它策略返回 None（由装配内 _resolve_group_speaker 解析）
"""
from __future__ import annotations

import json
import os
import sys

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.models.character import Character
from app.models.group_chat import GroupChat
from app.services.roleplay_prompt_assembly import (
    _enabled_member_ids,
    resolve_group_speaker_queue,
)


def _make_group(db_session, user_id, members, strategy=0, disabled=None):
    """创建测试群聊。members 为 Character 列表，strategy 为 activation_strategy。

    GroupChat 模型字段：member_ids（全部成员）+ disabled_members（禁用成员）。
    disabled=None 表示全部启用；disabled=["c2"] 表示 c2 禁用。
    """
    group = GroupChat(
        id=f"group-{strategy}-{len(members)}",
        user_id=user_id,
        name=f"Test Group S{strategy}",
        member_ids=json.dumps([str(m.id) for m in members]),
        activation_strategy=strategy,
        disabled_members=json.dumps(disabled if disabled is not None else []),
    )
    db_session.add(group)
    db_session.flush()
    return group


def _make_char(db_session, user_id, name, char_id=None):
    char = Character(
        id=char_id or f"char-{name}",
        user_id=user_id,
        name=name,
        description=f"{name} desc",
        first_mes="hello",
    )
    db_session.add(char)
    db_session.flush()
    return char


class TestResolveGroupSpeakerQueue:
    """resolve_group_speaker_queue 契约测试（纯查询，无副作用）。"""

    def test_no_group_id_returns_none(self, db_session, test_user):
        """无 group_id（1:1 聊天）返回 None，走单发言者路径。"""
        result = resolve_group_speaker_queue(db_session, None, None, "normal")
        assert result is None

    def test_group_not_found_returns_none(self, db_session, test_user):
        """群聊不存在返回 None。"""
        result = resolve_group_speaker_queue(db_session, "nonexistent", None, "normal")
        assert result is None

    def test_swipe_type_returns_none(self, db_session, test_user):
        """swipe 类型返回 None（ST generateGroupWrapper 单发言者路径）。"""
        c1 = _make_char(db_session, test_user.id, "Alice")
        c2 = _make_char(db_session, test_user.id, "Bob")
        group = _make_group(db_session, test_user.id, [c1, c2], strategy=2)
        result = resolve_group_speaker_queue(db_session, group.id, None, "swipe")
        assert result is None

    def test_continue_type_returns_none(self, db_session, test_user):
        """continue 类型返回 None。"""
        c1 = _make_char(db_session, test_user.id, "Alice")
        group = _make_group(db_session, test_user.id, [c1], strategy=2)
        result = resolve_group_speaker_queue(db_session, group.id, None, "continue")
        assert result is None

    def test_impersonate_type_returns_none(self, db_session, test_user):
        """impersonate 类型返回 None。"""
        c1 = _make_char(db_session, test_user.id, "Alice")
        group = _make_group(db_session, test_user.id, [c1], strategy=2)
        result = resolve_group_speaker_queue(db_session, group.id, None, "impersonate")
        assert result is None

    def test_quiet_type_returns_none(self, db_session, test_user):
        """quiet 类型返回 None。"""
        c1 = _make_char(db_session, test_user.id, "Alice")
        group = _make_group(db_session, test_user.id, [c1], strategy=2)
        result = resolve_group_speaker_queue(db_session, group.id, None, "quiet")
        assert result is None

    def test_list_strategy_returns_all_enabled_members(self, db_session, test_user):
        """LIST(1) 策略返回全部启用成员按名册顺序。"""
        c1 = _make_char(db_session, test_user.id, "Alice", char_id="c1")
        c2 = _make_char(db_session, test_user.id, "Bob", char_id="c2")
        c3 = _make_char(db_session, test_user.id, "Carol", char_id="c3")
        group = _make_group(db_session, test_user.id, [c1, c2, c3], strategy=1)
        result = resolve_group_speaker_queue(db_session, group.id, None, "normal")
        assert result == ["c1", "c2", "c3"]

    def test_list_strategy_filters_disabled_members(self, db_session, test_user):
        """LIST(1) 策略只返回启用成员（排除 disabled）。"""
        c1 = _make_char(db_session, test_user.id, "Alice", char_id="c1")
        c2 = _make_char(db_session, test_user.id, "Bob", char_id="c2")
        c3 = _make_char(db_session, test_user.id, "Carol", char_id="c3")
        group = _make_group(
            db_session, test_user.id, [c1, c2, c3], strategy=1,
            disabled=["c2"],  # c2 disabled
        )
        result = resolve_group_speaker_queue(db_session, group.id, None, "normal")
        assert result == ["c1", "c3"]

    def test_manual_strategy_no_speaker_returns_empty_queue(self, db_session, test_user):
        """MANUAL(2) 无指定发言者返回空队列 []（仅落用户消息，跳过 AI 生成）。"""
        c1 = _make_char(db_session, test_user.id, "Alice")
        c2 = _make_char(db_session, test_user.id, "Bob")
        group = _make_group(db_session, test_user.id, [c1, c2], strategy=2)
        result = resolve_group_speaker_queue(db_session, group.id, None, "normal")
        assert result == []

    def test_manual_strategy_with_speaker_returns_none(self, db_session, test_user):
        """MANUAL(2) 有指定发言者返回 None（走单发言者路径）。"""
        c1 = _make_char(db_session, test_user.id, "Alice")
        c2 = _make_char(db_session, test_user.id, "Bob")
        group = _make_group(db_session, test_user.id, [c1, c2], strategy=2)
        result = resolve_group_speaker_queue(db_session, group.id, "c1", "normal")
        assert result is None

    def test_natural_strategy_returns_none(self, db_session, test_user):
        """NATURAL(0) 策略返回 None（由 _resolve_group_speaker 解析）。"""
        c1 = _make_char(db_session, test_user.id, "Alice")
        c2 = _make_char(db_session, test_user.id, "Bob")
        group = _make_group(db_session, test_user.id, [c1, c2], strategy=0)
        result = resolve_group_speaker_queue(db_session, group.id, None, "normal")
        assert result is None

    def test_pooled_strategy_returns_none(self, db_session, test_user):
        """POOLED(3) 策略返回 None。"""
        c1 = _make_char(db_session, test_user.id, "Alice")
        group = _make_group(db_session, test_user.id, [c1], strategy=3)
        result = resolve_group_speaker_queue(db_session, group.id, None, "normal")
        assert result is None

    def test_talkative_strategy_returns_none(self, db_session, test_user):
        """TALKATIVE(4) 策略返回 None。"""
        c1 = _make_char(db_session, test_user.id, "Alice")
        group = _make_group(db_session, test_user.id, [c1], strategy=4)
        result = resolve_group_speaker_queue(db_session, group.id, None, "normal")
        assert result is None

    def test_swipe_overrides_manual_empty_queue(self, db_session, test_user):
        """swipe 类型覆盖 MANUAL 空队列（即使 MANUAL 也须复用/随机出一位发言者）。"""
        c1 = _make_char(db_session, test_user.id, "Alice")
        group = _make_group(db_session, test_user.id, [c1], strategy=2)
        result = resolve_group_speaker_queue(db_session, group.id, None, "swipe")
        assert result is None  # 不是 []

    def test_case_insensitive_generation_type(self, db_session, test_user):
        """generation_type 大小写不敏感。"""
        c1 = _make_char(db_session, test_user.id, "Alice")
        group = _make_group(db_session, test_user.id, [c1], strategy=2)
        result = resolve_group_speaker_queue(db_session, group.id, None, "SWIPE")
        assert result is None


class TestEnabledMemberIds:
    """_enabled_member_ids 辅助函数测试。"""

    def test_all_enabled_by_default(self, db_session, test_user):
        """默认全部成员启用。"""
        c1 = _make_char(db_session, test_user.id, "Alice", char_id="c1")
        c2 = _make_char(db_session, test_user.id, "Bob", char_id="c2")
        group = _make_group(db_session, test_user.id, [c1, c2], strategy=1)
        result = _enabled_member_ids(group)
        assert result == ["c1", "c2"]

    def test_filters_disabled(self, db_session, test_user):
        """排除 disabled 成员。"""
        c1 = _make_char(db_session, test_user.id, "Alice", char_id="c1")
        c2 = _make_char(db_session, test_user.id, "Bob", char_id="c2")
        c3 = _make_char(db_session, test_user.id, "Carol", char_id="c3")
        group = _make_group(
            db_session, test_user.id, [c1, c2, c3], strategy=1,
            disabled=["c2"],
        )
        result = _enabled_member_ids(group)
        assert result == ["c1", "c3"]

    def test_empty_members(self, db_session, test_user):
        """空成员列表返回空列表。"""
        group = GroupChat(
            id="group-empty",
            user_id=test_user.id,
            name="Empty Group",
            member_ids="[]",
            activation_strategy=1,
            disabled_members="[]",
        )
        db_session.add(group)
        db_session.flush()
        result = _enabled_member_ids(group)
        assert result == []

    def test_preserves_order(self, db_session, test_user):
        """保持名册顺序。"""
        c3 = _make_char(db_session, test_user.id, "Carol", char_id="c3")
        c1 = _make_char(db_session, test_user.id, "Alice", char_id="c1")
        c2 = _make_char(db_session, test_user.id, "Bob", char_id="c2")
        # members 顺序：c3, c1, c2
        group = _make_group(db_session, test_user.id, [c3, c1, c2], strategy=1)
        result = _enabled_member_ids(group)
        assert result == ["c3", "c1", "c2"]
