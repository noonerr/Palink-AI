"""1:1（单对话）非回归直测 —— 用户硬要求：群聊改动不得影响修改前的单对话后端。

复用 test_st_compat_group_chat_e2e 的 mock 基建（_run_assembly / _make_request /
_make_mock_db），并新增 build_st_compat_messages 单测，证明：
- group_id=None 装配：无群聊分支触发、system_prompt 不含发言者身份、report 无 group_* 项；
- build_st_compat_messages(is_group=False) 即使传入 generation_mode=1 + 合并卡，也绝不注入合并卡；
- worldbook 组策略（group_chars）在 1:1 路径不生效（解析 group_chars=None）。
"""

import os
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from app.services import roleplay_prompt_assembly as rpa  # noqa: E402
    from app.services.character_message_builder import build_st_compat_messages  # noqa: E402
    from test_st_compat_group_chat_e2e import (  # noqa: E402
        _make_request,
        _make_mock_db,
        _make_deps,
        _make_group,
        _run_assembly,
        assemble_roleplay_prompt,
        BASE_MESSAGES,
    )
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")


def _fake_db():
    """build_st_compat_messages 在 branch_id=None 时查询历史；返回空历史避免 DB 依赖。"""
    db = MagicMock()
    chain = db.query.return_value.filter.return_value.order_by.return_value.limit.return_value
    chain.all.return_value = []
    return db


# ───────────────────── 1) 装配层：group_id=None 无群聊泄漏 ─────────────────────

def test_assembly_1to1_no_group_branch_leakage():
    """group_id=None 装配：report 中不应出现任何 group_* included 项，
    system_prompt 不含群聊发言者身份标记。"""
    result = _run_assembly(group_id=None)

    group_items = [r for r in result.report if r.key.startswith("group_")]
    assert not any(r.status == "included" for r in group_items), \
        f"1:1 路径出现群聊分支泄漏: {[r.key for r in group_items]}"

    assert "[当前发言者身份]" not in result.system_prompt
    # 直接确认 report 里没有 group_member_profiles
    keys = {r.key for r in result.report}
    assert "group_member_profiles" not in keys


def test_assembly_1to1_vs_group_isolation():
    """同函数两条路径隔离：group_id 非空触发群聊分支，group_id=None 不触发。"""
    grp_result = _run_assembly(group_id="group-123", current_speaker_id="char-speaker",
                               member_profiles={"char-speaker": {"name": "Speaker", "description": "x"}})
    single_result = _run_assembly(group_id=None)

    grp_keys = {r.key for r in grp_result.report}
    single_keys = {r.key for r in single_result.report}

    assert "group_member_profiles" in grp_keys, "群聊路径未触发群分支（基建异常）"
    assert "group_member_profiles" not in single_keys, "1:1 路径误触发群分支（泄漏）"
    assert "[当前发言者身份]" in grp_result.system_prompt
    assert "[当前发言者身份]" not in single_result.system_prompt


# ───────────────────── 2) 构建器单测：1:1 绝不注入合并卡 ─────────────────────

def _make_char():
    return SimpleNamespace(
        id="char-1", name="Solo", description="SOLO_DESCRIPTION",
        personality="SOLO_PERSONALITY", scenario="SOLO_SCENARIO",
        mes_example="<START>\nSolo: hi", extensions=None,
        post_history_instructions=None,
    )


def _base_builder_kwargs(char, **overrides):
    kwargs = dict(
        db=_fake_db(), char=char, user_nickname="User", session_id="s", branch_id=None,
        message="hi", images=[], system_prompt_override="SYS",
        world_info_before="", world_info_after="", persona_description="",
        jailbreak="", authors_note="", authors_note_depth=4,
        dynamic_context_parts=[], prompt_lang="en", user_setting=None,
        _replace_placeholders=lambda text, *a, **kw: text,
        _get_full_branch_history=lambda *a, **kw: [],
        _contains_chinese=lambda text: False,
        normalize_image_url=lambda u, *a, **kw: u,
        include_user_message=False,
    )
    kwargs.update(overrides)
    return kwargs


COMBINED_CARD = {
    "description": "COMBINED_DESCRIPTION",
    "personality": "COMBINED_PERSONALITY",
    "scenario": "COMBINED_SCENARIO",
    "mes_example": "<START>\nCombined: hello",
}


def test_builder_1to1_ignores_combined_card():
    """is_group=False + generation_mode=1 + 合并卡：description 取 char.description，
    而非合并卡的 COMBINED_DESCRIPTION（C2 注入仅在 is_group 且 mode in (1,2) 生效）。"""
    char = _make_char()
    msgs = build_st_compat_messages(**_base_builder_kwargs(
        char, is_group=False, generation_mode=1, group_combined_card=COMBINED_CARD,
    ))
    joined = "\n".join(m.get("content", "") for m in msgs)
    assert "COMBINED_DESCRIPTION" not in joined, "1:1 模式误注入合并卡 description"
    assert "SOLO_DESCRIPTION" in joined, "1:1 模式未使用单卡 description"
    assert "COMBINED_SCENARIO" not in joined
    assert "SOLO_SCENARIO" in joined


def test_builder_1to1_no_group_name_prefix_in_system():
    """1:1 模式系统消息不应包含群聊 `Name: ` 风格的成员前缀注入。"""
    char = _make_char()
    msgs = build_st_compat_messages(**_base_builder_kwargs(char, is_group=False))
    joined = "\n".join(m.get("content", "") for m in msgs)
    # 群聊场景标记不应出现
    assert "[当前发言者身份]" not in joined
    assert "Group members:" not in joined


# ───────────────────── 3) group_profile 守卫：group_id=None 返回 None ─────────────────────

def test_build_group_profile_context_1to1_returns_none():
    """_build_group_profile_context 在 group_id=None 时直接返回 None（不触碰群聊逻辑）。"""
    req = _make_request(_make_mock_db(None), group_id=None)
    assert rpa._build_group_profile_context(req) is None


# ───────────────────── 4) worldbook 组策略在 1:1 不生效 ─────────────────────

def _run_assembly_spy_wb(group_id=None):
    """复用 e2e 基建，但不 patch _append_worldbook_context，改为 spy build_worldbook_context
    以捕获 group_chars 实参（验证 1:1 路径传入 None）。"""
    import asyncio  # noqa: E402

    group = _make_group(None) if group_id else None
    db = _make_mock_db(group)
    req = _make_request(db, group_id=group_id)
    deps = _make_deps()

    captured = {}

    def _spy_build_worldbook_context(*a, **k):
        captured["group_chars"] = k.get("group_chars")
        return SimpleNamespace(text="")

    with patch("app.services.roleplay_prompt_assembly.build_character_chat_messages",
                return_value=list(BASE_MESSAGES)), \
         patch("app.services.roleplay_prompt_assembly._append_plotline_context", new=MagicMock()), \
         patch("app.services.roleplay_prompt_assembly._append_memory_context", new=AsyncMock()), \
         patch("app.services.roleplay_prompt_assembly._load_context_template", return_value=None), \
         patch("app.services.roleplay_prompt_assembly._load_instruct_template", return_value=None), \
         patch("app.services.roleplay_prompt_assembly.evaluate_macros_in_messages",
               side_effect=lambda messages, env: messages), \
         patch("app.services.roleplay_prompt_assembly.evaluate_macros",
               side_effect=lambda text, env: text), \
         patch("app.services.status_bar_detector.build_status_instruction", return_value=""), \
         patch("app.services.roleplay_prompt_assembly.build_worldbook_context",
               side_effect=_spy_build_worldbook_context):
        asyncio.run(assemble_roleplay_prompt(req, deps))
    return captured


def test_worldbook_group_chars_none_in_1to1():
    """1:1 装配不应将任何群成员 character 传入 worldbook（group_chars=None）。

    验证 roleplay_prompt_assembly._append_worldbook_context 在 group_id=None 时
    对 build_worldbook_context 传入 group_chars=None（E1 守卫）。
    """
    captured = _run_assembly_spy_wb(group_id=None)
    assert captured.get("group_chars") is None, \
        f"1:1 路径 worldbook 收到群成员: {captured.get('group_chars')}"
