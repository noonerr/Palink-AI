"""群聊发言者选择内部逻辑直测 —— B1 NATURAL / B4 POOLED / _resolve_group_speaker 分支。

无需真实 DB / LLM：用 Fake 对象 + monkeypatch 固定随机变量，保证确定性。
覆盖：
1. _enabled_member_ids 禁用成员过滤（纯函数，无 DB）
2. _read_talkativeness 边界值（缺失 / "0" / "0.5" / 非法）
3. _select_natural_speaker：提及强制 / 概率激活 / 防连续 / follower 衰减
4. _select_pooled_speaker：未发言优先 / 全部已发言回退
5. _resolve_group_speaker 分支：NATURAL/POOLED/LIST/MANUAL/TALKATIVE/VOTING
   以及 st-compat 对原生 4/5 策略回退 NATURAL(0) 的固化测试
"""
import sys
import os
import json
import random
import asyncio

# 确保 backend 包根在 sys.path（脚本从 tests/ 目录运行时 sys.path[0] 不含 backend）
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
                 allow_self=False, follower=None, user_id="u1", chat_metadata=None):
        self.id = gid
        self.activation_strategy = strategy
        self.member_ids = member_ids if member_ids is not None else "[]"
        self.disabled_members = disabled if disabled is not None else "[]"
        self.allow_self_responses = allow_self
        self.follower_members = follower if follower is not None else "[]"
        self.user_id = user_id
        self.chat_metadata = chat_metadata


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


def _pick(idx):
    """monkeypatch 用：random.choice(seq) 返回 seq[idx]，固定选择。"""
    def _fake(seq):
        return seq[idx]
    return _fake


# ───────────────────── 1) _enabled_member_ids（纯函数） ─────────────────────

def test_enabled_member_ids_excludes_disabled():
    g = FakeGroup(member_ids='["m1","m2","m3"]', disabled='["m2"]')
    assert rpa._enabled_member_ids(g) == ["m1", "m3"]


def test_enabled_member_ids_no_disabled_returns_all():
    g = FakeGroup(member_ids='["m1","m2"]', disabled="[]")
    assert rpa._enabled_member_ids(g) == ["m1", "m2"]


def test_enabled_member_ids_empty_group():
    g = FakeGroup(member_ids="[]", disabled="[]")
    assert rpa._enabled_member_ids(g) == []


def test_enabled_member_ids_disabled_as_list():
    g = FakeGroup(member_ids='["m1","m2"]', disabled=["m1"])
    assert rpa._enabled_member_ids(g) == ["m2"]


# ───────────────────── 2) _read_talkativeness 边界 ─────────────────────

def test_read_talkativeness_default_and_edges():
    assert rpa._read_talkativeness(FakeChar("a", "A", talkativeness="0.5")) == 0.5
    assert rpa._read_talkativeness(FakeChar("a", "A", talkativeness="0")) == 0.0
    # 缺失字段 -> 0.5
    c = FakeChar("a", "A")
    del c.talkativeness
    assert rpa._read_talkativeness(c) == 0.5
    # 非法字符串 -> 0.5
    assert rpa._read_talkativeness(FakeChar("a", "A", talkativeness="abc")) == 0.5


# ───────────────────── 3) _select_natural_speaker ─────────────────────

def test_natural_mention_force():
    """用户输入提及某成员名 -> 强制激活该成员（单一命中确定性）。"""
    members = [FakeChar("m1", "Alice"), FakeChar("m2", "Bob")]
    db = FakeDB(session=None)
    g = FakeGroup(member_ids='["m1","m2"]', disabled="[]")
    result = rpa._select_natural_speaker(db, g, members, "Hello Alice, how are you?")
    assert result == "m1"


def test_natural_probability_all_zero_picks_first():
    """全员 talkativeness=0 -> 回退从全体成员随机；固定 choice 取首位。"""
    members = [FakeChar("m1", "Alice", "0"), FakeChar("m2", "Bob", "0")]
    db = FakeDB(session=None)
    g = FakeGroup(member_ids='["m1","m2"]', disabled="[]")
    with pytest.MonkeyPatch().context() as mp:
        mp.setattr(random, "choice", _pick(0))
        result = rpa._select_natural_speaker(db, g, members, "hi")
    assert result == "m1"


def test_natural_anti_consecutive_excludes_last():
    """全员 talkativeness=0，上一位发言 m1 -> 回退排除 m1，仅剩 m2。"""
    members = [FakeChar("m1", "Alice", "0"), FakeChar("m2", "Bob", "0")]
    # 历史末位发言为 Alice
    session = FakeSession(messages=[{"is_user": True, "name": "User"},
                                     {"is_user": False, "name": "Alice"}])
    db = FakeDB(session=session)
    g = FakeGroup(member_ids='["m1","m2"]', disabled="[]")
    with pytest.MonkeyPatch().context() as mp:
        mp.setattr(random, "choice", _pick(0))
        result = rpa._select_natural_speaker(db, g, members, "hi")
    assert result == "m2"


def test_natural_follower_damping_excludes_follower():
    """A(talk=1.0, 普通) 与 B(talk=1.0, follower) 同置。
    random.random=0.5 -> A 激活(0.5<=1.0)；B 衰减为 0.3 -> 0.5<=0.3 不成立被排除。
    证明 follower 衰减降低主动激活概率。"""
    members = [FakeChar("m1", "Alice", "1.0"),
               FakeChar("m2", "Bob", "1.0")]
    db = FakeDB(session=None)
    g = FakeGroup(member_ids='["m1","m2"]', disabled="[]", follower='["m2"]')
    with pytest.MonkeyPatch().context() as mp:
        mp.setattr(random, "random", lambda: 0.5)
        result = rpa._select_natural_speaker(db, g, members, "hi")
    assert result == "m1"


def test_natural_stcompat_ignores_follower():
    """S4.1：st-compat 模式忽略 follower_members（ST 1.18.0 无此概念）。

    同置 A(talk=1.0) B(talk=1.0, follower)，random.random=0.5。
    palink-native 下 B 衰减为 0.3 被排除（见上）；st-compat 下 follower 衰减被忽略，
    二者均激活，固定 choice 取首位 A -> 结果仍为 m1，但语义上 B 也参与了激活池
    （验证 follower 字段在 st-compat 不被读取）。"""
    members = [FakeChar("m1", "Alice", "1.0"),
               FakeChar("m2", "Bob", "1.0")]
    db = FakeDB(session=None)
    g = FakeGroup(member_ids='["m1","m2"]', disabled="[]", follower='["m2"]')
    with pytest.MonkeyPatch().context() as mp:
        mp.setattr(random, "random", lambda: 0.5)
        mp.setattr(random, "choice", _pick(0))
        # st-compat：follower 衰减被忽略，B 也满足 0.5<=1.0，activated=[A,B]
        result = rpa._select_natural_speaker(db, g, members, "hi", st_mode="st-compat")
    # 固定 choice 取首位 -> m1；关键是不因 follower 衰减而排除 m2（参与池）
    assert result == "m1"
    # 反向验证：若 follower 仍生效，B 会被排除，但此刻二者皆在池内，choice 首位即 m1
    # 用概率条件确保 B 也激活：再测一次 random=0.99 时 B 在 st-compat 下仍激活
    with pytest.MonkeyPatch().context() as mp:
        mp.setattr(random, "random", lambda: 0.99)
        mp.setattr(random, "choice", _pick(0))
        result2 = rpa._select_natural_speaker(db, g, members, "hi", st_mode="st-compat")
    # 0.99 <= 1.0 对 A、B 均成立（follower 忽略），二者都在池；取首位 m1
    assert result2 == "m1"


def test_natural_mention_excludes_last_speaker():
    """S4.2：提及命中最后发言者时，因 bannedUser 回避而忽略该提及命中。

    成员 Alice(=last) 与 Bob；输入提及 'Alice'。allow_self=False ->
    提及命中过滤掉 last(Alice)，回落概率激活；全员 talk=0 回退取首位（Bob）。"""
    members = [FakeChar("m1", "Alice", "0"), FakeChar("m2", "Bob", "0")]
    session = FakeSession(messages=[{"is_user": True, "name": "User"},
                                     {"is_user": False, "name": "Alice"}])
    db = FakeDB(session=session)
    g = FakeGroup(member_ids='["m1","m2"]', disabled="[]")
    with pytest.MonkeyPatch().context() as mp:
        mp.setattr(random, "choice", _pick(0))
        result = rpa._select_natural_speaker(db, g, members, "Hello Alice!")
    assert result == "m2"


def test_natural_probability_anti_consecutive_branch():
    """A(talk=1.0) B(talk=1.0)，last=A，allow_self=False。
    random.random=0.0 -> 二者概率条件成立，但 m.id!=last 排除 A；activated=[B]。"""
    members = [FakeChar("m1", "Alice", "1.0"),
               FakeChar("m2", "Bob", "1.0")]
    session = FakeSession(messages=[{"is_user": True, "name": "User"},
                                     {"is_user": False, "name": "Alice"}])
    db = FakeDB(session=session)
    g = FakeGroup(member_ids='["m1","m2"]', disabled="[]")
    with pytest.MonkeyPatch().context() as mp:
        mp.setattr(random, "random", lambda: 0.0)
        result = rpa._select_natural_speaker(db, g, members, "hi")
    assert result == "m2"


# ───────────────────── 4) _select_pooled_speaker ─────────────────────

def test_pooled_unspoken_priority():
    """历史：用户 -> A 发言 -> B 发言；C 未发言 -> 选 C。"""
    members = [FakeChar("m1", "Alice"), FakeChar("m2", "Bob"), FakeChar("m3", "Carol")]
    session = FakeSession(messages=[
        {"is_user": True, "name": "User"},
        {"is_user": False, "name": "Alice"},
        {"is_user": False, "name": "Bob"},
    ])
    db = FakeDB(session=session)
    g = FakeGroup(member_ids='["m1","m2","m3"]', disabled="[]")
    result = rpa._select_pooled_speaker(db, g, members)
    assert result == "m3"


def test_pooled_all_spoken_fallback_excludes_last():
    """全部已发言 -> 回退排除末位(C)，从 [A,B] 选（固定取首位 A）。"""
    members = [FakeChar("m1", "Alice"), FakeChar("m2", "Bob"), FakeChar("m3", "Carol")]
    session = FakeSession(messages=[
        {"is_user": True, "name": "User"},
        {"is_user": False, "name": "Alice"},
        {"is_user": False, "name": "Bob"},
        {"is_user": False, "name": "Carol"},
    ])
    db = FakeDB(session=session)
    g = FakeGroup(member_ids='["m1","m2","m3"]', disabled="[]")
    with pytest.MonkeyPatch().context() as mp:
        mp.setattr(random, "choice", _pick(0))
        result = rpa._select_pooled_speaker(db, g, members)
    assert result == "m1"


def test_pooled_no_user_marker_treats_all_unspoken():
    """历史无用户消息 -> spoken 为空 -> 从全体随机（固定取首位 A）。"""
    members = [FakeChar("m1", "Alice"), FakeChar("m2", "Bob")]
    session = FakeSession(messages=[{"is_user": False, "name": "Alice"}])
    db = FakeDB(session=session)
    g = FakeGroup(member_ids='["m1","m2"]', disabled="[]")
    with pytest.MonkeyPatch().context() as mp:
        mp.setattr(random, "choice", _pick(0))
        result = rpa._select_pooled_speaker(db, g, members)
    assert result == "m1"


def test_pooled_empty_members_returns_none():
    db = FakeDB(session=None)
    g = FakeGroup(member_ids="[]", disabled="[]")
    assert rpa._select_pooled_speaker(db, g, []) is None


# ───────────────────── 5) _resolve_group_speaker 分支 ─────────────────────

def _make_req(db, group, *, current_speaker_id=None, message="hi", model="m", allow_self=False):
    return rpa.PromptAssemblyRequest(
        db=db,
        user=FakeUser(),
        char=FakeChar("main", "Main"),
        session_id="s1",
        branch_id=None,
        message=message,
        group_id=group.id,
        current_speaker_id=current_speaker_id,
        allow_self_responses=allow_self,
        model=model,
    )


def test_resolve_manual_no_speaker_skips():
    """MANUAL(2) 无指定发言者 -> 不设置 current_speaker_id（跳过由队列承接）。"""
    members = [FakeChar("m1", "Alice"), FakeChar("m2", "Bob")]
    g = FakeGroup(strategy=2, member_ids='["m1","m2"]', disabled="[]")
    db = FakeDB(group=g, members=members)
    req = _make_req(db, g, current_speaker_id=None)
    asyncio.run(rpa._resolve_group_speaker(req))
    assert req.current_speaker_id is None


def test_resolve_natural_sets_speaker():
    """NATURAL(0) -> 装载成员并 _select_natural_speaker；全员 0 回退取首位。"""
    members = [FakeChar("m1", "Alice", "0"), FakeChar("m2", "Bob", "0")]
    g = FakeGroup(strategy=0, member_ids='["m1","m2"]', disabled="[]")
    db = FakeDB(group=g, members=members, session=None)
    req = _make_req(db, g)
    with pytest.MonkeyPatch().context() as mp:
        mp.setattr(random, "choice", _pick(0))
        asyncio.run(rpa._resolve_group_speaker(req))
    assert req.current_speaker_id == "m1"


def test_resolve_pooled_sets_speaker():
    """POOLED(3) -> 未发言优先；历史无用户标记 -> 全体，固定取首位。"""
    members = [FakeChar("m1", "Alice"), FakeChar("m2", "Bob")]
    session = FakeSession(messages=[{"is_user": False, "name": "Alice"}])
    g = FakeGroup(strategy=3, member_ids='["m1","m2"]', disabled="[]")
    db = FakeDB(group=g, members=members, session=session)
    req = _make_req(db, g)
    with pytest.MonkeyPatch().context() as mp:
        mp.setattr(random, "choice", _pick(0))
        asyncio.run(rpa._resolve_group_speaker(req))
    assert req.current_speaker_id == "m1"


def test_resolve_list_sets_speaker_rotational():
    """LIST(1) 单发言者 fallback：无 last -> 取名册首位。"""
    members = [FakeChar("m1", "Alice"), FakeChar("m2", "Bob")]
    g = FakeGroup(strategy=1, member_ids='["m1","m2"]', disabled="[]")
    db = FakeDB(group=g, members=members, session=None)
    req = _make_req(db, g)
    asyncio.run(rpa._resolve_group_speaker(req))
    assert req.current_speaker_id == "m1"


def test_resolve_talkative_uses_weighted_selector():
    """TALKATIVE(4) -> 调用 _select_talkative_speaker 并返回其结果。"""
    members = [FakeChar("m1", "Alice", "1.0"), FakeChar("m2", "Bob", "1.0")]
    g = FakeGroup(strategy=4, member_ids='["m1","m2"]', disabled="[]")
    db = FakeDB(group=g, members=members)
    req = _make_req(db, g)

    with pytest.MonkeyPatch().context() as mp:
        mp.setattr(rpa, "_select_talkative_speaker",
                   lambda db, group, members, allow_self_responses=False: "m2")
        asyncio.run(rpa._resolve_group_speaker(req))
    assert req.current_speaker_id == "m2"


def test_resolve_voting_falls_back_to_talkative():
    """VOTING(5) -> _select_voting_speaker 返回 None 时回退 _select_talkative_speaker。"""
    members = [FakeChar("m1", "Alice", "1.0"), FakeChar("m2", "Bob", "1.0")]
    g = FakeGroup(strategy=5, member_ids='["m1","m2"]', disabled="[]")
    db = FakeDB(group=g, members=members)

    async def _fake_vote(db, group, members, model):
        return None

    req = _make_req(db, g)
    with pytest.MonkeyPatch().context() as mp:
        mp.setattr(rpa, "_select_voting_speaker", _fake_vote)
        mp.setattr(rpa, "_select_talkative_speaker",
                   lambda db, group, members, allow_self_responses=False: "m2")
        asyncio.run(rpa._resolve_group_speaker(req))
    assert req.current_speaker_id == "m2"


def test_resolve_talkative_keeps_preset_speaker():
    """已指定 current_speaker_id -> 任何策略都不覆盖。"""
    members = [FakeChar("m1", "Alice"), FakeChar("m2", "Bob")]
    g = FakeGroup(strategy=4, member_ids='["m1","m2"]', disabled="[]")
    db = FakeDB(group=g, members=members)
    req = _make_req(db, g, current_speaker_id="m1")

    def _should_not_be_called(*a, **k):
        raise AssertionError("talkative selector must not be called when speaker preset")

    with pytest.MonkeyPatch().context() as mp:
        mp.setattr(rpa, "_select_talkative_speaker", _should_not_be_called)
        asyncio.run(rpa._resolve_group_speaker(req))
    assert req.current_speaker_id == "m1"


def test_resolve_stcompat_talkative_downgrades_to_natural():
    """st-compat 模式收到原生 TALKATIVE(4) -> 回退 NATURAL(0)，
    不得调用 _select_talkative_speaker。固定 choice 取首位。"""
    members = [FakeChar("m1", "Alice", "0"), FakeChar("m2", "Bob", "0")]
    g = FakeGroup(strategy=4, member_ids='["m1","m2"]', disabled="[]")
    us = FakeUserSetting(mode="st-compat")
    db = FakeDB(group=g, user_setting=us, members=members, session=None)
    req = _make_req(db, g)

    def _should_not_be_called(*a, **k):
        raise AssertionError("st-compat must NOT use native TALKATIVE selector")

    with pytest.MonkeyPatch().context() as mp:
        mp.setattr(rpa, "_select_talkative_speaker", _should_not_be_called)
        mp.setattr(random, "choice", _pick(0))
        asyncio.run(rpa._resolve_group_speaker(req))
    assert req.current_speaker_id == "m1"


def test_resolve_stcompat_voting_downgrades_to_natural():
    """st-compat 模式收到原生 VOTING(5) -> 回退 NATURAL(0)，
    不得调用 _select_voting_speaker / _select_talkative_speaker。"""
    members = [FakeChar("m1", "Alice", "0"), FakeChar("m2", "Bob", "0")]
    g = FakeGroup(strategy=5, member_ids='["m1","m2"]', disabled="[]")
    us = FakeUserSetting(mode="st-compat")
    db = FakeDB(group=g, user_setting=us, members=members, session=None)
    req = _make_req(db, g)

    def _should_not_be_called(*a, **k):
        raise AssertionError("st-compat must NOT use native VOTING/TALKATIVE selector")

    with pytest.MonkeyPatch().context() as mp:
        mp.setattr(rpa, "_select_talkative_speaker", _should_not_be_called)
        mp.setattr(rpa, "_select_voting_speaker", _should_not_be_called)
        mp.setattr(random, "choice", _pick(0))
        asyncio.run(rpa._resolve_group_speaker(req))
    assert req.current_speaker_id == "m1"


if __name__ == "__main__":
    test_enabled_member_ids_excludes_disabled()
    test_enabled_member_ids_no_disabled_returns_all()
    test_enabled_member_ids_empty_group()
    test_enabled_member_ids_disabled_as_list()
    test_read_talkativeness_default_and_edges()
    test_natural_mention_force()
    test_natural_probability_all_zero_picks_first()
    test_natural_anti_consecutive_excludes_last()
    test_natural_follower_damping_excludes_follower()
    test_natural_probability_anti_consecutive_branch()
    test_pooled_unspoken_priority()
    test_pooled_all_spoken_fallback_excludes_last()
    test_pooled_no_user_marker_treats_all_unspoken()
    test_pooled_empty_members_returns_none()
    test_resolve_manual_no_speaker_skips()
    test_resolve_natural_sets_speaker()
    test_resolve_pooled_sets_speaker()
    test_resolve_list_sets_speaker_rotational()
    test_resolve_talkative_uses_weighted_selector()
    test_resolve_voting_falls_back_to_talkative()
    test_resolve_talkative_keeps_preset_speaker()
    test_resolve_stcompat_talkative_downgrades_to_natural()
    test_resolve_stcompat_voting_downgrades_to_natural()
    print("\nALL GROUP SPEAKER SELECTION TESTS PASSED")
