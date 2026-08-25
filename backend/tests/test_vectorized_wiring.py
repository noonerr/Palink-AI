"""二期批次 V 线：世界书 vectorized 接线验证测试。

spec: docs/SPEC_二期_vectorized接线与N8止损_2026-08-25.md §1
- V-1: 编辑/导入触发点 + 删除清理 + 兜底懒同步门控
- V-2: 向量命中注入（vectorized_hit 标注）/ 未命中不注入 /
  非 vectorized 条目行为不变 / 嵌入异常静默降级
- V-3: vectorized_enabled 开关旁路（默认 false 存量零突变）
  + WI_VECTOR_TOP_K / WI_VECTOR_THRESHOLD env 覆盖
- sync 三态：入库 / 取消 vectorized 清除 / 变更重嵌（content_hash 生效）
- 导入往返：vectorized 字段经 ST V2 导入保真
"""

import json
import os
import sys
import uuid

import numpy as np
import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from sqlalchemy.orm import Session  # noqa: E402

from app.core.security import get_password_hash  # noqa: E402
from app.models import Character, User  # noqa: E402
from app.models.character import CharacterChatSession  # noqa: E402
from app.models.worldbook import WorldBook, WorldBookEntryVector, WorldBookStage  # noqa: E402
from app.services.worldbook_service import (  # noqa: E402
    _resolve_vector_threshold,
    _resolve_vector_top_k,
    _vector_query_text,
    build_worldbook_context,
)

WI_POS_AT_DEPTH = 4


def _mk_user(db_session: Session) -> User:
    user = User(
        username=f"vecuser-{uuid.uuid4().hex[:10]}",
        hashed_password=get_password_hash("TestPassword1"),
        role="user",
        is_active=True,
    )
    db_session.add(user)
    db_session.flush()
    return user


def _mk_parents(db_session: Session, sess_id: str, book_id: str):
    """创建 user + character + session + worldbook 四件套。"""
    user = _mk_user(db_session)
    char = Character(id=f"vecc-{uuid.uuid4().hex[:8]}", user_id=user.id, name="VecChar")
    db_session.add(char)
    db_session.flush()
    db_session.add(CharacterChatSession(
        id=sess_id, user_id=user.id, character_id=char.id, title="vec",
    ))
    db_session.add(WorldBook(id=book_id, user_id=user.id, name="vec-book"))
    db_session.commit()
    return user, char


def _mk_stage(eid: str, key: str, content: str, *, vectorized: bool = False,
              world_book_id: str = "wb") -> WorldBookStage:
    return WorldBookStage(
        id=eid,
        world_book_id=world_book_id,
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
        vectorized=vectorized,
    )


# ---------------------------------------------------------------------------
# sync 三态（真实 sync_worldbook_vectors + mock embed_text，SQLite 可跑）
# ---------------------------------------------------------------------------
class TestSyncThreeStates:
    def _fake_embed(self, texts):
        n = len(texts) if isinstance(texts, (list, tuple)) else 1
        return np.ones((n, 512), dtype="float32") * 0.01

    def _sync(self, db_session, book_id):
        from app.services.worldbook_vector_service import WorldBookVectorService
        svc = WorldBookVectorService(db_session)
        return svc.sync_worldbook_vectors(book_id)

    def test_vectorized_entry_gets_embedded(self, db_session, monkeypatch):
        monkeypatch.setattr(
            "app.services.worldbook_vector_service.embed_text", self._fake_embed,
        )
        _mk_parents(db_session, "sess-sync-a", "wb-sync-a")
        db_session.add(_mk_stage("vsync-a", "dragon", "Dragon lore", vectorized=True,
                                 world_book_id="wb-sync-a"))
        db_session.commit()

        result = self._sync(db_session, "wb-sync-a")
        assert result.get("synced") == 1, f"vectorized 条目应入库: {result}"
        row = db_session.query(WorldBookEntryVector).filter_by(entry_id="vsync-a").one()
        assert len(row.content_hash) == 64, "content_hash 应为 blake2b 十六进制"
        assert row.embedding.startswith("[") and row.embedding.endswith("]")

    def test_content_change_reembeds_via_hash(self, db_session, monkeypatch):
        monkeypatch.setattr(
            "app.services.worldbook_vector_service.embed_text", self._fake_embed,
        )
        _mk_parents(db_session, "sess-sync-b", "wb-sync-b")
        db_session.add(_mk_stage("vsync-b", "dragon", "Dragon lore", vectorized=True,
                                 world_book_id="wb-sync-b"))
        db_session.commit()

        first = self._sync(db_session, "wb-sync-b")
        second = self._sync(db_session, "wb-sync-b")
        assert second.get("skipped") == 1 and second.get("synced") == 0, \
            "内容未变时应被 content_hash 跳过"

        stage = (
            db_session.query(WorldBookStage)
            .filter(WorldBookStage.id == "vsync-b")
            .first()
        )
        stage.content = "Dragon lore updated"
        db_session.commit()
        third = self._sync(db_session, "wb-sync-b")
        assert third.get("synced") == 1, "内容变更后应重嵌入"

    def test_unvectorized_clears_existing_vectors(self, db_session, monkeypatch):
        monkeypatch.setattr(
            "app.services.worldbook_vector_service.embed_text", self._fake_embed,
        )
        _mk_parents(db_session, "sess-sync-c", "wb-sync-c")
        db_session.add(_mk_stage("vsync-c", "dragon", "Dragon lore", vectorized=True,
                                 world_book_id="wb-sync-c"))
        db_session.commit()
        assert self._sync(db_session, "wb-sync-c").get("synced") == 1

        stage = (
            db_session.query(WorldBookStage)
            .filter(WorldBookStage.id == "vsync-c")
            .first()
        )
        stage.vectorized = False
        db_session.commit()
        cleared = self._sync(db_session, "wb-sync-c")
        assert cleared.get("deleted") == 1, "取消 vectorized 应清除向量行"
        remain = db_session.query(WorldBookEntryVector).filter_by(entry_id="vsync-c").count()
        assert remain == 0


# ---------------------------------------------------------------------------
# V-1 触发点接线（API 端点层，mock fire 函数记录调用）
# ---------------------------------------------------------------------------
class TestSyncTriggerWiring:
    def _setup_client_book(self, db_session, *, vectorized: bool):
        from fastapi.testclient import TestClient
        from app.main import app

        user = _mk_user(db_session)
        db_session.add(WorldBook(id="wb-trig", user_id=user.id, name="trig-book"))
        db_session.add(_mk_stage("vtrig-1", "dragon", "Dragon lore",
                                 vectorized=vectorized, world_book_id="wb-trig"))
        db_session.commit()

        def _override_get_db():
            yield db_session

        async def _override_user():
            return user

        app.dependency_overrides[app.dependency_overrides_keys[0]] = _override_get_db \
            if False else None  # pragma: no cover
        return app

    def test_stage_update_triggers_sync(self, db_session, monkeypatch):
        """条目编辑路径：vectorized 书 commit 后应调度 sync。"""
        from app.api import worldbook as wb_api

        _mk_parents(db_session, "sess-t1", "wb-t1")
        db_session.add(_mk_stage("vt1", "dragon", "Dragon lore", vectorized=True,
                                 world_book_id="wb-t1"))
        db_session.commit()

        fired: list[str] = []
        monkeypatch.setattr(wb_api, "_fire_vector_sync", lambda bid: fired.append(bid))
        wb_api._schedule_worldbook_vector_sync(db_session, "wb-t1")
        assert fired == ["wb-t1"], "含 vectorized 条目的书编辑后必须调度同步"

    def test_schedule_gate_skips_non_vectorized_books(self, db_session, monkeypatch):
        """无 vectorized 条目的书不应触发同步（存量零突变）。"""
        from app.api import worldbook as wb_api

        _mk_parents(db_session, "sess-t2", "wb-t2")
        db_session.add(_mk_stage("vt2", "dragon", "Dragon lore", vectorized=False,
                                 world_book_id="wb-t2"))
        db_session.commit()

        fired: list[str] = []
        monkeypatch.setattr(wb_api, "_fire_vector_sync", lambda bid: fired.append(bid))
        wb_api._schedule_worldbook_vector_sync(db_session, "wb-t2")
        assert fired == [], "无 vectorized 条目时不得触发"

    def test_import_endpoint_fires_sync_for_vectorized_entries(
        self, client, db_session, monkeypatch,
    ):
        """ST V2 导入路径：含 vectorized 条目时 commit 后调度同步。"""
        from app.api import worldbook as wb_api

        payload = {
            "name": "imported-vec-book",
            "entries": {
                "0": {"uid": 0, "key": ["dragon"], "keysecondary": [],
                      "content": "Dragon lore", "comment": "d",
                      "disable": False, "vectorized": True},
                "1": {"uid": 1, "key": ["wolf"], "keysecondary": [],
                      "content": "Wolf lore", "comment": "w",
                      "disable": False, "vectorized": False},
            },
        }
        fired: list[str] = []
        monkeypatch.setattr(wb_api, "_fire_vector_sync", lambda bid: fired.append(bid))
        resp = client.post(
            "/api/worldbooks/import",
            files={"file": ("wb.json", json.dumps(payload).encode(), "application/json")},
        )
        assert resp.status_code == 200, resp.text
        wb_id = resp.json()["id"]
        assert fired == [wb_id], "导入含 vectorized 条目后应调度一次同步"

    def test_delete_endpoint_fires_vector_cleanup(self, client, db_session, monkeypatch):
        """删除世界书路径：应调度 delete_vectors 清理。"""
        from app.api import worldbook as wb_api

        payload = {
            "name": "to-delete",
            "entries": {
                "0": {"uid": 0, "key": ["k"], "keysecondary": [],
                      "content": "c", "comment": "", "disable": False},
            },
        }
        resp = client.post(
            "/api/worldbooks/import",
            files={"file": ("wd.json", json.dumps(payload).encode(), "application/json")},
        )
        wb_id = resp.json()["id"]

        deleted: list[str] = []
        monkeypatch.setattr(wb_api, "_fire_vector_delete", lambda bid: deleted.append(bid))
        resp = client.delete(f"/api/worldbooks/{wb_id}")
        assert resp.status_code == 200
        assert deleted == [wb_id], "删除世界书应清理向量行"


# ---------------------------------------------------------------------------
# V-2 检索注入（引擎级，mock _collect_vector_hits）
# ---------------------------------------------------------------------------
class TestVectorInjection:
    def _setup_book(self, db_session, sess_id="sess-vinj", book_id="wb-vinj"):
        user, char = _mk_parents(db_session, sess_id, book_id)
        hit = _mk_stage("vinj-hit", "unused-key-hit", "Semantically relevant lore",
                        vectorized=True, world_book_id=book_id)
        miss = _mk_stage("vinj-miss", "unused-key-miss", "Irrelevant lore",
                         vectorized=True, world_book_id=book_id)
        normal = _mk_stage("vinj-normal", "dragon", "Keyword dragon lore",
                           vectorized=False, world_book_id=book_id)
        hit.stage_index, miss.stage_index, normal.stage_index = 0, 1, 2
        db_session.add_all([hit, miss, normal])
        db_session.commit()
        msgs = [{"role": "user", "content": "tell me about the dragon"}]
        return user, char, msgs

    def test_hit_enters_activated_with_annotation(self, db_session, monkeypatch):
        user, char, msgs = self._setup_book(db_session)
        monkeypatch.setattr(
            "app.services.worldbook_service._collect_vector_hits",
            lambda db, entries, recent, top_k=None, threshold=None: {"vinj-hit": 0.8712},
        )
        result = build_worldbook_context(
            db=db_session, session_id="sess-vinj", user_id=user.id,
            recent_messages=list(msgs), character=char,
            enable_timed_effects=False, vectorized_enabled=True,
        )
        all_text = "\n".join([result.text or ""] +
                             [c for _, c, _ in result.depth_entries])
        assert "Semantically relevant lore" in all_text, "向量命中的条目必须注入"
        reports = {r.entry_id: r for r in result.debug_report}
        assert reports["vinj-hit"].status == "activated"
        assert reports["vinj-hit"].reason.startswith("vectorized_hit(score="), \
            f"debug report 必须带 score 标注: {reports['vinj-hit'].reason}"

    def test_miss_stays_out_and_keyword_entry_unaffected(self, db_session, monkeypatch):
        user, char, msgs = self._setup_book(db_session)
        monkeypatch.setattr(
            "app.services.worldbook_service._collect_vector_hits",
            lambda db, entries, recent, top_k=None, threshold=None: {"vinj-hit": 0.9},
        )
        result = build_worldbook_context(
            db=db_session, session_id="sess-vinj", user_id=user.id,
            recent_messages=list(msgs), character=char,
            enable_timed_effects=False, vectorized_enabled=True,
        )
        all_text = "\n".join([result.text or ""] +
                             [c for _, c, _ in result.depth_entries])
        assert "Irrelevant lore" not in all_text, "未命中的 vectorized 条目不得注入"
        reports = {r.entry_id: r for r in result.debug_report}
        miss_reports = [r for rid, r in reports.items() if rid == "vinj-miss"]
        assert miss_reports and miss_reports[-1].status == "skipped"
        assert miss_reports[-1].reason == "vectorized_no_match"
        assert "Keyword dragon lore" in all_text, "非 vectorized 关键词条目不受影响"
        assert reports["vinj-normal"].status == "activated"
        assert reports["vinj-normal"].reason == "keyword_match"

    def test_switch_off_bypasses_whole_chain(self, db_session, monkeypatch):
        """开关关闭：整条链路旁路——不调检索、vectorized 列被忽略（回归基线）。"""
        user, char, msgs = self._setup_book(db_session)
        calls: list[int] = []
        monkeypatch.setattr(
            "app.services.worldbook_service._collect_vector_hits",
            lambda *a, **k: calls.append(1) or {},
        )
        result = build_worldbook_context(
            db=db_session, session_id="sess-vinj", user_id=user.id,
            recent_messages=list(msgs), character=char,
            enable_timed_effects=False, vectorized_enabled=False,
        )
        assert calls == [], "开关关闭时不得发起任何向量检索"
        all_text = "\n".join([result.text or ""] +
                             [c for _, c, _ in result.depth_entries])
        assert "Keyword dragon lore" in all_text, "非 vectorized 行为完全不变"

    def test_embed_failure_degrades_silently(self, db_session, monkeypatch):
        """检索抛异常 → 静默降级为本轮无命中，主流程绝不阻塞。"""
        user, char, msgs = self._setup_book(db_session)

        def _boom(*a, **k):
            raise RuntimeError("embedding service unavailable")

        monkeypatch.setattr(
            "app.services.worldbook_service._collect_vector_hits", _boom,
        )
        result = build_worldbook_context(
            db=db_session, session_id="sess-vinj", user_id=user.id,
            recent_messages=list(msgs), character=char,
            enable_timed_effects=False, vectorized_enabled=True,
        )
        all_text = "\n".join([result.text or ""] +
                             [c for _, c, _ in result.depth_entries])
        assert "Semantically relevant lore" not in all_text, "降级时本轮无向量命中"
        assert "Keyword dragon lore" in all_text, "关键词管线不受影响"

    def test_query_text_uses_last4_messages_truncated(self):
        msgs = [{"role": "user", "content": f"m{i}"} for i in range(6)]
        text = _vector_query_text(msgs)
        lines = text.split("\n")
        assert lines == ["m2", "m3", "m4", "m5"], "查询文本应取最近 4 条消息"
        long_msgs = [{"role": "user", "content": "x" * 1500} for _ in range(3)]
        assert len(_vector_query_text(long_msgs)) <= 2000, "拼接结果须截断至 ~2000 字符"


# ---------------------------------------------------------------------------
# V-3 参数解析（显式参数 > env > 默认）
# ---------------------------------------------------------------------------
class TestVectorParams:
    def test_defaults_without_env(self, monkeypatch):
        monkeypatch.delenv("WI_VECTOR_TOP_K", raising=False)
        monkeypatch.delenv("WI_VECTOR_THRESHOLD", raising=False)
        assert _resolve_vector_top_k() == 5
        assert _resolve_vector_threshold() == 0.25

    def test_env_override(self, monkeypatch):
        monkeypatch.setenv("WI_VECTOR_TOP_K", "7")
        monkeypatch.setenv("WI_VECTOR_THRESHOLD", "0.5")
        assert _resolve_vector_top_k() == 7
        assert _resolve_vector_threshold() == 0.5

    def test_explicit_params_win_over_env(self, monkeypatch):
        monkeypatch.setenv("WI_VECTOR_TOP_K", "7")
        monkeypatch.setenv("WI_VECTOR_THRESHOLD", "0.5")
        assert _resolve_vector_top_k(3) == 3
        assert _resolve_vector_threshold(0.8) == 0.8

    def test_invalid_env_falls_back_to_default(self, monkeypatch):
        monkeypatch.setenv("WI_VECTOR_TOP_K", "not-a-number")
        monkeypatch.setenv("WI_VECTOR_THRESHOLD", "oops")
        assert _resolve_vector_top_k() == 5
        assert _resolve_vector_threshold() == 0.25


# ---------------------------------------------------------------------------
# 导入往返：vectorized 字段经 ST V2 导入保真
# ---------------------------------------------------------------------------
class TestImportRoundtrip:
    def test_vectorized_flag_survives_import(self, client, db_session):
        payload = {
            "name": "roundtrip-vec",
            "entries": {
                "0": {"uid": 0, "key": ["on"], "keysecondary": [],
                      "content": "entry one", "comment": "",
                      "disable": False, "vectorized": True},
                "1": {"uid": 1, "key": ["off"], "keysecondary": [],
                      "content": "entry two", "comment": "",
                      "disable": False, "vectorized": False},
            },
        }
        resp = client.post(
            "/api/worldbooks/import",
            files={"file": ("rt.json", json.dumps(payload).encode(), "application/json")},
        )
        assert resp.status_code == 200, resp.text
        wb_id = resp.json()["id"]
        stages = (
            db_session.query(WorldBookStage)
            .filter(WorldBookStage.world_book_id == wb_id)
            .order_by(WorldBookStage.stage_index)
            .all()
        )
        flags = {s.stage_index: s.vectorized for s in stages}
        assert flags[0] is True, "vectorized=true 必须经导入保真"
        assert flags[1] is False, "vectorized=false 必须经导入保真"
