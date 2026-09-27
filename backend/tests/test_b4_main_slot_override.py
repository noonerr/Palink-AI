"""B-4 A 方案回归：角色卡 system_prompt 作为 main 槽头部 override（对齐 ST charPrompt 语义）。

spec: docs/SILLYTAVERN_COMPAT_SPEC_2026-08-23.md §3 B-4
2026-09-27 身份层 ST 化（docs/SPEC_提示词身份层ST化_删除第一第三人称切换_2026-09-27.md）：
"你是{name}"核心规则层已删，main 槽改为 ST 默认任务指令（ST_DEFAULT_MAIN_PROMPT）。
锁定：
1. custom_prompt（角色 system_prompt）存在时置于 main 槽最前（先于 ST main prompt）；
2. custom_prompt 空时不影响新结构（无 character_override 参与）；
3. 既有 personality/background/scenario/description 属性装配顺序不变。
"""

import os
import sys

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.core.default_prompts import build_default_character_prompt  # noqa: E402


def _base(**kw):
    params = dict(
        char_name="B4Char",
        user_nickname="Tester",
        dialogue_mode="first_person",
        lang="zh",
        personality="活泼",
        background="海边",
        scenario="夏日",
        description="描述XYZ",
    )
    params.update(kw)
    return params


def test_custom_prompt_placed_first_in_main_slot():
    prompt = build_default_character_prompt(**_base(custom_prompt="CHAR_TOTAL_OVERRIDE"))
    assert prompt.startswith("核心设定：CHAR_TOTAL_OVERRIDE")
    assert prompt.index("CHAR_TOTAL_OVERRIDE") < prompt.index(
        "Write B4Char's next reply in a fictional chat between B4Char and Tester."
    )


def test_custom_prompt_absent_keeps_default_structure():
    prompt = build_default_character_prompt(**_base(custom_prompt=""))
    assert not prompt.startswith("核心设定：")
    assert "Write B4Char's next reply in a fictional chat between B4Char and Tester." in prompt
    assert "描述XYZ" in prompt


def test_attributes_order_unchanged_with_override():
    prompt = build_default_character_prompt(**_base(custom_prompt="OVERRIDE"))
    idx_personality = prompt.index("性格：活泼")
    idx_background = prompt.index("背景：海边")
    idx_scenario = prompt.index("场景：夏日")
    idx_description = prompt.index("描述：描述XYZ")
    assert idx_personality < idx_background < idx_scenario < idx_description
    assert prompt.index("OVERRIDE") < idx_personality