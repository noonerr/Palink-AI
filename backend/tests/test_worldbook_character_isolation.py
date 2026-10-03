"""[WB-CHAR-ISOLATION 2026-10-03 / 同日修订] 世界书角色隔离 — 三源判定回归测试。

修复的真实 bug：``build_worldbook_context`` 把 ``character_id IS NULL`` 的书
**无条件注入任何角色**，导致角色 A 的会话提示词里混进角色 B 的世界书内容。
叠加根因：``POST /api/worldbooks`` 建书接口根本不接收 ``character_id``，
所以用户建的每个世界书都是"全局"的。

ST 1.18.0 的权威语义（三源，各自独立、都有明确绑定维度，**无隐式全局**）：
  1. 卡内嵌     ``character.data.extensions.world`` / ``data.character_book``
  2. 角色附加   ``world_info.charLore[] = { name: 角色文件名, extraBooks: [书名] }``
                （world-info.js:1132 / :4376 / :6039-6052 按角色名绑定）
  3. 全局勾选   ``world_info.globalSelect`` ← ``selected_world_info``

Palink 侧映射：``character_id`` 是唯一的绑定维度——
  - ``character_id == 本会话角色`` → source="character"（覆盖 ST 的卡内嵌 + 角色附加）
  - 会话显式关联的（``SessionWorldBook``）→ source="chat"

⚠️ **2026-10-03 修订（用户裁定）**：删掉「``character_id IS NULL`` 也注入」这一路。
   先前把它当"全局书"保留是**方向反了** —— 用户的实际用法是所有世界书都随角色卡导入、
   每本都该绑定到具体角色；把未绑定的书继续注入所有卡，等于让**漏网的那几本继续散播**。
   ST 的 ``globalSelect`` 是用户**手动勾选**的集，不是「未绑定」的代名词。
   现在未绑定的书**不注入**，并由 ``[WB-UNBOUND]`` 告警暴露，便于用户补绑。

覆盖：
  1. 角色隔离：绑 A 的书不进 B 的会话（本次修复的核心断言）
  2. 判定：chat / character 两类各自标记正确
  3. book_sources 可见性表（书名 + 来源 + 绑定维度）
  4. 条目级 report 带 lore_source / book_name
  5. **未绑定的书不注入**（修订后的契约，见 `TestUnboundBooksNotInjected`）
  6. 跨用户书不进本用户会话（绑定维度必须带 user_id 过滤）
"""

import json
import os
import sys
import uuid

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from sqlalchemy.orm import Session  # noqa: E402

from app.core.security import get_password_hash  # noqa: E402
from app.models import Character, User  # noqa: E402
from app.models.character import CharacterChatSession  # noqa: E402
from app.models.worldbook import SessionWorldBook, WorldBook, WorldBookStage  # noqa: E402
from app.services.worldbook_service import build_worldbook_context  # noqa: E402


# ────────────────────────── fixtures / helpers ──────────────────────────

def _mk_user(db: Session, tag: str) -> User:
    u = User(
        username=f"wbiso-{tag}-{uuid.uuid4().hex[:8]}",
        hashed_password=get_password_hash("TestPassword1"),
        role="user",
        is_active=True,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _mk_char(db: Session, user: User, name: str) -> Character:
    c = Character(id=f"wbiso-c-{uuid.uuid4().hex[:8]}", user_id=user.id, name=name)
    db.add(c)
    db.commit()
    db.refresh(c)
    return c


def _mk_session(db: Session, user: User, char: Character, sid: str) -> CharacterChatSession:
    s = CharacterChatSession(id=sid, user_id=user.id, character_id=char.id, title="wb-iso")
    db.add(s)
    db.commit()
    db.refresh(s)
    return s


def _mk_book(
    db: Session,
    user: User,
    name: str,
    content: str,
    *,
    character_id: str | None = None,
    wb_type: str = "world_book",
) -> WorldBook:
    """建一本书 + 一条 constant 条目（constant 保证每轮必激活，隔离断言才成立）。"""
    wb = WorldBook(
        id=f"wbiso-wb-{uuid.uuid4().hex[:10]}",
        user_id=user.id,
        character_id=character_id,
        name=name,
        type=wb_type,
        format="custom",
        source_type="online_edit",
        is_parsed=True,
    )
    db.add(wb)
    db.commit()
    db.add(WorldBookStage(
        id=f"wbiso-st-{uuid.uuid4().hex[:10]}",
        world_book_id=wb.id,
        stage_index=0,
        title=f"{name}-entry",
        content=content,
        constant=True,
        enabled=True,
        use_probability=True,
        position=0,
        depth=4,
        scan_depth=4,
        keys=json.dumps([]),
        secondary_keys=json.dumps([]),
    ))
    db.commit()
    db.refresh(wb)
    return wb


def _text(result) -> str:
    parts = [result.text or ""]
    parts.extend(c for _, c, _ in result.depth_entries)
    for contents in result.entries_by_position.values():
        parts.extend(contents)
    return "\n".join(parts)


# ────────────────────────── 1. 角色隔离（核心） ──────────────────────────

class TestCharacterIsolation:
    def test_char_bound_book_does_not_leak_into_other_character(self, db_session: Session):
        """绑 Alice 的书**绝不**进 Bob 的会话 —— 本次修复的核心断言。"""
        user = _mk_user(db_session, "iso")
        alice = _mk_char(db_session, user, "Alice")
        bob = _mk_char(db_session, user, "Bob")
        s_a = _mk_session(db_session, user, alice, f"wbiso-s-{uuid.uuid4().hex[:8]}")
        s_b = _mk_session(db_session, user, bob, f"wbiso-s-{uuid.uuid4().hex[:8]}")

        _mk_book(db_session, user, "ALICE-CARD", "SECRET-ALICE-ONLY",
                 character_id=alice.id, wb_type="character_book")
        _mk_book(db_session, user, "ALICE-EXTRA", "SECRET-ALICE-LORE",
                 character_id=alice.id, wb_type="world_book")

        r_b = build_worldbook_context(
            db=db_session, session_id=s_b.id, user_id=user.id,
            recent_messages=[], character=bob,
        )
        t_b = _text(r_b)
        assert "SECRET-ALICE-ONLY" not in t_b, "卡内嵌书串到了 Bob 的会话"
        assert "SECRET-ALICE-LORE" not in t_b, "角色附加书串到了 Bob 的会话"

        r_a = build_worldbook_context(
            db=db_session, session_id=s_a.id, user_id=user.id,
            recent_messages=[], character=alice,
        )
        t_a = _text(r_a)
        assert "SECRET-ALICE-ONLY" in t_a, "Alice 自己的卡内嵌书没生效"
        assert "SECRET-ALICE-LORE" in t_a, "Alice 自己的附加书没生效"

    def test_unbound_book_is_not_injected(self, db_session: Session):
        """
        未绑定角色的书**不注入**（2026-10-03 用户裁定，取代原「全局书生效」契约）。

        用户的实际用法：所有世界书都随角色卡导入、每本都该绑定到具体角色。
        把未绑定的书继续注入所有卡 = 让漏网的那几本继续散播，方向反了。
        ST 的 ``globalSelect`` 是用户手动勾选集，不是「未绑定」的代名词。
        """
        user = _mk_user(db_session, "glob")
        alice = _mk_char(db_session, user, "Alice")
        bob = _mk_char(db_session, user, "Bob")
        s_a = _mk_session(db_session, user, alice, f"wbiso-s-{uuid.uuid4().hex[:8]}")
        s_b = _mk_session(db_session, user, bob, f"wbiso-s-{uuid.uuid4().hex[:8]}")

        _mk_book(db_session, user, "SHARED", "GLOBAL-LORE", character_id=None)

        for sid, char in ((s_a.id, alice), (s_b.id, bob)):
            r = build_worldbook_context(
                db=db_session, session_id=sid, user_id=user.id,
                recent_messages=[], character=char,
            )
            assert "GLOBAL-LORE" not in _text(r), (
                "未绑定的世界书不应注入任何角色（否则跨卡串味）"
            )
            assert "SHARED" not in (r.book_sources or {}), (
                "未绑定的书不应出现在 book_sources 里"
            )

    def test_unbound_book_leaves_rebinding_trace(self, db_session: Session, caplog):
        """未绑定的书要有可观测痕迹，让用户知道该去补绑（不能静默失效）。"""
        import logging as _logging

        user = _mk_user(db_session, "warn")
        alice = _mk_char(db_session, user, "Alice")
        s_a = _mk_session(db_session, user, alice, f"wbiso-s-{uuid.uuid4().hex[:8]}")
        _mk_book(db_session, user, "LOOSE", "LOOSE-LORE", character_id=None)

        with caplog.at_level(_logging.WARNING):
            build_worldbook_context(
                db=db_session, session_id=s_a.id, user_id=user.id,
                recent_messages=[], character=alice,
            )

        msgs = [r.getMessage() for r in caplog.records]
        assert any("[WB-UNBOUND" in m for m in msgs), (
            f"未绑定的书必须留下告警痕迹，实际日志: {msgs}"
        )
        assert any("LOOSE" in m for m in msgs), "告警里应点名是哪本书待绑"

    def test_other_users_book_not_injected_into_my_session(self, db_session: Session):
        """绑定维度必须带 user_id 过滤：别家用户的书不能进我的会话。"""
        u1 = _mk_user(db_session, "own1")
        u2 = _mk_user(db_session, "own2")
        c1 = _mk_char(db_session, u1, "Alice")
        s1 = _mk_session(db_session, u1, c1, f"wbiso-s-{uuid.uuid4().hex[:8]}")

        # 脏数据/越权 FK：别人的书恰好挂在我的角色上
        _mk_book(db_session, u2, "OTHER-USERS", "LEAKED-OTHER-USER",
                 character_id=c1.id)

        r = build_worldbook_context(
            db=db_session, session_id=s1.id, user_id=u1.id,
            recent_messages=[], character=c1,
        )
        assert "LEAKED-OTHER-USER" not in _text(r), "别家用户的书串进来了"


# ────────────────────────── 2/3. 三源判定 + 可见性 ──────────────────────────

class TestThreeSourceAttribution:
    def test_chat_character_global_sources_attributed(self, db_session: Session):
        """chat / character / global 三源各自标记正确。"""
        user = _mk_user(db_session, "three")
        alice = _mk_char(db_session, user, "Alice")
        sid = f"wbiso-s-{uuid.uuid4().hex[:8]}"
        s = _mk_session(db_session, user, alice, sid)

        wb_chat = _mk_book(db_session, user, "CHAT-BOUND", "CHAT-LORE", character_id=None)
        wb_char = _mk_book(db_session, user, "CHAR-BOUND", "CHAR-LORE", character_id=alice.id)
        wb_unbound = _mk_book(db_session, user, "UNBOUND-ONE", "GLOBAL-LORE", character_id=None)
        db_session.add(SessionWorldBook(session_id=sid, world_book_id=wb_chat.id))
        db_session.commit()

        r = build_worldbook_context(
            db=db_session, session_id=sid, user_id=user.id,
            recent_messages=[], character=alice,
        )
        srcs = {m["name"]: m["source"] for m in r.book_sources.values()}
        assert srcs["CHAT-BOUND"] == "chat", f"会话书来源判错: {srcs}"
        assert srcs["CHAR-BOUND"] == "character", f"角色书来源判错: {srcs}"
        # wb_unbound 未绑定且未被会话关联 → 不注入（2026-10-03 修订）
        assert "UNBOUND-ONE" not in srcs, f"未绑定的书不应注入: {srcs}"
        # 只注入两本：会话关联的 + 绑了本角色的
        assert len(r.book_sources) == 2

    def test_book_sources_carries_name_source_and_binding(self, db_session: Session):
        """book_sources 带书名 + 来源 + character_id（用户据此判断"为什么进来了"）。"""
        user = _mk_user(db_session, "vis")
        alice = _mk_char(db_session, user, "Alice")
        sid = f"wbiso-s-{uuid.uuid4().hex[:8]}"
        _mk_session(db_session, user, alice, sid)

        _mk_book(db_session, user, "BOUND", "X", character_id=alice.id)
        _mk_book(db_session, user, "UNBOUND", "Y", character_id=None)

        r = build_worldbook_context(
            db=db_session, session_id=sid, user_id=user.id,
            recent_messages=[], character=alice,
        )
        by_name = {m["name"]: m for m in r.book_sources.values()}
        assert by_name["BOUND"]["source"] == "character"
        assert by_name["BOUND"]["character_id"] == alice.id
        # 未绑定的书不进 book_sources（它不是"以 global 身份进来"，是压根没进）
        assert "UNBOUND" not in by_name


# ────────────────────────── 4. 条目级可观测性 ──────────────────────────

class TestEntryReportObservability:
    def test_activated_entries_carry_lore_source_and_book_name(self, db_session: Session):
        """激活条目带 lore_source / book_name —— 装配报告靠它逐条说明来源。"""
        user = _mk_user(db_session, "rep")
        alice = _mk_char(db_session, user, "Alice")
        bob = _mk_char(db_session, user, "Bob")
        s_a = _mk_session(db_session, user, alice, f"wbiso-s-{uuid.uuid4().hex[:8]}")

        _mk_book(db_session, user, "ALICE-BOOK", "A", character_id=alice.id)
        _mk_book(db_session, user, "BOB-BOOK", "G", character_id=bob.id)

        r = build_worldbook_context(
            db=db_session, session_id=s_a.id, user_id=user.id,
            recent_messages=[], character=alice,
        )
        activated = [e for e in r.debug_report if e.status == "activated"]
        assert activated, "没有任何条目激活"
        by_title = {e.title: e for e in activated}
        assert by_title["ALICE-BOOK-entry"].lore_source == "character"
        assert by_title["ALICE-BOOK-entry"].book_name == "ALICE-BOOK"
        # Bob 的书不进 Alice 的会话（未绑定的书同样不进 —— 两者都不该出现）
        assert "BOB-BOOK-entry" not in by_title
        assert "SHARED-entry" not in by_title


# ────────────────────────── 5. 存量书零回归 ──────────────────────────

class TestLegacyGlobalBooksNoLongerInjected:
    """
    取代原 `TestLegacyGlobalBooksZeroRegression`（2026-10-03 用户裁定后整条废弃）。

    原契约是「存量书（character_id IS NULL）仍按 global 注入，零回归」。
    用户裁定**推翻**了它：实际用法是世界书全部随卡导入、每本都该绑角色，
    让未绑定的书继续注入所有卡＝让漏网的书继续散播，方向反了。
    """

    def test_legacy_unbound_book_is_not_injected(self, db_session: Session):
        """完全模拟存量行（character_id=None, type="world_book"）：不注入任何角色。"""
        user = _mk_user(db_session, "legacy")
        alice = _mk_char(db_session, user, "Alice")
        bob = _mk_char(db_session, user, "Bob")
        s_a = _mk_session(db_session, user, alice, f"wbiso-s-{uuid.uuid4().hex[:8]}")
        s_b = _mk_session(db_session, user, bob, f"wbiso-s-{uuid.uuid4().hex[:8]}")

        _mk_book(db_session, user, "OLD-BOOK", "LEGACY-LORE", character_id=None)

        for sid, char in ((s_a.id, alice), (s_b.id, bob)):
            r = build_worldbook_context(
                db=db_session, session_id=sid, user_id=user.id,
                recent_messages=[], character=char,
            )
            assert "LEGACY-LORE" not in _text(r), (
                "未绑定的书不应注入 —— 它是待归属，不是全局"
            )