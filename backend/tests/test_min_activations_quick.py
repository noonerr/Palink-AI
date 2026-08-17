"""Phase E MIN_ACTIVATIONS 状态机快速验证测试。

验证:
1. min_activations=0 时默认行为不变（仅 DEFAULT_SCAN_DEPTH=4 范围内匹配）
2. min_activations>0 时 advanceScan 扩展深度找到更多条目
3. min_activations_depth_max 限制扫描深度上限
4. min_activations 已满足时不扩展扫描
"""
from __future__ import annotations

import json
from typing import Optional

from app.models.worldbook import WorldBookStage
from app.services.worldbook_service import (
    DEFAULT_SCAN_DEPTH,
    WI_POS_AT_DEPTH,
    WI_LOGIC_AND_ANY,
    _recursive_scan,
)


def _make_entry(
    eid: str, keys: list[str], content: str,
    scan_depth: Optional[int] = None,
) -> WorldBookStage:
    """构造一个最小可用的 WorldBookStage。"""
    return WorldBookStage(
        id=eid,
        world_book_id="wb-test",
        stage_index=0,
        title=eid,
        content=content,
        keys=json.dumps(keys, ensure_ascii=False),
        secondary_keys=None,
        # scan_depth=None 表示使用 global_scan_depth (ST: entry.scanDepth ?? getDepth())
        scan_depth=scan_depth,
        position=WI_POS_AT_DEPTH,
        selective=False,
        probability=100,
        constant=False,
        group=None,
        enabled=True,
        case_sensitive=False,
        match_whole_words=False,
        selective_logic=WI_LOGIC_AND_ANY,
        sticky=0,
        cooldown=0,
        delay=0,
        depth=4,
        order=0,
        priority=5,
        exclude_recursion=False,
        prevent_recursion=False,
        group_override=False,
        group_weight=0,
        min_activations=0,
        delay_until_recursion=0,
        triggers=None,
        character_filter=None,
        outlet_name=None,
        match_character_description=False,
        match_character_personality=False,
        match_character_depth_prompt=False,
        match_scenario=False,
        match_creator_notes=False,
        match_persona_description=False,
        role=0,
    )


# 6 条消息: alpha 在倒数第 2 条(depth 2), beta 在倒数第 5 条(depth 5)
MSGS = [
    {"role": "user", "content": "old msg 6"},
    {"role": "assistant", "content": "old msg 5 has beta"},
    {"role": "user", "content": "msg 4"},
    {"role": "assistant", "content": "msg 3"},
    {"role": "user", "content": "msg 2 has alpha"},
    {"role": "assistant", "content": "recent msg 1"},
]


def test_min_activations_zero_default_behavior():
    """min_activations=0: 只在 DEFAULT_SCAN_DEPTH=4 范围内匹配。

    entry_a (alpha) 在 depth 2，entry_b (beta) 在 depth 5。
    默认 scan_depth=None → 用 DEFAULT_SCAN_DEPTH=4，只看到最后 4 条消息。
    """
    # scan_depth=None: 使用 DEFAULT_SCAN_DEPTH
    entry_a = _make_entry("a", ["alpha"], "A content", scan_depth=None)
    entry_b = _make_entry("b", ["beta"], "B content", scan_depth=None)

    activated, _ = _recursive_scan([entry_a, entry_b], list(MSGS), None, None, 0)
    ids = [e.id for e in activated]

    assert "a" in ids, "entry_a (alpha at depth 2) should match within default depth 4"
    assert "b" not in ids, "entry_b (beta at depth 5) should NOT match with default depth 4"


def test_min_activations_positive_extends_scan():
    """min_activations=2, depth_max=0: advanceScan 扩展深度直到找到 b。

    ST: buffer.advanceScan() 递增 getDepth()，让未设自定义 scanDepth 的条目
    看到更多聊天历史。depth_max=0 时回退到 chat.length 作为上限。
    """
    entry_a = _make_entry("a", ["alpha"], "A content", scan_depth=None)
    entry_b = _make_entry("b", ["beta"], "B content", scan_depth=None)

    activated, _ = _recursive_scan(
        [entry_a, entry_b], list(MSGS), None, None, 0,
        min_activations=2, min_activations_depth_max=0,
    )
    ids = [e.id for e in activated]

    assert "a" in ids, "entry_a should still match"
    assert "b" in ids, "entry_b should match after advanceScan extends depth to 5+"


def test_min_activations_depth_max_limits_scan():
    """min_activations=2, depth_max=4: 上限不够, beta 找不到。

    ST over_max 检查: getDepth() > n_depth_max → 停止。
    """
    entry_a = _make_entry("a", ["alpha"], "A content", scan_depth=None)
    entry_b = _make_entry("b", ["beta"], "B content", scan_depth=None)

    activated, _ = _recursive_scan(
        [entry_a, entry_b], list(MSGS), None, None, 0,
        min_activations=2, min_activations_depth_max=4,
    )
    ids = [e.id for e in activated]

    assert "a" in ids, "entry_a should match"
    assert "b" not in ids, "entry_b should NOT match: depth_max=4 stops before msg 5"


def test_min_activations_already_satisfied_no_extend():
    """min_activations=1 且已有 1 个匹配: 不扩展扫描。

    ST: minActivationsNotSatisfied = allActivated < min → False → 不进入 MIN_ACTIVATIONS。
    """
    entry_a = _make_entry("a", ["alpha"], "A content", scan_depth=None)
    entry_b = _make_entry("b", ["beta"], "B content", scan_depth=None)

    activated, _ = _recursive_scan(
        [entry_a, entry_b], list(MSGS), None, None, 0,
        min_activations=1, min_activations_depth_max=0,
    )
    ids = [e.id for e in activated]

    assert "a" in ids, "entry_a should match"
    assert "b" not in ids, "entry_b should NOT match: min=1 already satisfied by entry_a"
