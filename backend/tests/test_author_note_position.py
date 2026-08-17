"""Author Note position injection tests for roleplay_prompt_assembly.

验证 ``author_note_position`` 四个 ST 1.18.0 取值在 ``assemble_roleplay_prompt``
（palink-native 路径）中的注入行为。对齐 ST 1.18.0 ``extension_prompt_types``：

    -1 = NONE          (不注入)
     0 = IN_PROMPT      (post-history 之后，追加到 system_prompt 末尾)
     1 = IN_CHAT        (chatHistory 内按 author_note_depth 插入)
     2 = BEFORE_PROMPT  (story string 之前，前插到 system_prompt 开头)

迁移 0056 已将旧 Palink 值 (0=depth/1=after/2=last/3=inactive/4=top) 转换为
此 ST 对齐集合。默认值 1 = IN_CHAT (匹配 ST DEFAULT_POSITION)。

测试通过 mock 隔离 DB 和外部服务依赖，专注验证 author note 在不同 position
下的放置位置。
"""

import asyncio
import os
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# 让 ``backend`` 目录可被导入（测试可位于 backend/tests/ 下独立运行）
_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from app.models.system import UserSetting  # noqa: E402,F401
    from app.services.roleplay_prompt_assembly import (  # noqa: E402
        PromptAssemblyDeps,
        PromptAssemblyRequest,
        assemble_roleplay_prompt,
    )
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover - 依赖缺失时跳过
    _IMPORT_OK = False
    _IMPORT_ERROR = exc


pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")


AUTHOR_NOTE_TEXT = "[TestAuthorNote: remember the secret word is BANANA]"
BASE_SYSTEM_PROMPT = "base system prompt"

# 6 条基础消息（system + 2 轮对话），让 depth 插入能落在中段而非首尾
BASE_MESSAGES = [
    {"role": "system", "content": BASE_SYSTEM_PROMPT},
    {"role": "user", "content": "hello"},
    {"role": "assistant", "content": "hi there"},
    {"role": "user", "content": "how are you?"},
    {"role": "assistant", "content": "I am fine"},
    {"role": "user", "content": "tell me a story"},
]


# ---------------------------------------------------------------------------
# Mock 构造工具
# ---------------------------------------------------------------------------
def _make_user_setting(position: int, depth: int = 4, frequency: int = 0,
                        note: str = AUTHOR_NOTE_TEXT) -> SimpleNamespace:
    """构造一个模拟的 UserSetting 对象。"""
    return SimpleNamespace(
        user_id=1,
        author_note=note,
        author_note_position=position,
        author_note_depth=depth,
        author_note_frequency=frequency,
        memory_mode="disabled",
        prompt_language="en",
        instruct_enabled=False,
        instruct_template_id=None,
        active_persona_id=None,
    )


def _make_mock_db(user_setting: SimpleNamespace) -> MagicMock:
    """构造 mock DB session，仅 UserSetting 查询返回 user_setting。"""
    db = MagicMock()

    def _query_side_effect(model):
        q = MagicMock()
        if model is UserSetting:
            q.filter.return_value.first.return_value = user_setting
        else:
            q.filter.return_value.first.return_value = None
        return q

    db.query.side_effect = _query_side_effect
    return db


def _make_request(db: MagicMock) -> PromptAssemblyRequest:
    """构造一个最小化的 PromptAssemblyRequest。"""
    user = SimpleNamespace(id=1, username="TestUser")
    char = SimpleNamespace(
        id="char-1",
        name="TestChar",
        description="A test character",
        extensions=None,
        mes_example=None,
        # _classify_prompt_identifier 需访问 post_history_instructions（预先存在的测试 mock 缺失字段）
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
        group_id=None,
    )


def _make_deps() -> PromptAssemblyDeps:
    """构造 mock deps，所有 callable 均为直通（返回输入或固定值）。"""
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


def _run_assembly(position: int, depth: int = 4):
    """运行 assemble_roleplay_prompt 并返回 PromptAssemblyResult。

    内部 patch 掉所有 DB / 外部服务依赖（worldbook、plotline、memory、
    context template、instruct template、macro evaluation、status bar），
    使其成为 no-op，从而隔离 author note position 逻辑进行测试。
    """
    user_setting = _make_user_setting(position=position, depth=depth)
    db = _make_mock_db(user_setting)
    req = _make_request(db)
    deps = _make_deps()

    # build_character_chat_messages 返回固定消息列表，排除历史/模板影响
    with patch(
        "app.services.roleplay_prompt_assembly.build_character_chat_messages",
        return_value=list(BASE_MESSAGES),
    ), patch(
        "app.services.roleplay_prompt_assembly._append_worldbook_context",
        new=MagicMock(),
    ), patch(
        "app.services.roleplay_prompt_assembly._append_plotline_context",
        new=MagicMock(),
    ), patch(
        "app.services.roleplay_prompt_assembly._append_memory_context",
        new=AsyncMock(),
    ), patch(
        "app.services.roleplay_prompt_assembly._load_context_template",
        return_value=None,
    ), patch(
        "app.services.roleplay_prompt_assembly._load_instruct_template",
        return_value=None,
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


def _extract_text(msg: dict) -> str:
    """从消息中提取纯文本内容（兼容 str 和 multimodal list）。"""
    content = msg.get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(
            p.get("text", "") for p in content
            if isinstance(p, dict) and p.get("type") == "text"
        )
    return str(content)


# ---------------------------------------------------------------------------
# position=-1: NONE (skip injection)
# ---------------------------------------------------------------------------
class TestPositionNone:
    """position=-1 (NONE): author note 不注入到任何位置。"""

    def test_note_not_in_messages(self):
        result = _run_assembly(position=-1)
        note_msgs = [
            m for m in result.messages
            if AUTHOR_NOTE_TEXT in _extract_text(m)
        ]
        assert len(note_msgs) == 0, \
            f"position=-1 (NONE) should not inject any message, got {len(note_msgs)}"

    def test_note_not_in_system_prompt(self):
        result = _run_assembly(position=-1)
        assert AUTHOR_NOTE_TEXT not in result.system_prompt

    def test_report_status_skipped(self):
        result = _run_assembly(position=-1)
        an_report = [r for r in result.report if r.key == "author_note"]
        assert len(an_report) == 1
        assert an_report[0].status == "skipped"
        assert "position_int=-1" in an_report[0].detail or "NONE" in an_report[0].detail


# ---------------------------------------------------------------------------
# position=0: IN_PROMPT (after post-history; appended to system_prompt end)
# ---------------------------------------------------------------------------
class TestPosition0InPrompt:
    """position=0 (IN_PROMPT): author note 文本追加到 system_prompt 末尾。"""

    def test_note_in_system_prompt(self):
        result = _run_assembly(position=0)
        assert AUTHOR_NOTE_TEXT in result.system_prompt
        assert result.system_prompt.endswith(AUTHOR_NOTE_TEXT)

    def test_note_not_as_separate_message(self):
        result = _run_assembly(position=0)
        note_msgs = [
            m for m in result.messages
            if m.get("role") == "system" and AUTHOR_NOTE_TEXT in _extract_text(m)
        ]
        # position=0 不应作为独立 system 消息出现在 messages 中
        assert len(note_msgs) == 0, \
            f"position=0 should not add a separate message, got {len(note_msgs)}"

    def test_report_status_included(self):
        result = _run_assembly(position=0)
        an_report = [r for r in result.report if r.key == "author_note"]
        assert len(an_report) == 1
        assert an_report[0].status == "included"
        assert "position_int=0" in an_report[0].detail


# ---------------------------------------------------------------------------
# position=1: IN_CHAT (in-chat at depth)
# ---------------------------------------------------------------------------
class TestPosition1InChat:
    """position=1 (IN_CHAT): author note 作为 system 消息按 depth 插入到 chat 中段。"""

    def test_note_appears_in_messages(self):
        result = _run_assembly(position=1, depth=4)
        note_msgs = [
            m for m in result.messages
            if m.get("role") == "system" and AUTHOR_NOTE_TEXT in _extract_text(m)
        ]
        assert len(note_msgs) == 1, f"expected 1 author note message, got {len(note_msgs)}"

    def test_note_not_first_or_last(self):
        result = _run_assembly(position=1, depth=4)
        first_msg = result.messages[0]
        last_msg = result.messages[-1]
        assert AUTHOR_NOTE_TEXT not in _extract_text(first_msg), \
            "position=1 should not be the first message"
        assert AUTHOR_NOTE_TEXT not in _extract_text(last_msg), \
            "position=1 should not be the last message"

    def test_note_inserted_at_depth(self):
        # 6 条消息 + depth=4 → insert_index = max(0, 6-4) = 2
        result = _run_assembly(position=1, depth=4)
        note_index = None
        for i, m in enumerate(result.messages):
            if m.get("role") == "system" and AUTHOR_NOTE_TEXT in _extract_text(m):
                note_index = i
                break
        assert note_index is not None, "author note not found in messages"
        assert note_index == 2, f"expected depth-4 insertion at index 2, got {note_index}"

    def test_note_not_in_system_prompt(self):
        result = _run_assembly(position=1, depth=4)
        assert AUTHOR_NOTE_TEXT not in result.system_prompt, \
            "position=1 should not append to system_prompt"

    def test_report_status_included(self):
        result = _run_assembly(position=1, depth=4)
        an_report = [r for r in result.report if r.key == "author_note"]
        assert len(an_report) == 1
        assert an_report[0].status == "included"
        assert "position_int=1" in an_report[0].detail


# ---------------------------------------------------------------------------
# position=2: BEFORE_PROMPT (before story string; prepended to system_prompt start)
# ---------------------------------------------------------------------------
class TestPosition2BeforePrompt:
    """position=2 (BEFORE_PROMPT): author note 文本前插到 system_prompt 开头。"""

    def test_note_in_system_prompt(self):
        result = _run_assembly(position=2)
        assert AUTHOR_NOTE_TEXT in result.system_prompt
        assert result.system_prompt.startswith(AUTHOR_NOTE_TEXT)

    def test_note_not_as_separate_message(self):
        result = _run_assembly(position=2)
        note_msgs = [
            m for m in result.messages
            if m.get("role") == "system" and AUTHOR_NOTE_TEXT in _extract_text(m)
        ]
        assert len(note_msgs) == 0, \
            f"position=2 should not add a separate message, got {len(note_msgs)}"

    def test_note_before_base_prompt(self):
        # BEFORE_PROMPT 应使 note 出现在 base system prompt 之前
        result = _run_assembly(position=2)
        assert result.system_prompt.index(AUTHOR_NOTE_TEXT) < \
               result.system_prompt.index(BASE_SYSTEM_PROMPT), \
            "position=2 note should precede the base system prompt"

    def test_report_status_included(self):
        result = _run_assembly(position=2)
        an_report = [r for r in result.report if r.key == "author_note"]
        assert len(an_report) == 1
        assert an_report[0].status == "included"
        assert "position_int=2" in an_report[0].detail


# ---------------------------------------------------------------------------
# position=0 与 position=2 共存验证（互不影响，均在 system_prompt 但首尾不同）
# ---------------------------------------------------------------------------
class TestPosition0And2Coexistence:
    """验证 position=0 (末尾追加) 和 position=2 (开头前插) 不会同时出现。

    由于 author_note_position 是单一整数字段，同一时刻只能取一个值，
    所以 position=0 和 position=2 不会在同一次请求中共存。此测试确认
    position=0 不会意外触发 position=2 的前插逻辑，反之亦然。
    """

    def test_position0_does_not_prepend_to_start(self):
        result = _run_assembly(position=0)
        assert not result.system_prompt.startswith(AUTHOR_NOTE_TEXT), \
            "position=0 should append (not prepend) the note"

    def test_position2_does_not_append_to_end(self):
        result = _run_assembly(position=2)
        assert not result.system_prompt.endswith(AUTHOR_NOTE_TEXT), \
            "position=2 should prepend (not append) the note"


# ---------------------------------------------------------------------------
# 空 author_note 验证
# ---------------------------------------------------------------------------
class TestEmptyAuthorNote:
    """当 author_note 为空时，所有 position 都应跳过注入。"""

    @pytest.mark.parametrize("position", [-1, 0, 1, 2])
    def test_empty_note_skipped(self, position):
        user_setting = _make_user_setting(position=position, note="")
        db = _make_mock_db(user_setting)
        req = _make_request(db)
        deps = _make_deps()

        with patch(
            "app.services.roleplay_prompt_assembly.build_character_chat_messages",
            return_value=list(BASE_MESSAGES),
        ), patch(
            "app.services.roleplay_prompt_assembly._append_worldbook_context",
            new=MagicMock(),
        ), patch(
            "app.services.roleplay_prompt_assembly._append_plotline_context",
            new=MagicMock(),
        ), patch(
            "app.services.roleplay_prompt_assembly._append_memory_context",
            new=AsyncMock(),
        ), patch(
            "app.services.roleplay_prompt_assembly._load_context_template",
            return_value=None,
        ), patch(
            "app.services.roleplay_prompt_assembly._load_instruct_template",
            return_value=None,
        ), patch(
            "app.services.roleplay_prompt_assembly.evaluate_macros_in_messages",
            side_effect=lambda messages, env: messages,
        ), patch(
            "app.services.roleplay_prompt_assembly.evaluate_macros",
            side_effect=lambda text, env: text,
        ), patch(
            "app.services.status_bar_detector.build_status_instruction",
            return_value="",
        ):
            result = asyncio.run(assemble_roleplay_prompt(req, deps))

        # 空字符串 → 跳过注入
        assert AUTHOR_NOTE_TEXT not in result.system_prompt
        note_msgs = [
            m for m in result.messages
            if AUTHOR_NOTE_TEXT in _extract_text(m)
        ]
        assert len(note_msgs) == 0
        an_report = [r for r in result.report if r.key == "author_note"]
        assert len(an_report) == 1
        assert an_report[0].status == "skipped"
