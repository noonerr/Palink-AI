"""ST-Compat 群聊装配路径 E2E 测试 (D8 修复).

验证 group_id 透传后，assemble_roleplay_prompt 内的群聊分支
（_resolve_group_speaker / _build_group_profile_context）被正确触发，
而非 dead code。同时验证单聊路径（无 group_id）不受影响。

覆盖 spec 中 D8 的 3 个 Scenario:
    1. group_id 非空 → 群聊分支触发（group profile 注入）
    2. group_id 为空 → 单聊路径（不触发群聊分支）
    3. group_id 非空但无 member_profiles → 群聊分支跳过 profile（report skipped）
"""

import asyncio
import json
import os
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from app.models.system import UserSetting  # noqa: E402,F401
    from app.models.group_chat import GroupChat  # noqa: E402,F401
    from app.models.character import Character  # noqa: E402,F401
    from app.services.roleplay_prompt_assembly import (  # noqa: E402
        PromptAssemblyDeps,
        PromptAssemblyRequest,
        assemble_roleplay_prompt,
    )
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")


BASE_SYSTEM_PROMPT = "base system prompt"
BASE_MESSAGES = [
    {"role": "system", "content": BASE_SYSTEM_PROMPT},
    {"role": "user", "content": "hello"},
    {"role": "assistant", "content": "hi there"},
]

GROUP_ID = "group-123"
SPEAKER_ID = "char-speaker"
OTHER_ID = "char-other"


def _make_user_setting():
    return SimpleNamespace(
        user_id=1,
        author_note=None,
        author_note_position=1,
        author_note_depth=4,
        author_note_frequency=0,
        memory_mode="disabled",
        prompt_language="en",
        instruct_enabled=False,
        instruct_template_id=None,
        active_persona_id=None,
        silly_tavern_mode="palink-native",
    )


def _make_group(member_profiles: dict | None):
    """构造 mock GroupChat。"""
    return SimpleNamespace(
        id=GROUP_ID,
        name="Test Group",
        member_ids=json.dumps([SPEAKER_ID, OTHER_ID]),
        member_profiles=json.dumps(member_profiles) if member_profiles else None,
        activation_strategy=0,  # 非 VOTING/TALKATIVE，_resolve_group_speaker 保持现状
        author_note=None,
        recent_messages_budget=20,
    )


def _make_member_chars():
    """构造群成员 Character 列表。"""
    return [
        SimpleNamespace(id=SPEAKER_ID, name="Speaker", description="speaker desc",
                        personality="speaker pers", talkativeness="0.7"),
        SimpleNamespace(id=OTHER_ID, name="OtherBot", description="other desc",
                        personality="other pers", talkativeness="0.3"),
    ]


def _make_mock_db(group):
    """构造 mock DB：UserSetting / GroupChat / Character 查询分别返回对应对象。"""
    db = MagicMock()
    user_setting = _make_user_setting()
    member_chars = _make_member_chars()

    def _query_side_effect(model):
        q = MagicMock()
        if model is UserSetting:
            q.filter.return_value.first.return_value = user_setting
        elif model is GroupChat:
            q.filter.return_value.first.return_value = group
        elif model is Character:
            q.filter.return_value.in_.return_value.all.return_value = member_chars
        else:
            q.filter.return_value.first.return_value = None
        return q

    db.query.side_effect = _query_side_effect
    return db


def _make_request(db, group_id=None, current_speaker_id=None):
    user = SimpleNamespace(id=1, username="TestUser")
    char = SimpleNamespace(
        id="char-1",
        name="TestChar",
        description="A test character",
        extensions=None,
        mes_example=None,
        post_history_instructions=None,
    )
    return PromptAssemblyRequest(
        db=db,
        user=user,
        char=char,
        session_id="test-session",
        branch_id=None,
        message="test message",
        images=[],
        include_prompt_regex=False,
        include_title_instruction=False,
        include_user_message=True,
        is_init=False,
        is_continue=False,
        smart_card_trigger=False,
        group_id=group_id,
        current_speaker_id=current_speaker_id,
    )


def _make_deps():
    return PromptAssemblyDeps(
        build_system_prompt=lambda *a, **kw: BASE_SYSTEM_PROMPT,
        replace_placeholders=lambda text, *a, **kw: text,
        get_full_branch_history=lambda *a, **kw: [],
        get_ancestor_branch_ids=lambda *a, **kw: [],
        contains_chinese=lambda text: False,
        apply_plugin_regex_scripts=lambda text, *a, **kw: text,
        apply_regex_scripts=lambda text, *a, **kw: text,
        apply_prompt_regex_to_messages=lambda messages, *a, **kw: messages,
    )


def _run_assembly(group_id=None, current_speaker_id=None, member_profiles=None):
    group = _make_group(member_profiles) if group_id else None
    db = _make_mock_db(group)
    req = _make_request(db, group_id=group_id, current_speaker_id=current_speaker_id)
    deps = _make_deps()

    with patch(
        "app.services.roleplay_prompt_assembly.build_character_chat_messages",
        return_value=list(BASE_MESSAGES),
    ), patch(
        "app.services.roleplay_prompt_assembly._append_worldbook_context", new=MagicMock(),
    ), patch(
        "app.services.roleplay_prompt_assembly._append_plotline_context", new=MagicMock(),
    ), patch(
        "app.services.roleplay_prompt_assembly._append_memory_context", new=AsyncMock(),
    ), patch(
        "app.services.roleplay_prompt_assembly._load_context_template", return_value=None,
    ), patch(
        "app.services.roleplay_prompt_assembly._load_instruct_template", return_value=None,
    ), patch(
        "app.services.roleplay_prompt_assembly.evaluate_macros_in_messages",
        side_effect=lambda messages, env: messages,
    ), patch(
        "app.services.roleplay_prompt_assembly.evaluate_macros",
        side_effect=lambda text, env: text,
    ), patch(
        "app.services.status_bar_detector.build_status_instruction", return_value="",
    ):
        return asyncio.run(assemble_roleplay_prompt(req, deps))


def _report_map(result):
    return {r.key: r for r in result.report}


def test_group_branch_triggered_with_profiles():
    """Scenario 1: group_id 非空 + member_profiles → 群聊分支触发，profile 注入。"""
    profiles = {
        SPEAKER_ID: {"name": "Speaker", "description": "speaker profile desc", "personality": "bold"},
        OTHER_ID: {"name": "OtherBot", "description": "other profile desc"},
    }
    result = _run_assembly(group_id=GROUP_ID, current_speaker_id=SPEAKER_ID, member_profiles=profiles)

    reports = _report_map(result)
    # 群聊 profile 分支被触发且 included
    assert "group_member_profiles" in reports, "群聊分支未触发（group_member_profiles 缺失）"
    assert reports["group_member_profiles"].status == "included"
    # 发言者身份注入到 system prompt
    assert "[当前发言者身份]" in result.system_prompt
    assert "Speaker" in result.system_prompt


def test_single_chat_no_group_branch():
    """Scenario 2: group_id 为空 → 单聊路径，不触发群聊分支。"""
    result = _run_assembly(group_id=None)

    reports = _report_map(result)
    # 单聊不应有 group_member_profiles included
    grp = reports.get("group_member_profiles")
    assert grp is None or grp.status != "included"
    # system prompt 不含群聊发言者身份
    assert "[当前发言者身份]" not in result.system_prompt


def test_group_without_profiles_skipped():
    """Scenario 3: group_id 非空但无 member_profiles → 群聊分支跳过 profile。"""
    result = _run_assembly(group_id=GROUP_ID, current_speaker_id=SPEAKER_ID, member_profiles=None)

    reports = _report_map(result)
    grp = reports.get("group_member_profiles")
    # 无 profile 时应 skipped（而非 included）
    assert grp is None or grp.status == "skipped"
    assert "[当前发言者身份]" not in result.system_prompt
