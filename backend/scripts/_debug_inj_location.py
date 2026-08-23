"""诊断：IN_PROMPT 注入最终落在哪条 message。"""
import asyncio
import sys

sys.path.insert(0, "/app")

from app.core.database import SessionLocal
from app.models import User, Character
from app.services.roleplay_prompt_assembly import (
    PromptAssemblyDeps,
    PromptAssemblyRequest,
    assemble_roleplay_prompt,
)
from app.api.character_ext import (
    _apply_plugin_regex_scripts,
    _apply_regex_scripts,
    _apply_prompt_regex_to_messages,
    _get_full_branch_history,
    _get_ancestor_branch_ids,
    _contains_chinese,
    _replace_placeholders,
    _build_char_system_prompt,
)

INJ = "[对话渲染格式规范]\n测试注入内容 @bubble:角色名|情绪|[对白]"


async def main():
    db = SessionLocal()
    db.commit()
    user = db.query(User).filter(User.id == 1).first()
    char = db.query(Character).filter(Character.id == "1641066c-951b-4965-8947-14cc13d6cf51").first()
    req = PromptAssemblyRequest(
        db=db,
        user=user,
        char=char,
        session_id="fba95ef7-21ca-4d66-b623-3ec4b73d6f50",
        branch_id="787041f7-7e33-460a-9369-fde748464db4",
        message="666",
        model="deepseek-v4-flash",
        include_user_message=False,
        max_tokens=16384,
        extension_prompts=[
            {
                "identifier": "bubble-dialogue-format",
                "content": INJ,
                "position": 0,
                "depth": 0,
                "role": "system",
                "scan": False,
            }
        ],
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
    a = await assemble_roleplay_prompt(req, deps)
    found = False
    for i, m in enumerate(a.messages):
        c = str(m.get("content", ""))
        mark = ""
        if "对话渲染格式规范" in c:
            mark = " <== INJECTION HERE"
            found = True
        print(f"[{i}] role={m['role']} len={len(c)}{mark}")
    if not found:
        print("!!! 注入完全丢失 !!!")
    print("report ext items:")
    for r in a.report:
        if "extension" in r.key:
            print("  ", r.key, r.status, r.detail)


asyncio.run(main())
