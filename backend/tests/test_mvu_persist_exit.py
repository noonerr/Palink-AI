"""包U：助手回复落库路径统一剥离 —— 出口行为 + 每条落库入口的残块断言。

## 病灶（线上取证，只读复核过）

会话 ``c6182e89-2271-46ba-abda-146d1bc6bbee`` 的消息 ``id=2852``（2198 字）落库正文里
留着整块 ``<UpdateVariable>…</UpdateVariable>``，而同一条 ``extra`` 里
``mvu_patch`` 有 17 条、``variables.stat_data`` 17 键 —— **解析做了、补丁留了、正文没剥**。
对同一份正文离线跑 Palink 自己的 ``strip_update_variable_blocks``：
684→682 字可剥净（``.tmp_probe/u_probe1.py``），即「不是识别不到，是那条落库路径没剥」。

真凶不是「某个入口没抄 strip」，而是 ``character_ext._character_chat_impl`` 的收尾段：
它在 ``persist_snapshot`` 把正文剥净**之后**，又从 ``result.full_content``（模型原文，
未剥 MVU、未过 AI_OUTPUT 正则）重新 ``extract_response_title`` 并
``_sync_message_content_to_active_swipe`` 回写正文 —— 把手抄的产物覆盖回原文。
凡带 ``[标题: xxx]`` 的回复必脏（标题指令由 character_message_builder 注入、模型必然输出）。

## 本文件锁三件事（全部零生成成本，不调用任何计费端点）

1. **出口行为**：``finalize_assistant_reply`` 对每一种块形状（三种上游别名 + 裸
   ``<JSONPatch>`` + 裸 JSON 数组 + 围栏包裹）都产出**无残块**正文，且解析先于剥离。
2. **每条落库入口**都经出口、且落库正文等于出口返回值 ⇒ 逐入口驱动真函数、
   断言 DB 行里 ``find_variable_block_residue(...) == []``。
   覆盖：WS 角色扮演 / WS 普通聊天 / HTTP 普通聊天 SSE / SSE 普通对话（含标题回写段）/
   regenerate / swipe / continue。
3. **反证目标**：把任一入口改回「手抄 strip」或恢复收尾段从 ``result.full_content``
   回写正文，第 2 组对应入口用例即红（见交付报告实测输出）。
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import types
import uuid

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

# ⚠️ 这里**不用** try/import + ``pytestmark = skipif(not _IMPORT_OK)``（AGENTS.md
# 验证纪律 5：那是把编译错误降级为 skip 的历史病灶，不得新增）。
# 导入失败就是要让它 collect error 直红 —— 模块改名时这个文件必须喊，不能静默消失。
from app.api import character_ext, chat as chat_api, websocket as ws_api  # noqa: E402
from app.models import (  # noqa: E402
    ChatMessage,
    ChatSession,
    Character,
    CharacterChatMessage,
    CharacterChatSession,
    User,
)
from app.services.assistant_reply_persist import (  # noqa: E402
    assert_no_variable_block_residue,
    finalize_assistant_reply,
    find_variable_block_residue,
)
from app.services.stream_builder import StreamResult  # noqa: E402


# ---------------------------------------------------------------------------
# 形状库：每一种都是「模型真实会输出」的形状，尾部一律带 [标题: xxx]
# （线上一条真实回复就是这个形状：正文 → 变量块 → 标题标记）
# ---------------------------------------------------------------------------

_PATCH = '[{"op": "replace", "path": "/好感度", "value": 60}]'
_BODY = "她在灯下抬眼看你，笑了一下。"

SHAPES: dict[str, str] = {
    # 上游三种别名（包Q 对齐面）
    "updatevariable": f"{_BODY}\n<UpdateVariable>\n<Analysis>好感度提升</Analysis>\n<JSONPatch>\n{_PATCH}\n</JSONPatch>\n</UpdateVariable>",
    "update_alias": f"{_BODY}\n<update>\n<JSONPatch>\n{_PATCH}\n</JSONPatch>\n</update>",
    "variableupdate_alias": f"{_BODY}\n<VariableUpdate>\n{_PATCH}\n</VariableUpdate>",
    # 裸 <JSONPatch>（包Q②）
    "bare_jsonpatch": f"{_BODY}\n<JSONPatch>\n{_PATCH}\n</JSONPatch>",
    # 裸 JSON 数组（BARE-JSONPATCH 兜底，2160 病灶）
    "bare_array": f"{_BODY}\n{_PATCH}",
    # 围栏包裹（```html … ```）
    "fenced": f"{_BODY}\n```html\n<UpdateVariable>\n{_PATCH}\n</UpdateVariable>\n```",
}

TITLE_MARKER = "\n[标题: 灯下一笑]"

_INIT_STAT = {"好感度": 50}


def _reply(shape: str, *, with_title: bool = True) -> str:
    text = SHAPES[shape]
    return text + (TITLE_MARKER if with_title else "")


# ---------------------------------------------------------------------------
# 世界夹具
# ---------------------------------------------------------------------------


def _make_char_world(db, *, session_prefix="u"):
    """User + MVU 角色卡 + 角色会话（chat_metadata 预置 stat_data）。"""
    user = User(
        username=f"pkg_u_{uuid.uuid4().hex[:8]}",
        hashed_password="dummy",
        role="user",
        is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    char = Character(
        user_id=user.id,
        name="测试角色",
        description="d",
        personality="",
        scenario="",
        first_mes="",
        mes_example="",
        system_prompt="s",
        post_history_instructions="",
        alternate_greetings="[]",
        tags="[]",
        creator_notes="",
        creator="t",
        character_version="1.0",
        extensions=json.dumps({"tavern_helper": {"variables": dict(_INIT_STAT)}}),
    )
    db.add(char)
    db.commit()
    db.refresh(char)

    session = CharacterChatSession(
        id=f"{session_prefix}-sess-{uuid.uuid4().hex[:8]}",
        user_id=user.id,
        character_id=char.id,
        title="pkgU",
        chat_metadata=json.dumps({"variables": {"stat_data": dict(_INIT_STAT)}}),
    )
    db.add(session)
    db.commit()
    return user, char, session


def _make_plain_world(db):
    """普通聊天（messages 表）所需 User + ChatSession。"""
    user = User(
        username=f"pkg_u_plain_{uuid.uuid4().hex[:8]}",
        hashed_password="dummy",
        role="user",
        is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    sid = f"pkg-u-plain-{uuid.uuid4().hex[:8]}"
    db.add(ChatSession(id=sid, user_id=user.id, title="pkgU plain", type="chat"))
    db.commit()
    return user, sid


class _FakeWsManager:
    """websocket 的广播层替：吃掉所有 send/broadcast，零网络。"""

    def __init__(self):
        self.chunks: list[str] = []

    async def send_chunk(self, session_id, content="", reasoning=""):
        self.chunks.append(content)

    async def send_error(self, session_id, message=""):
        return None

    async def send_done(self, session_id, usage=None):
        return None

    async def broadcast_to_session(self, session_id, payload):
        return None

    async def request_tool_call(self, *a, **k):
        return {}

    def clear_tool_response_queue(self, session_id):
        return None

    _stream_lock = asyncio.Lock()


async def _fake_stream(deltas):
    for d in deltas:
        yield d


def _patch_ws_common(monkeypatch, db_session):
    """两个 WS 生成函数共用的外部依赖替身。"""
    monkeypatch.setattr(ws_api, "SessionLocal", lambda: db_session)
    monkeypatch.setattr(ws_api, "ws_manager", _FakeWsManager())
    monkeypatch.setattr(ws_api, "ensure_quota", lambda *a, **k: None)
    monkeypatch.setattr(ws_api, "deduct_usage", lambda *a, **k: None)
    monkeypatch.setattr(
        ws_api, "compute_deduct_tokens", lambda *a, **k: 0
    )
    monkeypatch.setattr(
        ws_api, "generate_compact_title", _async_none
    )

    async def _no_image(*a, **k):
        return None

    monkeypatch.setattr(ws_api, "maybe_generate_image_for_message", _no_image)
    monkeypatch.setattr(ws_api, "generate_image_for_assistant_message", _no_image)
    monkeypatch.setattr(ws_api, "is_image_tool_enabled_for_user", lambda *a, **k: False)
    monkeypatch.setattr(ws_api, "resolve_generation_tools", lambda tools, **k: (tools, None, None))
    monkeypatch.setattr(
        "app.services.mvu_cleanup.run_auto_cleanup_for_session", lambda *a, **k: None
    )


async def _async_none(*a, **k):
    return None


# ===========================================================================
# 1. 出口行为：每一种块形状都必须剥净
# ===========================================================================


class TestSharedExitShapes:
    def test_no_shape_survives_the_exit(self):
        """核心断言：出口产出的正文对全部别名面零残块。"""
        for name, text in SHAPES.items():
            out = finalize_assistant_reply(
                None, raw_text=text, parse_variables=False, extract_title=True
            )
            assert find_variable_block_residue(out.content) == [], f"形状 {name} 残留未剥"
            assert _BODY in out.content, f"形状 {name} 误删了剧情正文"

    def test_parse_happens_on_pre_strip_text(self, db_session):
        """顺序契约：解析必须收到**剥离前**的原文，display_text 只供剥离用。

        这里故意把 display_text 传成「已经剥好的正文」——若出口把解析源写成了
        display_text，patches 就是 0 条。抄反顺序 = stat_data 永不更新
        （正是 F4 之前的形状），这条断言把它锁死。
        """
        user, char, session = _make_char_world(db_session)
        already_clean = _BODY
        out = finalize_assistant_reply(
            db_session,
            character_id=char.id,
            session_id=session.id,
            raw_text=SHAPES["updatevariable"],
            display_text=already_clean,
            parse_variables=True,
            extract_title=False,
        )
        assert len(out.patches) == 1, "解析源必须是 raw_text（剥离前原文）"
        assert out.content == already_clean
        assert find_variable_block_residue(out.content) == []

    @pytest.mark.parametrize("shape", sorted(SHAPES))
    def test_title_marker_extracted_together(self, shape):
        """标题与变量块在同一次出口调用里一并处理，落库正文两者皆无。"""
        text = _reply(shape)
        out = finalize_assistant_reply(
            None, raw_text=text, parse_variables=False, extract_title=True
        )
        assert find_variable_block_residue(out.content) == []
        assert "[标题:" not in out.content
        assert out.marker_title == "灯下一笑"

    def test_mvu_failure_still_strips(self):
        """MVU 解析抛异常 ⇒ 只降级为「不更新变量」，剥离照做（正文必须干净）。"""
        from app.services import assistant_reply_persist as mod

        original = mod.apply_mvu_reply_to_session

        def _boom(db, character_id, session_id, reply_text):
            raise RuntimeError("stat_data 落库炸了")

        mod.apply_mvu_reply_to_session = _boom
        try:
            out = finalize_assistant_reply(
                types.SimpleNamespace(),
                character_id="c",
                session_id="s",
                raw_text=SHAPES["updatevariable"],
                parse_variables=True,
                extract_title=False,
            )
        finally:
            mod.apply_mvu_reply_to_session = original

        assert find_variable_block_residue(out.content) == []
        assert out.variables is None
        assert out.variables_parsed is True  # 调用过，只是失败

    def test_parse_variables_off_does_not_touch_db(self):
        """普通聊天（messages 表）没有角色会话：parse_variables=False 不查库。"""
        calls = []
        from app.services import assistant_reply_persist as mod

        original = mod.apply_mvu_reply_to_session
        mod.apply_mvu_reply_to_session = lambda *a, **k: calls.append(a)
        try:
            out = finalize_assistant_reply(
                None, raw_text=SHAPES["bare_jsonpatch"], parse_variables=False
            )
        finally:
            mod.apply_mvu_reply_to_session = original
        assert calls == []
        assert find_variable_block_residue(out.content) == []

    def test_real_patch_lands_in_variables(self, db_session):
        """真跑：出口解析出补丁并落会话 stat_data，正文同时干净（不靠桩）。"""
        user, char, session = _make_char_world(db_session)
        out = finalize_assistant_reply(
            db_session,
            character_id=char.id,
            session_id=session.id,
            raw_text=SHAPES["updatevariable"],
            parse_variables=True,
            extract_title=True,
        )
        assert out.variables is not None
        assert out.variables["stat_data"]["好感度"] == 60
        assert len(out.patches) == 1
        assert find_variable_block_residue(out.content) == []
        assert _BODY in out.content


# ===========================================================================
# 2. 逐条落库入口：驱动真函数，断言 DB 行零残块
# ===========================================================================


class TestEntryPoints:
    # ---- 2.1 WS 角色扮演主路径 -------------------------------------------

    def _run_ws_character(self, db_session, monkeypatch, shape):
        user, char, session = _make_char_world(db_session)
        _patch_ws_common(monkeypatch, db_session)

        async def _fake_completion(**kwargs):
            for d in [
                {"content": _reply(shape)},
                {"usage": {"total_tokens": 10, "prompt_tokens": 5, "completion_tokens": 5}},
            ]:
                yield d

        monkeypatch.setattr(ws_api, "stream_text_completion", lambda **k: _fake_completion())

        ss = types.SimpleNamespace(full_content="", full_reasoning="", status="idle")
        asyncio.run(
            ws_api.run_character_chat_generation(
                ss=ss,
                session_id=session.id,
                branch_id=None,  # 模型 branch_id 可空且带 FK（conftest 开了 PRAGMA foreign_keys）
                user_id=user.id,
                messages=[{"role": "user", "content": "你好"}],
                model="test-model",
                is_new_session=False,
                memory_mode="disabled",
                user_message="你好",
                char=char,
                character_name=char.name,
                user_name="玩家",
            )
        )
        row = (
            db_session.query(CharacterChatMessage)
            .filter(
                CharacterChatMessage.session_id == session.id,
                CharacterChatMessage.role == "assistant",
            )
            .first()
        )
        return row

    @pytest.mark.parametrize("shape", sorted(SHAPES))
    def test_ws_character_chat_persist_is_clean(self, db_session, monkeypatch, shape):
        row = self._run_ws_character(db_session, monkeypatch, shape)
        assert row is not None, "WS 角色扮演入口必须落库 assistant 消息"
        assert_no_variable_block_residue(row.content, where=f"ws_character_chat/{shape}")
        assert "[标题:" not in (row.content or "")
        assert _BODY in (row.content or "")
        extra = json.loads(row.extra or "{}")
        # 补丁留存是「变量清理后可重演」的前提，收敛改造不许把它弄丢
        assert extra.get("mvu_patch"), "落库必须保留 extra.mvu_patch"
        assert extra["variables"]["stat_data"]["好感度"] == 60
        # swipe 与 content 同源：任何一条 swipe 里留块，前端切候选就还原出脏正文
        for swipe in json.loads(row.swipes or "[]"):
            assert_no_variable_block_residue(swipe, where=f"ws_character_chat/swipe/{shape}")

    # ---- 2.2 WS 普通聊天（messages 表，改前两处 content=final 直存原文）----

    def _run_ws_plain(self, db_session, monkeypatch, text):
        user, sid = _make_plain_world(db_session)
        _patch_ws_common(monkeypatch, db_session)
        monkeypatch.setattr(ws_api, "get_all_tools_openai_format", _async_none)

        async def _fake_completion(**kwargs):
            for d in [{"content": text}, {"usage": {"total_tokens": 1, "prompt_tokens": 1, "completion_tokens": 0}}]:
                yield d

        monkeypatch.setattr(ws_api, "stream_text_completion", lambda **k: _fake_completion())

        ss = types.SimpleNamespace(full_content="", full_reasoning="", status="idle")
        asyncio.run(
            ws_api.run_chat_generation(
                ss=ss,
                session_id=sid,
                user_id=user.id,
                messages=[{"role": "user", "content": "hi"}],
                model="test-model",
                is_new_session=False,
                web_search_results=[],
                web_search_query="",
                memory_mode="disabled",
                user_message="hi",
                enable_tools=False,
            )
        )
        return (
            db_session.query(ChatMessage)
            .filter(ChatMessage.session_id == sid, ChatMessage.role == "assistant")
            .first()
        )

    def test_ws_plain_chat_persist_is_clean(self, db_session, monkeypatch):
        """普通聊天不解析 MVU，但落库正文同样不许留块。"""
        for shape in sorted(SHAPES):
            row = self._run_ws_plain(db_session, monkeypatch, _reply(shape, with_title=False))
            assert row is not None
            assert_no_variable_block_residue(row.content, where=f"ws_plain/{shape}")

    # ---- 2.3 HTTP 普通聊天 SSE（chat.py）--------------------------------

    def test_http_plain_chat_persist_is_clean(self, db_session, monkeypatch):
        user, sid = _make_plain_world(db_session)

        class _FakeChatService:
            def __init__(self, db):
                self.db = db

            async def prepare_chat_context(self, req, user_id):
                return {
                    "user_message": {"role": "user", "content": req.message},
                    "memory_mode": "disabled",
                }

            def ensure_session(self, session_id, user_id, message, session_type):
                return sid, False

            def save_user_message(self, *a, **k):
                return None

        monkeypatch.setattr(chat_api, "ChatService", _FakeChatService)
        monkeypatch.setattr(chat_api, "SessionLocal", lambda: db_session)
        monkeypatch.setattr(chat_api, "enforce_rate_limit", lambda *a, **k: None)
        monkeypatch.setattr(chat_api, "ensure_quota", lambda *a, **k: None)
        monkeypatch.setattr(chat_api, "ensure_model_available", lambda *a, **k: None)
        monkeypatch.setattr(chat_api, "deduct_usage", lambda *a, **k: None)
        monkeypatch.setattr(chat_api, "compute_deduct_tokens", lambda *a, **k: 0)
        monkeypatch.setattr(chat_api, "get_all_tools_openai_format", _async_none)
        monkeypatch.setattr(chat_api, "generate_compact_title", _async_none)

        async def _no_image(*a, **k):
            return None

        monkeypatch.setattr(chat_api, "maybe_generate_image_for_message", _no_image)

        import app.services.stream_builder as stream_builder_mod

        async def _fake_stream_chat_deltas(stream, result, initial_events=None, enable_tools=True):
            result.full_content = _reply("updatevariable", with_title=False)
            yield "data: " + json.dumps({"content": "…"}) + "\n\n"

        monkeypatch.setattr(stream_builder_mod, "stream_chat_deltas", _fake_stream_chat_deltas)
        monkeypatch.setattr(chat_api, "stream_text_completion", lambda **k: iter([]))

        req = chat_api.ChatRequest(message="hi", model="test-model", session_id=sid)
        resp = asyncio.run(chat_api.chat_stream(req, types.SimpleNamespace(state=types.SimpleNamespace()), user, db_session))

        async def _drain():
            out = []
            async for chunk in resp.body_iterator:
                out.append(chunk)
            return out

        asyncio.run(_drain())

        row = (
            db_session.query(ChatMessage)
            .filter(ChatMessage.session_id == sid, ChatMessage.role == "assistant")
            .first()
        )
        assert row is not None, "HTTP 普通聊天入口必须落库 assistant 消息"
        assert_no_variable_block_residue(row.content, where="http_plain_chat")

    # ---- 2.4 SSE 普通对话（含 id=2852 的标题回写段）---------------------

    def _run_sse_character_chat(self, db_session, monkeypatch, shape):
        from sqlalchemy.orm import sessionmaker

        user, char, session = _make_char_world(db_session, session_prefix="pkgu-sse")
        engine = db_session.get_bind()
        monkeypatch.setattr(character_ext, "SessionLocal", lambda: db_session)
        monkeypatch.setattr(character_ext, "enforce_rate_limit", lambda *a, **k: None)
        monkeypatch.setattr(character_ext, "ensure_model_available", lambda *a, **k: None)
        monkeypatch.setattr(character_ext, "ensure_quota", lambda *a, **k: None)
        monkeypatch.setattr(character_ext, "deduct_usage", lambda *a, **k: None)
        monkeypatch.setattr(
            character_ext, "compute_deduct_tokens", lambda *a, **k: 0
        )
        monkeypatch.setattr(
            character_ext,
            "resolve_generation_tools",
            lambda tools, **k: (tools, None, None),
        )
        monkeypatch.setattr(
            "app.services.mvu_cleanup.run_auto_cleanup_for_session", lambda *a, **k: None
        )

        async def _no_image(*a, **k):
            return None

        monkeypatch.setattr(character_ext, "generate_image_for_assistant_message", _no_image)
        monkeypatch.setattr(
            character_ext, "is_image_tool_enabled_for_user", lambda *a, **k: False
        )

        async def _fake_assembly(req, deps):
            return types.SimpleNamespace(
                messages=[{"role": "user", "content": "hi"}],
                memory_mode="disabled",
                effective_max_tokens=64,
                ext_prompts_evidence=None,
                debug_dict=lambda: {},
            )

        monkeypatch.setattr(character_ext, "assemble_roleplay_prompt", _fake_assembly)

        import app.services.stream_builder as stream_builder_mod

        text = _reply(shape)

        async def _fake_stream_chat_deltas(stream, result, initial_events=None, enable_thinking=None):
            result.full_content = text
            yield "data: " + json.dumps({"content": text}) + "\n\n"

        monkeypatch.setattr(stream_builder_mod, "stream_chat_deltas", _fake_stream_chat_deltas)
        monkeypatch.setattr(character_ext, "stream_text_completion", lambda **k: iter([]))

        req = character_ext.CharacterChatRequest(
            character_id=char.id, message="你好", session_id=session.id, model="test-model"
        )

        async def _scenario():
            resp = await character_ext._character_chat_impl(req, types.SimpleNamespace(), user, db_session)
            async for _ in resp.body_iterator:
                pass

        asyncio.run(_scenario())

        verify = sessionmaker(bind=engine)()
        try:
            return (
                verify.query(CharacterChatMessage)
                .filter(
                    CharacterChatMessage.session_id == session.id,
                    CharacterChatMessage.role == "assistant",
                )
                .first()
            )
        finally:
            verify.close()

    @pytest.mark.parametrize("shape", sorted(SHAPES))
    def test_sse_character_chat_persist_is_clean(self, db_session, monkeypatch, shape):
        """**id=2852 的复现面**：假回复尾部带 [标题: xxx]，改前收尾段会用
        result.full_content 覆盖正文 ⇒ 残块必红。"""
        row = self._run_sse_character_chat(db_session, monkeypatch, shape)
        assert row is not None, "SSE 普通对话入口必须落库 assistant 消息"
        assert_no_variable_block_residue(row.content, where=f"sse_character_chat/{shape}")
        assert "[标题:" not in (row.content or "")
        assert _BODY in (row.content or "")
        assert row.short_title == "灯下一笑", "标题必须仍从标记来"
        extra = json.loads(row.extra or "{}")
        assert extra.get("mvu_patch"), "收敛改造不许丢掉 extra.mvu_patch"
        for swipe in json.loads(row.swipes or "[]"):
            assert_no_variable_block_residue(swipe, where=f"sse_character_chat/swipe/{shape}")

    # ---- 2.5 / 2.6 / 2.7 regenerate · swipe · continue ------------------

    def _make_action_world(self, db_session, content="旧回复正文"):
        user, char, session = _make_char_world(db_session, session_prefix="pkgu-act")
        msg = CharacterChatMessage(
            session_id=session.id,
            branch_id=None,
            role="assistant",
            content=content,
            model="test-model",
            is_user=False,
            is_system=False,
        )
        db_session.add(msg)
        db_session.commit()
        db_session.refresh(msg)
        return user, char, session, msg

    def _capture_persist_fn(self, monkeypatch):
        """动作流三入口（regenerate/swipe/continue）共用替身：急切捕获 persist_fn。

        ``_run_action_stream`` 是 async generator，端点只构造不迭代 ⇒ 必须换成
        普通函数在 kwargs 里把 persist_fn 抓出来（同 test_mvu_sse_wiring 的做法）。
        """
        captured: dict = {}

        def _fake_run_action_stream(**kwargs):
            captured["persist_fn"] = kwargs["persist_fn"]

            async def _gen():
                yield "data: {}\n\n"

            return _gen()

        monkeypatch.setattr(character_ext, "_run_action_stream", _fake_run_action_stream)
        monkeypatch.setattr(character_ext, "enforce_rate_limit", lambda *a, **k: None)
        monkeypatch.setattr(character_ext, "ensure_model_available", lambda *a, **k: None)
        monkeypatch.setattr(
            character_ext,
            "assemble_roleplay_prompt",
            lambda req, deps: _await_value(
                types.SimpleNamespace(
                    messages=[{"role": "user", "content": "hi"}],
                    memory_mode="disabled",
                    effective_max_tokens=64,
                    ext_prompts_evidence=None,
                )
            ),
        )
        return captured

    @pytest.mark.parametrize("shape", sorted(SHAPES))
    def test_regenerate_persist_is_clean(self, db_session, monkeypatch, shape):
        user, char, session, msg = self._make_action_world(db_session)
        captured = self._capture_persist_fn(monkeypatch)
        monkeypatch.setattr(character_ext, "SessionLocal", lambda: db_session)

        asyncio.run(
            character_ext.regenerate_message(
                session_id=session.id,
                req=character_ext.RegenerateRequest(message_id=msg.id),
                request=types.SimpleNamespace(),
                user=user,
                db=db_session,
            )
        )
        result = StreamResult()
        result.full_content = _reply(shape)
        _mid, final_content = captured["persist_fn"](db_session, result)
        assert_no_variable_block_residue(final_content, where=f"regenerate/{shape}")
        assert_no_variable_block_residue(msg.content, where=f"regenerate/row/{shape}")
        extra = json.loads(msg.extra or "{}")
        assert extra.get("mvu_patch"), "regenerate 必须留存 extra.mvu_patch"
        for swipe in json.loads(msg.swipes or "[]"):
            assert_no_variable_block_residue(swipe, where=f"regenerate/swipe/{shape}")

    @pytest.mark.parametrize("shape", sorted(SHAPES))
    def test_swipe_persist_is_clean(self, db_session, monkeypatch, shape):
        user, char, session, msg = self._make_action_world(db_session)
        captured = self._capture_persist_fn(monkeypatch)
        monkeypatch.setattr(character_ext, "SessionLocal", lambda: db_session)

        asyncio.run(
            character_ext.swipe_message(
                session_id=session.id,
                req=character_ext.SwipeRequest(message_id=msg.id),
                request=types.SimpleNamespace(),
                user=user,
                db=db_session,
            )
        )
        result = StreamResult()
        result.full_content = _reply(shape)
        _mid, final_content = captured["persist_fn"](db_session, result)
        assert_no_variable_block_residue(final_content, where=f"swipe/{shape}")
        assert_no_variable_block_residue(msg.content, where=f"swipe/row/{shape}")
        extra = json.loads(msg.extra or "{}")
        assert extra.get("mvu_patch"), "swipe 必须留存 extra.mvu_patch"

    @pytest.mark.parametrize("shape", sorted(SHAPES))
    def test_continue_persist_is_clean(self, db_session, monkeypatch, shape):
        user, char, session, msg = self._make_action_world(db_session)
        captured = self._capture_persist_fn(monkeypatch)
        monkeypatch.setattr(character_ext, "SessionLocal", lambda: db_session)

        asyncio.run(
            character_ext.continue_session(
                session_id=session.id,
                req=character_ext.ContinueRequest(),
                request=types.SimpleNamespace(),
                user=user,
                db=db_session,
            )
        )
        result = StreamResult()
        result.full_content = _reply(shape)
        captured["persist_fn"](db_session, result)
        assert_no_variable_block_residue(msg.content, where=f"continue/row/{shape}")
        assert msg.content.startswith("旧回复正文")
        assert _BODY in msg.content
        for swipe in json.loads(msg.swipes or "[]"):
            assert_no_variable_block_residue(swipe, where=f"continue/swipe/{shape}")


def _await_value(value):
    """assemble_roleplay_prompt 是协程：替身必须返回 awaitable。"""

    async def _coro():
        return value

    return _coro()
