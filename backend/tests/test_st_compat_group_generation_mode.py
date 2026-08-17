"""C1 + C2 回归测试：ST 群生成模式 (generation_mode) 与合并卡 (combineGroupIntoSingleCard).

验证 build_st_compat_messages 在 is_group 场景下按 generation_mode 切换：
- SWAP(0):   单发言者卡（char.description/personality/scenario/mes_example）
- APPEND(1): 合并卡（仅启用成员 description/personality/scenario/mes_example）
- APPEND_DISABLED(2): 合并卡（含禁用成员）

不依赖真实 ST golden vector，仅验证模式分流逻辑与字段替换正确性。
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
    from app.services.character_message_builder import build_st_compat_messages  # noqa: E402
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")


def _make_char(**overrides):
    defaults = dict(
        name="Elara",
        description="Elara single card desc",
        personality="Elara single card pers",
        scenario="Elara single card scen",
        mes_example="<START>\n{{user}}: x\n{{char}}: y",
        system_prompt="",
        post_history_instructions="",
        jailbreak=None,
    )
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def _make_db_with_history(history):
    db = MagicMock()
    query = MagicMock()
    query.filter.return_value = query
    query.order_by.return_value = query
    query.limit.return_value = query
    query.all.return_value = list(reversed(history))
    db.query.return_value = query
    return db


def _combined_card(include_disabled=False):
    """模拟 _build_group_combined_card 输出（prefix='' suffix=''）。"""
    members = [
        ("Alice", "desc A", "pers A", "scen A"),
        ("Bob", "desc B", "pers B", "scen B"),
    ]
    if include_disabled:
        members.append(("Carol", "desc C", "pers C", "scen C"))
    description = "\n".join(f"{n}: {d}" for n, d, _, _ in members)
    personality = "\n".join(f"{n}: {p}" for n, _, p, _ in members)
    scenario = "\n".join(f"{n}: {s}" for n, _, _, s in members)
    mes_example = "<START>\n{{user}}: hi\n{{char}}: hello from group"
    return {
        "description": description,
        "personality": personality,
        "scenario": scenario,
        "mes_example": mes_example,
    }


def _build(char=None, generation_mode=0, group_combined_card=None, **kwargs):
    char = char or _make_char()
    db = _make_db_with_history([])
    base = dict(
        db=db,
        char=char,
        user_nickname="User",
        session_id="sess-1",
        branch_id=None,
        message="hello",
        images=[],
        system_prompt_override=None,
        world_info_before="",
        world_info_after="",
        persona_description="",
        jailbreak="",
        authors_note="",
        authors_note_depth=4,
        dynamic_context_parts=[],
        prompt_lang="en",
        user_setting=None,
        _replace_placeholders=lambda t, u, c: t.replace("{{user}}", u).replace("{{char}}", c),
        _get_full_branch_history=lambda *a, **k: [],
        _contains_chinese=lambda t: False,
        normalize_image_url=lambda u, check_size=False: u,
        include_user_message=True,
        is_group=True,
        generation_mode=generation_mode,
        group_combined_card=group_combined_card,
    )
    base.update(kwargs)
    return build_st_compat_messages(**base)


def _contents(messages):
    return [m.get("content") for m in messages if isinstance(m.get("content"), str)]


def _joined(messages):
    return "\n".join(_contents(messages))


def test_swap_uses_single_char_card():
    """SWAP(0): 应使用单发言者卡（char.*），不出现合并卡成员。"""
    msgs = _build(generation_mode=0, group_combined_card=None)
    joined = _joined(msgs)
    assert "Elara single card desc" in joined
    assert "Alice: desc A" not in joined
    assert "Bob: desc B" not in joined


def test_append_uses_combined_card_enabled_only():
    """APPEND(1): 应使用合并卡（仅启用成员），不出现单卡 char.description。"""
    card = _combined_card(include_disabled=False)
    msgs = _build(generation_mode=1, group_combined_card=card)
    joined = _joined(msgs)
    # 合并卡字段出现
    assert "Alice: desc A" in joined
    assert "Bob: desc B" in joined
    assert "Alice: pers A" in joined
    assert "Bob: pers B" in joined
    assert "Alice: scen A" in joined
    assert "Bob: scen B" in joined
    # 单卡字段被替换，不应出现
    assert "Elara single card desc" not in joined
    assert "Elara single card pers" not in joined
    # mes_example 合并卡展开
    assert "[Example Chat]" in joined
    assert "hello from group" in joined
    # disabled 成员不应出现（APPEND 仅启用）
    assert "Carol: desc C" not in joined


def test_append_disabled_includes_disabled_members():
    """APPEND_DISABLED(2): 合并卡应含禁用成员（Carol）。"""
    card = _combined_card(include_disabled=True)
    msgs = _build(generation_mode=2, group_combined_card=card)
    joined = _joined(msgs)
    assert "Alice: desc A" in joined
    assert "Bob: desc B" in joined
    assert "Carol: desc C" in joined


def test_non_group_ignores_combined_card():
    """非群聊（is_group=False）：即使传入 generation_mode/combined_card 也不应生效。"""
    card = _combined_card(include_disabled=False)
    msgs = _build(generation_mode=1, group_combined_card=card, is_group=False)
    joined = _joined(msgs)
    assert "Elara single card desc" in joined
    assert "Alice: desc A" not in joined


def test_combined_card_macro_uses_char_name():
    """合并卡内 mes_example 的 {{char}} 应被 _sub 替换为当前 char_name（ST 同一发言者绑定语义）。"""
    card = _combined_card(include_disabled=False)
    msgs = _build(generation_mode=1, group_combined_card=card)
    joined = _joined(msgs)
    # char_name 在测试中为 "Elara"（is_group 且 speaker_char=None 时回退 char.name）
    assert "{{char}}" not in joined  # 宏应已被替换
    assert "hello from group" in joined
