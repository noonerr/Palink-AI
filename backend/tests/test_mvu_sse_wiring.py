"""MVU SSE 侧接线离线单测（SPEC_MVU变量更新SSE侧补齐与取证_2026-09-28 §3 T2）。

背景（SPEC §1 F4）：MVU 解析此前全链路只有 WS 一处调用（websocket.py
persist_snapshot），SSE 四入口（普通对话 / regenerate / swipe / continue）
既不解析也不剥离 <UpdateVariable>。

本文件锁三类行为（零网络）：
1. 共用函数 apply_mvu_reply_to_session：含 4 条 patch（replace/delta/文本）的
   假回复 → stat_data 数值变化 + 会话 chat_metadata.variables 落库 + 日志非空；
   strip_update_variable_blocks 剥离后的正文不含 <UpdateVariable>。
2. SSE 四入口各自调到共用函数（monkeypatch 计数桩，直调端点函数 + 捕获/驱动
   persist_fn），且落库正文不含标签、msg extra.variables 回写。
3. 变异验证：把共用函数调用从任一入口摘掉 → 对应入口用例的
   ``len(recorder.calls)`` 断言变红（2026-09-28 已逐入口实测）。
"""

import asyncio
import json
import logging
import os
import sys
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from app.api import character_ext
    from app.services.character_message_builder import apply_mvu_reply_to_session
    from app.services.mvu_engine import strip_update_variable_blocks
    from app.services.stream_builder import StreamResult
    from sqlalchemy import create_engine  # noqa: F401
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 夹具数据：真结构的最小 stat_data + 含 4 条 patch（replace/delta/文本）的假回复
# ---------------------------------------------------------------------------

_INIT_STAT = {"好感度": 51, "性欲值": 20, "时间": "中午", "地点": "校门口"}

_CHAR_EXTENSIONS = json.dumps(
    {
        "tavern_helper": {
            "variables": dict(_INIT_STAT),
        }
    },
    ensure_ascii=False,
)

_FAKE_REPLY = (
    "桃汐站在教育学院楼前的台阶上，远远看见了你。\n"
    "<UpdateVariable>\n<Analysis>\n好感度提升3，时间从中午推进到傍晚，地点切换。\n</Analysis>\n"
    "<JSONPatch>[\n"
    '  {"op": "replace", "path": "/好感度", "value": 54},\n'
    '  {"op": "delta", "path": "/性欲值", "value": 4},\n'
    '  {"op": "replace", "path": "/时间", "value": "傍晚"},\n'
    '  {"op": "replace", "path": "/地点", "value": "教育学院楼前"}\n'
    "]</JSONPatch>\n"
    "</UpdateVariable>"
)

_POST_MVU_STAT = {"好感度": 54, "性欲值": 24, "时间": "傍晚", "地点": "教育学院楼前"}


def _make_world(db_session, *, with_assistant_msg=True):
    """创建 user + MVU 卡角色 + 会话（chat_metadata 预置初始变量）+（可选）assistant 消息。"""
    from app.models import Character, CharacterChatMessage, CharacterChatSession, User

    user = User(
        username=f"mvu_wiring_{uuid.uuid4().hex[:8]}",
        hashed_password="dummy",
        role="user",
        is_active=True,
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)

    char = Character(
        user_id=user.id,
        name="桃汐",
        description="A test MVU character",
        personality="",
        scenario="",
        first_mes="",
        mes_example="",
        system_prompt="You are a test character.",
        post_history_instructions="",
        alternate_greetings="[]",
        tags="[]",
        creator_notes="",
        creator="test",
        character_version="1.0",
        extensions=_CHAR_EXTENSIONS,
    )
    db_session.add(char)
    db_session.commit()
    db_session.refresh(char)

    session = CharacterChatSession(
        id=f"mvu-sess-{uuid.uuid4().hex[:8]}",
        user_id=user.id,
        character_id=char.id,
        title="MVU wiring session",
        chat_metadata=json.dumps(
            {"variables": {"stat_data": dict(_INIT_STAT)}}, ensure_ascii=False
        ),
    )
    db_session.add(session)
    db_session.commit()

    msg = None
    if with_assistant_msg:
        msg = CharacterChatMessage(
            session_id=session.id,
            branch_id=None,
            role="assistant",
            content="旧回复",
            model="test-model",
            is_user=False,
            is_system=False,
        )
        db_session.add(msg)
        db_session.commit()
        db_session.refresh(msg)
    return user, char, session, msg


# ---------------------------------------------------------------------------
# 计数桩：替身 apply_mvu_reply_to_session（记录调用并返回固定新变量）
# ---------------------------------------------------------------------------


def _install_mvu_stub(monkeypatch, return_stat=None):
    """在 character_ext 命名空间替换共用函数为计数桩（入口调用点均为模块级
    名字引用，运行时查 module globals → monkeypatch 生效）。"""
    recorder = {"calls": []}

    def _stub(db, character_id, session_id, reply_text):
        recorder["calls"].append(
            {
                "db": db,
                "character_id": character_id,
                "session_id": session_id,
                "reply_text": reply_text,
            }
        )
        import copy

        vars_payload = {"stat_data": copy.deepcopy(return_stat or _POST_MVU_STAT)}
        return vars_payload, ["[block0] replace /好感度 → ok"], []

    monkeypatch.setattr(character_ext, "apply_mvu_reply_to_session", _stub)
    return recorder


async def _fake_assembly(req, deps):
    """替身装配结果：messages/memory_mode/effective_max_tokens/debug_dict 四字段足够。"""
    return SimpleNamespace(
        messages=[{"role": "user", "content": "hi"}],
        memory_mode="disabled",
        effective_max_tokens=64,
        debug_dict=lambda: {},
    )


def _patch_stream_prelude(monkeypatch, db_session):
    """四个 SSE 入口共用的外部依赖替换：限流/模型可用性/装配/DB 会话。"""
    monkeypatch.setattr(character_ext, "enforce_rate_limit", lambda *a, **k: None)
    monkeypatch.setattr(character_ext, "ensure_model_available", lambda *a, **k: None)
    monkeypatch.setattr(character_ext, "assemble_roleplay_prompt", _fake_assembly)
    monkeypatch.setattr(character_ext, "SessionLocal", lambda: db_session)


# ---------------------------------------------------------------------------
# Part 1：共用函数行为（真跑 apply_mvu_reply_to_session，SQLite 会话）
# ---------------------------------------------------------------------------


def test_apply_mvu_reply_updates_stat_data_and_session_metadata(db_session):
    from app.models import CharacterChatSession

    user, char, session, _ = _make_world(db_session, with_assistant_msg=False)

    new_vars, logs, _patches = apply_mvu_reply_to_session(db_session, char.id, session.id, _FAKE_REPLY)

    assert new_vars is not None
    assert new_vars["stat_data"]["好感度"] == 54
    assert new_vars["stat_data"]["性欲值"] == 24
    assert new_vars["stat_data"]["时间"] == "傍晚"
    assert new_vars["stat_data"]["地点"] == "教育学院楼前"
    assert logs, "有 patch 命中时必须返回非空日志"
    assert any("好感度" in l for l in logs)

    # 会话 chat_metadata.variables 已更新（同一 session 对象上可见）
    sess_row = (
        db_session.query(CharacterChatSession)
        .filter(CharacterChatSession.id == session.id)
        .first()
    )
    meta = json.loads(sess_row.chat_metadata)
    assert meta["variables"]["stat_data"]["好感度"] == 54
    assert meta["variables"]["stat_data"]["时间"] == "傍晚"


def test_apply_mvu_reply_inits_vars_when_metadata_empty(db_session):
    """chat_metadata 无 variables 时先从卡 extensions 初始化再应用 patch（WS 同款兜底）。"""
    from app.models import CharacterChatSession

    user, char, session, _ = _make_world(db_session, with_assistant_msg=False)
    session.chat_metadata = None
    db_session.commit()

    new_vars, logs, _patches = apply_mvu_reply_to_session(db_session, char.id, session.id, _FAKE_REPLY)

    assert new_vars["stat_data"]["好感度"] == 54
    assert new_vars["stat_data"]["性欲值"] == 24
    assert logs
    sess_row = (
        db_session.query(CharacterChatSession)
        .filter(CharacterChatSession.id == session.id)
        .first()
    )
    meta = json.loads(sess_row.chat_metadata)
    assert meta["variables"]["stat_data"]["地点"] == "教育学院楼前"


def test_apply_mvu_reply_missing_session_returns_none(db_session):
    """会话不存在 → (None, [])，调用方据此跳过 extra.variables 回写（WS 同款语义）。"""
    user, char, session, _ = _make_world(db_session, with_assistant_msg=False)
    new_vars, logs, _patches = apply_mvu_reply_to_session(db_session, char.id, "no-such-session", _FAKE_REPLY)
    assert new_vars is None
    assert logs == []


def test_strip_after_parse_display_text_clean():
    """剥离后的正文不含 <UpdateVariable> / JSONPatch，剧情正文保留。"""
    cleaned = strip_update_variable_blocks(_FAKE_REPLY)
    assert "<UpdateVariable>" not in cleaned
    assert "JSONPatch" not in cleaned
    assert "好感度" not in cleaned
    assert "桃汐站在教育学院楼前的台阶上" in cleaned


# ---------------------------------------------------------------------------
# Part 2：SSE 四入口接线（计数桩 + 捕获/驱动 persist_fn）
# ---------------------------------------------------------------------------


def _assert_common(recorder, db_session, char, session, raw_reply):
    assert len(recorder["calls"]) == 1, (
        f"该入口必须恰好调用一次共用函数，实际 {len(recorder['calls'])} 次"
        f"（变异验证：摘掉调用此断言即红）"
    )
    call = recorder["calls"][0]
    assert call["db"] is db_session
    assert call["character_id"] == char.id
    assert call["session_id"] == session.id
    assert call["reply_text"] == raw_reply


def test_regenerate_entry_calls_mvu_and_strips(db_session, monkeypatch):
    user, char, session, msg = _make_world(db_session)
    recorder = _install_mvu_stub(monkeypatch)
    _patch_stream_prelude(monkeypatch, db_session)

    captured = {}

    def _fake_run_action_stream(**kwargs):
        # 普通函数急切捕获（async gen 函数体要迭代才执行，端点只构造不迭代）
        captured["persist_fn"] = kwargs["persist_fn"]

        async def _gen():
            yield "data: " + json.dumps({"session_id": session.id}) + "\n\n"

        return _gen()

    monkeypatch.setattr(character_ext, "_run_action_stream", _fake_run_action_stream)

    asyncio.run(
        character_ext.regenerate_message(
            session_id=session.id,
            req=character_ext.RegenerateRequest(message_id=msg.id),
            request=MagicMock(),
            user=user,
            db=db_session,
        )
    )

    result = StreamResult()
    result.full_content = _FAKE_REPLY
    message_id, final_content = captured["persist_fn"](db_session, result)

    _assert_common(recorder, db_session, char, session, _FAKE_REPLY)
    assert message_id == msg.id
    # 落库正文不含标签（strip 在 persist_fn 内执行）
    assert "<UpdateVariable>" not in (final_content or "")
    assert "<UpdateVariable>" not in (msg.content or "")
    # 新 swipe 落库干净 + extra.variables 回写
    swipes = json.loads(msg.swipes)
    assert swipes[-1] == final_content
    extra = json.loads(msg.extra)
    assert extra["variables"]["stat_data"]["好感度"] == 54


def test_swipe_entry_calls_mvu_and_strips(db_session, monkeypatch):
    user, char, session, msg = _make_world(db_session)
    recorder = _install_mvu_stub(monkeypatch)
    _patch_stream_prelude(monkeypatch, db_session)

    captured = {}

    def _fake_run_action_stream(**kwargs):
        # 普通函数急切捕获（async gen 函数体要迭代才执行，端点只构造不迭代）
        captured["persist_fn"] = kwargs["persist_fn"]

        async def _gen():
            yield "data: " + json.dumps({"session_id": session.id}) + "\n\n"

        return _gen()

    monkeypatch.setattr(character_ext, "_run_action_stream", _fake_run_action_stream)

    asyncio.run(
        character_ext.swipe_message(
            session_id=session.id,
            req=character_ext.SwipeRequest(message_id=msg.id),
            request=MagicMock(),
            user=user,
            db=db_session,
        )
    )

    result = StreamResult()
    result.full_content = _FAKE_REPLY
    message_id, final_content = captured["persist_fn"](db_session, result)

    _assert_common(recorder, db_session, char, session, _FAKE_REPLY)
    assert message_id == msg.id
    assert "<UpdateVariable>" not in (final_content or "")
    swipes = json.loads(msg.swipes)
    assert swipes[-1] == final_content
    extra = json.loads(msg.extra)
    assert extra["variables"]["stat_data"]["性欲值"] == 24


def test_continue_entry_calls_mvu_and_strips(db_session, monkeypatch):
    user, char, session, msg = _make_world(db_session)
    recorder = _install_mvu_stub(monkeypatch)
    _patch_stream_prelude(monkeypatch, db_session)

    captured = {}

    def _fake_run_action_stream(**kwargs):
        # 普通函数急切捕获（async gen 函数体要迭代才执行，端点只构造不迭代）
        captured["persist_fn"] = kwargs["persist_fn"]

        async def _gen():
            yield "data: " + json.dumps({"session_id": session.id}) + "\n\n"

        return _gen()

    monkeypatch.setattr(character_ext, "_run_action_stream", _fake_run_action_stream)

    asyncio.run(
        character_ext.continue_session(
            session_id=session.id,
            req=character_ext.ContinueRequest(),
            request=MagicMock(),
            user=user,
            db=db_session,
        )
    )

    result = StreamResult()
    result.full_content = _FAKE_REPLY
    message_id, final_content = captured["persist_fn"](db_session, result)

    _assert_common(recorder, db_session, char, session, _FAKE_REPLY)
    assert message_id == msg.id
    # 追加正文干净：旧内容 + 剥离后的续写增量
    assert "<UpdateVariable>" not in (msg.content or "")
    assert msg.content.startswith("旧回复")
    assert "桃汐站在教育学院楼前的台阶上" in msg.content
    extra = json.loads(msg.extra)
    assert extra["variables"]["stat_data"]["好感度"] == 54


def test_character_chat_impl_entry_calls_mvu_and_strips(db_session, monkeypatch, _engine):
    """普通对话入口：驱动真实 event_generator 到收尾（stub 模型流），
    persist_snapshot(force=True) 内的 MVU 接线 + 剥离 + extra.variables 落库。"""
    from sqlalchemy.orm import sessionmaker

    from app.models import CharacterChatMessage

    user, char, session, _ = _make_world(db_session, with_assistant_msg=False)
    recorder = _install_mvu_stub(monkeypatch)
    _patch_stream_prelude(monkeypatch, db_session)

    import app.services.stream_builder as stream_builder_mod

    async def _fake_stream_chat_deltas(stream, result, initial_events=None, enable_thinking=None):
        result.full_content = _FAKE_REPLY
        yield "data: " + json.dumps({"content": "…"}) + "\n\n"

    monkeypatch.setattr(stream_builder_mod, "stream_chat_deltas", _fake_stream_chat_deltas)
    monkeypatch.setattr(
        character_ext,
        "stream_text_completion",
        lambda **kwargs: iter([]),
    )

    req = character_ext.CharacterChatRequest(
        character_id=char.id,
        message="你好",
        session_id=session.id,
        model="test-model",
    )

    async def _scenario():
        resp = await character_ext._character_chat_impl(req, MagicMock(), user, db_session)
        chunks = []
        async for chunk in resp.body_iterator:
            chunks.append(chunk)
        return chunks

    asyncio.run(_scenario())

    _assert_common(recorder, db_session, char, session, _FAKE_REPLY)

    # event_generator 收尾会 close save_db（即 db_session）；用绑定同一 engine 的新会话验证落库
    verify = sessionmaker(bind=_engine)()
    try:
        row = (
            verify.query(CharacterChatMessage)
            .filter(
                CharacterChatMessage.session_id == session.id,
                CharacterChatMessage.role == "assistant",
            )
            .first()
        )
        assert row is not None, "普通对话入口必须落库 assistant 消息"
        assert "<UpdateVariable>" not in (row.content or "")
        assert "桃汐站在教育学院楼前的台阶上" in (row.content or "")
        extra = json.loads(row.extra)
        assert extra["variables"]["stat_data"]["好感度"] == 54
    finally:
        verify.close()
