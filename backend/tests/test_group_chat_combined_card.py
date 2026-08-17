"""群聊合并卡保真测试 —— 直测 _build_group_combined_card（S3 修复）。

对齐 ST group-chats.js:497-571（collectField / customTransform / replaceAndPrepareForJoin）：
1. 默认 prefix/suffix 下，各字段逐成员按 \\n 连接，且**不自动前缀成员名**（ST 不前缀）。
2. mes_example 逐成员若未以 <START> 开头则补 "<START>\\n"；已开头则保留。
3. chat_metadata.scenario / chat_metadata.mes_example 非空时整体覆盖对应字段。
4. generation_mode_join_prefix/suffix 中的 <FIELDNAME> / {{char}} 被正确替换。
5. 禁用成员由调用方预选（APPEND 仅启用 / APPEND_DISABLED 含全量）；函数原样拼接传入成员。
"""

import json
import os
import sys
from types import SimpleNamespace

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from app.services import roleplay_prompt_assembly as rpa  # noqa: E402
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")


def _char(cid, name, description="", personality="", scenario="", mes_example=""):
    return SimpleNamespace(
        id=cid, name=name, description=description,
        personality=personality, scenario=scenario, mes_example=mes_example,
    )


def _group(chat_metadata):
    return SimpleNamespace(chat_metadata=chat_metadata)


def test_combined_card_no_member_name_prefix():
    """默认 prefix/suffix：逐成员 \\n 连接，无 'Name: ' 自动前缀（对齐 ST collectField）。"""
    members = [
        _char("m1", "Alice", description="desc A", personality="pers A", scenario="sc A"),
        _char("m2", "Bob", description="desc B", personality="pers B", scenario="sc B"),
    ]
    card = rpa._build_group_combined_card(_group("{}"), members)
    assert "Name:" not in card["description"]
    assert card["description"] == "desc A\ndesc B"
    assert card["personality"] == "pers A\npers B"
    assert card["scenario"] == "sc A\nsc B"


def test_combined_card_mes_example_start_wrap():
    """mes_example 未以 <START> 开头补 '<START>\\n'；已开头保留（ST preprocess）。"""
    members = [
        _char("m1", "Alice", mes_example="Alice: hi"),
        _char("m2", "Bob", mes_example="<START>\nBob: yo"),
    ]
    card = rpa._build_group_combined_card(_group("{}"), members)
    assert card["mes_example"] == "<START>\nAlice: hi\n<START>\nBob: yo"
    # 已带 <START> 的不重复包裹
    assert card["mes_example"].count("<START>") == 2


def test_combined_card_scenario_override():
    """chat_metadata.scenario 非空 → 整体覆盖逐成员场景（ST baseChatReplace 覆盖优先）。"""
    members = [_char("m1", "Alice", scenario="sc A"), _char("m2", "Bob", scenario="sc B")]
    meta = json.dumps({"scenario": "OVERRIDE_SCENARIO"})
    card = rpa._build_group_combined_card(_group(meta), members)
    assert card["scenario"] == "OVERRIDE_SCENARIO"


def test_combined_card_mes_example_override():
    """chat_metadata.mes_example 非空 → 整体覆盖逐成员示例。"""
    members = [_char("m1", "Alice", mes_example="Alice: hi"),
               _char("m2", "Bob", mes_example="Bob: yo")]
    meta = json.dumps({"mes_example": "<START>\nOVERRIDE_EX"})
    card = rpa._build_group_combined_card(_group(meta), members)
    assert card["mes_example"] == "<START>\nOVERRIDE_EX"


def test_combined_card_fieldname_and_char_token_substitution():
    """generation_mode_join_prefix 含 <FIELDNAME> / {{char}} → 被字段名/成员名替换。"""
    members = [
        _char("m1", "Alice", description="desc A"),
        _char("m2", "Bob", description="desc B"),
    ]
    meta = json.dumps({"generation_mode_join_prefix": "<FIELDNAME> of {{char}}: "})
    card = rpa._build_group_combined_card(_group(meta), members)
    assert card["description"] == "Description of Alice: desc A\nDescription of Bob: desc B"


def test_combined_card_token_substitution_in_value():
    """成员 description 内的 {{char}} / <FIELDNAME> 也被 customTransform 替换。"""
    members = [_char("m1", "Alice", description="{{char}} is a <FIELDNAME> hero")]
    card = rpa._build_group_combined_card(_group("{}"), members)
    # <FIELDNAME> 在 description 字段映射为 "Description"；{{char}} → Alice
    assert card["description"] == "Alice is a Description hero"


def test_combined_card_disabled_handled_by_caller():
    """函数原样拼接传入成员；禁用过滤由调用方（APPEND/APPEND_DISABLED）负责。"""
    enabled = [_char("m1", "Alice", description="desc A")]
    all_members = [_char("m1", "Alice", description="desc A"),
                   _char("m2", "Bob", description="desc B")]
    card_enabled = rpa._build_group_combined_card(_group("{}"), enabled)
    card_all = rpa._build_group_combined_card(_group("{}"), all_members)
    # APPEND（仅启用）：仅 Alice
    assert card_enabled["description"] == "desc A"
    assert "desc B" not in card_enabled["description"]
    # APPEND_DISABLED（含禁用）：Alice + Bob
    assert card_all["description"] == "desc A\ndesc B"
