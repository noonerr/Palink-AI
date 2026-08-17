"""D3 深层修复验证：SWAP 群聊必须以「发言者卡」而非「主角色卡」构建 system_prompt 与角色卡。

模拟 websocket _gen 循环在装配前的回填逻辑：
    await _resolve_group_speaker(req_local)
    req_local.char = speaker_char   # 发言者卡
随后 assemble_roleplay_prompt 内部所有 char=req.char 读取点（原生 system_prompt /
st-compat char_system_prompt / 两个 builder）应统一使用发言者卡。

覆盖两种对照：
  A. 未回填（模拟修复前）：system_prompt 含主角色标记、不含发言者标记（即 bug 表现）。
  B. 回填（模拟修复后）：system_prompt 含发言者标记、不含主角色标记（修复后正确行为）。
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

from app.models.system import UserSetting  # noqa: E402
from app.models.group_chat import GroupChat  # noqa: E402
from app.models.character import Character  # noqa: E402
from app.services.roleplay_prompt_assembly import (  # noqa: E402
    PromptAssemblyDeps,
    PromptAssemblyRequest,
    assemble_roleplay_prompt,
    _resolve_group_speaker,
)

GROUP_ID = "group-d3"
SPEAKER_ID = "char-speaker"
OTHER_ID = "char-other"
MAIN_MARKER = "MAIN_CHAR_DESC_MARKER"
SPEAKER_MARKER = "SPEAKER_CHAR_DESC_MARKER"


def _make_user_setting():
    return SimpleNamespace(
        user_id=1, author_note=None, author_note_position=1, author_note_depth=4,
        author_note_frequency=0, memory_mode="disabled", prompt_language="en",
        instruct_enabled=False, instruct_template_id=None, active_persona_id=None,
        silly_tavern_mode="palink-native",
    )


def _make_group():
    return SimpleNamespace(
        id=GROUP_ID, name="D3 Group",
        member_ids=json.dumps([SPEAKER_ID, OTHER_ID]),
        member_profiles=None,
        activation_strategy=0,  # NATURAL：无选角时由 _resolve_group_speaker 解析
        generation_mode=0,      # SWAP：单发言者卡
        author_note=None, recent_messages_budget=20,
    )


def _make_member_chars():
    return [
        SimpleNamespace(id=SPEAKER_ID, name="Speaker", description=SPEAKER_MARKER,
                        personality="speaker pers", talkativeness="0.7",
                        system_prompt=None, background="", scenario="", extensions=None,
                        mes_example=None, creator_notes=None, preset_data=None),
        SimpleNamespace(id=OTHER_ID, name="OtherBot", description="other desc",
                        personality="other pers", talkativeness="0.3",
                        system_prompt=None, background="", scenario="", extensions=None,
                        mes_example=None, creator_notes=None, preset_data=None),
    ]


def _make_mock_db(group):
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


def _make_main_char():
    return SimpleNamespace(
        id="char-main", name="MainChar", description=MAIN_MARKER,
        personality="main pers", system_prompt=None, background="", scenario="",
        extensions=None, mes_example=None, creator_notes=None, preset_data=None,
    )


def _make_request(db, char, group_id, current_speaker_id):
    user = SimpleNamespace(id=1, username="TestUser")
    return PromptAssemblyRequest(
        db=db, user=user, char=char, session_id="d3-session", branch_id=None,
        message="test message", images=[], include_prompt_regex=False,
        include_title_instruction=False, include_user_message=True,
        is_init=False, is_continue=False, smart_card_trigger=False,
        group_id=group_id, current_speaker_id=current_speaker_id,
    )


def _make_deps():
    # build_system_prompt 内嵌 char.description，便于断言实际用的是哪张卡
    return PromptAssemblyDeps(
        build_system_prompt=lambda char, *a, **kw: f"SYSPROMPT::{getattr(char, 'description', '')}",
        replace_placeholders=lambda text, *a, **kw: text,
        get_full_branch_history=lambda *a, **kw: [],
        get_ancestor_branch_ids=lambda *a, **kw: [],
        contains_chinese=lambda text: False,
        apply_plugin_regex_scripts=lambda text, *a, **kw: text,
        apply_regex_scripts=lambda text, *a, **kw: text,
        apply_prompt_regex_to_messages=lambda messages, *a, **kw: messages,
    )


def _run_assembly_with_backfill(backfill: bool):
    """模拟 websocket _gen 循环：backfill=True 时装配前回填 req.char=发言者卡（修复后行为）。"""
    group = _make_group()
    db = _make_mock_db(group)
    main_char = _make_main_char()
    req = _make_request(db, main_char, GROUP_ID, SPEAKER_ID)
    deps = _make_deps()

    with patch("app.services.roleplay_prompt_assembly.build_character_chat_messages",
               return_value=[{"role": "system", "content": "x"}]), \
         patch("app.services.roleplay_prompt_assembly._append_worldbook_context", new=MagicMock()), \
         patch("app.services.roleplay_prompt_assembly._append_plotline_context", new=MagicMock()), \
         patch("app.services.roleplay_prompt_assembly._append_memory_context", new=AsyncMock()), \
         patch("app.services.roleplay_prompt_assembly._load_context_template", return_value=None), \
         patch("app.services.roleplay_prompt_assembly._load_instruct_template", return_value=None), \
         patch("app.services.roleplay_prompt_assembly.evaluate_macros_in_messages",
               side_effect=lambda messages, env: messages), \
         patch("app.services.roleplay_prompt_assembly.evaluate_macros",
               side_effect=lambda text, env: text), \
         patch("app.services.status_bar_detector.build_status_instruction", return_value=""):
        # —— websocket _gen 的 D3 回填逻辑 ——
        asyncio.run(_resolve_group_speaker(req))
        _resolved = req.current_speaker_id or SPEAKER_ID
        speaker_char = main_char
        if _resolved:
            _sc = db.query(Character).filter(Character.id == str(_resolved)).first()
            # 模拟 _resolve_group_speaker 返回的 member 列表（与 mock 一致）
            for m in _make_member_chars():
                if m.id == str(_resolved):
                    _sc = m
                    break
            speaker_char = _sc
        if backfill:
            req.char = speaker_char  # D3 回填
        return asyncio.run(assemble_roleplay_prompt(req, deps))


def test_d3_no_backfill_uses_main_card():
    """修复前（不回填）：system_prompt 含主角色标记，不含发言者标记（即 bug 表现）。"""
    result = _run_assembly_with_backfill(backfill=False)
    assert MAIN_MARKER in result.system_prompt, "未回填时应使用主角色卡"
    assert SPEAKER_MARKER not in result.system_prompt, "未回填时不应使用发言者卡"


def test_d3_backfill_uses_speaker_card():
    """修复后（回填）：system_prompt 含发言者标记，不含主角色标记。"""
    result = _run_assembly_with_backfill(backfill=True)
    assert SPEAKER_MARKER in result.system_prompt, "回填后应使用发言者卡（SWAP 群聊 D3）"
    assert MAIN_MARKER not in result.system_prompt, "回填后不应使用主角色卡"
