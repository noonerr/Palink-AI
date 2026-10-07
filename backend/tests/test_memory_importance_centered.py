"""[IMP-CENTER] importance 评分项居中化的回归测试（2026-10-07）。

背景：``_score_candidates`` 旧公式 ``similarity*0.6 + ctx*0.2 + importance*0.2``
里，自动入库记忆的 importance 恒为默认 0.5（写入点全部硬编码，前端无设置
入口），等价于给所有候选加常数 +0.1——不改变排序，却让这 20% 权重"假装存在"。

居中后 ``（importance − 0.5) × 0.2``：

1. 默认 0.5 的行贡献恰好为 0 → 候选间排序与「纯 similarity+ctx」一致；
2. 与旧公式相比，**所有默认行的相对次序逐条不变**（旧式多加的是同一常数）；
3. 手动经 /api/memory/vector/store 设置过 importance 的行仍按偏离 0.5 的
   幅度浮动，人工加权能力保留。
"""

import os
import sys
from datetime import datetime

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from app.memory_module.models import MemoryEntry
    from app.memory_module.retriever import MemoryRetriever
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")

_NOW = datetime(2026, 10, 7, 12, 0, 0)


def _entry(row_id: int, importance: float = 0.5) -> MemoryEntry:
    """embedding 置 None → _compute_context_proximity 对全部候选返回 0，
    评分退化为 similarity 与 importance 的纯函数，便于精确断言。"""
    return MemoryEntry(
        id=row_id,
        user_id=1,
        session_id="s",
        branch_id=None,
        message_id=None,
        role="assistant",
        content=f"记忆正文 {row_id}",
        importance_score=importance,
        topics=[],
        tokens_count=10,
        created_at=_NOW,
        embedding=None,
    )


def _score_all(candidates):
    retriever = MemoryRetriever(storage=None)
    return {m.id: score for m, score in retriever._score_candidates(candidates, stm_ids=set())}


class TestImportanceCentered:
    def test_default_importance_contributes_zero(self):
        """默认 0.5 的行：score = similarity × 0.6（importance 项恰为 0）。"""
        scores = _score_all([(_entry(1), 0.9), (_entry(2), 0.7)])
        assert scores[1] == pytest.approx(0.9 * 0.6)
        assert scores[2] == pytest.approx(0.7 * 0.6)

    def test_ranking_among_default_rows_unchanged_vs_old_formula(self):
        """默认行排序与旧公式逐条等价（旧式每条多加同一常数 +0.1，不改相对次序）。"""
        candidates = [(_entry(1), 0.95), (_entry(2), 0.8), (_entry(3), 0.62)]
        centered_order = [
            m.id for m, _ in sorted(
                MemoryRetriever(storage=None)._score_candidates(candidates, stm_ids=set()),
                key=lambda x: x[1], reverse=True,
            )
        ]
        old_order = [
            m.id for m, _ in sorted(
                candidates, key=lambda x: x[1] * 0.6 + (x[0].importance_score or 0.5) * 0.2,
                reverse=True,
            )
        ]
        assert centered_order == old_order

    def test_manual_importance_still_differentiates(self):
        """手动置高（1.0）的行获得 +0.1，可越过相似度略高的默认行。"""
        manual = _entry(1, importance=1.0)
        default = _entry(2, importance=0.5)
        scores = _score_all([(manual, 0.70), (default, 0.75)])
        assert scores[1] == pytest.approx(0.70 * 0.6 + 0.1)
        assert scores[2] == pytest.approx(0.75 * 0.6)
        assert scores[1] > scores[2], "手动置高应能补偿 0.05 的相似度差距"

    def test_manual_importance_low_penalizes(self):
        """手动置低（0.0）的行获得 −0.1，会被相似度相同的默认行压过。"""
        low = _entry(1, importance=0.0)
        default = _entry(2, importance=0.5)
        scores = _score_all([(low, 0.80), (default, 0.80)])
        assert scores[1] < scores[2]

    def test_none_importance_treated_as_default(self):
        """importance_score 为 NULL 的行按默认 0.5 处理，贡献为 0。"""
        entry = _entry(1)
        entry.importance_score = None
        scores = _score_all([(entry, 0.9)])
        assert scores[1] == pytest.approx(0.9 * 0.6)
