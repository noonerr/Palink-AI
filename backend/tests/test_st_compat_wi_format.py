"""ST-Compat wi_format wrapping tests (D3 修复).

验证 build_st_compat_messages 对世界书 before/after/depth 条目应用 wi_format 包裹，
与 ST 1.18.0 openai.js:780-792 formatWorldInfo 一致：
    空 format 返回原值，否则 wi_format.replace("{0}", content)。

覆盖 spec 中 3 个 Scenario:
    1. 空 wi_format（向后兼容，与修复前一致）
    2. 非空 wi_format 包裹
    3. 多条目全部包裹
"""

import os
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from app.services.character_message_builder import (  # noqa: E402
        build_st_compat_messages,
        _apply_wi_format,
    )
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")


def _make_char():
    return SimpleNamespace(
        name="Alice",
        description="desc",
        personality="pers",
        scenario="scen",
        mes_example="",
        post_history_instructions=None,
        jailbreak=None,
    )


def _make_db_empty_history():
    db = MagicMock()
    query = MagicMock()
    query.filter.return_value = query
    query.order_by.return_value = query
    query.limit.return_value = query
    query.all.return_value = []
    db.query.return_value = query
    return db


def _build(wi_format="", world_info_before="", world_info_after="", depth_entries=None):
    return build_st_compat_messages(
        db=_make_db_empty_history(),
        char=_make_char(),
        user_nickname="User",
        session_id="sess-1",
        branch_id=None,
        message="hello",
        images=[],
        system_prompt_override=None,
        world_info_before=world_info_before,
        world_info_after=world_info_after,
        persona_description="",
        jailbreak="",
        authors_note="",
        authors_note_depth=4,
        dynamic_context_parts=[],
        prompt_lang="en",
        user_setting=None,
        _replace_placeholders=lambda t, u, c: t,
        _get_full_branch_history=lambda *a, **k: [],
        _contains_chinese=lambda t: False,
        normalize_image_url=lambda u, check_size=False: u,
        include_user_message=True,
        wi_format=wi_format,
        worldbook_depth_entries=depth_entries,
    )


def test_apply_wi_format_empty():
    """空 format 返回原值。"""
    assert _apply_wi_format("some content", "") == "some content"
    assert _apply_wi_format("some content", "   ") == "some content"


def test_apply_wi_format_wraps():
    """非空 format 用 {0} 包裹。"""
    assert _apply_wi_format("lore", "[World Info: {0}]") == "[World Info: lore]"


def test_apply_wi_format_empty_content():
    """空内容返回空串。"""
    assert _apply_wi_format("", "[World Info: {0}]") == ""


def test_before_after_unwrapped_by_default():
    """Scenario 1: 默认 wi_format="" 时行为与修复前一致（向后兼容）。"""
    msgs = _build(wi_format="", world_info_before="BEFORE LORE", world_info_after="AFTER LORE")
    contents = [m.get("content") for m in msgs if m.get("role") == "system"]
    assert "BEFORE LORE" in contents
    assert "AFTER LORE" in contents


def test_before_after_wrapped_with_format():
    """Scenario 2: 非空 wi_format 包裹 before/after 条目。"""
    msgs = _build(
        wi_format="[WI: {0}]",
        world_info_before="BEFORE LORE",
        world_info_after="AFTER LORE",
    )
    contents = [m.get("content") for m in msgs if m.get("role") == "system"]
    assert "[WI: BEFORE LORE]" in contents
    assert "[WI: AFTER LORE]" in contents


def test_depth_entries_not_wrapped_with_format():
    """A-6: depth 条目不应用 wi_format 包裹（ST 仅 worldInfoBefore/After 应用 formatWorldInfo）。"""
    # depth_entries 为三元组 (depth, content, role)
    msgs = _build(
        wi_format="[WI: {0}]",
        depth_entries=[(2, "DEPTH LORE", 0)],
    )
    contents = [m.get("content") for m in msgs]
    assert "DEPTH LORE" in contents
    assert "[WI: DEPTH LORE]" not in contents


def test_depth_entries_unwrapped_by_default():
    """默认 wi_format="" 时 depth 条目不包裹（向后兼容）。"""
    msgs = _build(wi_format="", depth_entries=[(2, "DEPTH LORE", 0)])
    contents = [m.get("content") for m in msgs]
    assert "DEPTH LORE" in contents
