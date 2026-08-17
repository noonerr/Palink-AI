"""群聊 swipe/continue/impersonate/quiet 专用选角直测 — Phase B 对齐验证。

对齐 ST 1.18.0 ``group-chats.js`` ``generateGroupWrapper`` (L1006-L1031)：
  - ``type === 'swipe' || type === 'continue'`` → ``activateSwipe({allowSystem: false})``
  - ``type === 'impersonate'``                   → ``activateImpersonate``
  - ``type === 'quiet'``                         → ``activateSwipe({allowSystem: true})``

覆盖：
1. ``_activate_swipe`` 复用最近角色发言者（allow_system=False 跳过 system/narrator）
2. ``_activate_swipe`` allow_system=True 不跳过 system 发言者
3. ``_activate_swipe`` 无历史 / 无匹配 → 回退随机
4. ``_activate_swipe`` 空成员 → None
5. ``_activate_impersonate`` 随机选 1 个；空成员 → None
6. ``resolve_group_speaker_queue`` 对 swipe/continue/impersonate/quiet 返回 None（单发言者路径）
7. ``_resolve_group_speaker`` 对 swipe 设置 current_speaker_id（复用）
8. ``_resolve_group_speaker`` 对 impersonate 设置 current_speaker_id（随机）
"""
import asyncio
import json
import os
import sys

_BACKEND_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_ROOT not in sys.path:
    sys.path.insert(0, _BACKEND_ROOT)

import pytest  # noqa: E402

from app.services import roleplay_prompt_assembly as rpa  # noqa: E402


# ───────────────────────────── Fake 对象 ─────────────────────────────

class FakeUser:
    def __init__(self, uid="u1"):
        self.id = uid


class FakeUserSetting:
    def __init__(self, mode="palink-native"):
        self.silly_tavern_mode = mode


class FakeChar:
    def __init__(self, cid, name, talkativeness="0.5"):
        self.id = cid
        self.name = name
        self.talkativeness = talkativeness
        self.description = ""
        self.personality = ""
        self.scenario = ""
        self.mes_example = ""


class FakeGroup:
    def __init__(self, gid="g1", strategy=0, member_ids=None, disabled=None,
                 allow_self=False, follower=None, user_id="u1", chat_metadata=None,
                 generation_mode_join_prefix=None, generation_mode_join_suffix=None):
        self.id = gid
        self.activation_strategy = strategy
        self.member_ids = member_ids if member_ids is not None else "[]"
        self.disabled_members = disabled if disabled is not None else "[]"
        self.allow_self_responses = allow_self
        self.follower_members = follower if follower is not None else "[]"
        self.user_id = user_id
        self.chat_metadata = chat_metadata
        self.generation_mode_join_prefix = generation_mode_join_prefix
        self.generation_mode_join_suffix = generation_mode_join_suffix


class FakeSession:
    def __init__(self, messages=None, group_id="g1", user_id="u1"):
        self.messages = messages if messages is not None else []
        self.group_id = group_id
        self.user_id = user_id
        self.updated_at = 1


class FakeQuery:
    def __init__(self, obj):
        self._obj = obj

    def filter(self, *a, **k):
        return self

    def order_by(self, *a, **k):
        return self

    def first(self):
        if isinstance(self._obj, list):
            return self._obj[0] if self._obj else None
        return self._obj

    def all(self):
        if isinstance(self._obj, list):
            return self._obj
        return [self._obj] if self._obj is not None else []


class FakeDB:
    def __init__(self, *, group=None, user_setting=None, members=None, session=None):
        self._group = group
        self._user_setting = user_setting
        self._members = members or []
        self._session = session

    def query(self, model, *a, **k):
        if model.__name__ == "GroupChat":
            return FakeQuery(self._group)
        if model.__name__ == "UserSetting":
            return FakeQuery(self._user_setting)
        if model.__name__ == "Character":
            return FakeQuery(self._members)
        if model.__name__ == "GroupChatSession":
            return FakeQuery(self._session)
        return FakeQuery(None)


def _msg(name, is_user=False, is_system=False):
    """构造群聊消息 dict。"""
    return {"name": name, "is_user": is_user, "is_system": is_system, "mes": "x"}


# ───────────────────── 1) _activate_swipe ─────────────────────

class TestActivateSwipe:
    """ST 1.18.0 activateSwipe (group-chats.js:1130-1173) 等价验证。"""

    def test_reuses_last_character_speaker(self):
        """swipe/continue: 复用最近一条角色发言者（跳过 user）。"""
        members = [FakeChar("m1", "Alice"), FakeChar("m2", "Bob")]
        msgs = [
            _msg("Alice", is_user=False),
            _msg("User", is_user=True),
            _msg("Bob", is_user=False),
        ]
        db = FakeDB(session=FakeSession(messages=json.dumps(msgs)))
        group = FakeGroup(member_ids='["m1","m2"]')
        result = rpa._activate_swipe(db, group, members, allow_system=False)
        assert result == "m2"  # Bob 是最近的非 user 发言者

    def test_skips_user_messages(self):
        """swipe: 跳过 user 消息，回溯到最近的角色发言。"""
        members = [FakeChar("m1", "Alice"), FakeChar("m2", "Bob")]
        msgs = [
            _msg("Alice", is_user=False),
            _msg("User", is_user=True),
            _msg("User", is_user=True),
        ]
        db = FakeDB(session=FakeSession(messages=json.dumps(msgs)))
        group = FakeGroup(member_ids='["m1","m2"]')
        result = rpa._activate_swipe(db, group, members, allow_system=False)
        assert result == "m1"  # Alice

    def test_allow_system_false_skips_system(self):
        """allow_system=False (swipe/continue): 跳过 system/narrator 消息。"""
        members = [FakeChar("m1", "Alice"), FakeChar("m2", "Narrator")]
        msgs = [
            _msg("Alice", is_user=False),
            _msg("Narrator", is_user=False, is_system=True),
        ]
        db = FakeDB(session=FakeSession(messages=json.dumps(msgs)))
        group = FakeGroup(member_ids='["m1","m2"]')
        result = rpa._activate_swipe(db, group, members, allow_system=False)
        assert result == "m1"  # Alice（跳过 Narrator 的 system 消息）

    def test_allow_system_true_includes_system(self):
        """allow_system=True (quiet): 不跳过 system 消息。"""
        members = [FakeChar("m1", "Alice"), FakeChar("m2", "Narrator")]
        msgs = [
            _msg("Alice", is_user=False),
            _msg("Narrator", is_user=False, is_system=True),
        ]
        db = FakeDB(session=FakeSession(messages=json.dumps(msgs)))
        group = FakeGroup(member_ids='["m1","m2"]')
        result = rpa._activate_swipe(db, group, members, allow_system=True)
        assert result == "m2"  # Narrator（system 消息不被跳过）

    def test_no_history_falls_back_to_random(self, monkeypatch):
        """无历史 → 回退 random.choice(members) (ST shuffle(members)[0])。"""
        members = [FakeChar("m1", "Alice"), FakeChar("m2", "Bob")]
        db = FakeDB(session=None)
        group = FakeGroup(member_ids='["m1","m2"]')
        monkeypatch.setattr(rpa.random, "choice", lambda seq: seq[1])
        result = rpa._activate_swipe(db, group, members, allow_system=False)
        assert result == "m2"  # 回退随机选 Bob

    def test_no_matching_name_falls_back_to_random(self, monkeypatch):
        """历史中无匹配成员名 → 回退随机。"""
        members = [FakeChar("m1", "Alice"), FakeChar("m2", "Bob")]
        msgs = [_msg("Charlie", is_user=False)]  # Charlie 不在成员中
        db = FakeDB(session=FakeSession(messages=json.dumps(msgs)))
        group = FakeGroup(member_ids='["m1","m2"]')
        monkeypatch.setattr(rpa.random, "choice", lambda seq: seq[0])
        result = rpa._activate_swipe(db, group, members, allow_system=False)
        assert result == "m1"

    def test_empty_members_returns_none(self):
        db = FakeDB()
        group = FakeGroup(member_ids="[]")
        assert rpa._activate_swipe(db, group, [], allow_system=False) is None

    def test_messages_as_list_not_string(self):
        """session.messages 为 list（非 JSON 字符串）时也能解析。"""
        members = [FakeChar("m1", "Alice")]
        msgs = [_msg("Alice", is_user=False)]
        db = FakeDB(session=FakeSession(messages=msgs))
        group = FakeGroup(member_ids='["m1"]')
        result = rpa._activate_swipe(db, group, members, allow_system=False)
        assert result == "m1"


# ───────────────────── 2) _activate_impersonate ─────────────────────

class TestActivateImpersonate:
    """ST 1.18.0 activateImpersonate (group-chats.js:1114-1121) 等价验证。"""

    def test_returns_a_member_id(self, monkeypatch):
        members = [FakeChar("m1", "Alice"), FakeChar("m2", "Bob")]
        monkeypatch.setattr(rpa.random, "choice", lambda seq: seq[0])
        assert rpa._activate_impersonate(members) == "m1"

    def test_returns_different_member(self, monkeypatch):
        members = [FakeChar("m1", "Alice"), FakeChar("m2", "Bob")]
        monkeypatch.setattr(rpa.random, "choice", lambda seq: seq[1])
        assert rpa._activate_impersonate(members) == "m2"

    def test_empty_members_returns_none(self):
        assert rpa._activate_impersonate([]) is None

    def test_single_member(self):
        members = [FakeChar("m1", "Alice")]
        assert rpa._activate_impersonate(members) == "m1"


# ───────────────────── 3) resolve_group_speaker_queue ─────────────────────

class TestResolveGroupSpeakerQueueGenType:
    """swipe/continue/impersonate/quiet 走单发言者路径（返回 None）。"""

    @pytest.mark.parametrize("gen_type", ["swipe", "continue", "impersonate", "quiet"])
    def test_gen_type_returns_none(self, gen_type):
        """ST generateGroupWrapper: 这些类型优先于 activation_strategy，走单发言者路径。"""
        members = [FakeChar("m1", "Alice"), FakeChar("m2", "Bob")]
        db = FakeDB(group=FakeGroup(strategy=1, member_ids='["m1","m2"]'),
                    members=members)  # strategy=1 (LIST) 正常会返回 list
        result = rpa.resolve_group_speaker_queue(
            db, group_id="g1", current_speaker_id=None, generation_type=gen_type,
        )
        assert result is None  # 即使 LIST 策略，swipe 等也走单发言者路径

    def test_normal_gen_type_respects_strategy(self):
        """normal/None 走原策略（LIST 返回 list）。"""
        members = [FakeChar("m1", "Alice"), FakeChar("m2", "Bob")]
        db = FakeDB(group=FakeGroup(strategy=1, member_ids='["m1","m2"]'),
                    members=members)
        result = rpa.resolve_group_speaker_queue(
            db, group_id="g1", current_speaker_id=None, generation_type=None,
        )
        assert result is not None
        assert isinstance(result, list)

    def test_manual_with_swipe_does_not_return_empty(self):
        """MANUAL(2) + swipe: 不返回空队列（swipe 必须出一位发言者）。"""
        members = [FakeChar("m1", "Alice"), FakeChar("m2", "Bob")]
        db = FakeDB(group=FakeGroup(strategy=2, member_ids='["m1","m2"]'),
                    members=members)
        result = rpa.resolve_group_speaker_queue(
            db, group_id="g1", current_speaker_id=None, generation_type="swipe",
        )
        assert result is None  # 走单发言者路径，不返回 []


# ───────────────────── 4) _resolve_group_speaker 集成 ─────────────────────

class TestResolveGroupSpeakerGenType:
    """_resolve_group_speaker 对 swipe/impersonate 设置 current_speaker_id。"""

    def _make_req(self, db, gen_type, current_speaker_id=None):
        """构造最小 PromptAssemblyRequest-like 对象。"""
        from types import SimpleNamespace
        return SimpleNamespace(
            db=db,
            group_id="g1",
            user=FakeUser(),
            current_speaker_id=current_speaker_id,
            generation_type=gen_type,
            allow_self_responses=False,
        )

    def test_swipe_reuses_last_speaker(self):
        """swipe: _resolve_group_speaker 设置 current_speaker_id 为最近发言者。"""
        members = [FakeChar("m1", "Alice"), FakeChar("m2", "Bob")]
        msgs = [_msg("Bob", is_user=False), _msg("User", is_user=True)]
        db = FakeDB(
            group=FakeGroup(strategy=0, member_ids='["m1","m2"]'),
            user_setting=FakeUserSetting(),
            members=members,
            session=FakeSession(messages=json.dumps(msgs)),
        )
        req = self._make_req(db, "swipe")
        asyncio.run(rpa._resolve_group_speaker(req))
        assert req.current_speaker_id == "m2"  # Bob

    def test_impersonate_picks_random(self, monkeypatch):
        """impersonate: _resolve_group_speaker 随机选一位。"""
        members = [FakeChar("m1", "Alice"), FakeChar("m2", "Bob")]
        db = FakeDB(
            group=FakeGroup(strategy=0, member_ids='["m1","m2"]'),
            user_setting=FakeUserSetting(),
            members=members,
            session=None,
        )
        monkeypatch.setattr(rpa.random, "choice", lambda seq: seq[1])
        req = self._make_req(db, "impersonate")
        asyncio.run(rpa._resolve_group_speaker(req))
        assert req.current_speaker_id == "m2"  # Bob

    def test_continue_reuses_last_speaker(self):
        """continue: 与 swipe 相同，复用最近发言者。"""
        members = [FakeChar("m1", "Alice"), FakeChar("m2", "Bob")]
        msgs = [_msg("Alice", is_user=False)]
        db = FakeDB(
            group=FakeGroup(strategy=0, member_ids='["m1","m2"]'),
            user_setting=FakeUserSetting(),
            members=members,
            session=FakeSession(messages=json.dumps(msgs)),
        )
        req = self._make_req(db, "continue")
        asyncio.run(rpa._resolve_group_speaker(req))
        assert req.current_speaker_id == "m1"  # Alice

    def test_existing_speaker_id_not_overridden(self):
        """已有 current_speaker_id 时不被 swipe 覆盖。"""
        members = [FakeChar("m1", "Alice"), FakeChar("m2", "Bob")]
        msgs = [_msg("Bob", is_user=False)]
        db = FakeDB(
            group=FakeGroup(strategy=0, member_ids='["m1","m2"]'),
            user_setting=FakeUserSetting(),
            members=members,
            session=FakeSession(messages=json.dumps(msgs)),
        )
        req = self._make_req(db, "swipe", current_speaker_id="m1")
        asyncio.run(rpa._resolve_group_speaker(req))
        assert req.current_speaker_id == "m1"  # 不覆盖已有值

    def test_quiet_uses_allow_system_true(self):
        """quiet: activateSwipe(allow_system=True)，复用含 system 的发言者。"""
        members = [FakeChar("m1", "Alice"), FakeChar("m2", "Narrator")]
        msgs = [
            _msg("Alice", is_user=False),
            _msg("Narrator", is_user=False, is_system=True),
        ]
        db = FakeDB(
            group=FakeGroup(strategy=0, member_ids='["m1","m2"]'),
            user_setting=FakeUserSetting(),
            members=members,
            session=FakeSession(messages=json.dumps(msgs)),
        )
        req = self._make_req(db, "quiet")
        asyncio.run(rpa._resolve_group_speaker(req))
        assert req.current_speaker_id == "m2"  # Narrator（quiet 允许 system）
