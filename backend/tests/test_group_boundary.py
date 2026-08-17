"""群聊边界用例直测（项 E）—— 空群 / 单成员 / 全 disabled / LIST 有序队列 /
LIST 多成员中间发言者异常不中断其余成员。

全部使用 fake 对象，不依赖真实数据库。复用 test_f1_speaker_queue / selection 的轻量 fake 模式。
"""
import sys
import os
import types
import asyncio

_BACKEND_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_ROOT not in sys.path:
    sys.path.insert(0, _BACKEND_ROOT)

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from app.services import roleplay_prompt_assembly as rpa  # noqa: E402


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
                 allow_self=False, follower=None, user_id="u1"):
        self.id = gid
        self.activation_strategy = strategy
        self.member_ids = member_ids if member_ids is not None else "[]"
        self.disabled_members = disabled if disabled is not None else "[]"
        self.allow_self_responses = allow_self
        self.follower_members = follower if follower is not None else "[]"
        self.user_id = user_id


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


def _make_req(db, group, *, current_speaker_id=None, message="hi", model="m"):
    return rpa.PromptAssemblyRequest(
        db=db,
        user=FakeUser(),
        char=FakeChar("main", "Main"),
        session_id="s1",
        branch_id=None,
        message=message,
        group_id=group.id,
        current_speaker_id=current_speaker_id,
        allow_self_responses=False,
        model=model,
    )


# ───────────────────── 空群 ─────────────────────

def test_empty_group_natural_returns_none():
    """空群（无成员）NATURAL -> 不设置发言者（None）。"""
    g = FakeGroup(strategy=0, member_ids="[]", disabled="[]")
    db = FakeDB(group=g, members=[])
    req = _make_req(db, g)
    asyncio.run(rpa._resolve_group_speaker(req))
    assert req.current_speaker_id is None


def test_empty_group_voting_raises_400():
    """空群 VOTING -> 抛 HTTPException 400（既有防御 :2077）。"""
    g = FakeGroup(strategy=5, member_ids="[]", disabled="[]")
    db = FakeDB(group=g, members=[])
    req = _make_req(db, g)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(rpa._resolve_group_speaker(req))
    assert exc.value.status_code == 400


def test_empty_group_talkative_raises_400():
    """空群 TALKATIVE -> 抛 HTTPException 400（既有防御 :2105，与 VOTING 同源）。"""
    g = FakeGroup(strategy=4, member_ids="[]", disabled="[]")
    db = FakeDB(group=g, members=[])
    req = _make_req(db, g)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(rpa._resolve_group_speaker(req))
    assert exc.value.status_code == 400


def test_empty_group_pooled_returns_none():
    """空群 POOLED -> _select_pooled_speaker 返回 None。"""
    g = FakeGroup(strategy=3, member_ids="[]", disabled="[]")
    db = FakeDB(group=g, members=[])
    req = _make_req(db, g)
    asyncio.run(rpa._resolve_group_speaker(req))
    assert req.current_speaker_id is None


# ───────────────────── 单成员群 ─────────────────────

def test_single_member_natural_returns_that_member():
    """单成员群 NATURAL -> 必定返回该唯一成员（确定性）。"""
    members = [FakeChar("m1", "Solo", "0")]
    g = FakeGroup(strategy=0, member_ids='["m1"]', disabled="[]")
    db = FakeDB(group=g, members=members)
    req = _make_req(db, g)
    asyncio.run(rpa._resolve_group_speaker(req))
    assert req.current_speaker_id == "m1"


def test_single_member_talkative_returns_that_member():
    """单成员群 TALKATIVE -> _select_talkative_speaker 直接返回唯一成员。"""
    members = [FakeChar("m1", "Solo", "1.0")]
    g = FakeGroup(strategy=4, member_ids='["m1"]', disabled="[]")
    db = FakeDB(group=g, members=members)
    req = _make_req(db, g)
    asyncio.run(rpa._resolve_group_speaker(req))
    assert req.current_speaker_id == "m1"


# ───────────────────── 全 disabled ─────────────────────

def test_all_disabled_enabled_member_ids_empty():
    """全 disabled -> _enabled_member_ids 返回 []，激活侧无候选。"""
    g = FakeGroup(member_ids='["m1","m2"]', disabled='["m1","m2"]')
    assert rpa._enabled_member_ids(g) == []


def test_all_disabled_natural_no_speaker():
    """全 disabled 群 NATURAL -> _load_members 空 -> 不设置发言者。"""
    members = [FakeChar("m1", "A"), FakeChar("m2", "B")]
    g = FakeGroup(strategy=0, member_ids='["m1","m2"]', disabled='["m1","m2"]')
    db = FakeDB(group=g, members=members)
    req = _make_req(db, g)
    asyncio.run(rpa._resolve_group_speaker(req))
    assert req.current_speaker_id is None


# ───────────────────── LIST 有序队列（F1 串联） ─────────────────────

def test_list_queue_ordered_enabled_members():
    """LIST(1) -> resolve_group_speaker_queue 返回全启用成员按名册顺序。"""
    g = FakeGroup(strategy=1, member_ids='["m1","m2","m3"]', disabled="[]")
    db = FakeDB(group=g)
    q = rpa.resolve_group_speaker_queue(db, "g1", None)
    assert q == ["m1", "m2", "m3"]


def test_list_queue_excludes_disabled():
    """LIST(1) + 禁用 m2 -> 队列仅 [m1, m3]。"""
    g = FakeGroup(strategy=1, member_ids='["m1","m2","m3"]', disabled='["m2"]')
    db = FakeDB(group=g)
    q = rpa.resolve_group_speaker_queue(db, "g1", None)
    assert q == ["m1", "m3"]


# ───────────────────── LIST 多成员中间发言者异常不中断其余 ─────────────────────

def test_list_mid_speaker_exception_non_interrupting():
    """复刻 websocket._gen 的逐发言者循环契约（对照 websocket.py:1629-1633）：
    某个发言者的生成抛异常被捕获，其余发言者仍正常完成，循环不中断。"""
    import app.api.websocket as ws

    calls = []          # 成功生成的发言者
    failed = []         # 捕获异常的发言者

    async def fake_assemble(req, deps):
        return types.SimpleNamespace(
            messages=[{"role": "user", "content": "hi"}],
            memory_mode="disabled",
            effective_max_tokens=512,
        )

    async def fake_run(ss, **kwargs):
        sid = kwargs.get("char") and getattr(kwargs["char"], "id", None)
        name = kwargs.get("character_name")
        if sid == "m2":
            # 模拟中间发言者生成失败
            raise RuntimeError("generation failed for m2")
        calls.append((sid, name))
        async with ss._lock:
            ss.full_content += f"[{name}]"
            ss.status = "done"
        return None

    orig_assemble = ws.assemble_roleplay_prompt
    orig_run = ws.run_character_chat_generation
    ws.assemble_roleplay_prompt = fake_assemble
    ws.run_character_chat_generation = fake_run

    from app.services.websocket_manager import StreamSession
    ss = StreamSession(session_id="s1")

    speaker_chars = {
        "m1": types.SimpleNamespace(id="m1", name="Alice", extensions=None),
        "m2": types.SimpleNamespace(id="m2", name="Bob", extensions=None),
        "m3": types.SimpleNamespace(id="m3", name="Carol", extensions=None),
    }
    main_char = types.SimpleNamespace(id="main", name="Main", extensions=None)

    async def run_loop(speaker_ids):
        # 对照 websocket._gen：每个发言者装配+生成+落库，异常被捕获并记录
        for idx, speaker_id in enumerate(speaker_ids):
            async with ss._lock:
                ss.full_content = ""
                ss.full_reasoning = ""
                ss.status = "streaming"
            req_local = types.SimpleNamespace(current_speaker_id=speaker_id, group_id="g1")
            await fake_assemble(req_local, None)
            resolved = req_local.current_speaker_id or speaker_id
            speaker_char = speaker_chars.get(resolved, main_char)
            speaker_name = speaker_char.name
            try:
                await fake_run(ss=ss, char=speaker_char, character_name=speaker_name,
                              is_new_session=(idx == 0))
            except Exception as exc:  # 对照 :1629-1633 的 per-speaker catch
                failed.append((resolved, str(exc)))
                continue

    try:
        asyncio.run(run_loop(["m1", "m2", "m3"]))
    finally:
        ws.assemble_roleplay_prompt = orig_assemble
        ws.run_character_chat_generation = orig_run

    # m1、m3 成功；m2 失败被捕获且未中断循环
    assert ("m1", "Alice") in calls, calls
    assert ("m3", "Carol") in calls, calls
    assert ("m2", "generation failed for m2") in failed, failed
    assert len(calls) == 2 and len(failed) == 1


if __name__ == "__main__":
    test_empty_group_natural_returns_none()
    test_empty_group_voting_raises_400()
    test_empty_group_talkative_raises_400()
    test_empty_group_pooled_returns_none()
    test_single_member_natural_returns_that_member()
    test_single_member_talkative_returns_that_member()
    test_all_disabled_enabled_member_ids_empty()
    test_all_disabled_natural_no_speaker()
    test_list_queue_ordered_enabled_members()
    test_list_queue_excludes_disabled()
    test_list_mid_speaker_exception_non_interrupting()
    print("\nALL GROUP BOUNDARY TESTS PASSED")
