"""[ASM-3 2026-10-24] 世界书扫描预览端点回归测试。

被测对象：``POST /api/character-sessions/{session_id}/worldbook-scan``
（backend/app/api/worldbook.py::scan_session_worldbook）。

三组断言：
  1. 基本扫描：激活列表 / worldInfoString / 预算读数来自后端权威装配
     （build_worldbook_context），ST getWorldInfoPrompt 契约形状正确；
  2. 只读性：扫描不落任何 SessionWorldBookEntryState（timed-effects tick 与
     record_activation 写入被 rollback 丢弃），两次扫描结果一致；
  3. **参数-生产一致性**（2026-10-05 教训的守卫）：monkeypatch 双向捕获
     build_worldbook_context 的实参 —— 同一会话上，本端点与生产装配链
     （debug-prompt-assembly → assemble_roleplay_prompt →
     _append_worldbook_context）传给 build_worldbook_context 的 kwargs
     逐项相等；且两者激活条目集合逐项相等。
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
from app.models.character import CharacterChatMessage, CharacterChatSession  # noqa: E402
from app.models.worldbook import (  # noqa: E402
    SessionWorldBookEntryState,
    WorldBook,
    WorldBookStage,
)


# ────────────────────────── fixtures / helpers ──────────────────────────

def _mk_user(db: Session, tag: str) -> User:
    u = User(
        username=f"wbasm3-{tag}-{uuid.uuid4().hex[:8]}",
        hashed_password=get_password_hash("TestPassword1"),
        role="user",
        is_active=True,
    )
    db.add(u)
    db.commit()
    return u


def _mk_char(db: Session, user: User, name: str) -> Character:
    c = Character(id=f"asm3-c-{uuid.uuid4().hex[:8]}", user_id=user.id, name=name)
    db.add(c)
    db.commit()
    return c


def _mk_session(db: Session, user: User, char: Character) -> CharacterChatSession:
    s = CharacterChatSession(
        id=f"asm3-s-{uuid.uuid4().hex[:8]}",
        user_id=user.id,
        character_id=char.id,
        title="asm3",
    )
    db.add(s)
    db.commit()
    return s


def _mk_msg(db: Session, session: CharacterChatSession, role: str, content: str, name: str = "") -> None:
    db.add(CharacterChatMessage(
        session_id=session.id,
        role=role,
        content=content,
        name=name or None,
    ))
    db.commit()


def _mk_book(db: Session, user: User, char: Character, name: str) -> WorldBook:
    """绑角色的书（character 来源）+ 三条条目：constant / 命中关键词 / 不命中。"""
    wb = WorldBook(
        id=f"asm3-wb-{uuid.uuid4().hex[:8]}",
        user_id=user.id,
        character_id=char.id,
        name=name,
        type="world_book",
        format="custom",
        source_type="online_edit",
        is_parsed=True,
    )
    db.add(wb)
    db.commit()

    stages = [
        # constant：每轮必激活（position 0 = before）
        ("constant", "ASM3-CONSTANT-CONTENT", True, json.dumps([]), 0),
        # 关键词命中（position 1 = after）
        ("kw-hit", "ASM3-KEYWORD-CONTENT", False, json.dumps(["灵石"]), 1),
        # 关键词不命中（聊天里没有这个词）
        ("kw-miss", "ASM3-SHOULD-NOT-APPEAR", False, json.dumps(["绝不出现的词"]), 0),
    ]
    for idx, (title, content, constant, keys, position) in enumerate(stages):
        db.add(WorldBookStage(
            id=f"asm3-st-{uuid.uuid4().hex[:8]}-{idx}",
            world_book_id=wb.id,
            stage_index=idx,
            title=title,
            content=content,
            constant=constant,
            enabled=True,
            use_probability=True,
            position=position,
            depth=4,
            scan_depth=4,
            keys=keys,
            secondary_keys=json.dumps([]),
        ))
    db.commit()
    return wb


def _mk_sticky_book(db: Session, user: User, char: Character, name: str) -> WorldBook:
    """constant + sticky 条目：扫描会触发 record_activation 写状态行。"""
    wb = WorldBook(
        id=f"asm3-wbs-{uuid.uuid4().hex[:8]}",
        user_id=user.id,
        character_id=char.id,
        name=name,
        type="world_book",
        format="custom",
        source_type="online_edit",
        is_parsed=True,
    )
    db.add(wb)
    db.commit()
    db.add(WorldBookStage(
        id=f"asm3-sts-{uuid.uuid4().hex[:8]}",
        world_book_id=wb.id,
        stage_index=0,
        title="sticky-entry",
        content="ASM3-STICKY-CONTENT",
        constant=True,
        enabled=True,
        use_probability=True,
        position=0,
        depth=4,
        scan_depth=4,
        keys=json.dumps([]),
        secondary_keys=json.dumps([]),
        sticky=3,
        cooldown=0,
    ))
    db.commit()
    return wb


def _scan(client, session_id: str, body: dict | None = None):
    return client.post(
        f"/api/character-sessions/{session_id}/worldbook-scan",
        json=body or {},
    )


# ────────────────────────── 1. 基本扫描 ──────────────────────────

class TestScanBasics:
    def test_scan_returns_backend_authoritative_activation(self, client, db_session, test_user):
        char = _mk_char(db_session, test_user, "Alice")
        session = _mk_session(db_session, test_user, char)
        _mk_msg(db_session, session, "user", "少年走进坊市，灵石的光泽映在袖口。", name="用户")
        _mk_msg(db_session, session, "assistant", "摊主眯起眼打量来客。", name="Alice")
        _mk_book(db_session, test_user, char, "ASM3-BOOK")

        resp = _scan(client, session.id)
        assert resp.status_code == 200, resp.text
        data = resp.json()

        # 激活集合：constant + 关键词命中；不命中条目 status=skipped
        activated = {e["entry_id"]: e for e in data["entries"] if e["status"] == "activated"}
        skipped = {e["title"] for e in data["entries"] if e["status"] != "activated"}
        assert {e["title"] for e in activated.values()} == {"constant", "kw-hit"}
        assert skipped == {"kw-miss"}
        assert data["activated_entry_ids"] == sorted(activated.keys()) or set(data["activated_entry_ids"]) == set(activated.keys())

        # worldInfoString 含后端判定激活的内容、绝不含未命中条目
        assert "ASM3-CONSTANT-CONTENT" in data["worldInfoString"]
        assert "ASM3-KEYWORD-CONTENT" in data["worldInfoString"]
        assert "ASM3-SHOULD-NOT-APPEAR" not in data["worldInfoString"]

        # ST 契约形状（world-info.js:893-920）：before=position0 / after=position1
        assert data["worldInfoBefore"] == "ASM3-CONSTANT-CONTENT"
        assert data["worldInfoAfter"] == "ASM3-KEYWORD-CONTENT"

        # 预算读数在场（对照面）
        assert data["budget"]["max_context_tokens"] > 0
        assert data["budget"]["world_info_budget"] == 25  # 无用户设置 → 生产默认
        assert data["read_only"] is True

    def test_scan_404_on_foreign_session(self, client, db_session, test_user):
        other = _mk_user(db_session, "other")
        char = _mk_char(db_session, other, "Bob")
        session = _mk_session(db_session, other, char)
        resp = _scan(client, session.id)
        assert resp.status_code == 404


# ────────────────────────── 2. 只读性 ──────────────────────────

class TestScanIsReadOnly:
    def test_scan_leaves_no_entry_state_and_is_idempotent(self, client, db_session, test_user):
        """timed-effects（sticky）在扫描期会写 SessionWorldBookEntryState（
        TimedEffectsManager.record_activation），生产随后 commit；
        本端点 rollback 丢弃 ⇒ 预览不消费 sticky 计数，且两次预览结果一致。

        注意：端点的 db.rollback() 会 expire 共享 db_session 上的 ORM 对象，
        故先把 session.id 快照成纯字符串再发请求（只测表行为，不碰 ORM 状态）。"""
        char = _mk_char(db_session, test_user, "Cara")
        session = _mk_session(db_session, test_user, char)
        sid = str(session.id)
        _mk_msg(db_session, session, "user", "开场", name="用户")
        _mk_sticky_book(db_session, test_user, char, "ASM3-STICKY-BOOK")

        r1 = _scan(client, sid)
        assert r1.status_code == 200
        assert "ASM3-STICKY-CONTENT" in r1.json()["worldInfoString"]

        # 状态表零行（rollback 丢弃 record_activation 的 db.add）
        states = db_session.query(SessionWorldBookEntryState).filter(
            SessionWorldBookEntryState.session_id == sid
        ).all()
        assert states == []

        # 第二次预览结果与第一次逐项一致（未消费 sticky tick）
        r2 = _scan(client, sid)
        assert r2.status_code == 200
        assert r2.json()["worldInfoString"] == r1.json()["worldInfoString"]
        assert r2.json()["activated_entry_ids"] == r1.json()["activated_entry_ids"]


# ────────────────────────── 3. 参数-生产一致性（守卫测试） ──────────────────────────

class TestParamParityWithProduction:
    def test_scan_kwargs_match_production_assembly(self, client, db_session, test_user, monkeypatch):
        """同一会话：生产装配链（debug-prompt-assembly）与本端点传给
        build_worldbook_context 的 kwargs 逐项相等；激活条目集合逐项相等。

        这是 2026-10-05「离线探针参数漂移」教训的结构化守卫：端点参数采集
        逻辑一旦与 roleplay_prompt_assembly._append_worldbook_context 漂移，
        本测试即红。
        """
        import app.services.worldbook_service as wb_service
        import app.services.roleplay_prompt_assembly as rpa

        char = _mk_char(db_session, test_user, "Dora")
        session = _mk_session(db_session, test_user, char)
        _mk_msg(db_session, session, "user", "灵石坊市的灯火", name="用户")
        _mk_msg(db_session, session, "assistant", "她数着掌心的灵石。", name="Dora")
        _mk_book(db_session, test_user, char, "ASM3-PARITY-BOOK")

        captured: list[dict] = []
        real_fn = wb_service.build_worldbook_context

        def _capture(**kwargs):
            captured.append(kwargs)
            return real_fn(**kwargs)

        # 端点侧：函数体内 `from ..services.worldbook_service import build_worldbook_context`
        # 在调用时解析模块属性 ⇒ 打 services 命名空间生效。
        monkeypatch.setattr(wb_service, "build_worldbook_context", _capture)
        # 生产侧：roleplay_prompt_assembly 顶层 from-import 绑定进自己命名空间。
        monkeypatch.setattr(rpa, "build_worldbook_context", _capture)

        # ① 生产链：debug-prompt-assembly（message="" → continue 轮语义）
        # [ASM-2 2026-10-24] debug 端点 model 改必填（T-1 堵口），取证请求
        # 必须显式带与生产一致的 model。
        debug_resp = client.post(
            f"/api/character-sessions/{session.id}/debug-prompt-assembly",
            json={"message": "", "model": "deepseek-v4-flash", "max_tokens": 2048},
        )
        assert debug_resp.status_code == 200, debug_resp.text[:500]

        # ② 预览端点：同会话、同空 message、同 model —— 两侧同 model，
        #    max_context_tokens 解引用才同源，kwargs parity 不因预算分叉假红。
        scan_resp = _scan(client, session.id, {"message": "", "model": "deepseek-v4-flash"})
        assert scan_resp.status_code == 200, scan_resp.text[:500]

        assert len(captured) == 2, f"应恰好捕获两次调用，实际 {len(captured)}"
        production_kwargs, scan_kwargs = captured[0], captured[1]

        # kwargs 逐项相等（db 是同一会话对象，剔除后比对值）
        prod_cmp = {k: v for k, v in production_kwargs.items() if k != "db"}
        scan_cmp = {k: v for k, v in scan_kwargs.items() if k != "db"}
        assert set(prod_cmp.keys()) == set(scan_cmp.keys()), (
            f"kwargs 键集漂移：仅生产有 {set(prod_cmp) - set(scan_cmp)}，"
            f"仅端点有 {set(scan_cmp) - set(prod_cmp)}"
        )
        for key in sorted(prod_cmp):
            assert prod_cmp[key] == scan_cmp[key], (
                f"参数 {key} 漂移：生产={prod_cmp[key]!r} 端点={scan_cmp[key]!r}"
            )

        # 激活条目集合逐项一致：生产 report 的 worldbook_entry_* activated
        # vs 端点 activated_entry_ids（验收 ① 的对照读数）
        report_items = debug_resp.json()["assembly"]["report"]
        prod_activated = {
            item["key"] for item in report_items
            if item["key"].startswith("worldbook_entry_") and item["status"] == "activated"
        }
        prod_activated_ids = {k[len("worldbook_entry_"):] for k in prod_activated}
        scan_activated_ids = set(scan_resp.json()["activated_entry_ids"])
        assert prod_activated_ids == scan_activated_ids, (
            f"激活集合不一致：生产={sorted(prod_activated_ids)} 端点={sorted(scan_activated_ids)}"
        )
        assert len(prod_activated_ids) > 0  # 防御：集合为空时上面的相等是假绿
