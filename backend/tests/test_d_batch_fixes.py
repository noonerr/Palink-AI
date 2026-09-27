"""批次 D 修复测试（2026-08-29）：群聊世界书 NameError + creator_notes 剔除 + 高频斜杠命令。

来源: docs/REPORT_ST兼容性深度调研_2026-08-29.md 第一档清单
     + docs/PLAN_ST兼容修复批次_2026-08-28.md 批次 D。

覆盖面：
1. 群聊世界书: _append_worldbook_context 群聊分支此前引用非作用域变量
   _g_mode/group_wi_strategy（主装配局部变量）与裸 db → 凡 req.group_id 为真
   必 NameError，被函数外层 except 吞掉、世界书注入整体静默失效。修复后群
   上下文经入参传入，入参缺省时按 req.group_id 现场解析兜底。真实调用断言
   注入产物（constant 条目内容出现在 dynamic_context_parts）。
2. creator_notes（P2-13 尾巴）: 属性表/角色卡块不再包含创作者备注，
   显式 {{creator_notes}} 宏保留（ST 语义: 纯 UI 字段不进 prompt，显式引用除外）。
3. 高频斜杠命令 10 个: /genraw /del /cut /delswipe /hide /unhide /listvar
   /if /inject /flushinject —— 真实 DB 会话语义（记忆级联 / 锁定跳过 /
   索引范围 / swipe 收缩 / chat_metadata 注入存储）。
"""

import json
import os
import sys
from types import SimpleNamespace

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from app.models.character import (
        Character,
        CharacterChatMessage,
        CharacterChatSession,
    )
    from app.models.group_chat import GroupChat
    from app.models.worldbook import WorldBook, WorldBookStage
    from app.api.character_ext import (
        _build_character_card_attributes,
        _build_character_card_block,
        _replace_character_card_placeholders,
    )
    from app.services.slash_command_service import (
        SlashCommandContext,
        SlashCommandRegistry,
        execute_slash_command,
    )
    from app.services.roleplay_prompt_assembly import _append_worldbook_context
    from app.memory_module import storage as mem_storage_mod
    from app.memory_module.storage import MemoryStorage
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")


# ---------------------------------------------------------------------------
# 共享 fixture 工具
# ---------------------------------------------------------------------------

def _make_character(db, user_id, name="Alice", **kw):
    char = Character(user_id=user_id, name=name, **kw)
    db.add(char)
    db.flush()
    return char


def _make_session(db, char, user_id):
    sess = CharacterChatSession(character_id=char.id, user_id=user_id)
    db.add(sess)
    db.flush()
    return sess


def _add_msg(db, session_id, content, role="assistant", is_user=False,
             is_locked=False, is_hidden=False):
    msg = CharacterChatMessage(
        session_id=session_id,
        role=role,
        content=content,
        is_user=is_user,
        is_system=False,
        is_locked=is_locked,
        is_hidden=is_hidden,
    )
    db.add(msg)
    db.flush()
    return msg


# ---------------------------------------------------------------------------
# 1. creator_notes 剔除（P2-13 尾巴）
# ---------------------------------------------------------------------------

class TestCreatorNotesExclusion:
    CREATOR_NOTE = "SECRET-CREATOR-NOTE-9137"

    def _char(self, db, user_id):
        return _make_character(
            db, user_id,
            description="DESC-TEXT",
            creator_notes=self.CREATOR_NOTE,
        )

    def test_attributes_exclude_creator_notes(self, db_session, test_user):
        """属性表不含创作者备注（zh）。"""
        char = self._char(db_session, test_user.id)
        result = _build_character_card_attributes(char, "zh")
        assert "DESC-TEXT" in result
        assert self.CREATOR_NOTE not in result
        assert "创作者备注" not in result

    def test_card_block_exclude_creator_notes(self, db_session, test_user):
        """角色卡块（use_custom_prompts 路径）不含创作者备注（en）。"""
        char = self._char(db_session, test_user.id)
        result = _build_character_card_block(char, "en")
        assert "DESC-TEXT" in result
        assert self.CREATOR_NOTE not in result
        assert "Creator Notes" not in result

    def test_explicit_creator_notes_macro_preserved(self, db_session, test_user):
        """显式 {{creator_notes}} 宏仍然生效（ST: 显式引用除外）。"""
        char = self._char(db_session, test_user.id)
        result = _replace_character_card_placeholders(
            "前 {{creator_notes}} 后", char, prompt_lang="zh"
        )
        assert self.CREATOR_NOTE in result

    def test_attributes_macro_has_no_creator_notes(self, db_session, test_user):
        """{{attributes}} 展开产物同样不含创作者备注。"""
        char = self._char(db_session, test_user.id)
        result = _replace_character_card_placeholders(
            "{{attributes}}", char, prompt_lang="zh"
        )
        assert self.CREATOR_NOTE not in result


# ---------------------------------------------------------------------------
# 2. 群聊世界书 NameError 修复
# ---------------------------------------------------------------------------

class _StubDeps:
    """_append_worldbook_context 所需 deps 方法的直通桩。

    本组测试关注群聊上下文与 NameError 消失，正则/占位符替换不参与断言。
    """

    def apply_plugin_regex_scripts(self, text, *args, **kwargs):
        return text

    def apply_regex_scripts(self, text, *args, **kwargs):
        return text

    def replace_placeholders(self, text, *args, **kwargs):
        return text


WB_MARK_TEXT = "GROUP-WB-MARK-TEXT"
WB_MARK_DEPTH = "GROUP-WB-MARK-DEPTH"


def _make_group_worldbook(db, char, user_id):
    """双条目覆盖两条注入路径: position=0 → dynamic_context_parts（text），
    position=4（缺省 atDepth）→ DepthInjection 队列。"""
    wb = WorldBook(name="G", character_id=char.id, user_id=user_id)
    db.add(wb)
    db.flush()
    db.add(WorldBookStage(
        world_book_id=wb.id,
        title="garden-text",
        content=WB_MARK_TEXT,
        keys=json.dumps(["garden"]),
        constant=True,
        enabled=True,
        position=0,
    ))
    db.add(WorldBookStage(
        world_book_id=wb.id,
        title="garden-depth",
        content=WB_MARK_DEPTH,
        keys=json.dumps(["garden"]),
        constant=True,
        enabled=True,
        position=4,
    ))
    db.flush()
    return wb


def _make_wb_req(db, user, char, session, group_id=None):
    return SimpleNamespace(
        db=db,
        user=user,
        char=char,
        session_id=session.id,
        branch_id=None,
        is_init=False,
        message="hello garden",
        smart_card_trigger=False,
        is_continue=False,
        group_id=group_id,
        user_nickname=getattr(user, "username", None) or "Tester",
    )


class TestGroupWorldbookNoNameError:
    """群聊分支引用非作用域变量（_g_mode/group_wi_strategy/db）的回归锁。

    修复前：req.group_id 非空时短路求值到 _g_mode 即 NameError → 外层 except
    吞掉 → dynamic_context_parts 不含世界书内容（整体静默失效）。
    修复后：入参传入 / 现场解析，constant 条目正常注入。
    """

    def _setup(self, db_session, test_user):
        char = _make_character(db_session, test_user.id)
        member = _make_character(db_session, test_user.id, name="Bob")
        session = _make_session(db_session, char, test_user.id)
        _make_group_worldbook(db_session, char, test_user.id)
        group = GroupChat(
            user_id=test_user.id,
            name="G",
            member_ids=json.dumps([str(member.id)]),
            disabled_members="[]",
        )
        db_session.add(group)
        db_session.flush()
        return char, member, session, group

    def test_group_injection_with_group_param(self, db_session, test_user):
        """群聊请求 + group_chat 入参 → 世界书注入不再 NameError。"""
        char, _member, session, group = self._setup(db_session, test_user)
        req = _make_wb_req(db_session, test_user, char, session, group_id=group.id)
        parts, depth_entries, report = [], [], []
        _append_worldbook_context(
            req, _StubDeps(), parts, depth_entries, report,
            char_name=char.name, group_chat=group, group_wi_strategy="all",
        )
        assert any(WB_MARK_TEXT in p for p in parts)
        assert any(WB_MARK_DEPTH in d.content for d in depth_entries)

    def test_group_injection_fallback_resolution(self, db_session, test_user):
        """group_chat 入参缺省时按 req.group_id 现场解析兜底（直接调用路径）。"""
        char, _member, session, group = self._setup(db_session, test_user)
        req = _make_wb_req(db_session, test_user, char, session, group_id=group.id)
        parts, depth_entries, report = [], [], []
        _append_worldbook_context(
            req, _StubDeps(), parts, depth_entries, report,
            char_name=char.name, group_wi_strategy="all",
        )
        assert any(WB_MARK_TEXT in p for p in parts)
        assert any(WB_MARK_DEPTH in d.content for d in depth_entries)

    def test_strategy_one_still_injects(self, db_session, test_user):
        """strategy=one（默认）+ group_id 在场 → 正常注入（不加载群成员字段）。"""
        char, _member, session, group = self._setup(db_session, test_user)
        req = _make_wb_req(db_session, test_user, char, session, group_id=group.id)
        parts, depth_entries, report = [], [], []
        _append_worldbook_context(
            req, _StubDeps(), parts, depth_entries, report,
            char_name=char.name, group_chat=group, group_wi_strategy="one",
        )
        assert any(WB_MARK_TEXT in p for p in parts)
        assert any(WB_MARK_DEPTH in d.content for d in depth_entries)

    def test_private_chat_unaffected(self, db_session, test_user):
        """私聊（group_id=None）路径零回归。"""
        char, _member, session, _group = self._setup(db_session, test_user)
        req = _make_wb_req(db_session, test_user, char, session, group_id=None)
        parts, depth_entries, report = [], [], []
        _append_worldbook_context(
            req, _StubDeps(), parts, depth_entries, report,
            char_name=char.name,
        )
        assert any(WB_MARK_TEXT in p for p in parts)
        assert any(WB_MARK_DEPTH in d.content for d in depth_entries)


# ---------------------------------------------------------------------------
# 3. 高频斜杠命令
# ---------------------------------------------------------------------------

class TestSlashDBatchCommands:
    @pytest.fixture(autouse=True)
    def _mem_tables(self, db_session, monkeypatch):
        """初始化 memory 表：/del /cut 的记忆镜像级联（delete_by_message_id）
        需要 conversation_memories 表存在（与生产行为一致，不做异常吞并）。"""
        monkeypatch.setattr(mem_storage_mod, "_tables_initialized", False)
        monkeypatch.setattr(mem_storage_mod, "_is_postgres_cached", None)
        monkeypatch.setattr(mem_storage_mod, "_migration_done", False)
        MemoryStorage(db_session)
        yield

    def _ctx(self, db, user, char, session):
        return SlashCommandContext(
            db=db,
            session_id=session.id,
            user_id=user.id,
            user_name="Tester",
            character=char,
            session=session,
            input_text="",
        )

    def _setup(self, db_session, test_user, name="Alice"):
        char = _make_character(db_session, test_user.id, name=name)
        session = _make_session(db_session, char, test_user.id)
        return char, session

    # ---- 注册表 ----

    def test_registry_contains_new_commands(self):
        cmds = set(SlashCommandRegistry.list_commands())
        for name in (
            "genraw", "del", "cut", "delswipe", "hide",
            "unhide", "listvar", "if", "inject", "flushinject",
        ):
            assert name in cmds, f"missing /{name}"

    # ---- /genraw ----

    def test_genraw_alias_sets_raw_gen_prompt(self, db_session, test_user):
        char, session = self._setup(db_session, test_user)
        result = execute_slash_command(
            "/genraw hello world", self._ctx(db_session, test_user, char, session)
        )
        assert result.send_to_chat is False
        assert result.gen_prompt == "hello world"

    # ---- /del ----

    def test_del_removes_recent_and_skips_locked(self, db_session, test_user):
        char, session = self._setup(db_session, test_user)
        m1 = _add_msg(db_session, session.id, "one")
        m2 = _add_msg(db_session, session.id, "two", is_locked=True)
        m3 = _add_msg(db_session, session.id, "three")
        result = execute_slash_command(
            "/del 2", self._ctx(db_session, test_user, char, session)
        )
        db_session.commit()
        remaining = {
            m.id for m in db_session.query(CharacterChatMessage)
            .filter(CharacterChatMessage.session_id == session.id).all()
        }
        assert m1.id in remaining and m2.id in remaining
        assert m3.id not in remaining
        assert "Deleted 1" in (result.response or "")
        assert "skipped 1 locked" in (result.response or "")

    def test_del_default_one(self, db_session, test_user):
        char, session = self._setup(db_session, test_user)
        m1 = _add_msg(db_session, session.id, "one")
        m2 = _add_msg(db_session, session.id, "two")
        execute_slash_command("/del", self._ctx(db_session, test_user, char, session))
        db_session.commit()
        remaining = {
            m.id for m in db_session.query(CharacterChatMessage)
            .filter(CharacterChatMessage.session_id == session.id).all()
        }
        assert remaining == {m1.id}

    # ---- /cut ----

    def test_cut_range_deletes(self, db_session, test_user):
        char, session = self._setup(db_session, test_user)
        m1 = _add_msg(db_session, session.id, "one")
        m2 = _add_msg(db_session, session.id, "two")
        m3 = _add_msg(db_session, session.id, "three")
        m4 = _add_msg(db_session, session.id, "four")
        result = execute_slash_command(
            "/cut 1-2", self._ctx(db_session, test_user, char, session)
        )
        db_session.commit()
        remaining = {
            m.id for m in db_session.query(CharacterChatMessage)
            .filter(CharacterChatMessage.session_id == session.id).all()
        }
        assert remaining == {m1.id, m4.id}
        assert "1-2" in (result.response or "")

    def test_cut_negative_index(self, db_session, test_user):
        char, session = self._setup(db_session, test_user)
        m1 = _add_msg(db_session, session.id, "one")
        _add_msg(db_session, session.id, "two")
        m3 = _add_msg(db_session, session.id, "three")
        execute_slash_command(
            "/cut -2--1", self._ctx(db_session, test_user, char, session)
        )
        db_session.commit()
        remaining = {
            m.id for m in db_session.query(CharacterChatMessage)
            .filter(CharacterChatMessage.session_id == session.id).all()
        }
        assert remaining == {m1.id}

    # ---- /delswipe ----

    def test_delswipe_deletes_last_swipe(self, db_session, test_user):
        char, session = self._setup(db_session, test_user)
        msg = _add_msg(db_session, session.id, "C")
        msg.swipes = json.dumps(["A", "B", "C"], ensure_ascii=False)
        msg.swipe_id = 2
        db_session.flush()
        result = execute_slash_command(
            "/delswipe", self._ctx(db_session, test_user, char, session)
        )
        db_session.commit()
        db_session.refresh(msg)
        assert json.loads(msg.swipes) == ["A", "B"]
        assert msg.swipe_id == 1
        assert msg.content == "B"
        assert "2/2" in (result.response or "")

    def test_delswipe_by_index(self, db_session, test_user):
        char, session = self._setup(db_session, test_user)
        msg = _add_msg(db_session, session.id, "B")
        msg.swipes = json.dumps(["A", "B", "C"], ensure_ascii=False)
        msg.swipe_id = 0
        db_session.flush()
        execute_slash_command(
            "/delswipe 2", self._ctx(db_session, test_user, char, session)
        )
        db_session.commit()
        db_session.refresh(msg)
        assert json.loads(msg.swipes) == ["A", "C"]
        assert msg.swipe_id == 0
        assert msg.content == "A"

    def test_delswipe_refuses_single_swipe(self, db_session, test_user):
        char, session = self._setup(db_session, test_user)
        _add_msg(db_session, session.id, "only")
        result = execute_slash_command(
            "/delswipe", self._ctx(db_session, test_user, char, session)
        )
        assert "Only one swipe" in (result.response or "")

    # ---- /hide /unhide ----

    def test_hide_unhide(self, db_session, test_user):
        char, session = self._setup(db_session, test_user)
        m1 = _add_msg(db_session, session.id, "one")
        m2 = _add_msg(db_session, session.id, "two")
        m3 = _add_msg(db_session, session.id, "three")
        ctx = self._ctx(db_session, test_user, char, session)
        execute_slash_command("/hide", ctx)  # 缺省 = 最后一条
        db_session.commit()
        db_session.refresh(m3)
        assert m3.is_hidden is True and m1.is_hidden is False
        execute_slash_command("/hide 0-1", ctx)
        db_session.commit()
        db_session.refresh(m1)
        db_session.refresh(m2)
        assert m1.is_hidden is True and m2.is_hidden is True
        execute_slash_command("/unhide 1", ctx)
        db_session.commit()
        db_session.refresh(m2)
        db_session.refresh(m1)
        assert m2.is_hidden is False and m1.is_hidden is True

    # ---- /listvar ----

    def test_listvar_lists_chat_variables(self, db_session, test_user):
        char, session = self._setup(db_session, test_user)
        ctx = self._ctx(db_session, test_user, char, session)
        execute_slash_command("/setvar gold 100", ctx)
        result = execute_slash_command("/listvar", ctx)
        payload = json.loads(result.response or "{}")
        assert payload.get("gold") == "100"

    def test_listvar_empty(self, db_session, test_user):
        char, session = self._setup(db_session, test_user)
        result = execute_slash_command(
            "/listvar", self._ctx(db_session, test_user, char, session)
        )
        assert "no chat variables" in (result.response or "")

    # ---- /if ----

    def test_if_true_executes_command(self, db_session, test_user):
        char, session = self._setup(db_session, test_user)
        ctx = self._ctx(db_session, test_user, char, session)
        execute_slash_command("/setvar flag 1", ctx)
        result = execute_slash_command(
            "/if {{getvar::flag}} then /getvar flag", ctx
        )
        assert "flag=1" in (result.response or "")

    def test_if_false_skips(self, db_session, test_user):
        char, session = self._setup(db_session, test_user)
        m1 = _add_msg(db_session, session.id, "keep me")
        ctx = self._ctx(db_session, test_user, char, session)
        execute_slash_command("/setvar flag 0", ctx)
        result = execute_slash_command(
            "/if {{getvar::flag}} then /del", ctx
        )
        db_session.commit()
        assert "skipped" in (result.response or "")
        remaining = db_session.query(CharacterChatMessage).filter(
            CharacterChatMessage.session_id == session.id
        ).all()
        assert [m.id for m in remaining] == [m1.id]

    def test_if_negation(self, db_session, test_user):
        char, session = self._setup(db_session, test_user)
        ctx = self._ctx(db_session, test_user, char, session)
        execute_slash_command("/setvar flag 0", ctx)
        result = execute_slash_command(
            "/if !{{getvar::flag}} then /getvar flag", ctx
        )
        assert "flag=0" in (result.response or "")

    # ---- /inject /flushinject ----

    def test_inject_writes_chat_metadata(self, db_session, test_user):
        char, session = self._setup(db_session, test_user)
        ctx = self._ctx(db_session, test_user, char, session)
        execute_slash_command("/inject hello world", ctx)
        execute_slash_command("/inject position=2 depth=1 status line", ctx)
        db_session.commit()
        db_session.refresh(session)
        meta = json.loads(session.chat_metadata)
        injections = meta["palink_injections"]
        assert len(injections) == 2
        assert injections[0] == {"content": "hello world", "position": 0, "depth": 4}
        assert injections[1] == {"content": "status line", "position": 2, "depth": 1}

    def test_flushinject_clears(self, db_session, test_user):
        char, session = self._setup(db_session, test_user)
        ctx = self._ctx(db_session, test_user, char, session)
        execute_slash_command("/inject a", ctx)
        execute_slash_command("/inject b", ctx)
        result = execute_slash_command("/flushinject", ctx)
        db_session.commit()
        db_session.refresh(session)
        meta = json.loads(session.chat_metadata)
        assert "palink_injections" not in meta
        assert "Flushed 2" in (result.response or "")
