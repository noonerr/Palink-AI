# -*- coding: utf-8 -*-
"""打印完整 system_prompt 与 worldbook 文本"""
import sys
sys.stdout.reconfigure(encoding='utf-8')
import asyncio

from app.core.database import SessionLocal
from app.models import CharacterChatSession, Character, User
from app.api.character_ext import (
    _build_char_system_prompt, _replace_placeholders, _get_full_branch_history,
    _get_ancestor_branch_ids, _contains_chinese, _apply_regex_scripts,
    _apply_plugin_regex_scripts, _apply_prompt_regex_to_messages,
)
from app.services.roleplay_prompt_assembly import (
    PromptAssemblyRequest, PromptAssemblyDeps, assemble_roleplay_prompt,
)

SESSION_ID = 'c0c2adae-8d41-4601-a1c3-dcf4f62caf1a'

async def main():
    db = SessionLocal()
    try:
        session = db.query(CharacterChatSession).filter(CharacterChatSession.id == SESSION_ID).first()
        char = db.query(Character).filter(Character.id == session.character_id).first()
        user = db.query(User).filter(User.id == session.user_id).first()
        req = PromptAssemblyRequest(
            db=db, user=user, char=char, session_id=SESSION_ID, branch_id=None,
            message='桃子我爱你', model='deepseek-v4-flash',
            user_nickname='admin', include_prompt_regex=True,
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
        result = await assemble_roleplay_prompt(req, deps)
        print('=== SYSTEM PROMPT ===')
        print(result.system_prompt)
        print()
        print('=== MESSAGES[0] ===')
        print(str(result.messages[0].get('content','')))
        print()
        # worldbook 文本（含 UpdateVariable 的）
        for i, m in enumerate(result.messages):
            c = str(m.get('content',''))
            if 'UpdateVariable' in c or '变量输出格式' in c:
                idx = c.find('变量输出格式')
                print(f'=== MESSAGES[{i}] 变量输出格式 context ===')
                print(c[max(0,idx-100):idx+400])
                break
    finally:
        db.close()

asyncio.run(main())
