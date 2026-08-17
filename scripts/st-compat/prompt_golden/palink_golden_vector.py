"""Palink 侧提示词黄金向量生成器。

在 backend 容器内运行（需要 DB 连接和 app 模块可导入）。
设置受控测试场景 → 调用 assemble_roleplay_prompt → 输出 messages JSON。

用法（容器内）:
    python /app/scripts/prompt_golden/palink_golden_vector.py \
        --fixture basic_char \
        --output /app/scripts/prompt_golden/results/palink_basic_char.json

用法（宿主机 docker exec）:
    docker compose exec backend python /app/scripts/prompt_golden/palink_golden_vector.py --fixture basic_char
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import uuid
from pathlib import Path

# ---------------------------------------------------------------------------
# Fixture 定义：每个 fixture 描述一个受控测试场景
# ---------------------------------------------------------------------------

FIXTURES: dict[str, dict] = {
    "basic_char": {
        "description": "A mysterious librarian named Elara who guards ancient tomes.",
        "personality": "Reserved, intellectual, secretly warm.",
        "scenario": "You visit the Grand Library seeking a forbidden book.",
        "first_mes": "*Elara looks up from her desk* \"Welcome to the Grand Library. How may I assist you today?\"",
        "mes_example": "<START>\n{{user}}: I'm looking for the Codex of Shadows.\n{{char}}: *Her eyes narrow* \"That tome is restricted. May I ask why you seek it?\"",
        "system_prompt": "",
        "post_history_instructions": "",
        "creator_notes": "",
        "character_version": "1.0",
        "chat_messages": [
            {"role": "user", "content": "Hello, I'd like to find a rare book."},
            {"role": "assistant", "content": "*Elara adjusts her glasses* \"Of course. What title are you seeking?\""},
        ],
        "current_message": "The Codex of Shadows, I've heard it's here.",
        "worldbook": None,
        "instruct_template": None,
        "context_template": None,
    },
    "char_with_worldbook": {
        "description": "Captain Aria Stormwind, a sky pirate navigating the cloud seas.",
        "personality": "Bold, charismatic, reckless.",
        "scenario": "You've stowed away on Aria's airship, the Tempest.",
        "first_mes": "*Aria spots you hiding behind a barrel* \"Well, well... a stowaway. Give me one reason not to throw you overboard.\"",
        "mes_example": "",
        "system_prompt": "",
        "post_history_instructions": "",
        "creator_notes": "",
        "character_version": "2.0",
        "chat_messages": [
            {"role": "user", "content": "I stowed away on your airship, the Tempest. Please don't throw me off!"},
            {"role": "assistant", "content": "*Aria laughs* \"A stowaway on the Tempest? Bold move. We're sailing the cloud seas tomorrow, so you'd better earn your keep.\""},
        ],
        "current_message": "What's the fastest way to get to the Floating Isles?",
        "worldbook": {
            "name": "Sky World Lore",
            "entries": [
                {
                    "keys": ["Tempest", "airship"],
                    "content": "The Tempest is a legendary sky pirate vessel, powered by a captured storm elemental. It is the fastest ship in the cloud seas.",
                    "enabled": True,
                    "selective": False,
                    "constant": False,
                    "position": 0,  # before char
                    "depth": 4,
                    "order": 100,
                },
                {
                    "keys": ["cloud seas", "sky ocean"],
                    "content": "The Cloud Seas are vast expanses of navigable atmosphere between floating islands. Ships sail on wind currents and storm streams.",
                    "enabled": True,
                    "selective": False,
                    "constant": False,
                    "position": 0,
                    "depth": 4,
                    "order": 90,
                },
            ],
        },
        "instruct_template": None,
        "context_template": None,
    },
    "worldbook_positions": {
        "description": "A detective in a noir city.",
        "personality": "Cynical, observant.",
        "scenario": "You enter the detective's office.",
        "first_mes": "*The detective looks up* \"What brings you here?\"",
        "mes_example": "",
        "system_prompt": "",
        "post_history_instructions": "",
        "creator_notes": "",
        "character_version": "1.0",
        "chat_messages": [
            {"role": "user", "content": "I need help finding my missing cat, Whiskers."},
            {"role": "assistant", "content": "*Sighs* \"Missing cat cases. My specialty. Tell me everything.\""},
        ],
        "current_message": "She was last seen near the old warehouse district.",
        "worldbook": {
            "name": "Noir City Lore",
            "entries": [
                {
                    "keys": ["detective", "office"],
                    "content": "[BEFORE_CHAR] The detective's office is on the third floor of a rundown building. Neon signs flicker outside the window.",
                    "enabled": True,
                    "selective": False,
                    "constant": True,
                    "position": 0,  # BEFORE_CHAR -> worldInfoBefore
                    "depth": 4,
                    "order": 100,
                },
                {
                    "keys": ["warehouse", "district"],
                    "content": "[AFTER_CHAR] The warehouse district is a dangerous area controlled by smugglers. Police rarely patrol there.",
                    "enabled": True,
                    "selective": False,
                    "constant": False,
                    "position": 1,  # AFTER_CHAR -> worldInfoAfter
                    "depth": 4,
                    "order": 90,
                },
                {
                    "keys": ["cat", "Whiskers"],
                    "content": "[AT_DEPTH] Whiskers is a rare silver tabby cat with a distinctive collar. She has been missing for three days.",
                    "enabled": True,
                    "selective": False,
                    "constant": False,
                    "position": 4,  # AT_DEPTH -> depth injection
                    "depth": 2,
                    "order": 80,
                },
            ],
        },
        "instruct_template": None,
        "context_template": None,
    },
    "char_with_instruct": {
        "description": "A helpful AI assistant named Nova.",
        "personality": "Precise, efficient, slightly humorous.",
        "scenario": "User asks Nova for technical help.",
        "first_mes": "Hello! I'm Nova. How can I help you today?",
        "mes_example": "",
        "system_prompt": "You are Nova, a helpful AI assistant.",
        "post_history_instructions": "Remember to be concise and accurate.",
        "creator_notes": "",
        "character_version": "1.0",
        "chat_messages": [
            {"role": "user", "content": "How do I fix a Python import error?"},
            {"role": "assistant", "content": "Let me help you troubleshoot that import error. First, check your Python path."},
        ],
        "current_message": "I checked the path but it still fails with ModuleNotFoundError.",
        "worldbook": None,
        "instruct_template": {
            "name": "TestInstruct",
            "input_sequence": "### User:",
            "input_suffix": "",
            "output_sequence": "### Assistant:",
            "output_suffix": "",
            "system_sequence": "### System:",
            "system_suffix": "",
            "stop_sequence": "### User:",
            "separator_sequence": "\n",
            "wrap_user_messages": True,
            "wrap_ai_messages": True,
            "macro_before": True,
        },
        "context_template": None,
    },
    "long_chat_truncation": {
        "description": "A storyteller who narrates an epic fantasy.",
        "personality": "Dramatic, verbose.",
        "scenario": "An ongoing adventure story.",
        "first_mes": "The tale begins in a land far away...",
        "mes_example": "",
        "system_prompt": "",
        "post_history_instructions": "",
        "creator_notes": "",
        "character_version": "1.0",
        # V-3 修复: long_chat_truncation 场景必须真实创建 30 条历史消息
        # （PALINK_SKIP_CHAT_HISTORY 不再跳过），使总 token 超过 token_budget，
        # 从而真实触发 _apply_st_compat_history_trim 的 D4 token 裁剪路径。
        # 消息内容刻意加长（每条约 200+ tokens），确保 30 条历史 + 首条
        # 消息总 token > 默认 budget（5632），裁剪真正生效而非直接返回。
        "skip_chat_history": False,
        # 30 条消息触发裁剪逻辑
        "chat_messages": [
            {"role": "user" if i % 2 == 0 else "assistant",
             "content": f"Message number {i+1}: {'The hero ventures deeper into the dungeon, encountering traps and treasures at every turn. The ancient walls echo with whispers of forgotten kings and the torchlight flickers against weathered stone. ' * 8}"}
            for i in range(30)
        ],
        "worldbook": None,
        "instruct_template": None,
        "context_template": None,
    },
}


async def generate_golden_vector(fixture_name: str, output_path: str | None) -> dict:
    """为指定 fixture 生成 Palink 侧黄金向量。"""
    from app.core.database import SessionLocal
    from app.models.user import User
    from app.models.character import (
        Character, CharacterChatSession, CharacterChatSessionBranch, CharacterChatMessage,
    )
    from app.models.system import UserSetting, InstructTemplate
    from app.services.roleplay_prompt_assembly import (
        PromptAssemblyDeps,
        PromptAssemblyRequest,
        assemble_roleplay_prompt,
    )
    from app.api.character_ext import (
        _build_char_system_prompt,
        _replace_placeholders,
        _get_full_branch_history,
        _get_ancestor_branch_ids,
        _contains_chinese,
        _apply_regex_scripts,
        _apply_plugin_regex_scripts,
        _apply_prompt_regex_to_messages,
    )

    fixture = FIXTURES[fixture_name]
    db = SessionLocal()

    try:
        # 记录创建的对象以便清理
        created_char_id = None
        created_session_id = None
        preset_id = None

        # 1. 使用已有用户（避免序列冲突）
        test_user = db.query(User).filter(User.is_active == True).first()
        if not test_user:
            raise RuntimeError("No active user found in DB")

        # 2. 确保 UserSetting 存在并重置 instruct 状态（测试隔离）
        user_setting = db.query(UserSetting).filter(UserSetting.user_id == test_user.id).first()
        if not user_setting:
            user_setting = UserSetting(user_id=test_user.id)
            db.add(user_setting)
            db.flush()
        # 重置 instruct 状态（避免上一个 fixture 泄漏）
        user_setting.instruct_enabled = False
        user_setting.instruct_template_id = None
        # 设置 ST 兼容模式
        user_setting.silly_tavern_mode = "st-compat"
        db.flush()

        # 3. 创建测试角色
        char_id = str(uuid.uuid4())
        created_char_id = char_id
        char = Character(
            id=char_id,
            user_id=test_user.id,
            name=f"GoldenTest_{fixture_name}",
            description=fixture["description"],
            personality=fixture.get("personality", ""),
            scenario=fixture.get("scenario", ""),
            first_mes=fixture.get("first_mes", ""),
            mes_example=fixture.get("mes_example", ""),
            system_prompt=fixture.get("system_prompt", ""),
            post_history_instructions=fixture.get("post_history_instructions", ""),
            creator_notes=fixture.get("creator_notes", ""),
            character_version=fixture.get("character_version", ""),
        )
        db.add(char)
        db.flush()

        # 4. 创建世界书（如果 fixture 有）
        if fixture.get("worldbook"):
            from app.models.worldbook import WorldBook, WorldBookStage
            wb_data = fixture["worldbook"]
            wb = WorldBook(
                id=str(uuid.uuid4()),
                user_id=test_user.id,
                character_id=char_id,
                name=wb_data["name"],
            )
            db.add(wb)
            db.flush()
            for idx, entry_data in enumerate(wb_data["entries"]):
                import json as _json
                entry = WorldBookStage(
                    id=str(uuid.uuid4()),
                    world_book_id=wb.id,
                    stage_index=idx,
                    title=entry_data.get("keys", [""])[0] if entry_data.get("keys") else "",
                    content=entry_data["content"],
                    keys=_json.dumps(entry_data.get("keys", [])),
                    enabled=entry_data.get("enabled", True),
                    selective=entry_data.get("selective", False),
                    constant=entry_data.get("constant", False),
                    position=entry_data.get("position", 0),
                    depth=entry_data.get("depth", 4),
                    order=entry_data.get("order", 100),
                    selective_logic=entry_data.get("selective_logic", 0),
                )
                db.add(entry)
            db.flush()

        # 5. 创建 instruct 模板（如果 fixture 有）
        # 注意：ST 1.18.0 在 Chat Completion API 模式下（chat_completion_source
        # 为 openai/claude/custom 等），即使启用了 instruct 模板，也只注入
        # instruct.system_prompt 作为系统消息，不会应用文本 instruct wrapping
        # （### User:/### Assistant:/### System: 前缀）。Palink 的
        # _should_apply_instruct_wrapping 实现了相同逻辑。
        # 因此这里同时创建一个 PromptPreset 指定 chat_completion_source="openai"，
        # 模拟 ST 的 Chat Completion API 模式，确保 instruct wrapping 被跳过。
        if fixture.get("instruct_template"):
            it_data = fixture["instruct_template"]
            it = InstructTemplate(
                user_id=test_user.id,
                name=it_data["name"],
                input_prefix=it_data.get("input_sequence", ""),
                input_suffix=it_data.get("input_suffix", ""),
                output_prefix=it_data.get("output_sequence", ""),
                output_suffix=it_data.get("output_suffix", ""),
                system_sequence=it_data.get("system_sequence", ""),
                system_suffix=it_data.get("system_suffix", ""),
                stop_sequence=it_data.get("stop_sequence", ""),
            )
            db.add(it)
            db.flush()
            # 绑定到 user_setting
            user_setting.instruct_template_id = it.id
            user_setting.instruct_enabled = True
            db.flush()

        # 5.5 创建 PromptPreset 指定 chat_completion_source="openai"
        # 模拟 ST 1.18.0 Chat Completion API 模式（与捕获 golden vector 时的 ST 配置一致）。
        # 在此模式下，instruct 文本 wrapping 被跳过，仅注入 instruct.system_prompt。
        from app.models.prompt_preset import PromptPreset
        preset = PromptPreset(
            id=str(uuid.uuid4()),
            user_id=test_user.id,
            name=f"GoldenPreset_{fixture_name}",
            chat_completion_source="openai",
        )
        db.add(preset)
        db.flush()
        preset_id = preset.id

        # 6. 创建聊天 session + branch + messages
        session_id = str(uuid.uuid4())
        created_session_id = session_id
        session = CharacterChatSession(
            id=session_id,
            user_id=test_user.id,
            character_id=char_id,
            title=f"Golden Test {fixture_name}",
        )
        db.add(session)
        db.flush()

        # 创建活跃分支
        branch_id = str(uuid.uuid4())
        branch = CharacterChatSessionBranch(
            id=branch_id,
            session_id=session_id,
            is_active=True,
        )
        db.add(branch)
        db.flush()

        from datetime import datetime, timezone, timedelta
        base_time = datetime.now(timezone.utc) - timedelta(minutes=len(fixture["chat_messages"]))
        # 注意：ST 侧捕获时 Playwright 选择角色会创建新聊天（仅 first_mes），
        # 不会加载我们通过 /api/chats/save 保存的聊天历史（ES 模块化导致
        # openCharacterChat 不在全局作用域）。为使 Palink 与 ST 输入一致，
        # 此处也跳过 chat_messages 的创建，仅保留 first_mes + current_message。
        # 聊天历史截断逻辑由 test_st_compat_token_budget.py 单元测试覆盖。
        # V-3 修复: fixture 可显式声明 skip_chat_history=False 以真实创建历史
        # 并触发端到端 token 裁剪（long_chat_truncation 场景）。
        _skip_chat_history = fixture.get("skip_chat_history", True)
        if not _skip_chat_history:
            for i, msg_data in enumerate(fixture["chat_messages"]):
                msg = CharacterChatMessage(
                    session_id=session_id,
                    branch_id=branch_id,
                    role=msg_data["role"],
                    content=msg_data["content"],
                    is_user=(msg_data["role"] == "user"),
                    created_at=base_time + timedelta(minutes=i),
                )
                db.add(msg)
        db.flush()

        # 6.5 添加 first_mes 作为第一条 assistant 消息
        # ST 创建新聊天时会将 first_mes 作为聊天历史的第一条 assistant 消息。
        # Palink 侧必须模拟此行为，否则 prompt 会缺少 first_mes。
        first_mes = fixture.get("first_mes", "")
        if first_mes:
            first_msg = CharacterChatMessage(
                session_id=session_id,
                branch_id=branch_id,
                role="assistant",
                content=first_mes,
                is_user=False,
                created_at=base_time - timedelta(minutes=1),
            )
            db.add(first_msg)
            db.flush()

        # 7. 调用 assemble_roleplay_prompt
        deps = PromptAssemblyDeps(
            build_system_prompt=_build_char_system_prompt,
            replace_placeholders=_replace_placeholders,
            get_full_branch_history=_get_full_branch_history,
            get_ancestor_branch_ids=_get_ancestor_branch_ids,
            contains_chinese=_contains_chinese,
            apply_plugin_regex_scripts=_apply_plugin_regex_scripts,
            apply_regex_scripts=_apply_regex_scripts,
            apply_prompt_regex_to_messages=_apply_prompt_regex_to_messages,
        )

        # 最后一条 user 消息作为当前输入（优先使用 current_message 字段）
        last_user_msg = fixture.get("current_message", "")
        if not last_user_msg:
            for m in reversed(fixture["chat_messages"]):
                if m["role"] == "user":
                    last_user_msg = m["content"]
                    break

        req = PromptAssemblyRequest(
            db=db,
            user=test_user,
            char=char,
            session_id=session_id,
            branch_id=branch_id,
            message=last_user_msg,
            model="test-model",
            user_nickname="User",  # ST 默认 persona name
            max_tokens=2048,
            include_user_message=True,
            prompt_preset_id=preset_id,  # 指定 chat_completion_source="openai"
        )

        result = await assemble_roleplay_prompt(req, deps)

        # 8. 构造输出
        golden = {
            "fixture": fixture_name,
            "source": "palink",
            "messages": result.messages,
            "system_prompt": result.system_prompt,
            "dynamic_context_parts": result.dynamic_context_parts,
            "effective_max_tokens": result.effective_max_tokens,
            "stop_sequences": result.stop_sequences,
            "total_tokens_estimate": result.total_tokens_estimate,
            "token_budget": result.token_budget,
            "report": [
                {"key": r.key, "status": r.status, "detail": r.detail, "tokens": r.tokens_estimate}
                for r in result.report
            ],
        }

        # 清理测试数据
        db.commit()  # 先提交以确保所有对象可见
        if created_session_id:
            db.query(CharacterChatMessage).filter(CharacterChatMessage.session_id == created_session_id).delete()
            db.query(CharacterChatSessionBranch).filter(CharacterChatSessionBranch.session_id == created_session_id).delete()
            db.query(CharacterChatSession).filter(CharacterChatSession.id == created_session_id).delete()
        if created_char_id:
            from app.models.worldbook import WorldBook, WorldBookStage
            wb_ids = [w.id for w in db.query(WorldBook).filter(WorldBook.character_id == created_char_id).all()]
            if wb_ids:
                db.query(WorldBookStage).filter(WorldBookStage.world_book_id.in_(wb_ids)).delete(synchronize_session=False)
                db.query(WorldBook).filter(WorldBook.id.in_(wb_ids)).delete(synchronize_session=False)
            db.query(Character).filter(Character.id == created_char_id).delete()
        # 清理 PromptPreset
        if preset_id:
            from app.models.prompt_preset import PromptPreset
            db.query(PromptPreset).filter(PromptPreset.id == preset_id).delete()
        db.commit()

        # 输出
        if output_path:
            Path(output_path).parent.mkdir(parents=True, exist_ok=True)
            with open(output_path, "w", encoding="utf-8") as f:
                json.dump(golden, f, ensure_ascii=False, indent=2)
            print(f"[OK] Golden vector written to {output_path}")
        else:
            print(json.dumps(golden, ensure_ascii=False, indent=2))

        return golden

    except Exception as exc:
        db.rollback()
        print(f"[FAIL] {fixture_name}: {exc}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(description="Palink prompt golden vector generator")
    parser.add_argument("--fixture", choices=list(FIXTURES.keys()), default="basic_char",
                        help="Fixture name to generate")
    parser.add_argument("--all", action="store_true", help="Generate all fixtures")
    parser.add_argument("--output", type=str, default=None,
                        help="Output JSON path (default: stdout)")
    args = parser.parse_args()

    if args.all:
        for name in FIXTURES:
            out = args.output
            if out:
                out = str(Path(out).parent / f"palink_{name}.json")
            asyncio.run(generate_golden_vector(name, out))
    else:
        asyncio.run(generate_golden_vector(args.fixture, args.output))


if __name__ == "__main__":
    main()
