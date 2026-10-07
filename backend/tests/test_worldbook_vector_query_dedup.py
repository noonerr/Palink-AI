"""[EMB-DEDUP] 世界书多书查询共享一次嵌入的回归测试（2026-10-07）。

背景：``_collect_vector_hits`` 对每本含 vectorized 条目的书各调一次
``query_entries``，而旧实现里每次调用都对**同一份查询文本**重新嵌入——
挂 N 本书 = 每轮 N 次一模一样的嵌入调用。修复后嵌入一次、向量传参给每本书。

覆盖四件事：

1. 多本书场景下嵌入调用恰好一次，且各书收到同一份查询向量。
2. 嵌入调用失败 → 全部书按 P3 降级（回退关键词），不调 query_entries。
3. 嵌入产出维度 ≠ 契约维度（嵌入器降级）→ 全部书按 P3 降级。
4. ``query_entries(query_vec=...)`` 传入预计算向量后**不再**自行嵌入
   （EMB-DEDUP 的另一半契约）。
"""

import os
import sys
from types import SimpleNamespace

import numpy as np
import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from app.memory_module.config import memory_config
    from app.services.worldbook_service import _collect_vector_hits
    import app.memory_module.embedder as embedder_mod
    import app.services.worldbook_vector_service as wb_vec_svc_mod
    from app.services.worldbook_vector_service import WorldBookVectorService
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")


def _book_entry(world_book_id: str):
    return SimpleNamespace(world_book_id=world_book_id, vectorized=True)


def _recent_msgs():
    return [{"content": "她把剑收回了鞘"}, {"content": "窗外的雨还没停"}]


class TestCollectVectorHitsDedup:
    """嵌入一次、多书共享同一查询向量。"""

    def test_embed_once_shared_across_books(self, db_session, monkeypatch):
        dim = int(memory_config.VECTOR_DIMENSION)
        embed_calls = []

        def fake_embed(texts):
            embed_calls.append(list(texts) if isinstance(texts, list) else texts)
            return np.array([[0.1] * dim], dtype=np.float32)

        monkeypatch.setattr(embedder_mod, "embed_text", fake_embed)

        captured = []

        def fake_query_entries(self, wb_id, query_text, top_k=3, threshold=0.55, query_vec=None):
            captured.append({"wb": wb_id, "vec": list(query_vec), "text": query_text})
            return ([("entry-1", 0.7)], False)

        monkeypatch.setattr(WorldBookVectorService, "query_entries", fake_query_entries)

        hits, degraded = _collect_vector_hits(
            db_session,
            [_book_entry("wb-A"), _book_entry("wb-B"), _book_entry("wb-A")],  # 重复书去重
            _recent_msgs(),
            top_k=3,
            threshold=0.55,
        )

        assert len(embed_calls) == 1, f"同一查询文本必须只嵌入一次，实际 {len(embed_calls)} 次"
        assert len(captured) == 2, "去重后应恰好查询 2 本书"
        assert captured[0]["vec"] == captured[1]["vec"], "两本书必须收到同一份查询向量"
        assert hits == {"entry-1": 0.7}
        assert degraded == set()

    def test_embed_failure_degrades_all_books(self, db_session, monkeypatch):
        """嵌入服务挂 → 全部书降级（P3 回退关键词），不触发逐书查询。"""

        def boom(texts):
            raise RuntimeError("embedding service down")

        monkeypatch.setattr(embedder_mod, "embed_text", boom)

        def fail_query_entries(self, *args, **kwargs):
            pytest.fail("嵌入失败后不应再进入逐书查询")

        monkeypatch.setattr(WorldBookVectorService, "query_entries", fail_query_entries)

        hits, degraded = _collect_vector_hits(
            db_session,
            [_book_entry("wb-A"), _book_entry("wb-B")],
            _recent_msgs(),
            top_k=3,
            threshold=0.55,
        )
        assert hits == {}
        assert degraded == {"wb-A", "wb-B"}, "嵌入失败必须整体降级，不得当真未命中"

    def test_dim_mismatch_degrades_all_books(self, db_session, monkeypatch):
        """[DIM-CONTRACT] 查询向量维度不符（嵌入器降级）→ 全部书降级。"""
        dim = int(memory_config.VECTOR_DIMENSION)
        bad_dim = dim + 1 if dim != 512 else 384

        def degraded_embed(texts):
            return np.array([[0.1] * bad_dim], dtype=np.float32)

        monkeypatch.setattr(embedder_mod, "embed_text", degraded_embed)

        def fail_query_entries(self, *args, **kwargs):
            pytest.fail("维度不符后不应再进入逐书查询")

        monkeypatch.setattr(WorldBookVectorService, "query_entries", fail_query_entries)

        hits, degraded = _collect_vector_hits(
            db_session,
            [_book_entry("wb-A")],
            _recent_msgs(),
            top_k=3,
            threshold=0.55,
        )
        assert hits == {}
        assert degraded == {"wb-A"}


class TestQueryEntriesAcceptsPrecomputedVec:
    """query_entries(query_vec=...) 传入向量后不再自行嵌入。"""

    def test_no_embed_when_vec_given(self, db_session, monkeypatch):
        dim = int(memory_config.VECTOR_DIMENSION)

        def fail_embed(texts):
            pytest.fail("传入 query_vec 后不得再调用嵌入")

        # worldbook_vector_service 顶层 import 绑定了本模块命名空间的名字，
        # 补丁必须打在这里（打在 embedder 原模块不影响已绑定的引用）
        monkeypatch.setattr(wb_vec_svc_mod, "embed_text", fail_embed)

        svc = WorldBookVectorService(db_session)
        # SQLite 上 <=> SQL 必然失败 → 走既有降级路径返回 ([], True)；
        # 本测试只钉"嵌入未被调用"这一条契约。
        hits, degraded = svc.query_entries(
            "wb-x", "随便什么查询文本", top_k=3, threshold=0.55,
            query_vec=[0.1] * dim,
        )
        assert hits == []
        assert degraded is True

    def test_without_vec_still_embeds(self, db_session, monkeypatch):
        """不传 query_vec 时保持原行为（函数内自嵌）——EMB-DEDUP 不改变缺省路径。"""
        dim = int(memory_config.VECTOR_DIMENSION)
        calls = []

        def fake_embed(texts):
            calls.append(texts)
            return np.array([[0.1] * dim], dtype=np.float32)

        monkeypatch.setattr(wb_vec_svc_mod, "embed_text", fake_embed)

        svc = WorldBookVectorService(db_session)
        hits, degraded = svc.query_entries("wb-x", "查询文本", top_k=3, threshold=0.55)
        assert len(calls) == 1, "缺省路径必须保留函数内嵌入"
        assert degraded is True  # SQLite 降级，嵌入确实发生过了
