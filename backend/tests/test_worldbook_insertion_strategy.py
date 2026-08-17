"""Phase G 回归测试: ST 1.18.0 ``world_info_character_strategy`` 插入排序策略。

验证 ``_sort_by_insertion_strategy`` 对齐 ST ``getSortedEntries``
(world-info.js:4478-4527 + sortFn L88 ``b.order - a.order``)。

覆盖:
1. ``character_first`` (默认, strategy=1): character lore 在前, global 在后
2. ``global_first`` (strategy=2): global lore 在前, character 在后
3. ``evenly`` (strategy=0): character + global 合并按 order 降序
4. chatLore 始终最前
5. 同 tier 内 order 降序 (higher order first) — 对齐 ST sortFn
6. 未知 strategy 值回退 character_first
"""
import os
import sys
from types import SimpleNamespace

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.services.worldbook_service import _sort_by_insertion_strategy  # noqa: E402


def _entry(eid, wb_id, order, priority=5, position=0):
    """构造一个最小 WorldBookStage 替身。"""
    return SimpleNamespace(
        id=eid, world_book_id=wb_id, order=order, priority=priority,
        position=position, group=None, group_weight=None, group_override=False,
        constant=False, content=f"entry-{eid}", depth=4, role=0,
        enabled=True, keys="[]", title=f"t-{eid}",
    )


def _lore_map(**kw):
    """构造 world_book_id -> lore_source 映射。"""
    return dict(kw)


# ───────────────────────── 1. character_first (默认) ─────────────────────────

class TestCharacterFirst:
    def test_character_before_global(self):
        """character_first: character lore 排在 global lore 之前，不论 order。"""
        entries = [
            _entry("g1", "wb_global", order=10),    # global, order=10
            _entry("c1", "wb_char", order=5),       # character, order=5
        ]
        lore = _lore_map(wb_global="global", wb_char="character")
        result = _sort_by_insertion_strategy(list(entries), lore, 1)
        assert [e.id for e in result] == ["c1", "g1"]

    def test_character_first_order_descending_within_tier(self):
        """同 tier 内 order 降序 (higher order first)，对齐 ST sortFn。"""
        entries = [
            _entry("c_low", "wb_char", order=50),
            _entry("c_high", "wb_char", order=100),
            _entry("c_mid", "wb_char", order=75),
        ]
        lore = _lore_map(wb_char="character")
        result = _sort_by_insertion_strategy(list(entries), lore, 1)
        # order 降序: 100 > 75 > 50
        assert [e.id for e in result] == ["c_high", "c_mid", "c_low"]

    def test_character_first_global_order_descending(self):
        """global tier 内也按 order 降序。"""
        entries = [
            _entry("g_low", "wb_g", order=10),
            _entry("g_high", "wb_g", order=90),
        ]
        lore = _lore_map(wb_g="global")
        result = _sort_by_insertion_strategy(list(entries), lore, 1)
        assert [e.id for e in result] == ["g_high", "g_low"]

    def test_character_first_mixed_lore_orders(self):
        """character (order=50) 仍排在 global (order=100) 之前。"""
        entries = [
            _entry("g1", "wb_g", order=100),
            _entry("c1", "wb_c", order=50),
            _entry("c2", "wb_c", order=80),
            _entry("g2", "wb_g", order=20),
        ]
        lore = _lore_map(wb_g="global", wb_c="character")
        result = _sort_by_insertion_strategy(list(entries), lore, 1)
        # character tier (order desc): c2(80), c1(50)
        # global tier (order desc): g1(100), g2(20)
        assert [e.id for e in result] == ["c2", "c1", "g1", "g2"]


# ───────────────────────── 2. global_first ─────────────────────────

class TestGlobalFirst:
    def test_global_before_character(self):
        """global_first: global lore 排在 character lore 之前。"""
        entries = [
            _entry("c1", "wb_c", order=100),
            _entry("g1", "wb_g", order=5),
        ]
        lore = _lore_map(wb_c="character", wb_g="global")
        result = _sort_by_insertion_strategy(list(entries), lore, 2)
        assert [e.id for e in result] == ["g1", "c1"]


# ───────────────────────── 3. evenly ─────────────────────────

class TestEvenly:
    def test_evenly_merges_and_sorts_by_order(self):
        """evenly: character + global 合并按 order 降序，不分 tier。"""
        entries = [
            _entry("c1", "wb_c", order=50),
            _entry("g1", "wb_g", order=100),
            _entry("c2", "wb_c", order=75),
            _entry("g2", "wb_g", order=25),
        ]
        lore = _lore_map(wb_c="character", wb_g="global")
        result = _sort_by_insertion_strategy(list(entries), lore, 0)
        # 合并后 order 降序: 100 > 75 > 50 > 25
        assert [e.id for e in result] == ["g1", "c2", "c1", "g2"]


# ───────────────────────── 4. chatLore 最前 ─────────────────────────

class TestChatLoreFirst:
    def test_chat_before_all(self):
        """chatLore 始终排在 character/global 之前，不论 order。"""
        entries = [
            _entry("c1", "wb_c", order=999),    # character, high order
            _entry("g1", "wb_g", order=999),    # global, high order
            _entry("s1", "wb_s", order=1),      # chat, low order
        ]
        lore = _lore_map(wb_c="character", wb_g="global", wb_s="chat")
        result = _sort_by_insertion_strategy(list(entries), lore, 1)
        assert result[0].id == "s1"

    def test_chat_order_descending_within_tier(self):
        """chat tier 内也按 order 降序。"""
        entries = [
            _entry("s1", "wb_s", order=10),
            _entry("s2", "wb_s", order=50),
            _entry("c1", "wb_c", order=999),
        ]
        lore = _lore_map(wb_s="chat", wb_c="character")
        result = _sort_by_insertion_strategy(list(entries), lore, 1)
        # chat tier (order desc): s2(50), s1(10)
        # then character tier: c1(999)
        assert [e.id for e in result] == ["s2", "s1", "c1"]


# ───────────────────────── 5. order 降序 (ST sortFn 对齐) ─────────────────────────

class TestOrderDescending:
    def test_descending_not_ascending(self):
        """关键回归: ST sortFn (a,b)=>b.order-a.order 是降序。
        Palink 此前用升序 (e.order or 0)，本测试确保已改为降序。"""
        entries = [
            _entry("e1", "wb", order=10),
            _entry("e2", "wb", order=90),
            _entry("e3", "wb", order=50),
        ]
        lore = _lore_map(wb="character")
        result = _sort_by_insertion_strategy(list(entries), lore, 1)
        # 降序: 90 > 50 > 10
        assert [e.id for e in result] == ["e2", "e3", "e1"]

    def test_same_order_uses_priority_as_tiebreaker(self):
        """同 tier 同 order 时，priority 高的排前（Palink 扩展 tiebreaker）。"""
        entries = [
            _entry("low_pri", "wb", order=50, priority=3),
            _entry("high_pri", "wb", order=50, priority=8),
        ]
        lore = _lore_map(wb="character")
        result = _sort_by_insertion_strategy(list(entries), lore, 1)
        assert [e.id for e in result] == ["high_pri", "low_pri"]


# ───────────────────────── 6. 未知 strategy / 边界 ─────────────────────────

class TestEdgeCases:
    def test_unknown_strategy_defaults_to_character_first(self):
        """未知 strategy 值 (如 99) 回退到 character_first 行为。"""
        entries = [
            _entry("g1", "wb_g", order=100),
            _entry("c1", "wb_c", order=5),
        ]
        lore = _lore_map(wb_g="global", wb_c="character")
        result = _sort_by_insertion_strategy(list(entries), lore, 99)
        # character_first: c1 before g1
        assert [e.id for e in result] == ["c1", "g1"]

    def test_empty_list(self):
        """空列表不报错。"""
        result = _sort_by_insertion_strategy([], {}, 1)
        assert result == []

    def test_single_entry(self):
        """单条目排序不变。"""
        entries = [_entry("e1", "wb", order=50)]
        lore = _lore_map(wb="character")
        result = _sort_by_insertion_strategy(list(entries), lore, 1)
        assert len(result) == 1
        assert result[0].id == "e1"

    def test_unknown_lore_source_treated_as_global(self):
        """未知 lore 来源 (不在映射中) 当作 global 处理。"""
        entries = [
            _entry("c1", "wb_c", order=50),
            _entry("x1", "wb_unknown", order=100),  # 未知来源
        ]
        lore = _lore_map(wb_c="character")  # wb_unknown 不在映射中
        result = _sort_by_insertion_strategy(list(entries), lore, 1)
        # character_first: c1 (character) before x1 (unknown=global)
        assert [e.id for e in result] == ["c1", "x1"]

    def test_none_order_treated_as_zero(self):
        """order=None 当作 0 处理。"""
        entries = [
            _entry("e1", "wb", order=None),
            _entry("e2", "wb", order=10),
        ]
        lore = _lore_map(wb="character")
        result = _sort_by_insertion_strategy(list(entries), lore, 1)
        # 降序: 10 > 0(None)
        assert [e.id for e in result] == ["e2", "e1"]
