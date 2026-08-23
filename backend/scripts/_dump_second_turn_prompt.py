"""复现第二轮对话的 prompt 装配并 dump 完整 messages。

背景：2026-08-19 用户实测第二轮对话 100% 空响应（reasoning-only / 完全空），
日志显示 attempt=3 的 reasoning_tail 为提示词规则片段
"禁止使用其他情绪词，禁止自造新词。\n</now_plot>"。
本脚本在容器内复现装配，dump 第二轮完整 prompt 供分析。

用法：docker exec palink-ai-backend-1 python /app/scripts/_dump_second_turn_prompt.py
"""

import asyncio
import json
import sys

sys.path.insert(0, "/app")

from app.core.database import SessionLocal  # noqa: E402
from app.models import User, Character  # noqa: E402
from app.services.roleplay_prompt_assembly import (  # noqa: E402
    PromptAssemblyDeps,
    PromptAssemblyRequest,
    assemble_roleplay_prompt,
)
from app.api.character_ext import (  # noqa: E402
    _apply_plugin_regex_scripts,
    _apply_regex_scripts,
    _apply_prompt_regex_to_messages,
    _get_full_branch_history,
    _get_ancestor_branch_ids,
    _contains_chinese,
    _replace_placeholders,
    _build_char_system_prompt,
)

SESSION_ID = "93e9b2ee-fbe5-41eb-ba5f-652cf7ca89b4"
CHAR_ID = "c21c3512-7d38-4177-a55f-742afabe5ca6"
BRANCH_ID = "e75416f8-d1c8-4af7-bfd6-449e8c491007"
USER_ID = 1
MESSAGE = "666"


async def main() -> None:
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.id == USER_ID).first()
        char = db.query(Character).filter(Character.id == CHAR_ID).first()
        # 用户消息 2214（桃子我爱你）已落库，与真实第二轮一致：include_user_message=False
        req = PromptAssemblyRequest(
            db=db,
            user=user,
            char=char,
            session_id=SESSION_ID,
            branch_id=BRANCH_ID,
            message=MESSAGE,
            model="deepseek-v4-flash",
            include_user_message=False,
            max_tokens=16384,
        )
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
        assembly = await assemble_roleplay_prompt(req, deps)
        out = {
            "messages": assembly.messages,
            "debug": assembly.debug_dict(),
            "system_prompt": assembly.system_prompt,
            "dynamic_context_parts": assembly.dynamic_context_parts,
        }
        with open("/tmp/prompt_dump.json", "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
        print(f"dumped {len(assembly.messages)} messages -> /tmp/prompt_dump.json")
        for i, m in enumerate(assembly.messages):
            content = m.get("content") or ""
            if isinstance(content, list):
                content = str(content)
            print(f"--- [{i}] role={m.get('role')} len={len(content)} head={content[:80]!r}")
    finally:
        db.close()


asyncio.run(main())
