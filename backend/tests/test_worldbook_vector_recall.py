"""世界书向量召回接通与防护（P1~P4）验证测试。

spec: docs/SPEC_世界书向量召回接通与防护_2026-09-29.md
- P1: top_k/threshold 解析优先级（显式 > settings > env > 默认 3/0.55）
      + settings 层读取（world_info_settings.vector_top_k / vector_threshold）
      + build_worldbook_context 解析接线（装配层保持零接触）
- P2/P3/P4 用例随对应提交追加。

全程零成本：嵌入一律 mock，不碰任何外部模型。
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
from app.models import Character, User, UserSetting  # noqa: E402
from app.models.character import CharacterChatSession  # noqa: E402
from app.models.worldbook import WorldBook, WorldBookStage  # noqa: E402
from app.services.worldbook_service import (  # noqa: E402
    _read_vector_params_from_settings,
    _resolve_vector_threshold,
    _resolve_vector_top_k,
    build_worldbook_context,
)

WI_POS_AT_DEPTH = 4


def _mk_parents(db_session: Session, sess_id: str, book_id: str):
    """user + character + session + worldbook（character_id=None → global lore）。"""
    user = User(
        username=f"wbvec-{uuid.uuid4().hex[:10]}",
        hashed_password=get_password_hash("TestPassword1"),
        role="user",
        is_active=True,
    )
    db_session.add(user)
    db_session.flush()
    char = Character(id=f"wbvecc-{uuid.uuid4().hex[:8]}", user_id=user.id, name="WbVecChar")
    db_session.add(char)
    db_session.flush()
    db_session.add(CharacterChatSession(
        id=sess_id, user_id=user.id, character_id=char.id, title="wbvec",
    ))
    db_session.add(WorldBook(id=book_id, user_id=user.id, name="wbvec-book"))
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
# P1: 参数解析优先级——显式 > settings > env > 默认（3 / 0.55）
# ---------------------------------------------------------------------------
class TestP1ParamResolution:
    def test_settings_layer_wins_over_env(self, monkeypatch):
        monkeypatch.setenv("WI_VECTOR_TOP_K", "7")
        monkeypatch.setenv("WI_VECTOR_THRESHOLD", "0.4")
        assert _resolve_vector_top_k(None, 4) == 4
        assert _resolve_vector_threshold(None, 0.7) == 0.7

    def test_explicit_wins_over_settings_and_env(self, monkeypatch):
        monkeypatch.setenv("WI_VECTOR_TOP_K", "7")
        monkeypatch.setenv("WI_VECTOR_THRESHOLD", "0.4")
        assert _resolve_vector_top_k(2, 9) == 2
        assert _resolve_vector_threshold(0.8, 0.9) == 0.8

    def test_settings_clamped_to_legal_range(self, monkeypatch):
        monkeypatch.delenv("WI_VECTOR_TOP_K", raising=False)
        monkeypatch.delenv("WI_VECTOR_THRESHOLD", raising=False)
        assert _resolve_vector_top_k(None, 99) == 10
        assert _resolve_vector_top_k(None, 0) == 1
        assert _resolve_vector_threshold(None, 1.5) == 1.0
        assert _resolve_vector_threshold(None, -0.5) == 0.0

    def test_invalid_settings_fall_through_to_env(self, monkeypatch):
        monkeypatch.setenv("WI_VECTOR_TOP_K", "6")
        monkeypatch.setenv("WI_VECTOR_THRESHOLD", "0.6")
        assert _resolve_vector_top_k(None, "abc") == 6
        assert _resolve_vector_threshold(None, "oops") == 0.6


# ---------------------------------------------------------------------------
# P1: settings 层读取（world_info_settings.vector_top_k / vector_threshold）
# ---------------------------------------------------------------------------
class TestP1SettingsRead:
    def test_reads_vector_keys(self, db_session):
        user, _ = _mk_parents(db_session, "sess-p1a", "wb-p1a")
        db_session.add(UserSetting(
            user_id=user.id,
            silly_tavern_settings=json.dumps({
                "world_info_settings": {"vector_top_k": 4, "vector_threshold": 0.7},
            }),
        ))
        db_session.commit()
        assert _read_vector_params_from_settings(db_session, user.id) == (4, 0.7)

    def test_invalid_value_returns_none_for_that_key(self, db_session):
        user, _ = _mk_parents(db_session, "sess-p1b", "wb-p1b")
        db_session.add(UserSetting(
            user_id=user.id,
            silly_tavern_settings=json.dumps({
                "world_info_settings": {"vector_top_k": "abc", "vector_threshold": 0.7},
            }),
        ))
        db_session.commit()
        assert _read_vector_params_from_settings(db_session, user.id) == (None, 0.7)

    def test_missing_user_setting_returns_none(self, db_session):
        user, _ = _mk_parents(db_session, "sess-p1c", "wb-p1c")
        assert _read_vector_params_from_settings(db_session, user.id) == (None, None)

    def test_non_dict_world_info_settings_returns_none(self, db_session):
        user, _ = _mk_parents(db_session, "sess-p1d", "wb-p1d")
        db_session.add(UserSetting(
            user_id=user.id,
            silly_tavern_settings=json.dumps({"world_info_settings": "garbage"}),
        ))
        db_session.commit()
        assert _read_vector_params_from_settings(db_session, user.id) == (None, None)


# ---------------------------------------------------------------------------
# P1: build_worldbook_context 解析接线（settings 层在服务内部读取，
#     装配层 roleplay_prompt_assembly 保持零接触）
# ---------------------------------------------------------------------------
class TestP1BuildWiring:
    def _setup(self, db_session, sess_id, book_id, wis=None):
        user, char = _mk_parents(db_session, sess_id, book_id)
        if wis is not None:
            db_session.add(UserSetting(
                user_id=user.id,
                silly_tavern_settings=json.dumps({"world_info_settings": wis}),
            ))
            db_session.commit()
        db_session.add(_mk_stage(f"{book_id}-stage", "dragon", "Dragon lore",
                                 vectorized=False, world_book_id=book_id))
        db_session.commit()
        msgs = [{"role": "user", "content": "tell me about the dragon"}]
        return user, char, msgs

    def _capture_collect(self, monkeypatch, captured):
        def _fake_collect(db, entries, recent, top_k=None, threshold=None):
            captured.update(top_k=top_k, threshold=threshold)
            return {}
        monkeypatch.setattr(
            "app.services.worldbook_service._collect_vector_hits", _fake_collect,
        )

    def test_defaults_reach_collect(self, db_session, monkeypatch):
        user, char, msgs = self._setup(db_session, "sess-p1e", "wb-p1e")
        monkeypatch.delenv("WI_VECTOR_TOP_K", raising=False)
        monkeypatch.delenv("WI_VECTOR_THRESHOLD", raising=False)
        captured: dict = {}
        self._capture_collect(monkeypatch, captured)
        build_worldbook_context(
            db=db_session, session_id="sess-p1e", user_id=user.id,
            recent_messages=list(msgs), character=char,
            enable_timed_effects=False, vectorized_enabled=True,
        )
        assert captured == {"top_k": 3, "threshold": 0.55}, \
            "无 settings 无 env 时应落到新默认 3/0.55"

    def test_settings_reach_collect(self, db_session, monkeypatch):
        user, char, msgs = self._setup(
            db_session, "sess-p1f", "wb-p1f",
            wis={"vector_top_k": 4, "vector_threshold": 0.7},
        )
        captured: dict = {}
        self._capture_collect(monkeypatch, captured)
        build_worldbook_context(
            db=db_session, session_id="sess-p1f", user_id=user.id,
            recent_messages=list(msgs), character=char,
            enable_timed_effects=False, vectorized_enabled=True,
        )
        assert captured == {"top_k": 4, "threshold": 0.7}, \
            "settings 层值应优先于 env/默认抵达检索"

    def test_switch_off_skips_settings_read_and_collect(self, db_session, monkeypatch):
        user, char, msgs = self._setup(
            db_session, "sess-p1g", "wb-p1g",
            wis={"vector_top_k": 4, "vector_threshold": 0.7},
        )
        calls: list[int] = []
        monkeypatch.setattr(
            "app.services.worldbook_service._collect_vector_hits",
            lambda *a, **k: calls.append(1) or {},
        )
        build_worldbook_context(
            db=db_session, session_id="sess-p1g", user_id=user.id,
            recent_messages=list(msgs), character=char,
            enable_timed_effects=False, vectorized_enabled=False,
        )
        assert calls == [], "开关关闭时不得发起检索"


# ---------------------------------------------------------------------------
# P3: 降级信号（degraded_books）→ 有关键词的 vectorized 条目回退关键词匹配
# ---------------------------------------------------------------------------
class TestP3DegradedFallback:
    def _setup(self, db_session, sess_id, book_id, *, with_keys=True):
        """vectorized 条目（可选关键词）+ 普通 key 条目。"""
        user, char = _mk_parents(db_session, sess_id, book_id)
        vec_entry = _mk_stage(
            f"{book_id}-vec", "dragon" if with_keys else "unused-key",
            "Vectorized dragon lore", vectorized=True, world_book_id=book_id,
        )
        vec_entry.stage_index = 0
        if not with_keys:
            vec_entry.keys = json.dumps([])
        normal = _mk_stage(f"{book_id}-normal", "dragon", "Keyword dragon lore",
                           vectorized=False, world_book_id=book_id)
        normal.stage_index = 1
        db_session.add_all([vec_entry, normal])
        db_session.commit()
        msgs = [{"role": "user", "content": "tell me about the dragon"}]
        return user, char, msgs

    def test_degraded_book_falls_back_to_keywords(self, db_session, monkeypatch):
        """降级书 + 有关键词 → 回退关键词匹配，report 如实标注回退原因。"""
        user, char, msgs = self._setup(db_session, "sess-p3a", "wb-p3a")
        monkeypatch.setattr(
            "app.services.worldbook_service._collect_vector_hits",
            lambda db, entries, recent, top_k=None, threshold=None: ({}, {"wb-p3a"}),
        )
        result = build_worldbook_context(
            db=db_session, session_id="sess-p3a", user_id=user.id,
            recent_messages=list(msgs), character=char,
            enable_timed_effects=False, vectorized_enabled=True,
        )
        all_text = "\n".join([result.text or ""] +
                             [c for _, c, _ in result.depth_entries])
        assert "Vectorized dragon lore" in all_text, \
            "降级时有关键词的 vectorized 条目必须回退关键词匹配注入"
        reports = {r.entry_id: r for r in result.debug_report}
        assert reports["wb-p3a-vec"].status == "activated"
        assert reports["wb-p3a-vec"].reason == "vectorized_degraded_keyword_fallback", \
            f"回退激活必须带专属 reason: {reports['wb-p3a-vec'].reason}"
        assert reports["wb-p3a-normal"].reason == "keyword_match", \
            "普通条目 reason 不受降级影响"

    def test_degraded_no_keywords_stays_out_with_honest_reason(self, db_session, monkeypatch):
        """降级书 + 无关键词 → 如实记 skipped（不再静默消失，也不再伪装 no_match）。"""
        user, char, msgs = self._setup(db_session, "sess-p3b", "wb-p3b", with_keys=False)
        monkeypatch.setattr(
            "app.services.worldbook_service._collect_vector_hits",
            lambda db, entries, recent, top_k=None, threshold=None: ({}, {"wb-p3b"}),
        )
        result = build_worldbook_context(
            db=db_session, session_id="sess-p3b", user_id=user.id,
            recent_messages=list(msgs), character=char,
            enable_timed_effects=False, vectorized_enabled=True,
        )
        all_text = "\n".join([result.text or ""] +
                             [c for _, c, _ in result.depth_entries])
        assert "Vectorized dragon lore" not in all_text, "无关键词无命中，不得注入"
        reports = {r.entry_id: r for r in result.debug_report}
        vec_reports = [r for r in result.debug_report if r.entry_id == "wb-p3b-vec"]
        assert vec_reports and vec_reports[-1].status == "skipped"
        assert vec_reports[-1].reason == "vectorized_degraded_no_keywords"

    def test_healthy_book_no_match_unchanged(self, db_session, monkeypatch):
        """健康书（未降级）+ 未命中 → 语义保持 vectorized_no_match（回归基线）。"""
        user, char, msgs = self._setup(db_session, "sess-p3c", "wb-p3c")
        monkeypatch.setattr(
            "app.services.worldbook_service._collect_vector_hits",
            lambda db, entries, recent, top_k=None, threshold=None: ({}, set()),
        )
        result = build_worldbook_context(
            db=db_session, session_id="sess-p3c", user_id=user.id,
            recent_messages=list(msgs), character=char,
            enable_timed_effects=False, vectorized_enabled=True,
        )
        reports = [r for r in result.debug_report if r.entry_id == "wb-p3c-vec"]
        assert reports and reports[-1].status == "skipped"
        assert reports[-1].reason == "vectorized_no_match"


class TestP3CollectDegradedSignals:
    """_collect_vector_hits 自身的降级判定（真函数 + mock 向量服务）。"""

    def _mk_book_with_vec_entry(self, db_session, sess_id, book_id):
        user, char = _mk_parents(db_session, sess_id, book_id)
        db_session.add(_mk_stage(f"{book_id}-vec", "dragon", "Dragon lore",
                                 vectorized=True, world_book_id=book_id))
        db_session.commit()
        msgs = [{"role": "user", "content": "about the dragon"}]
        return user, char, msgs

    def _collect(self, db_session, entries, msgs):
        from app.services.worldbook_service import _collect_vector_hits
        return _collect_vector_hits(db_session, entries, msgs, top_k=3, threshold=0.55)

    def _entries(self, db_session, book_id):
        return (
            db_session.query(WorldBookStage)
            .filter(WorldBookStage.world_book_id == book_id)
            .all()
        )

    def test_query_failure_marks_book_degraded(self, db_session, monkeypatch):
        from app.services.worldbook_vector_service import WorldBookVectorService

        user, char, msgs = self._mk_book_with_vec_entry(db_session, "sess-p3d", "wb-p3d")
        monkeypatch.setattr(
            WorldBookVectorService, "sync_worldbook_vectors",
            lambda self, bid: {"synced": 0, "skipped": 0, "deleted": 0},
        )

        def _boom(self, bid, qtext, top_k=3, threshold=0.55):
            raise RuntimeError("embedding service unavailable")

        monkeypatch.setattr(WorldBookVectorService, "query_entries", _boom)
        hits, degraded = self._collect(db_session, self._entries(db_session, "wb-p3d"), msgs)
        assert hits == {}
        assert degraded == {"wb-p3d"}, "查询异常的书必须标记为降级"

    def test_query_success_no_degradation(self, db_session, monkeypatch):
        from app.services.worldbook_vector_service import WorldBookVectorService

        user, char, msgs = self._mk_book_with_vec_entry(db_session, "sess-p3e", "wb-p3e")
        monkeypatch.setattr(
            WorldBookVectorService, "sync_worldbook_vectors",
            lambda self, bid: {"synced": 0, "skipped": 0, "deleted": 0},
        )
        monkeypatch.setattr(
            WorldBookVectorService, "query_entries",
            lambda self, bid, qtext, top_k=3, threshold=0.55: ([("x1", 0.9)], False),
        )
        hits, degraded = self._collect(db_session, self._entries(db_session, "wb-p3e"), msgs)
        assert hits == {"x1": 0.9}
        assert degraded == set(), "查询成功且未降级时不得标记"

    def test_empty_query_text_degrades_all_books(self, db_session):
        user, char, msgs = self._mk_book_with_vec_entry(db_session, "sess-p3f", "wb-p3f")
        hits, degraded = self._collect(
            db_session, self._entries(db_session, "wb-p3f"),
            [{"role": "user", "content": ""}],
        )
        assert hits == {}
        assert degraded == {"wb-p3f"}, "查询文本为空时应整书降级（回退关键词）"
