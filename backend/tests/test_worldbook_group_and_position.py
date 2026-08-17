"""E1 + E2 回归测试：群 per-member 世界书 haystack 并集 + WI 位置枚举映射。"""

import os
import sys
from types import SimpleNamespace

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.services.worldbook_import_utils import normalize_worldbook_position  # noqa: E402
from app.services.worldbook_service import (  # noqa: E402
    WI_POS_BEFORE_CHAR,
    WI_POS_AFTER_CHAR,
    WI_POS_BEFORE_AN,
    WI_POS_AFTER_AN,
    WI_POS_AT_DEPTH,
    WI_POS_EM_TOP,
    WI_POS_EM_BOTTOM,
    WI_POS_OUTLET,
)


# ---------------------------------------------------------------------------
# E2: normalize_worldbook_position 映射（ST 1.18.0 枚举 -> Palink 0..7）
# ---------------------------------------------------------------------------

class TestNormalizeWorldbookPosition:
    def test_st_integer_enum_full_range(self):
        # ST 0..7 与 Palink 0..7 逐位对应（identity 透传）
        assert normalize_worldbook_position(0) == WI_POS_BEFORE_CHAR
        assert normalize_worldbook_position(1) == WI_POS_AFTER_CHAR
        assert normalize_worldbook_position(2) == WI_POS_BEFORE_AN
        assert normalize_worldbook_position(3) == WI_POS_AFTER_AN
        assert normalize_worldbook_position(4) == WI_POS_AT_DEPTH
        assert normalize_worldbook_position(5) == WI_POS_EM_TOP
        assert normalize_worldbook_position(6) == WI_POS_EM_BOTTOM
        assert normalize_worldbook_position(7) == WI_POS_OUTLET
        # 越界（旧 9 枚举的 8=OUTLET）回退 AT_DEPTH
        assert normalize_worldbook_position(8) == WI_POS_AT_DEPTH

    def test_at_depth_four_maps_to_at_depth_four(self):
        # 规范明确要求的验收点：atDepth=4 原样保留
        assert normalize_worldbook_position(4) == WI_POS_AT_DEPTH == 4

    def test_st_string_names(self):
        assert normalize_worldbook_position("before_char") == WI_POS_BEFORE_CHAR
        assert normalize_worldbook_position("after_char") == WI_POS_AFTER_CHAR
        assert normalize_worldbook_position("before_annotation") == WI_POS_BEFORE_AN
        assert normalize_worldbook_position("after_annotation") == WI_POS_AFTER_AN
        assert normalize_worldbook_position("at_depth") == WI_POS_AT_DEPTH
        assert normalize_worldbook_position("em_top") == WI_POS_EM_TOP
        assert normalize_worldbook_position("em_bottom") == WI_POS_EM_BOTTOM
        assert normalize_worldbook_position("outlet") == WI_POS_OUTLET

    def test_palink_legacy_string_names_still_work(self):
        # 既有导出/蓝图往返兼容
        assert normalize_worldbook_position("before_example") == WI_POS_BEFORE_AN
        assert normalize_worldbook_position("after_example") == WI_POS_AFTER_AN
        assert normalize_worldbook_position("at_top") == WI_POS_AT_DEPTH
        assert normalize_worldbook_position("at_bottom") == WI_POS_EM_TOP

    def test_unknown_and_out_of_range_fallback(self):
        assert normalize_worldbook_position(99) == WI_POS_AT_DEPTH
        assert normalize_worldbook_position("nonsense") == WI_POS_AT_DEPTH
        assert normalize_worldbook_position(None) == WI_POS_AT_DEPTH


# ---------------------------------------------------------------------------
# E1: _build_haystack 群成员字段并入（受 match_* 门控）
# ---------------------------------------------------------------------------

def _make_char(name, **kw):
    defaults = dict(
        description=f"{name} desc",
        personality=f"{name} pers",
        scenario=f"{name} scen",
        extensions=None,
        creator_notes=f"{name} notes",
    )
    defaults.update(kw)
    return SimpleNamespace(name=name, **defaults)


def _make_entry(**kw):
    defaults = dict(
        scan_depth=4,
        match_persona_description=False,
        match_character_description=True,
        match_character_personality=True,
        match_character_depth_prompt=False,
        match_scenario=True,
        match_creator_notes=True,
    )
    defaults.update(kw)
    return SimpleNamespace(**defaults)


def test_build_haystack_includes_group_members_when_enabled():
    from app.services.worldbook_service import _build_haystack

    entry = _make_entry()
    speaker = _make_char("Speaker")
    members = [_make_char("Alice"), _make_char("Bob")]

    hay = _build_haystack(entry, [], speaker, group_chars=members)
    # 发言者字段
    assert "Speaker desc" in hay
    # 群成员字段并集
    assert "Alice desc" in hay and "Bob desc" in hay
    assert "Alice pers" in hay and "Bob pers" in hay
    assert "Alice scen" in hay and "Bob scen" in hay


def test_build_haystack_group_union_gated_by_match_flags():
    from app.services.worldbook_service import _build_haystack

    entry = _make_entry(
        match_character_personality=False,  # 仅 description 参与
        match_scenario=False,
        match_creator_notes=False,
    )
    speaker = _make_char("Speaker")
    members = [_make_char("Alice")]

    hay = _build_haystack(entry, [], speaker, group_chars=members)
    assert "Alice desc" in hay
    assert "Alice pers" not in hay  # personality 门控关闭


def test_build_haystack_no_group_chars_unchanged():
    from app.services.worldbook_service import _build_haystack

    entry = _make_entry()
    speaker = _make_char("Speaker")
    hay = _build_haystack(entry, [], speaker, group_chars=None)
    assert "Speaker desc" in hay
    assert "Alice" not in hay  # 无群成员时不出现
