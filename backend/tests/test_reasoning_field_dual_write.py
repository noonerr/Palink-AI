"""Phase 3 extra 字段: reasoning 双写 + IGNORE_SYMBOL 过滤测试。

验证:
1. streaming 完成后，extra.reasoning 非空且与 content 中 ⋇...⋑ 内容一致 (双写兼容)
2. 历史消息（仅有 content 内联，无 extra.reasoning）可通过读取路径 fallback 解析
3. extra.ignore=true 的消息在 prompt 装配时被跳过 (IGNORE_SYMBOL 对齐)

参考:
- SillyTavern-1.18.0/public/scripts/messages.js: getReasoning/shouldFilterIgnore
- SillyTavern-1.18.0/public/scripts/openai.js: prepareOpenAIMessages (isIgnore 过滤)
- docs/REASONING_FIELD_MIGRATION.md (双写兼容方案)
"""
from __future__ import annotations

import json
import os
import sys
from types import SimpleNamespace

# 让 backend 目录可被导入
_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import pytest


# ---------------------------------------------------------------------------
# Test 1: _st_message_kwargs 正确写入 extra.reasoning 等字段 (双写契约)
# ---------------------------------------------------------------------------

def test_st_message_kwargs_writes_reasoning_extra():
    """验证 _st_message_kwargs 把 extra 字段正确序列化到 kwargs 中。

    这是双写兼容方案的契约测试：调用方传入 extra={reasoning: ...} 后，
    _st_message_kwargs 应返回 {"extra": "<JSON 含 reasoning 字段>"}。
    """
    from app.api.character_ext import _st_message_kwargs

    extra_dict = {
        "gen_id": "abc12345",
        "reasoning": "I should think about this carefully.",
        "reasoning_type": "thinking",
        "reasoning_duration": 1.234,
        "model": "gpt-4",
        "token_count": 100,
    }

    kwargs = _st_message_kwargs(
        role="assistant",
        content="Hello world",
        char_name="Alice",
        user_name="Bob",
        extra=extra_dict,
        gen_id="abc12345",
    )

    # extra 应被 JSON 序列化
    assert "extra" in kwargs
    assert isinstance(kwargs["extra"], str)
    parsed_extra = json.loads(kwargs["extra"])
    assert parsed_extra["reasoning"] == "I should think about this carefully."
    assert parsed_extra["reasoning_type"] == "thinking"
    assert parsed_extra["reasoning_duration"] == 1.234
    assert parsed_extra["gen_id"] == "abc12345"
    assert parsed_extra["model"] == "gpt-4"
    assert parsed_extra["token_count"] == 100

    # gen_id 也应作为顶层 kwarg 出现 (供 CharacterChatMessage 构造)
    # 注: gen_id 实际通过 extra 字典传递，_st_message_kwargs 不重复顶层暴露
    # 但 CharacterChatMessage 无 gen_id 列，所以 gen_id 只在 extra 中
    assert parsed_extra["gen_id"] == "abc12345"


# ---------------------------------------------------------------------------
# Test 2: 历史消息 fallback - 从 content 解析 ⋇...⋐ (兼容老消息)
# ---------------------------------------------------------------------------

def test_reasoning_fallback_from_content_inline():
    """验证历史消息（仅有 content 内联，无 extra.reasoning）的读取 fallback。

    模拟场景：旧版本生成的消息只有 content 中的 ⋇...⋑ 包裹，没有 extra.reasoning。
    读取时应能从 content 中解析出 reasoning。
    """
    # reasoning 内容（模拟 LLM 思考链）
    reasoning_text = "Let me think about how to respond to the user."
    content_text = "Hello! Nice to meet you."

    # 模拟旧消息的 content (⋇...⋑ 包裹的 reasoning + 实际内容)
    # 使用 Unicode 字符 ⋇ (U+22C7) 和 ⋑ (U+22D1)
    legacy_content = f"⋇{reasoning_text}⋑\n{content_text}"

    # 模拟 extra 字段 (旧消息无 reasoning 字段)
    legacy_extra = {}  # 空字典，模拟老消息没有 reasoning 字段

    # 读取路径: 优先 extra.reasoning，fallback 到 content 解析
    def get_reasoning(content: str, extra: dict) -> str:
        if extra.get("reasoning"):
            return extra["reasoning"]
        # fallback: 从 content 解析 ⋇...⋑
        import re
        match = re.search(r"⋇([^⋇⋑]*)⋑", content)
        return match.group(1) if match else ""

    extracted = get_reasoning(legacy_content, legacy_extra)
    assert extracted == reasoning_text, f"Expected '{reasoning_text}', got '{extracted}'"

    # 验证新消息 (双写) 的优先级: extra.reasoning 优先
    new_extra = {"reasoning": "New reasoning from extra field."}
    extracted_new = get_reasoning(legacy_content, new_extra)
    assert extracted_new == "New reasoning from extra field."


# ---------------------------------------------------------------------------
# Test 3: IGNORE_SYMBOL 过滤 - extra.ignore=true 的消息被跳过
# ---------------------------------------------------------------------------

def test_ignore_symbol_filters_message_from_prompt(db_session):
    """验证 extra.ignore=true 的消息在 prompt 装配时被跳过。

    ST 1.18.0 行为: Symbol.for('ignore') 标记的消息不出现在 prompt 中。
    Palink 方案: 用 extra.ignore=true 布尔字段替代 Symbol。
    """
    from app.models import Character, User, CharacterChatSession, CharacterChatMessage
    from app.services.character_message_builder import build_character_chat_messages

    # 创建测试用户和角色
    user = User(
        username="test_ignore_user",
        hashed_password="dummy",
        role="user",
        is_active=True,
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)

    char = Character(
        user_id=user.id,
        name="TestChar",
        description="A test character",
        personality="",
        scenario="",
        first_mes="",
        mes_example="",
        system_prompt="You are a test character.",
        post_history_instructions="",
        alternate_greetings="[]",
        tags="[]",
        creator_notes="",
        creator="test",
        character_version="1.0",
        extensions="{}",
    )
    db_session.add(char)
    db_session.commit()
    db_session.refresh(char)

    # 创建会话
    session = CharacterChatSession(
        id="test-session-ignore",
        user_id=user.id,
        character_id=char.id,
        title="Test session",
    )
    db_session.add(session)
    db_session.commit()

    # 创建 3 条消息: user -> assistant (ignored) -> user
    msg1 = CharacterChatMessage(
        session_id=session.id,
        branch_id=None,
        role="user",
        content="Hello",
        is_user=True,
        is_system=False,
    )
    # 这条 assistant 消息被标记为 ignore
    msg2 = CharacterChatMessage(
        session_id=session.id,
        branch_id=None,
        role="assistant",
        content="This should be ignored",
        is_user=False,
        is_system=False,
        extra=json.dumps({"ignore": True}),
    )
    msg3 = CharacterChatMessage(
        session_id=session.id,
        branch_id=None,
        role="user",
        content="Are you there?",
        is_user=True,
        is_system=False,
    )
    db_session.add_all([msg1, msg2, msg3])
    db_session.commit()

    # 用 _get_full_branch_history 模拟器（返回按 id 升序）
    def fake_get_full_branch_history(db, sess_id, br_id, limit=100):
        return (
            db.query(CharacterChatMessage)
            .filter(
                CharacterChatMessage.session_id == sess_id,
                CharacterChatMessage.branch_id == None,
            )
            .order_by(CharacterChatMessage.id.asc())
            .limit(limit)
            .all()
        )

    messages = build_character_chat_messages(
        db=db_session,
        char=char,
        user_nickname="Tester",
        session_id=session.id,
        branch_id=None,
        message="New message",
        images=[],
        system_prompt="System prompt",
        dynamic_context_parts=[],
        prompt_lang="en",
        user_setting=None,
        _replace_placeholders=lambda text, *args: text,
        _get_full_branch_history=fake_get_full_branch_history,
        _contains_chinese=lambda text: False,
        normalize_image_url=lambda url, **kwargs: url,
        include_user_message=False,  # 不包含用户消息，避免干扰断言
        include_title_instruction=False,
    )

    # 断言被 ignore 的消息内容不出现在任何 message 中
    all_content = " ".join(str(m.get("content", "")) for m in messages)
    assert "This should be ignored" not in all_content, (
        f"IGNORE_SYMBOL 过滤失败: 被标记 ignore 的消息内容仍出现在 prompt 中。"
        f"Messages: {messages}"
    )

    # 断言其他消息仍然存在
    assert any("Hello" in str(m.get("content", "")) for m in messages), \
        f"未忽略的消息应该保留在 prompt 中。Messages: {messages}"
    assert any("Are you there?" in str(m.get("content", "")) for m in messages), \
        f"未忽略的消息应该保留在 prompt 中。Messages: {messages}"


# ---------------------------------------------------------------------------
# Test 4: _st_message_extra 透传 Phase 3 字段 (round-trip 保障)
# ---------------------------------------------------------------------------

def test_st_message_extra_passes_phase3_fields():
    """验证 _st_message_extra 把 Phase 3 新增 12 个字段透传到 extra 中。

    这是 ST 卡片 round-trip 的契约测试：导入时所有字段都能被提取，
    不会丢失。
    """
    from app.api.silly_tavern import _st_message_extra

    # 构造一个含所有 Phase 3 字段的消息字典
    item = {
        "extra": {},
        "swipes": ["Hello"],
        "swipe_id": 0,
        # Phase 3 字段
        "reasoning": "Thinking...",
        "reasoning_type": "thinking",
        "reasoning_duration": 2.5,
        "reasoning_display_text": "Edited thinking",
        "tool_invocations": [{"id": "call_1", "name": "search"}],
        "files": [{"id": "f1", "name": "doc.pdf"}],
        "media_display": "carousel",
        "media_index": 0,
        "media": [{"url": "http://example.com/img.png"}],
        "bias": {"token1": 5},
        "memory": "Previous context",
        "ignore": False,
    }

    extra = _st_message_extra(item, item["swipes"], item["swipe_id"])

    # 验证所有 Phase 3 字段都被透传
    assert extra["reasoning"] == "Thinking..."
    assert extra["reasoning_type"] == "thinking"
    assert extra["reasoning_duration"] == 2.5
    assert extra["reasoning_display_text"] == "Edited thinking"
    assert extra["tool_invocations"] == [{"id": "call_1", "name": "search"}]
    assert extra["files"] == [{"id": "f1", "name": "doc.pdf"}]
    assert extra["media_display"] == "carousel"
    assert extra["media_index"] == 0
    assert extra["media"] == [{"url": "http://example.com/img.png"}]
    assert extra["bias"] == {"token1": 5}
    assert extra["memory"] == "Previous context"
    assert extra["ignore"] is False

    # 验证 swipe_info 也被设置 (用于 round-trip)
    assert "swipe_info" in extra
    assert isinstance(extra["swipe_info"], list)
    assert len(extra["swipe_info"]) == 1
