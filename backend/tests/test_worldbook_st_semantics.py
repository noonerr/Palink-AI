"""ST (SillyTavern) world-info semantics comparison fixtures & validation.

对照 SillyTavern 1.18.0 ``public/scripts/world-info.js`` 的语义，为 Palink 后端
worldbook 引擎 (``app.services.worldbook_service``) 创建对照 fixtures 与验证。

测试分三层：
1. 纯函数验证（无需 DB）：token 估算、预算解析、装饰器解析、正则/关键词匹配。
2. WorldBookStage 级别验证（内存对象，无需 DB session）：主/次关键词匹配与选择性逻辑。
3. 完整引擎验证（需要 DB session，占位 ``pytest.skip``）：常量、递归、分组、深度、预算等。

============================================================================
语义对照说明（重要）
============================================================================
ST ``world_info_logic`` 常量:
    AND_ANY = 0, NOT_ALL = 1, NOT_ANY = 2, AND_ALL = 3
Palink ``WI_LOGIC_*`` 常量与此**完全一致**。

ST ``world_info_position`` 常量:
    before=0, after=1, ANTop=2, ANBottom=3, atDepth=4, EMTop=5, EMBottom=6, outlet=7
Palink ``WI_POS_*`` 常量与此**完全一致**。

【已记录的语义差异 — 未修改核心逻辑】
ST 将 ``selectiveLogic`` 应用于**次关键词**（主关键词仅需 "any match" 即可推进到次关键词检查）。
Palink 将 ``selective_logic`` 应用于**主关键词**（次关键词固定为 OR/any 匹配）。
本文件中的断言按 Palink **实际行为**编写，并在注释中标注对应 ST 语义，便于后续对照。
修改此差异会改变所有现存世界书条目的行为，属于高风险变更，故仅在 fixtures 中记录。
"""

import json
import os
import random
import sys
import uuid

import pytest

# 让 ``backend`` 目录可被导入（测试可位于 backend/tests/ 下独立运行）
_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.core.security import get_password_hash  # noqa: E402
from app.models import Character, User  # noqa: E402
from app.models.character import CharacterChatSession  # noqa: E402
from app.models.worldbook import WorldBook, WorldBookStage  # noqa: E402
from app.services.worldbook_service import (  # noqa: E402
    DEFAULT_BUDGET,
    DEFAULT_MAX_RECURSION,
    DEFAULT_SCAN_DEPTH,
    WI_LOGIC_AND_ALL,
    WI_LOGIC_AND_ANY,
    WI_LOGIC_NOT_ALL,
    WI_LOGIC_NOT_ANY,
    WI_POS_AFTER_AN,
    WI_POS_AFTER_CHAR,
    WI_POS_AT_DEPTH,
    WI_POS_BEFORE_AN,
    WI_POS_BEFORE_CHAR,
    WI_POS_EM_BOTTOM,
    WI_POS_EM_TOP,
    WI_POS_OUTLET,
    WorldbookContextResult,
    WorldbookEntryReport,
    _compile_regex_key,
    _estimate_tokens,
    _match_key,
    _match_primary_keys,
    _match_secondary_keys,
    _parse_decorators,
    _parse_json_list,
    _recursive_scan,
    _resolve_budget,
    build_worldbook_context,
)


# ---------------------------------------------------------------------------
# 常量一致性对照：Palink 常量必须与 ST 1.18.0 完全一致
# ---------------------------------------------------------------------------
class TestSTConstantParity:
    """确认 Palink 常量与 ST 1.18.0 ``world-info.js`` 数值完全一致。"""

    def test_world_info_logic_constants(self):
        # ST: world_info_logic = { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 }
        assert WI_LOGIC_AND_ANY == 0
        assert WI_LOGIC_NOT_ALL == 1
        assert WI_LOGIC_NOT_ANY == 2
        assert WI_LOGIC_AND_ALL == 3

    def test_world_info_position_constants(self):
        # ST: world_info_position = { before:0, after:1, ANTop:2, ANBottom:3,
        #                             atDepth:4, EMTop:5, EMBottom:6, outlet:7 }
        assert WI_POS_BEFORE_CHAR == 0
        assert WI_POS_AFTER_CHAR == 1
        assert WI_POS_BEFORE_AN == 2
        assert WI_POS_AFTER_AN == 3
        assert WI_POS_AT_DEPTH == 4
        assert WI_POS_EM_TOP == 5
        assert WI_POS_EM_BOTTOM == 6
        assert WI_POS_OUTLET == 7

    def test_default_settings(self):
        # Palink 默认值（ST 默认 scan depth=2, 但 Palink 取 4；此处只锁默认常量）
        assert DEFAULT_BUDGET == 16000
        assert DEFAULT_SCAN_DEPTH == 4
        assert DEFAULT_MAX_RECURSION == 5


# ---------------------------------------------------------------------------
# 工具：从 ST 格式条目 dict 构造内存 WorldBookStage（无需 DB session）
# ---------------------------------------------------------------------------
def make_stage(st_entry: dict) -> WorldBookStage:
    """把 ST 格式的世界书条目 dict 转换为内存中的 WorldBookStage 实例。

    ST 字段名 → Palink 字段名映射在此集中维护，确保 fixtures 数据结构与
    ST ``world-info.js`` 条目格式对齐。仅用于单元/对照测试，不写入 DB。
    """
    def _j(value):
        if value is None:
            return None
        if isinstance(value, str):
            return value
        return json.dumps(value, ensure_ascii=False)

    stage = WorldBookStage(
        id=str(st_entry.get("uid") or st_entry.get("id") or f"stage-{id(st_entry)}"),
        world_book_id=st_entry.get("_world_book_id", "wb-test"),
        stage_index=st_entry.get("order", 0),
        title=st_entry.get("comment") or st_entry.get("title") or "",
        content=st_entry.get("content", "") or "",
        keys=_j(st_entry.get("key", [])),
        secondary_keys=_j(st_entry.get("keysecondary", [])),
        scan_depth=st_entry.get("scanDepth", st_entry.get("scan_depth", DEFAULT_SCAN_DEPTH)),
        position=st_entry.get("position", WI_POS_AT_DEPTH),
        selective=bool(st_entry.get("selective", False)),
        probability=st_entry.get("probability", 100),
        constant=bool(st_entry.get("constant", False)),
        group=st_entry.get("group"),
        enabled=not bool(st_entry.get("disable", False)),
        case_sensitive=bool(st_entry.get("case_sensitive", False)),
        match_whole_words=bool(st_entry.get("match_whole_words", False)),
        selective_logic=st_entry.get("selective_logic", st_entry.get("selectiveLogic", WI_LOGIC_AND_ANY)),
        sticky=st_entry.get("sticky", 0),
        cooldown=st_entry.get("cooldown", 0),
        delay=st_entry.get("delay", 0),
        depth=st_entry.get("depth", 4),
        order=st_entry.get("order", 0),
        priority=st_entry.get("priority", 5),
        exclude_recursion=bool(st_entry.get("exclude_recursion", False)),
        prevent_recursion=bool(st_entry.get("prevent_recursion", False)),
        group_override=bool(st_entry.get("group_override", False)),
        group_weight=st_entry.get("group_weight", 0),
        min_activations=st_entry.get("min_activations", 0),
        delay_until_recursion=st_entry.get("delay_until_recursion", 0),
        triggers=_j(st_entry.get("triggers", [])),
        character_filter=_j(st_entry.get("character_filter", [])),
        outlet_name=st_entry.get("outlet_name") or st_entry.get("outletName"),
        match_character_description=bool(st_entry.get("match_character_description", False)),
        match_character_personality=bool(st_entry.get("match_character_personality", False)),
        match_character_depth_prompt=bool(st_entry.get("match_character_depth_prompt", False)),
        match_scenario=bool(st_entry.get("match_scenario", False)),
        match_creator_notes=bool(st_entry.get("match_creator_notes", False)),
    )
    return stage


# ---------------------------------------------------------------------------
# ST 格式条目 fixtures（数据结构对齐 ST world-info.js）
# ---------------------------------------------------------------------------
@pytest.fixture
def constant_entry():
    """常量条目：constant=True，始终激活（跳过关键词匹配）。ST: entry.constant。"""
    return {
        "uid": 1,
        "key": [],
        "keysecondary": [],
        "comment": "constant entry",
        "content": "Always active content",
        "constant": True,
        "selective": False,
        "selective_logic": 0,
        "position": WI_POS_BEFORE_CHAR,
        "disable": False,
        "probability": 100,
        "depth": 4,
        "order": 100,
        "priority": 10,
    }


@pytest.fixture
def primary_key_entry():
    """主关键词条目：单主关键词命中即激活。"""
    return {
        "uid": 2,
        "key": ["dragon", "wyrm"],
        "keysecondary": [],
        "comment": "primary key entry",
        "content": "Dragon info",
        "constant": False,
        "selective": False,
        "selective_logic": WI_LOGIC_AND_ANY,
        "position": WI_POS_BEFORE_CHAR,
        "probability": 100,
        "depth": 4,
        "scanDepth": 4,
    }


@pytest.fixture
def selective_and_any_entry():
    """选择性 AND_ANY (0)：主关键词 any + 次关键词 any 都命中才激活。

    ST 语义：selectiveLogic=AND_ANY 应用于次关键词（任一命中即可）。
    Palink 实际：selective_logic 应用于主关键词（任一命中），次关键词固定 OR。
    """
    return {
        "uid": 3,
        "key": ["dragon"],
        "keysecondary": ["fire", "scales"],
        "comment": "selective AND_ANY",
        "content": "Fire dragon lore",
        "constant": False,
        "selective": True,
        "selective_logic": WI_LOGIC_AND_ANY,
        "position": WI_POS_AT_DEPTH,
        "depth": 4,
    }


@pytest.fixture
def selective_not_any_entry():
    """选择性 NOT_ANY (2)：无任何匹配时激活。"""
    return {
        "uid": 4,
        "key": ["dragon"],
        "keysecondary": ["unicorn"],
        "comment": "selective NOT_ANY",
        "content": "No dragon here lore",
        "constant": False,
        "selective": True,
        "selective_logic": WI_LOGIC_NOT_ANY,
        "position": WI_POS_AT_DEPTH,
        "depth": 4,
    }


@pytest.fixture
def probability_zero_entry():
    """概率为 0：满足其他条件也不应激活。"""
    return {
        "uid": 5,
        "key": ["rare"],
        "keysecondary": [],
        "comment": "probability zero",
        "content": "Never triggers",
        "constant": False,
        "selective": False,
        "probability": 0,
        "position": WI_POS_AT_DEPTH,
        "depth": 4,
    }


@pytest.fixture
def probability_hundred_entry():
    """概率为 100：满足关键词条件时必然激活。"""
    return {
        "uid": 6,
        "key": ["common"],
        "keysecondary": [],
        "comment": "probability hundred",
        "content": "Always triggers when matched",
        "constant": False,
        "selective": False,
        "probability": 100,
        "position": WI_POS_AT_DEPTH,
        "depth": 4,
    }


@pytest.fixture
def recursion_chain_a():
    """递归链 A：内容中包含 B 的关键词，触发递归扫描。"""
    return {
        "uid": 10,
        "key": ["castle"],
        "keysecondary": [],
        "comment": "recursion A",
        "content": "The castle has a dungeon.",  # dungeon 是 B 的关键词
        "constant": False,
        "selective": False,
        "position": WI_POS_AT_DEPTH,
        "depth": 4,
    }


@pytest.fixture
def recursion_chain_b():
    """递归链 B：关键词 dungeon，由 A 的内容递归激活。"""
    return {
        "uid": 11,
        "key": ["dungeon"],
        "keysecondary": [],
        "comment": "recursion B",
        "content": "The dungeon is dark.",
        "constant": False,
        "selective": False,
        "position": WI_POS_AT_DEPTH,
        "depth": 4,
    }


@pytest.fixture
def prevent_recursion_entry():
    """prevent_recursion=True：自身正常激活，内容不进入递归扫描 buffer（A3 语义修正）。"""
    return {
        "uid": 12,
        "key": ["dragon"],
        "keysecondary": [],
        "comment": "prevent recursion",
        "content": "Only at depth 0",
        "constant": False,
        "selective": False,
        "prevent_recursion": True,
        "position": WI_POS_AT_DEPTH,
        "depth": 4,
    }


@pytest.fixture
def delay_until_recursion_entry():
    """delay_until_recursion=2：递归深度达到 2 才可激活。"""
    return {
        "uid": 13,
        "key": ["dragon"],
        "keysecondary": [],
        "comment": "delay until recursion 2",
        "content": "Delayed lore",
        "constant": False,
        "selective": False,
        "delay_until_recursion": 2,
        "position": WI_POS_AT_DEPTH,
        "depth": 4,
    }


@pytest.fixture
def exclude_recursion_entry():
    """exclude_recursion=True：内容不计入递归扫描文本。"""
    return {
        "uid": 14,
        "key": ["dragon"],
        "keysecondary": [],
        "comment": "exclude recursion",
        "content": "Won't seed further recursion",
        "constant": False,
        "selective": False,
        "exclude_recursion": True,
        "position": WI_POS_AT_DEPTH,
        "depth": 4,
    }


@pytest.fixture
def group_weighted_entries():
    """分组加权条目组：同组按 group_weight 随机选一个（非 override 时）。"""
    return [
        {
            "uid": 20,
            "key": ["weather"],
            "keysecondary": [],
            "comment": "group A sunny",
            "content": "It is sunny.",
            "constant": False,
            "selective": False,
            "group": "weather",
            "group_weight": 80,
            "position": WI_POS_AT_DEPTH,
            "depth": 4,
        },
        {
            "uid": 21,
            "key": ["weather"],
            "keysecondary": [],
            "comment": "group A rainy",
            "content": "It is rainy.",
            "constant": False,
            "selective": False,
            "group": "weather",
            "group_weight": 20,
            "position": WI_POS_AT_DEPTH,
            "depth": 4,
        },
    ]


@pytest.fixture
def group_override_entry():
    """group_override=True：分组内所有条目均保留，不参与随机淘汰。"""
    return {
        "uid": 22,
        "key": ["weather"],
        "keysecondary": [],
        "comment": "group override",
        "content": "Override weather",
        "constant": False,
        "selective": False,
        "group": "weather2",
        "group_override": True,
        "group_weight": 100,
        "position": WI_POS_AT_DEPTH,
        "depth": 4,
    }


@pytest.fixture
def min_activations_entries():
    """min_activations=2 的分组：激活数不足 2 时整组被淘汰。"""
    return [
        {
            "uid": 30,
            "key": ["alpha"],
            "keysecondary": [],
            "comment": "min act A",
            "content": "Alpha lore",
            "constant": False,
            "selective": False,
            "group": "minact",
            "min_activations": 2,
            "position": WI_POS_AT_DEPTH,
            "depth": 4,
        },
        {
            "uid": 31,
            "key": ["beta"],
            "keysecondary": [],
            "comment": "min act B",
            "content": "Beta lore",
            "constant": False,
            "selective": False,
            "group": "minact",
            "min_activations": 2,
            "position": WI_POS_AT_DEPTH,
            "depth": 4,
        },
    ]


@pytest.fixture
def depth_insertion_entry():
    """深度插入条目：position=atDepth(4), depth=2。"""
    return {
        "uid": 40,
        "key": ["dragon"],
        "keysecondary": [],
        "comment": "depth insertion",
        "content": "Injected at depth 2",
        "constant": False,
        "selective": False,
        "position": WI_POS_AT_DEPTH,
        "depth": 2,
    }


@pytest.fixture
def position_before_entry():
    """position=before(0)。"""
    return {
        "uid": 41,
        "key": ["dragon"],
        "keysecondary": [],
        "comment": "before char",
        "content": "Before char content",
        "constant": False,
        "selective": False,
        "position": WI_POS_BEFORE_CHAR,
        "depth": 4,
    }


@pytest.fixture
def position_outlet_entry():
    """position=outlet(7)，需指定 outlet_name。"""
    return {
        "uid": 42,
        "key": ["dragon"],
        "keysecondary": [],
        "comment": "outlet",
        "content": "Outlet content",
        "constant": False,
        "selective": False,
        "position": WI_POS_OUTLET,
        "outlet_name": "lore_box",
        "depth": 4,
    }


@pytest.fixture
def budget_huge_entry():
    """超大 token 内容，用于触发预算排除。"""
    return {
        "uid": 50,
        "key": ["dragon"],
        "keysecondary": [],
        "comment": "huge budget",
        "content": "word " * 5000,  # 约 5000 tokens
        "constant": False,
        "selective": False,
        "position": WI_POS_BEFORE_CHAR,
        "depth": 4,
    }


@pytest.fixture
def case_sensitive_entry():
    """case_sensitive=True：大小写敏感匹配。"""
    return {
        "uid": 60,
        "key": ["Dragon"],
        "keysecondary": [],
        "comment": "case sensitive",
        "content": "Case sensitive lore",
        "constant": False,
        "selective": False,
        "case_sensitive": True,
        "position": WI_POS_AT_DEPTH,
        "depth": 4,
    }


@pytest.fixture
def whole_words_entry():
    """match_whole_words=True：仅匹配完整单词。"""
    return {
        "uid": 61,
        "key": ["cat"],
        "keysecondary": [],
        "comment": "whole words",
        "content": "Whole word lore",
        "constant": False,
        "selective": False,
        "match_whole_words": True,
        "position": WI_POS_AT_DEPTH,
        "depth": 4,
    }


@pytest.fixture
def regex_key_entry():
    """正则关键词条目：key 以 /pattern/flags 形式。"""
    return {
        "uid": 62,
        "key": ["/dragon|wyrm/i"],
        "keysecondary": [],
        "comment": "regex key",
        "content": "Regex lore",
        "constant": False,
        "selective": False,
        "position": WI_POS_AT_DEPTH,
        "depth": 4,
    }


@pytest.fixture
def decorator_activate_entry():
    """@@activate 装饰器：强制激活，跳过关键词匹配。"""
    return {
        "uid": 70,
        "key": [],
        "keysecondary": [],
        "comment": "decorator activate",
        "content": "@@activate\nForced active content",
        "constant": False,
        "selective": False,
        "position": WI_POS_AT_DEPTH,
        "depth": 4,
    }


@pytest.fixture
def decorator_dont_activate_entry():
    """@@dont_activate 装饰器：强制跳过。"""
    return {
        "uid": 71,
        "key": ["dragon"],
        "keysecondary": [],
        "comment": "decorator dont_activate",
        "content": "@@dont_activate\nShould not activate",
        "constant": False,
        "selective": False,
        "position": WI_POS_AT_DEPTH,
        "depth": 4,
    }


@pytest.fixture
def disabled_entry():
    """disable=True：条目被禁用。"""
    return {
        "uid": 72,
        "key": ["dragon"],
        "keysecondary": [],
        "comment": "disabled",
        "content": "Disabled content",
        "constant": False,
        "selective": False,
        "disable": True,
        "position": WI_POS_AT_DEPTH,
        "depth": 4,
    }


@pytest.fixture
def sticky_entry():
    """sticky=3：激活后保持 3 轮。"""
    return {
        "uid": 80,
        "key": ["dragon"],
        "keysecondary": [],
        "comment": "sticky",
        "content": "Sticky lore",
        "constant": False,
        "selective": False,
        "sticky": 3,
        "cooldown": 0,
        "delay": 0,
        "position": WI_POS_AT_DEPTH,
        "depth": 4,
    }


@pytest.fixture
def cooldown_entry():
    """cooldown=2：激活后冷却 2 轮。"""
    return {
        "uid": 81,
        "key": ["dragon"],
        "keysecondary": [],
        "comment": "cooldown",
        "content": "Cooldown lore",
        "constant": False,
        "selective": False,
        "sticky": 0,
        "cooldown": 2,
        "delay": 0,
        "position": WI_POS_AT_DEPTH,
        "depth": 4,
    }


@pytest.fixture
def delay_entry():
    """delay=2：前 2 轮不激活。"""
    return {
        "uid": 82,
        "key": ["dragon"],
        "keysecondary": [],
        "comment": "delay",
        "content": "Delay lore",
        "constant": False,
        "selective": False,
        "sticky": 0,
        "cooldown": 0,
        "delay": 2,
        "position": WI_POS_AT_DEPTH,
        "depth": 4,
    }


@pytest.fixture
def triggers_entry():
    """triggers=['to_title']：仅在标题生成时激活。"""
    return {
        "uid": 90,
        "key": ["dragon"],
        "keysecondary": [],
        "comment": "triggers",
        "content": "Triggered lore",
        "constant": False,
        "selective": False,
        "triggers": ["to_title"],
        "position": WI_POS_AT_DEPTH,
        "depth": 4,
    }


@pytest.fixture
def character_filter_entry():
    """character_filter=['Aria']：仅对 name/tag 命中的角色激活。"""
    return {
        "uid": 91,
        "key": ["dragon"],
        "keysecondary": [],
        "comment": "character filter",
        "content": "Filtered lore",
        "constant": False,
        "selective": False,
        "character_filter": ["Aria"],
        "position": WI_POS_AT_DEPTH,
        "depth": 4,
    }


@pytest.fixture
def world_book_with_budget():
    """带预算配置的世界书：budget_tokens='10%', budget_cap=500。"""
    return {
        "id": "wb-budget",
        "name": "budget worldbook",
        "budget_tokens": "10%",
        "budget_cap": 500,
    }


# ---------------------------------------------------------------------------
# 第一层：纯函数验证（无需 DB，真实断言）
# ---------------------------------------------------------------------------
class TestEstimateTokens:
    """``_estimate_tokens``：中文 *2 + 英文词数。"""

    def test_english_words(self):
        assert _estimate_tokens("hello world foo") == 3

    def test_chinese_chars(self):
        # 3 个中文字符 → 3 * 2 = 6
        assert _estimate_tokens("龙骑士") == 6

    def test_mixed(self):
        # 2 中文(4) + 2 英文词(2) = 6
        assert _estimate_tokens("飞龙 dragon wyrm") == 6

    def test_empty(self):
        assert _estimate_tokens("") == 0
        assert _estimate_tokens(None) == 0


class TestResolveBudget:
    """``_resolve_budget``：百分比 / 固定值 / cap / 回退。对照 ST budget 逻辑。"""

    def test_fixed_tokens(self):
        assert _resolve_budget("1000", 0, None, DEFAULT_BUDGET) == 1000

    def test_fixed_tokens_string(self):
        assert _resolve_budget("2048", 0, 8000, DEFAULT_BUDGET) == 2048

    def test_percentage_of_max_context(self):
        # ST: budget = maxContext * (world_info_budget / 100)
        assert _resolve_budget("10%", 0, 8000, DEFAULT_BUDGET) == 800

    def test_percentage_falls_back_to_default_when_no_context(self):
        assert _resolve_budget("10%", 0, None, 16000) == 1600

    def test_budget_cap_applies(self):
        # ST: if budget_cap > 0 and budget > cap → budget = cap
        assert _resolve_budget("10000", 500, 8000, DEFAULT_BUDGET) == 500

    def test_budget_cap_zero_means_no_cap(self):
        assert _resolve_budget("10000", 0, 8000, DEFAULT_BUDGET) == 10000

    def test_empty_budget_uses_default(self):
        assert _resolve_budget(None, 0, 8000, 1234) == 1234
        assert _resolve_budget("", 0, 8000, 1234) == 1234

    def test_invalid_percentage(self):
        # 非法百分比回退为 0
        assert _resolve_budget("abc%", 0, 8000, DEFAULT_BUDGET) == 0

    def test_invalid_fixed(self):
        # 非法固定值回退为 default
        assert _resolve_budget("notanumber", 0, 8000, 999) == 999


class TestParseJsonList:
    """``_parse_json_list``：解析 JSON 数组字符串。"""

    def test_valid_array_string(self):
        assert _parse_json_list('["a", "b"]') == ["a", "b"]

    def test_list_input(self):
        assert _parse_json_list(["x", "y"]) == ["x", "y"]

    def test_empty(self):
        assert _parse_json_list(None) == []
        assert _parse_json_list("") == []

    def test_invalid(self):
        assert _parse_json_list("not json") == []


class TestParseDecorators:
    """``_parse_decorators``：解析 ST 兼容装饰器 @@activate / @@dont_activate / @@include。"""

    def test_activate(self):
        d = _parse_decorators("@@activate\ncontent")
        assert d["activate"] is True
        assert d["dont_activate"] is False

    def test_dont_activate(self):
        d = _parse_decorators("@@dont_activate\ncontent")
        assert d["dont_activate"] is True
        assert d["activate"] is False

    def test_include(self):
        d = _parse_decorators("@@include some text\nbody")
        assert d["include"] == "some text"

    def test_no_decorators(self):
        d = _parse_decorators("plain content only")
        assert d["activate"] is False
        assert d["dont_activate"] is False
        assert d["include"] is None

    def test_empty(self):
        d = _parse_decorators("")
        assert d["activate"] is False


class TestCompileRegexKey:
    """``_compile_regex_key``：/pattern/flags 解析。"""

    def test_plain_regex(self):
        p = _compile_regex_key("/dragon/")
        assert p is not None
        assert p.search("a dragon here") is not None

    def test_case_insensitive_flag(self):
        p = _compile_regex_key("/dragon/i")
        assert p is not None
        assert p.search("DRAGON") is not None

    def test_multiline_flag(self):
        p = _compile_regex_key("/^dragon/m")
        assert p is not None

    def test_non_regex_key(self):
        # 不以 / 开头 → 不是正则
        assert _compile_regex_key("dragon") is None

    def test_invalid_regex(self):
        assert _compile_regex_key("/(/") is None

    def test_empty(self):
        assert _compile_regex_key("") is None


class TestMatchKey:
    """``_match_key``：大小写 / 整词 / 正则 / 子串。"""

    def test_substring_case_insensitive(self):
        assert _match_key("Red Dragon", "dragon", False, False) is True

    def test_substring_case_sensitive_match(self):
        assert _match_key("Red Dragon", "Dragon", True, False) is True

    def test_substring_case_sensitive_mismatch(self):
        assert _match_key("Red dragon", "Dragon", True, False) is False

    def test_whole_words_match(self):
        assert _match_key("a cat sat", "cat", False, True) is True

    def test_whole_words_no_match(self):
        # 'cat' 不应匹配 'category' 中的子串
        assert _match_key("the category", "cat", False, True) is False

    def test_regex_key(self):
        assert _match_key("a wyrm flew", "/dragon|wyrm/i", False, False) is True

    def test_empty_needle(self):
        assert _match_key("text", "", False, False) is False

    def test_empty_haystack(self):
        assert _match_key("", "dragon", False, False) is False


# ---------------------------------------------------------------------------
# 第二层：WorldBookStage 级别验证（内存对象，无需 DB session）
# ---------------------------------------------------------------------------
class TestPrimaryKeyLogic:
    """``_match_primary_keys``：ST 1.18.0 主关键词固定 AND_ANY 语义。

    Bug #1 修复: ST 1.18.0 ``world-info.js:4802-4810`` 中 primary keys 使用
    ``entry.key.find(key => matchKeys(...))`` —— 任意一个 primary key 匹配
    即激活（固定 AND_ANY 语义）。``selectiveLogic`` 只应用于 secondary keys
    (``world-info.js:4827-4866``)，不应在 primary 层应用。
    """

    def test_and_any_any_match(self, primary_key_entry):
        stage = make_stage(primary_key_entry)
        ok, matches = _match_primary_keys(stage, "a dragon flies")
        assert ok is True
        assert "dragon" in matches

    def test_and_any_no_match(self, primary_key_entry):
        stage = make_stage(primary_key_entry)
        ok, _ = _match_primary_keys(stage, "nothing here")
        assert ok is False

    def test_and_all_all_match_ignored_as_primary(self):
        # Bug #1: primary keys 固定 AND_ANY，selectiveLogic=AND_ALL 在 primary 层被忽略
        # ST 行为: 任一 primary key 匹配即激活
        stage = make_stage({
            "uid": 1, "key": ["dragon", "fire"], "selective_logic": WI_LOGIC_AND_ALL,
            "content": "x",
        })
        ok, matches = _match_primary_keys(stage, "dragon and fire")
        assert ok is True
        assert "dragon" in matches

    def test_and_all_partial_match_treated_as_and_any(self):
        # Bug #1: primary keys 固定 AND_ANY，partial match 也激活
        # (旧 Palink 行为: AND_ALL 时 partial match 不激活; ST: 激活)
        stage = make_stage({
            "uid": 1, "key": ["dragon", "fire"], "selective_logic": WI_LOGIC_AND_ALL,
            "content": "x",
        })
        ok, matches = _match_primary_keys(stage, "only dragon")
        assert ok is True
        assert "dragon" in matches

    def test_not_any_ignored_as_primary(self):
        # Bug #1: primary keys 固定 AND_ANY，NOT_ANY 在 primary 层被忽略
        # ST 行为: 任一 primary key 匹配即激活 (NOT_ANY 不再生效)
        stage = make_stage({
            "uid": 1, "key": ["dragon"], "selective_logic": WI_LOGIC_NOT_ANY,
            "content": "x",
        })
        ok, matches = _match_primary_keys(stage, "a dragon")
        assert ok is True
        assert "dragon" in matches

    def test_not_all_ignored_as_primary(self):
        # Bug #1: primary keys 固定 AND_ANY，NOT_ALL 在 primary 层被忽略
        stage = make_stage({
            "uid": 1, "key": ["dragon", "fire"], "selective_logic": WI_LOGIC_NOT_ALL,
            "content": "x",
        })
        ok, _ = _match_primary_keys(stage, "only dragon")
        assert ok is True

    def test_empty_keys_never_matches(self):
        stage = make_stage({"uid": 1, "key": [], "content": "x"})
        ok, _ = _match_primary_keys(stage, "anything")
        assert ok is False


class TestSecondaryKeys:
    """``_match_secondary_keys``：ST 1.18.0 selectiveLogic 应用于次关键词。

    Bug #1 修复: ST 1.18.0 ``world-info.js:4827-4866`` 中 selectiveLogic
    应用在 secondary keys 层，支持 AND_ANY / NOT_ALL / NOT_ANY / AND_ALL
    四种逻辑，且对 AND_ANY / NOT_ALL 使用短路求值。
    """

    def test_and_any_any_match(self, selective_and_any_entry):
        # AND_ANY: 任一 secondary key 匹配即通过
        stage = make_stage(selective_and_any_entry)
        ok, matches = _match_secondary_keys(stage, "dragon with fire")
        assert ok is True
        assert "fire" in matches

    def test_and_any_no_match(self, selective_and_any_entry):
        # AND_ANY: 全部不匹配 → 不通过
        stage = make_stage(selective_and_any_entry)
        ok, _ = _match_secondary_keys(stage, "dragon alone")
        assert ok is False

    def test_and_all_all_match(self):
        # AND_ALL: 全部 secondary key 匹配才通过
        stage = make_stage({
            "uid": 1, "key": ["x"], "keysecondary": ["fire", "ice"],
            "selective_logic": WI_LOGIC_AND_ALL, "content": "x",
        })
        ok, _ = _match_secondary_keys(stage, "fire and ice")
        assert ok is True

    def test_and_all_partial_match(self):
        # AND_ALL: 部分匹配 → 不通过
        stage = make_stage({
            "uid": 1, "key": ["x"], "keysecondary": ["fire", "ice"],
            "selective_logic": WI_LOGIC_AND_ALL, "content": "x",
        })
        ok, _ = _match_secondary_keys(stage, "only fire")
        assert ok is False

    def test_not_any_no_match_activates(self):
        # NOT_ANY: 全部不匹配 → 通过
        stage = make_stage({
            "uid": 1, "key": ["x"], "keysecondary": ["fire"],
            "selective_logic": WI_LOGIC_NOT_ANY, "content": "x",
        })
        ok, matches = _match_secondary_keys(stage, "nothing here")
        assert ok is True
        assert matches == []

    def test_not_any_match_deactivates(self):
        # NOT_ANY: 任一匹配 → 不通过
        stage = make_stage({
            "uid": 1, "key": ["x"], "keysecondary": ["fire"],
            "selective_logic": WI_LOGIC_NOT_ANY, "content": "x",
        })
        ok, _ = _match_secondary_keys(stage, "a fire")
        assert ok is False

    def test_not_all_partial_match_activates(self):
        # NOT_ALL: 任一不匹配 → 通过 (短路)
        stage = make_stage({
            "uid": 1, "key": ["x"], "keysecondary": ["fire", "ice"],
            "selective_logic": WI_LOGIC_NOT_ALL, "content": "x",
        })
        ok, _ = _match_secondary_keys(stage, "only fire")
        assert ok is True

    def test_not_all_all_match_deactivates(self):
        # NOT_ALL: 全部匹配 → 不通过
        stage = make_stage({
            "uid": 1, "key": ["x"], "keysecondary": ["fire", "ice"],
            "selective_logic": WI_LOGIC_NOT_ALL, "content": "x",
        })
        ok, _ = _match_secondary_keys(stage, "fire and ice")
        assert ok is False

    def test_empty_secondary_is_ok(self):
        # 无次关键词 → 视为通过
        stage = make_stage({"uid": 1, "key": ["x"], "keysecondary": [], "content": "x"})
        ok, matches = _match_secondary_keys(stage, "anything")
        assert ok is True
        assert matches == []


# ---------------------------------------------------------------------------
# 第三层：完整引擎验证（真实 DB session）
#
# 2026-10-10 补实：原先这里 28 个用例全是 ``pytest.skip("requires DB session")``
# 空壳。该 skip 理由是假的——``tests/conftest.py:84`` 的 ``db_session`` fixture
# 一直可用（SQLite in-memory，函数级隔离）。现全部改写为真实断言：
# 建库（User / Character / CharacterChatSession / WorldBook / WorldBookStage）
# → 调用 ``build_worldbook_context`` → 断言 debug_report 状态与具体值。
#
# 断言一律按 ``worldbook_service.py`` 的**实际实现**编写，不按旧 docstring 的
# 想象语义；凡与旧 docstring 冲突处都在用例内标注了实现行号。
# ---------------------------------------------------------------------------
def _mk_world(db_session, st_entries, *, tag="t", budget_tokens=None, budget_cap=0):
    """建好一整套世界书依赖并返回 (user, char, session_id, book_id)。

    书绑定到本会话角色（``character_id=char.id`` → lore source="character"），
    符合 [WB-CHAR-ISOLATION 2026-10-03] 之后「未绑定的书不注入」的契约
    （见 worldbook_service.py:1949-1973）。
    """
    book_id = f"wb-{tag}-{uuid.uuid4().hex[:8]}"
    sess_id = f"sess-{tag}-{uuid.uuid4().hex[:8]}"

    user = User(
        username=f"wbse-{tag}-{uuid.uuid4().hex[:8]}",
        hashed_password=get_password_hash("TestPassword1"),
        role="user",
        is_active=True,
    )
    db_session.add(user)
    db_session.flush()

    char = Character(
        id=f"wbse-c-{tag}-{uuid.uuid4().hex[:8]}",
        user_id=user.id,
        name="WbSeChar",
    )
    db_session.add(char)
    db_session.flush()

    db_session.add(CharacterChatSession(
        id=sess_id, user_id=user.id, character_id=char.id, title="wbse",
    ))
    db_session.add(WorldBook(
        id=book_id,
        user_id=user.id,
        name=f"wbse-book-{tag}",
        character_id=char.id,
        budget_tokens=budget_tokens,
        budget_cap=budget_cap,
    ))
    db_session.flush()

    for raw in st_entries:
        entry = dict(raw)
        entry["_world_book_id"] = book_id
        db_session.add(make_stage(entry))
    db_session.commit()
    return user, char, sess_id, book_id


def _run(db_session, user, char, sess_id, messages, **kwargs):
    """调用真实引擎 ``build_worldbook_context`` 并提交（供多轮用例复用会话）。"""
    result = build_worldbook_context(
        db_session,
        sess_id,
        user.id,
        recent_messages=[{"role": "user", "content": m} for m in messages],
        character=char,
        **kwargs,
    )
    # 提交以便 TimedEffectsManager 下一轮能读到本轮写入的 sticky/cooldown 状态
    db_session.commit()
    return result


def _report_of(result, entry_id):
    """取该条目**最后一条**报告（递归每轮会产生一条，末态才是真实结果）。"""
    reports = [r for r in result.debug_report if r.entry_id == entry_id]
    return reports[-1] if reports else None


def _activated_ids(result):
    return [r.entry_id for r in result.debug_report if r.status == "activated"]


def _pick_highest_weight(population, weights=None, cum_weights=None, k=1):
    """``random.choices`` 的确定性替身：恒取权重最大者（用于分组加权断言）。"""
    ws = weights or [1] * len(population)
    idx = max(range(len(population)), key=lambda i: ws[i])
    return [population[idx]] * k


class TestConstantEntry:
    def test_constant_entry_always_activates(self, db_session, constant_entry):
        """常量条目应始终激活，无论 recent_messages 内容。

        实现依据: worldbook_service.py:906-920 —— ``if entry.constant`` 位于
        关键词匹配之前，直接 activated(reason="constant")。
        """
        user, char, sess, _ = _mk_world(db_session, [constant_entry], tag="const")

        # 1) 有无关消息
        r1 = _run(db_session, user, char, sess, ["今天天气不错，跟关键词毫无关系"])
        rep1 = _report_of(r1, "1")
        assert rep1.status == "activated"
        assert rep1.reason == "constant"
        # constant_entry.position = WI_POS_BEFORE_CHAR(0) → 进 entries_by_position[0]
        assert r1.entries_by_position == {0: ["Always active content"]}
        assert r1.text == "[World Lore]\nAlways active content"

        # 2) 空消息列表：常量条目同样必须激活
        r2 = _run(db_session, user, char, sess, [])
        rep2 = _report_of(r2, "1")
        assert rep2.status == "activated"
        assert rep2.reason == "constant"
        assert r2.entries_by_position == {0: ["Always active content"]}


class TestPrimaryKeyMatch:
    def test_primary_key_match_activates(self, db_session, primary_key_entry):
        """主关键词命中应激活条目。

        实现依据: worldbook_service.py:993-1003（``_match_primary_keys``，
        ST 固定 AND_ANY：任一 primary key 命中即通过）。
        """
        user, char, sess, _ = _mk_world(db_session, [primary_key_entry], tag="pk")

        hit = _run(db_session, user, char, sess, ["a dragon flies overhead"])
        rep = _report_of(hit, "2")
        assert rep.status == "activated"
        assert rep.reason == "keyword_match"
        assert "dragon" in rep.matched_keywords
        # position=WI_POS_BEFORE_CHAR(0)
        assert hit.entries_by_position == {0: ["Dragon info"]}

        miss = _run(db_session, user, char, sess, ["nothing relevant at all"])
        rep_miss = _report_of(miss, "2")
        assert rep_miss.status == "skipped"
        assert rep_miss.reason == "primary_keys_mismatch"
        assert miss.entries_by_position == {}


class TestSelectiveLogic:
    def test_selective_and_any(self, db_session, selective_and_any_entry):
        """选择性 AND_ANY：主关键词命中 + 任一次关键词命中才激活。

        实现依据: worldbook_service.py:1005-1019 + :592-594
        （``_match_secondary_keys`` AND_ANY 短路：任一次关键词命中即通过）。
        """
        user, char, sess, _ = _mk_world(db_session, [selective_and_any_entry], tag="sel")

        hit = _run(db_session, user, char, sess, ["the dragon breathes fire"])
        rep = _report_of(hit, "3")
        assert rep.status == "activated"
        assert rep.reason == "keyword_match"
        assert "dragon" in rep.matched_keywords
        assert "fire" in rep.matched_keywords

        # 主关键词命中但次关键词一个都不中 → 不激活
        miss = _run(db_session, user, char, sess, ["the dragon sleeps quietly"])
        rep_miss = _report_of(miss, "3")
        assert rep_miss.status == "skipped"
        assert rep_miss.reason == "secondary_keys_mismatch"

    def test_selective_not_any(self, db_session, selective_not_any_entry):
        """选择性 NOT_ANY：次关键词全部不匹配才激活，任一命中即抑制。

        实现依据: worldbook_service.py:602-603（``logic == NOT_ANY`` →
        ``return not has_any_match``）。
        """
        user, char, sess, _ = _mk_world(db_session, [selective_not_any_entry], tag="sna")

        # 没有 unicorn → NOT_ANY 通过
        hit = _run(db_session, user, char, sess, ["a dragon appears"])
        rep = _report_of(hit, "4")
        assert rep.status == "activated"
        assert rep.reason == "keyword_match"
        assert rep.matched_keywords == ["dragon"]

        # 出现 unicorn → NOT_ANY 不通过
        miss = _run(db_session, user, char, sess, ["a dragon and a unicorn"])
        rep_miss = _report_of(miss, "4")
        assert rep_miss.status == "skipped"
        assert rep_miss.reason == "secondary_keys_mismatch"


class TestProbability:
    def test_probability_zero_never_activates(self, db_session, probability_zero_entry, monkeypatch):
        """概率为 0 的条目即使关键词命中也不应激活。

        实现依据: worldbook_service.py:1021-1041 —— ``use_prob and prob < 100``
        时滚动 ``random.random() * 100``，``roll >= prob`` 即跳过。
        """
        monkeypatch.setattr(random, "random", lambda: 0.5)  # roll = 50
        user, char, sess, _ = _mk_world(db_session, [probability_zero_entry], tag="p0")

        result = _run(db_session, user, char, sess, ["a rare sighting"])
        rep = _report_of(result, "5")
        assert rep.status == "skipped"
        assert rep.reason == "probability=0%,roll=50"
        assert rep.probability_roll == 50
        # 未激活 → 不进入任何位置分组
        assert result.depth_entries == []
        assert result.entries_by_position == {}
        assert result.text is None

    def test_probability_hundred_always_activates(self, db_session, probability_hundred_entry):
        """概率为 100 的条目满足关键词条件时必然激活（且不滚动随机数）。

        实现依据: worldbook_service.py:1025 —— ``prob < 100`` 为假时整段跳过，
        因此 ``probability_roll`` 保持默认 None。
        """
        user, char, sess, _ = _mk_world(db_session, [probability_hundred_entry], tag="p100")

        result = _run(db_session, user, char, sess, ["a common sighting"])
        rep = _report_of(result, "6")
        assert rep.status == "activated"
        assert rep.reason == "keyword_match"
        assert rep.probability_roll is None
        assert result.depth_entries == [(4, "Always triggers when matched", 0)]

        miss = _run(db_session, user, char, sess, ["nothing here"])
        assert _report_of(miss, "6").reason == "primary_keys_mismatch"


class TestRecursion:
    def test_recursion_activation(self, db_session, recursion_chain_a, recursion_chain_b):
        """递归激活：A 内容包含 B 的关键词，B 应在递归扫描中被激活。

        实现依据: worldbook_service.py:1155-1172 —— 每轮把已激活条目的内容
        （非 exclude/prevent）追加为一条 system 消息，进入下一轮 haystack。
        """
        user, char, sess, _ = _mk_world(
            db_session, [recursion_chain_a, recursion_chain_b], tag="rec",
        )

        result = _run(db_session, user, char, sess, ["we enter the castle"])

        # A（uid 10）在 depth=0 命中 "castle"
        rep_a = _report_of(result, "10")
        assert rep_a.status == "activated"
        assert rep_a.recursion_depth == 0
        assert rep_a.matched_keywords == ["castle"]

        # B（uid 11）在 depth=1 由 A 的内容 "The castle has a dungeon." 命中
        rep_b = _report_of(result, "11")
        assert rep_b.status == "activated"
        assert rep_b.recursion_depth == 1
        assert rep_b.matched_keywords == ["dungeon"]

        assert _activated_ids(result) == ["10", "11"]
        assert result.depth_entries == [
            (4, "The castle has a dungeon.", 0),
            (4, "The dungeon is dark.", 0),
        ]

    def test_prevent_recursion(self, db_session, prevent_recursion_entry):
        """prevent_recursion 条目自身正常激活，内容不进入递归扫描 buffer。

        实现依据: worldbook_service.py:1161-1163 —— 收集 new_content_parts 时
        跳过 ``prevent_recursion`` 条目；条目本身不被跳过（A3，注释 :788-790）。
        """
        # 下游条目以 prevent 条目内容里的 "depth" 为关键词：只有当 prevent
        # 条目内容真的进入递归 buffer 时才可能被激活。
        downstream = {
            "uid": 201,
            "key": ["depth"],
            "keysecondary": [],
            "comment": "downstream",
            "content": "Downstream depth lore",
            "position": WI_POS_AT_DEPTH,
            "depth": 4,
        }
        user, char, sess, _ = _mk_world(
            db_session, [prevent_recursion_entry, downstream], tag="prev",
        )

        result = _run(db_session, user, char, sess, ["a dragon appears"])

        # 1) prevent 条目自身正常激活（A3 语义）
        rep = _report_of(result, "12")
        assert rep.status == "activated"
        assert rep.reason == "keyword_match"
        assert rep.recursion_depth == 0

        # 2) 其内容 "Only at depth 0" 未进入递归 buffer → 下游条目始终未命中
        rep_down = _report_of(result, "201")
        assert rep_down.status == "skipped"
        assert rep_down.reason == "primary_keys_mismatch"
        # 从未进入 depth=1，说明递归在第一轮后就 break（:1165-1167）
        assert all(r.recursion_depth == 0 for r in result.debug_report)
        assert result.depth_entries == [(4, "Only at depth 0", 0)]

    def test_delay_until_recursion(self, db_session, delay_until_recursion_entry):
        """delay_until_recursion 延迟到指定递归深度才可激活。

        实现依据: worldbook_service.py:792-803 —— ``delay_until > 0 and
        recursion_depth < delay_until`` → skipped，reason 带 current 深度。
        """
        # 造一条 3 层递归链，让 delayed 条目在第 2 层才首次被评估
        chain_a = {
            "uid": 101, "key": ["castle"], "keysecondary": [],
            "comment": "chain A", "content": "The castle has a tower.",
            "order": 3, "position": WI_POS_AT_DEPTH, "depth": 4,
        }
        chain_b = {
            "uid": 102, "key": ["tower"], "keysecondary": [],
            "comment": "chain B", "content": "The tower hides a dragon.",
            "order": 2, "position": WI_POS_AT_DEPTH, "depth": 4,
        }
        delayed = dict(delay_until_recursion_entry, order=1)

        user, char, sess, _ = _mk_world(
            db_session, [chain_a, chain_b, delayed], tag="dur",
        )

        result = _run(db_session, user, char, sess, ["we enter the castle"])

        delayed_reports = [r for r in result.debug_report if r.entry_id == "13"]
        # depth=0 / depth=1 各被拦一次
        assert [r.recursion_depth for r in delayed_reports] == [0, 1, 2]
        assert delayed_reports[0].status == "skipped"
        assert delayed_reports[0].reason == "delay_until_recursion=2,current=0"
        assert delayed_reports[1].status == "skipped"
        assert delayed_reports[1].reason == "delay_until_recursion=2,current=1"
        # depth=2 放行并命中 B 内容里的 "dragon"
        assert delayed_reports[2].status == "activated"
        assert delayed_reports[2].reason == "keyword_match"
        assert delayed_reports[2].matched_keywords == ["dragon"]

    def test_exclude_recursion(self, db_session, exclude_recursion_entry):
        """exclude_recursion 条目内容不计入递归扫描文本。

        实现依据:
        - worldbook_service.py:1161-1163 —— 内容不入 new_content_parts；
        - worldbook_service.py:808-818 —— depth>0 时该条目本身也被跳过。
        """
        # 下游条目以 exclude 条目内容里的 "seed" 为关键词
        downstream = {
            "uid": 202, "key": ["seed"], "keysecondary": [],
            "comment": "downstream", "content": "Downstream seed lore",
            "order": 1, "position": WI_POS_AT_DEPTH, "depth": 4,
        }
        user, char, sess, _ = _mk_world(
            db_session,
            [dict(exclude_recursion_entry, order=2), downstream],
            tag="exrec",
        )

        result = _run(db_session, user, char, sess, ["a dragon appears"])

        # 1) depth=0 正常激活
        rep = _report_of(result, "14")
        assert rep.status == "activated"
        assert rep.recursion_depth == 0

        # 2) 内容 "Won't seed further recursion" 未进入递归 buffer → 下游不激活
        rep_down = _report_of(result, "202")
        assert rep_down.status == "skipped"
        assert rep_down.reason == "primary_keys_mismatch"
        assert result.depth_entries == [(4, "Won't seed further recursion", 0)]


class TestGroupWeighted:
    def test_group_weighted_choice(self, db_session, group_weighted_entries, monkeypatch):
        """分组加权：同组非 override 时按 group_weight 随机选一个，其余淘汰。

        实现依据: ``_apply_group_scoring`` worldbook_service.py:1787-1801 ——
        ``random.choices(random_candidates, weights=weights, k=1)``，
        未中选者 status="eliminated" / reason="group_scoring_eliminated"。
        权重取值: ``(e.group_weight if (e.group_weight or 0) > 0 else 100)``（:1788）。
        """
        from app.services import worldbook_service as wbs

        # 用确定性替身替换 random.choices：恒选权重最大者（uid20 weight=80 > uid21 weight=20）
        monkeypatch.setattr(wbs.random, "choices", _pick_highest_weight)

        user, char, sess, _ = _mk_world(db_session, group_weighted_entries, tag="gw")
        result = _run(db_session, user, char, sess, ["weather report"])

        rep20 = _report_of(result, "20")
        rep21 = _report_of(result, "21")
        assert rep20.status == "activated", "权重最大者应被选中"
        assert rep21.status == "eliminated"
        assert rep21.reason == "group_scoring_eliminated"

    def test_group_override_keeps_all(self, db_session, group_override_entry):
        """group_override=True 的**实际**语义（与旧 docstring 不符，按实现写）。

        ⚠️ 旧 docstring 写「分组内条目全部保留」，但实现是 ST 1.18.0 groupOverride：
        ``_apply_group_scoring`` worldbook_service.py:1732-1746 —— 组内**有任意**
        override 条目时，选 **order 最小**的 override 作为**唯一 winner**，
        淘汰组内其他全部条目（含非 override）。故本用例构造一个同组非 override
        sibling，断言它被淘汰 —— 这才真正验证 override 语义（单条目时两种解释结果相同）。
        """
        sibling = {
            **group_override_entry,
            "uid": 23,
            "comment": "non-override sibling",
            "content": "Sibling content",
            "group_override": False,
            "group_weight": 100,
        }
        user, char, sess, _ = _mk_world(
            db_session, [group_override_entry, sibling], tag="gov"
        )
        result = _run(db_session, user, char, sess, ["weather"])

        status = {r.entry_id: (r.status, r.reason) for r in result.debug_report}
        winners = [eid for eid, (st, _) in status.items() if st == "activated"]
        assert len(winners) == 1, f"override 组应只留唯一 winner，实际 {winners}"
        loser = [eid for eid in ("22", "23") if eid != winners[0]][0]
        assert status[loser] == ("eliminated", "group_override_eliminated")

    def test_min_activations_not_met(self, db_session, min_activations_entries):
        """min_activations 未满足时整组被淘汰。

        实现依据: ``_apply_group_scoring`` worldbook_service.py:1748-1761 ——
        ``min_required`` 取组内最大 min_activations（:1750-1754），
        已激活条目数 ``len(group_entries) < min_required`` 则整组 eliminated，
        reason 为 f-string ``min_activations_not_met(required=..,actual=..)``（:1760）。

        构造：两个条目 key 分别是 alpha / beta，消息只含 "alpha"
        ⇒ 只有 uid30 激活 ⇒ 组内激活数 1 < 2 ⇒ 淘汰。
        """
        user, char, sess, _ = _mk_world(db_session, min_activations_entries, tag="ma")
        result = _run(db_session, user, char, sess, ["alpha"])

        rep30 = _report_of(result, "30")
        assert rep30.status == "eliminated"
        assert rep30.reason.startswith("min_activations_not_met(required=2,actual=1)"), \
            f"reason 应说明 required/actual，实际 {rep30.reason!r}"


class TestDepthInsertion:
    def test_depth_insertion(self, db_session, depth_insertion_entry):
        """深度插入：条目应出现在 depth_entries 中对应深度。

        实现依据: build_worldbook_context worldbook_service.py:2161-2169 ——
        ``_depth_value = 4 if entry.depth is None else entry.depth``（**depth=0 是合法值**，
        不能写成 `entry.depth or 4`，那是已修过的 2026-10-05 缺陷），
        追加三元组 ``(depth, content, role)``，role 默认 0=system。
        """
        user, char, sess, _ = _mk_world(db_session, [depth_insertion_entry], tag="dep")
        result = _run(db_session, user, char, sess, ["a dragon appears"])

        assert _report_of(result, "40").status == "activated"
        assert result.depth_entries == [(2, "Injected at depth 2", 0)], \
            f"depth=2 的条目应落 (2, content, 0)，实际 {result.depth_entries}"

    def test_position_before(self, db_session, position_before_entry):
        """position=before(0) 应进入 entries_by_position[0]。

        实现依据: worldbook_service.py:2177-2178 —— 非 AT_DEPTH/EM_*/OUTLET 的
        position 一律 ``entries_by_position.setdefault(pos, []).append(content)``。
        """
        user, char, sess, _ = _mk_world(db_session, [position_before_entry], tag="pbf")
        result = _run(db_session, user, char, sess, ["a dragon appears"])

        assert _report_of(result, "41").status == "activated"
        assert result.entries_by_position == {0: ["Before char content"]}, \
            f"实际 {result.entries_by_position}"

    def test_position_outlet(self, db_session, position_outlet_entry):
        """position=outlet(7) 应进入 outlet_entries[outlet_name]。

        实现依据: worldbook_service.py:2174-2176 ——
        ``outlet_name = (entry.outlet_name or "default").strip() or "default"``，
        再 ``outlet_entries.setdefault(outlet_name, []).append(content)``。
        """
        user, char, sess, _ = _mk_world(db_session, [position_outlet_entry], tag="out")
        result = _run(db_session, user, char, sess, ["a dragon appears"])

        assert _report_of(result, "42").status == "activated"
        assert result.outlet_entries == {"lore_box": ["Outlet content"]}, \
            f"实际 {result.outlet_entries}"


class TestBudgetExclusion:
    def test_budget_exclusion(self, db_session, budget_huge_entry):
        """超出 token budget 的条目应被 trim（status=trimmed）。

        实现依据: ``_apply_budget`` worldbook_service.py:1387-1394 ——
        ``used + est > max_tokens`` 时 status="trimmed"，
        reason=f"budget_exceeded (est=.., used=.., max=..)"（:1393）。
        本用例把书级预算压到 100，条目 content 约 5000 tokens ⇒ 必然超。
        """
        user, char, sess, _ = _mk_world(
            db_session, [budget_huge_entry], tag="bud", budget_tokens=100
        )
        result = _run(db_session, user, char, sess, ["a dragon appears"])

        rep = _report_of(result, "50")
        assert rep.status == "trimmed", f"应被预算裁掉，实际 {rep.status}"
        assert rep.reason.startswith("budget_exceeded"), f"实际 reason={rep.reason!r}"
        # 被裁掉的条目不应进入最终文本
        assert "word word" not in (result.text or "")

    def test_budget_percentage_and_cap(self, world_book_with_budget):
        """budget_tokens='10%' + budget_cap=500 ⇒ min(10%·ctx, 500)。

        实现依据: ``_resolve_budget`` worldbook_service.py:1331-1346 ——
        百分比按 max_context_tokens 折算（:1336-1337），
        再 ``cap > 0 and resolved > cap`` 时钳到 cap（:1344-1346）。

        诚实标注：本用例直接调纯函数，**不经过引擎**（原注释即说「纯函数层面已覆盖」）。
        引擎级端到端（书级 budget_tokens 真的生效）由上一个用例覆盖。
        """
        from app.services.worldbook_service import _resolve_budget

        # 10% of 10000 = 1000，被 cap=500 钳住
        assert _resolve_budget("10%", 500, 10000, 16000) == 500
        # 无 cap 时按百分比
        assert _resolve_budget("10%", 0, 10000, 16000) == 1000
        # cap 大于百分比结果时不生效
        assert _resolve_budget("10%", 5000, 10000, 16000) == 1000
        # 固定值
        assert _resolve_budget("800", 0, 10000, 16000) == 800
        # 空值回退 default
        assert _resolve_budget(None, 0, 10000, 16000) == 16000


class TestTimedEffects:
    def test_sticky_keeps_active(self, db_session, sticky_entry):
        """sticky 激活后在剩余轮次内保持激活（无条件激活，跳过关键词匹配）。

        实现依据: ``_scan_entries`` worldbook_service.py:922-940 ——
        ``is_sticky_active`` 为真时直接 activated，**reason="sticky_active"**，
        并续期（``record_activation``）。
        第 1 轮命中关键词激活；第 2 轮消息**不含** "dragon"，但 sticky_remaining>0
        ⇒ 仍应 activated(reason="sticky_active")。
        """
        user, char, sess, _ = _mk_world(db_session, [sticky_entry], tag="stk")

        r1 = _run(db_session, user, char, sess, ["a dragon appears"])
        assert _report_of(r1, "80").status == "activated"

        # 第 2 轮：消息与关键词无关，靠 sticky 保持
        r2 = _run(db_session, user, char, sess, ["nothing relevant here"])
        rep2 = _report_of(r2, "80")
        assert rep2.status == "activated", "sticky 期内应无条件激活"
        assert rep2.reason == "sticky_active"

    def test_cooldown_blocks(self, db_session, cooldown_entry):
        """cooldown 激活后在冷却轮次内不可再次激活。

        实现依据: ``TimedEffectsManager.can_activate`` worldbook_service.py:220-223
        （``cooldown_remaining > 0 and not is_sticky_active`` → False）+
        ``_scan_entries`` :851-872 生成 reason="timed_effect:cooldown=N"（:860-861）。
        """
        user, char, sess, _ = _mk_world(db_session, [cooldown_entry], tag="cd")

        r1 = _run(db_session, user, char, sess, ["a dragon appears"])
        assert _report_of(r1, "81").status == "activated"

        r2 = _run(db_session, user, char, sess, ["a dragon appears again"])
        rep2 = _report_of(r2, "81")
        assert rep2.status == "skipped", "冷却期内不应再次激活"
        assert rep2.reason.startswith("timed_effect:cooldown="), \
            f"实际 reason={rep2.reason!r}"

    def test_delay_blocks_initial(self, db_session, delay_entry):
        """delay 前 N 轮不可激活（ST chat_length 绝对语义）。

        实现依据: ``can_activate`` worldbook_service.py:212-213 ——
        ``entry.delay > 0 and effective_chat_length < entry.delay`` → False；
        reason 由 ``_scan_entries`` :854-858 拼成 "timed_effect:delay=2,chat_length=1"。
        注意 delay 判定是**无状态**的（D-1 修复，2026-08-23），不依赖 state 行。
        """
        user, char, sess, _ = _mk_world(db_session, [delay_entry], tag="dly")

        # chat_length=1 < delay=2 ⇒ 本轮抑制
        r = _run(db_session, user, char, sess, ["a dragon appears"], chat_length=1)
        rep = _report_of(r, "82")
        assert rep.status == "skipped"
        assert rep.reason.startswith("timed_effect:delay="), f"实际 reason={rep.reason!r}"

        # chat_length=5 >= delay=2 ⇒ 解除抑制
        r2 = _run(db_session, user, char, sess, ["a dragon appears"], chat_length=5)
        assert _report_of(r2, "82").status == "activated", "超过 delay 后应可激活"


class TestDecorators:
    def test_decorator_activate(self, db_session, decorator_activate_entry):
        """@@activate 强制激活（跳过关键词匹配）。

        实现依据: ``_scan_entries`` worldbook_service.py:890-904 ——
        ``decorators.get('activate')`` 为真时直接 activated，
        **reason="decorator_activate"**（:898），且 key 为空也不影响。
        """
        user, char, sess, _ = _mk_world(db_session, [decorator_activate_entry], tag="da")
        # 消息与任何关键词都无关（该条目 key 本来就是空）
        result = _run(db_session, user, char, sess, ["unrelated text"])

        rep = _report_of(result, "70")
        assert rep.status == "activated"
        assert rep.reason == "decorator_activate"

    def test_decorator_dont_activate(self, db_session, decorator_dont_activate_entry):
        """@@dont_activate 强制跳过（即使关键词命中）。

        实现依据: ``_scan_entries`` worldbook_service.py:879-889 ——
        ``dont_activate`` 或 ``exclude`` 为真时 skipped，
        reason 在两者间二选一（:886）：exclude 优先为 "decorator_exclude"，
        否则 "decorator_dont_activate"。
        """
        user, char, sess, _ = _mk_world(
            db_session, [decorator_dont_activate_entry], tag="dd"
        )
        # 关键词 "dragon" 命中，但装饰器应压制
        result = _run(db_session, user, char, sess, ["a dragon appears"])

        rep = _report_of(result, "71")
        assert rep.status == "skipped"
        assert rep.reason == "decorator_dont_activate", f"实际 reason={rep.reason!r}"


class TestDisabledEntry:
    def test_disabled_skipped(self, db_session, disabled_entry):
        """disable=True 的条目应被跳过（reason=disabled）。

        实现依据: ``_scan_entries`` worldbook_service.py:778-787 ——
        检查的是 ``entry.enabled is False``；而 ``make_stage`` :139 把 ST 的
        ``disable`` 映射为 ``enabled = not bool(disable)``，故 fixture 的
        ``"disable": True`` ⇒ ``enabled=False``。该检查位于扫描最前，优先于一切。
        """
        user, char, sess, _ = _mk_world(db_session, [disabled_entry], tag="dis")
        result = _run(db_session, user, char, sess, ["a dragon appears"])

        rep = _report_of(result, "72")
        assert rep.status == "skipped"
        assert rep.reason == "disabled"


class TestTriggersAndFilter:
    def test_triggers_mismatch(self, db_session, triggers_entry):
        """triggers 与 trigger_type 不匹配时跳过。

        实现依据: ``_scan_entries`` worldbook_service.py:820-831 ——
        条件为 ``triggers and trigger_type and trigger_type not in triggers``，
        **必须显式传 trigger_type 才会触发**（不传时该检查整体短路、条目照常参与关键词匹配）。
        reason = f"trigger_mismatch:{trigger_type}"（:828）。
        """
        user, char, sess, _ = _mk_world(db_session, [triggers_entry], tag="trg")

        # 该条目 triggers=["to_title"]，传 trigger_type="normal" ⇒ 不匹配
        r_mismatch = _run(
            db_session, user, char, sess, ["a dragon appears"], trigger_type="normal"
        )
        rep = _report_of(r_mismatch, "90")
        assert rep.status == "skipped"
        assert rep.reason == "trigger_mismatch:normal", f"实际 reason={rep.reason!r}"

        # 传匹配的 trigger_type="to_title" ⇒ 不跳过，正常走关键词匹配
        r_match = _run(
            db_session, user, char, sess, ["a dragon appears"], trigger_type="to_title"
        )
        assert _report_of(r_match, "90").status == "activated"

    def test_character_filter_mismatch(self, db_session, character_filter_entry):
        """character_filter 与当前角色 name/tag 不匹配时跳过。

        实现依据: ``_scan_entries`` worldbook_service.py:833-849 ——
        当前角色名不在 filter 里、且没有任何 tag 命中时 skipped，
        reason="character_filter_mismatch"（:846）。
        fixture 的 filter=["Aria"]，而 ``_mk_world`` 建的角色名是 "WbSeChar" ⇒ 不匹配。
        """
        user, char, sess, _ = _mk_world(
            db_session, [character_filter_entry], tag="cf"
        )
        result = _run(db_session, user, char, sess, ["a dragon appears"])

        rep = _report_of(result, "91")
        assert rep.status == "skipped"
        assert rep.reason == "character_filter_mismatch"


class TestDebugReportFields:
    """验证 WorldbookEntryReport 携带的调试字段完整性。

    对照任务要求：debug report 应包含
    - 激活/跳过原因 (status + reason)
    - 匹配的主/次关键词 (matched_keywords)
    - 递归深度 (recursion_depth)
    - 概率滚动结果 (probability_roll)
    - 分组评分决策 (eliminated status)
    - 预算包含/排除 (trimmed status)
    - 最终插入位置 (position)
    """

    def test_report_dataclass_fields(self):
        """WorldbookEntryReport 应包含全部调试字段（含新增 enrichment 字段）。"""
        r = WorldbookEntryReport(
            entry_id="x",
            title="t",
            status="activated",
            reason="keyword_match",
            matched_keywords=["dragon"],
            tokens_estimate=10,
            recursion_depth=2,
            position=WI_POS_AT_DEPTH,
            probability_roll=42,
        )
        assert r.recursion_depth == 2
        assert r.position == WI_POS_AT_DEPTH
        assert r.probability_roll == 42
        assert r.matched_keywords == ["dragon"]

    def test_report_default_fields(self):
        """未设置时 enrichment 字段应有安全默认值。"""
        r = WorldbookEntryReport(entry_id="x", title="t", status="skipped")
        assert r.recursion_depth == -1
        assert r.position is None
        assert r.probability_roll is None
        assert r.matched_keywords == []
        assert r.tokens_estimate == 0

    def test_engine_report_contains_depth_and_position(self, db_session, primary_key_entry):
        """端到端：activated 报告应携带 recursion_depth 与 position。

        实现依据: ``_scan_entries`` worldbook_service.py:773
        （``_entry_position_map = {e.id: e.position for e in entries}``）
        与 :1066-1068 的扫描后回填循环：
        ``_r.recursion_depth = recursion_depth`` / ``_r.position = _entry_position_map.get(_r.entry_id)``。
        初始扫描传 recursion_depth=0，故此处应为 0 而非 dataclass 默认的 -1。
        position 取的是**条目自身**的 position（本 fixture 为 ``WI_POS_BEFORE_CHAR``=0），
        不是 WI_POS_AT_DEPTH —— 别照 AT_DEPTH 想当然。
        """
        user, char, sess, _ = _mk_world(db_session, [primary_key_entry], tag="rdp")
        result = _run(db_session, user, char, sess, ["a dragon appears"])

        rep = _report_of(result, "2")
        assert rep.status == "activated"
        assert rep.recursion_depth == 0, \
            f"初始扫描应为 0（-1 是 dataclass 默认值，说明回填没跑到），实际 {rep.recursion_depth}"
        assert rep.position == WI_POS_BEFORE_CHAR, f"实际 {rep.position}"

    def test_engine_report_contains_probability_roll(self, db_session, probability_zero_entry, monkeypatch):
        """端到端：因概率被跳过的报告应携带 probability_roll。

        实现依据: worldbook_service.py:1037 —— 概率滚动命中时
        ``WorldbookEntryReport(..., probability_roll=int(roll))``。
        固定 ``random.random() -> 0.5`` ⇒ roll = 50。
        """
        monkeypatch.setattr(random, "random", lambda: 0.5)
        user, char, sess, _ = _mk_world(db_session, [probability_zero_entry], tag="pr")

        result = _run(db_session, user, char, sess, ["a rare sighting"])
        rep = _report_of(result, "5")
        assert rep.status == "skipped"
        assert rep.probability_roll == 50, f"实际 {rep.probability_roll}"


class TestWorldbookContextResult:
    """验证 WorldbookContextResult 结构包含所有位置分组（对照 ST 输出结构）。"""

    def test_result_fields(self):
        result = WorldbookContextResult(
            text="lore",
            debug_report=[],
            total_tokens=5,
            budget_used=100,
        )
        assert result.entries_by_position == {}
        assert result.depth_entries == []
        assert result.em_top_entries == []
        assert result.em_bottom_entries == []
        assert result.outlet_entries == {}

    def test_result_positions_match_st(self):
        """ST 输出分组：WIBefore/After/EM/ANTop/ANBottom/Depth/Outlet。
        Palink WorldbookContextResult 应覆盖等价分组。"""
        # entries_by_position 覆盖 before(0)/after(1)/ANTop(2)/ANBottom(3)
        # depth_entries 覆盖 atDepth(4)
        # em_top_entries / em_bottom_entries 覆盖 EMTop(5)/EMBottom(6)
        # outlet_entries 覆盖 outlet(7)
        result = WorldbookContextResult(
            text=None, debug_report=[], total_tokens=0, budget_used=0,
            entries_by_position={0: ["before"], 1: ["after"]},
            depth_entries=[(2, "at-depth", 0)],  # G6: (depth, content, role)
            em_top_entries=["em-top"],
            em_bottom_entries=["em-bottom"],
            outlet_entries={"lore_box": ["outlet"]},
        )
        assert result.entries_by_position[0] == ["before"]
        assert result.depth_entries == [(2, "at-depth", 0)]
        assert result.outlet_entries["lore_box"] == ["outlet"]


# ---------------------------------------------------------------------------
# Phase E: MIN_ACTIVATIONS 状态机单元测试（无需 DB session）
#
# 对照 ST 1.18.0 ``world-info.js:4991-5005`` 的 scan_state.MIN_ACTIVATIONS 状态机。
# ``_recursive_scan`` 接受内存 ``WorldBookStage`` 列表，可在无 DB 环境下验证
# 状态机行为。
# ---------------------------------------------------------------------------
class TestMinActivationsStateMachine:
    """验证 MIN_ACTIVATIONS 全局状态机行为对齐 ST 1.18.0。

    ST 行为 (world-info.js:4991-5005):
        - ``world_info_min_activations > 0`` 时强制 ``max_recursion_steps=0``
        - 常规扫描完成后，若激活数 < min，递增 ``buffer.getDepth()`` 继续扫描
        - ``buffer.advanceScan()`` 扩展聊天历史范围，让更多条目匹配关键词
        - 上限: ``world_info_min_activations_depth_max`` 或 ``chat.length``
        - MIN_ACTIVATIONS 状态 ≠ RECURSION 状态 (world-info.js:4747-4761):
          * ``delayUntilRecursion`` 条目仍被跳过 (scanState !== RECURSION)
          * ``excludeRecursion`` 条目不被跳过 (仅 RECURSION 状态跳过)
          * ``preventRecursion`` 条目正常激活 (仅排除内容进入递归 buffer)
    """

    def test_min_activations_zero_default_behavior_unchanged(self):
        """min_activations=0 (默认) 时行为与重构前完全一致。

        只有关键词在 DEFAULT_SCAN_DEPTH 范围内匹配的条目被激活，
        不会扩展扫描深度。
        """
        # 关键词 "dragon" 出现在第 1 条消息（索引 0，超出 DEFAULT_SCAN_DEPTH=4 范围）
        entries = [
            make_stage({
                "uid": 1,
                "key": ["dragon"],
                "keysecondary": [],
                "comment": "far entry",
                "content": "Dragon lore",
                "constant": False,
                "selective": False,
                "position": WI_POS_AT_DEPTH,
                "depth": 4,
            }),
        ]
        recent = [{"role": "user", "content": f"msg {i}"} for i in range(10)]
        recent[0]["content"] = "I saw a dragon."  # 索引 0，距离末尾 10 条

        activated, report = _recursive_scan(
            entries=entries,
            recent_messages=recent,
            char=None,
            timed_mgr=None,
            message_index=0,
            min_activations=0,  # 默认关闭
        )
        # DEFAULT_SCAN_DEPTH=4，只看最近 4 条消息（索引 6-9），"dragon" 在索引 0 不可见
        assert len(activated) == 0

    def test_min_activations_extends_scan_depth(self):
        """min_activations>0 时递增扫描深度，让远距离关键词也能匹配。"""
        entries = [
            make_stage({
                "uid": 1,
                "key": ["dragon"],
                "keysecondary": [],
                "comment": "far entry",
                "content": "Dragon lore",
                "constant": False,
                "selective": False,
                "position": WI_POS_AT_DEPTH,
                "depth": 4,
            }),
        ]
        recent = [{"role": "user", "content": f"msg {i}"} for i in range(10)]
        recent[9]["content"] = "I saw a dragon."  # 第 10 条（索引 9）

        activated, report = _recursive_scan(
            entries=entries,
            recent_messages=recent,
            char=None,
            timed_mgr=None,
            message_index=0,
            min_activations=1,  # 要求至少 1 个激活
            min_activations_depth_max=20,  # 足够大
        )
        # MIN_ACTIVATIONS 会递增 global_scan_depth 直到看到 "dragon"
        assert len(activated) == 1
        assert activated[0].title == "far entry"

    def test_min_activations_depth_max_limit(self):
        """min_activations_depth_max 限制最大扫描深度，未满足阈值时停止。"""
        entries = [
            make_stage({
                "uid": 1,
                "key": ["dragon"],
                "keysecondary": [],
                "comment": "far entry",
                "content": "Dragon lore",
                "constant": False,
                "selective": False,
                "position": WI_POS_AT_DEPTH,
                "depth": 4,
            }),
        ]
        recent = [{"role": "user", "content": f"msg {i}"} for i in range(10)]
        recent[0]["content"] = "I saw a dragon."  # 第 1 条（索引 0），需要 depth=10 才能看到

        activated, report = _recursive_scan(
            entries=entries,
            recent_messages=recent,
            char=None,
            timed_mgr=None,
            message_index=0,
            min_activations=1,
            min_activations_depth_max=6,  # 只扫描到 depth=6，看不到第 1 条
        )
        # depth_max=6 不足以看到索引 0 的消息
        assert len(activated) == 0

    def test_min_activations_prevent_recursion_still_activates(self):
        """Bug #E2: prevent_recursion 条目在 MIN_ACTIVATIONS 期间应正常激活。

        ST world-info.js: ``preventRecursion`` 不在扫描阶段跳过条目，
        仅排除其内容进入递归 buffer。MIN_ACTIVATIONS ≠ RECURSION，
        因此 prevent_recursion 条目应被激活。
        """
        entries = [
            make_stage({
                "uid": 1,
                "key": ["dragon"],
                "keysecondary": [],
                "comment": "prevent recursion entry",
                "content": "Dragon lore",
                "constant": False,
                "selective": False,
                "prevent_recursion": True,
                "position": WI_POS_AT_DEPTH,
                "depth": 4,
            }),
        ]
        recent = [{"role": "user", "content": "I saw a dragon."}]

        activated, report = _recursive_scan(
            entries=entries,
            recent_messages=recent,
            char=None,
            timed_mgr=None,
            message_index=0,
            min_activations=1,
            min_activations_depth_max=10,
        )
        # prevent_recursion 条目应被激活（MIN_ACTIVATIONS 不是 RECURSION）
        assert len(activated) == 1
        assert activated[0].title == "prevent recursion entry"

    def test_min_activations_delay_until_recursion_skipped(self):
        """delay_until_recursion 条目在 MIN_ACTIVATIONS 期间仍被跳过。

        ST world-info.js:4748: ``scanState !== RECURSION && delayUntilRecursion && !isSticky``
        → 跳过。MIN_ACTIVATIONS 不是 RECURSION，所以 delay_until_recursion 条目被跳过。
        """
        entries = [
            make_stage({
                "uid": 1,
                "key": ["dragon"],
                "keysecondary": [],
                "comment": "delayed entry",
                "content": "Dragon lore",
                "constant": False,
                "selective": False,
                "delay_until_recursion": 2,
                "position": WI_POS_AT_DEPTH,
                "depth": 4,
            }),
        ]
        recent = [{"role": "user", "content": "I saw a dragon."}]

        activated, report = _recursive_scan(
            entries=entries,
            recent_messages=recent,
            char=None,
            timed_mgr=None,
            message_index=0,
            min_activations=1,
            min_activations_depth_max=10,
        )
        # delay_until_recursion=2 在 MIN_ACTIVATIONS（recursion_depth=0）期间被跳过
        assert len(activated) == 0

    def test_min_activations_stops_at_chat_length(self):
        """MIN_ACTIVATIONS 扫描深度不超过聊天消息数量。

        ST world-info.js:4998: ``getDepth() > chat.length`` → over_max → 停止。
        """
        entries = [
            make_stage({
                "uid": 1,
                "key": ["nonexistent_keyword"],
                "keysecondary": [],
                "comment": "never matches",
                "content": "Lore",
                "constant": False,
                "selective": False,
                "position": WI_POS_AT_DEPTH,
                "depth": 4,
            }),
        ]
        recent = [{"role": "user", "content": "short chat"}]

        activated, report = _recursive_scan(
            entries=entries,
            recent_messages=recent,
            char=None,
            timed_mgr=None,
            message_index=0,
            min_activations=5,  # 要求 5 个，但只有 1 条消息
            min_activations_depth_max=0,  # 0=回退到 chat.length
        )
        # 只有 1 条消息，扫描深度不可能超过 1，无法满足 min_activations=5
        assert len(activated) == 0

    def test_min_activations_already_satisfied_no_extension(self):
        """常规扫描已满足 min_activations 时，不扩展扫描深度。"""
        entries = [
            make_stage({
                "uid": 1,
                "key": ["dragon"],
                "keysecondary": [],
                "comment": "near entry",
                "content": "Dragon lore",
                "constant": False,
                "selective": False,
                "position": WI_POS_AT_DEPTH,
                "depth": 4,
            }),
            make_stage({
                "uid": 2,
                "key": ["castle"],
                "keysecondary": [],
                "comment": "near entry 2",
                "content": "Castle lore",
                "constant": False,
                "selective": False,
                "position": WI_POS_AT_DEPTH,
                "depth": 4,
            }),
        ]
        recent = [
            {"role": "user", "content": "I saw a dragon and a castle."},
        ]

        activated, report = _recursive_scan(
            entries=entries,
            recent_messages=recent,
            char=None,
            timed_mgr=None,
            message_index=0,
            min_activations=2,  # 已满足，无需扩展
            min_activations_depth_max=10,
        )
        assert len(activated) == 2

    def test_min_activations_custom_scan_depth_not_overridden(self):
        """自定义 scan_depth 的条目不受 advanceScan 影响。

        ST world-info.js:280: ``let depth = entry.scanDepth ?? this.getDepth()``
        条目自定义 scan_depth 优先于全局 global_scan_depth。
        """
        entries = [
            # 自定义 scan_depth=1，只看最近 1 条消息
            make_stage({
                "uid": 1,
                "key": ["dragon"],
                "keysecondary": [],
                "comment": "custom scan_depth=1",
                "content": "Dragon lore",
                "constant": False,
                "selective": False,
                "scanDepth": 1,
                "position": WI_POS_AT_DEPTH,
                "depth": 4,
            }),
        ]
        recent = [
            {"role": "user", "content": "nothing here"},
            {"role": "assistant", "content": "I saw a dragon."},  # 索引 1
        ]

        activated, report = _recursive_scan(
            entries=entries,
            recent_messages=recent,
            char=None,
            timed_mgr=None,
            message_index=0,
            min_activations=1,
            min_activations_depth_max=10,
        )
        # scan_depth=1 只看最后 1 条（"I saw a dragon"），即使 advanceScan 扩展全局深度
        # 自定义 scan_depth 仍优先 → 条目应被激活
        assert len(activated) == 1

