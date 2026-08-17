"""ST 1.18.0 世界书 position 5/6/7 (EMTop/EMBottom/outlet) 注入测试。

验证:
1. {{mesExamples}} 宏能拼接世界书 EMTop/EMBottom 条目（position 5/6）
2. {{outlet::name}} 宏能返回世界书 outlet 条目（position 7）
3. MacroEnv 正确传递 wb_em_top_entries/wb_em_bottom_entries/wb_outlet_entries

参考:
- SillyTavern-1.18.0/public/scripts/world-info.js:5093-5143
- SillyTavern-1.18.0/public/script.js:4576-4596 (mesExamplesArray 组装)
- SillyTavern-1.18.0/public/scripts/macros.js:597-600, 668 ({{outlet::name}})
"""
from __future__ import annotations

import sys
import os

# 让 backend 目录可被导入
_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.services.macro_service import MacroEnv, evaluate_macros


class _StubChar:
    """模拟 Character 对象，仅提供 mes_example 字段。"""

    def __init__(self, mes_example: str = ""):
        self.mes_example = mes_example
        # 角色卡其他字段默认 None，避免宏解析报错
        self.description = None
        self.personality = None
        self.scenario = None
        self.first_mes = None
        self.system_prompt = None
        self.post_history_instructions = None
        self.creator_notes = None
        self.jailbreak_prompt = None
        self.alternate_greetings = None
        self.tags = None
        self.name = "TestChar"


class _StubDB:
    """模拟 DB session，所有查询返回 None。"""

    def query(self, *args, **kwargs):
        return _StubQuery()

    def add(self, *args, **kwargs):
        pass

    def commit(self):
        pass

    def rollback(self):
        pass


class _StubQuery:
    def filter(self, *args, **kwargs):
        return self

    def first(self):
        return None

    def all(self):
        return []

    def delete(self):
        pass


def test_mesexamples_macro_includes_em_top_and_em_bottom():
    """{{mesExamples}} 宏应拼接: em_top + char.mes_example + em_bottom。"""
    char = _StubChar(mes_example="<START>\n{{user}}: Hi\n{{char}}: Hello")
    env = MacroEnv(
        db=_StubDB(),
        session_id=None,
        user_id=None,
        user_name="Alice",
        char_name="Bob",
        character=char,
        worldbook_em_top=["[ExampleTop] Some intro lore"],
        worldbook_em_bottom=["[ExampleBottom] Some closing lore"],
    )

    result = evaluate_macros("Examples: {{mesExamples}}", env)

    # 验证 em_top 在 mes_example 之前
    assert "[ExampleTop] Some intro lore" in result
    # 验证 mes_example 在中间
    assert "<START>" in result
    assert "Hello" in result
    # 验证 em_bottom 在 mes_example 之后
    assert "[ExampleBottom] Some closing lore" in result
    # 验证顺序: em_top 在 mes_example 之前
    top_pos = result.find("[ExampleTop]")
    start_pos = result.find("<START>")
    bottom_pos = result.find("[ExampleBottom]")
    assert top_pos < start_pos < bottom_pos, (
        f"EMTop should come before mes_example which should come before EMBottom. "
        f"Positions: top={top_pos}, start={start_pos}, bottom={bottom_pos}"
    )


def test_mesexamples_macro_without_worldbook_entries():
    """无 EMTop/EMBottom 条目时，{{mesExamples}} 仅返回 char.mes_example。"""
    char = _StubChar(mes_example="Just a normal example")
    env = MacroEnv(
        db=_StubDB(),
        user_name="Alice",
        char_name="Bob",
        character=char,
    )

    result = evaluate_macros("{{mesExamples}}", env)
    assert result == "Just a normal example"


def test_outlet_macro_returns_joined_entries():
    """{{outlet::name}} 宏应返回 outlet 条目的 join('\\n')。"""
    env = MacroEnv(
        db=_StubDB(),
        user_name="Alice",
        char_name="Bob",
        worldbook_outlets={"village": ["Lore about village", "More village lore"]},
    )

    result = evaluate_macros("Location: {{outlet::village}}", env)
    assert "Lore about village" in result
    assert "More village lore" in result
    assert result.count("\n") >= 1  # 两条记录应有换行分隔


def test_outlet_macro_returns_empty_for_missing_outlet():
    """{{outlet::nonexistent}} 应返回空串。"""
    env = MacroEnv(
        db=_StubDB(),
        user_name="Alice",
        char_name="Bob",
        worldbook_outlets={"village": ["Lore"]},
    )

    result = evaluate_macros("[{{outlet::nonexistent}}]", env)
    assert result == "[]", f"Expected '[]' for missing outlet, got: {result!r}"


def test_outlet_macro_with_multiple_outlets():
    """多个 outlet 应独立工作。"""
    env = MacroEnv(
        db=_StubDB(),
        user_name="Alice",
        char_name="Bob",
        worldbook_outlets={
            "village": ["Village lore"],
            "forest": ["Forest lore 1", "Forest lore 2"],
        },
    )

    result = evaluate_macros("{{outlet::village}} | {{outlet::forest}}", env)
    assert "Village lore" in result
    assert "Forest lore 1" in result
    assert "Forest lore 2" in result
    assert "|" in result


def test_outlet_macro_in_character_description():
    """{{outlet::xxx}} 嵌入在角色描述中时应正确替换。"""
    char = _StubChar()
    char.description = "The hero arrives at {{outlet::location}}."
    env = MacroEnv(
        db=_StubDB(),
        user_name="Alice",
        char_name="Bob",
        character=char,
        worldbook_outlets={"location": ["the ancient castle"]},
    )

    result = evaluate_macros("{{description}}", env)
    assert "the ancient castle" in result
    assert "{{outlet::location}}" not in result


def test_mesexamples_with_user_char_macros_in_em_entries():
    """EMTop/EMBottom 条目内的 {{user}}/{{char}} 应被替换。"""
    char = _StubChar(mes_example="Normal example")
    env = MacroEnv(
        db=_StubDB(),
        user_name="Alice",
        char_name="Bob",
        character=char,
        worldbook_em_top=["{{user}} meets {{char}}"],
    )

    result = evaluate_macros("{{mesExamples}}", env)
    assert "Alice meets Bob" in result
