# -*- coding: utf-8 -*-
"""聚焦：messages 结构 + 变量输出格式完整内容 + status_current_variable 转换 + 角色卡字段"""
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
        print('=== CHAR FIELDS ===')
        print('name:', char.name)
        print('description len:', len(char.description or ''))
        print('system_prompt len:', len(char.system_prompt or ''))
        print('first_mes len:', len(char.first_mes or ''))
        ext = char.extensions
        if isinstance(ext, str):
            import json
            ext = json.loads(ext) if ext else {}
        print('extensions keys:', list(ext.keys()) if isinstance(ext, dict) else type(ext))
        req = PromptAssemblyRequest(
            db=db, user=user, char=char, session_id=SESSION_ID, branch_id=None,
            message='开始', model='deepseek-v4-flash',
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
        print()
        print('=== MESSAGES STRUCTURE ===')
        for i, m in enumerate(result.messages):
            c = str(m.get('content', ''))
            role = m.get('role')
            print(f'[{i}] role={role} len={len(c)} head={c[:60]!r}')
        print()
        # 找含"变量输出格式"的完整消息，打印其前后
        for i, m in enumerate(result.messages):
            c = str(m.get('content', ''))
            if '变量输出格式' in c:
                idx = c.find('变量输出格式')
                print(f'=== MESSAGES[{i}] 变量输出格式 完整段落（前 2500）===')
                print(c[max(0, idx-800):idx+2500])
                break
        # 检查 status_current_variable 转换
        print()
        print('=== status_current_variable 检查 ===')
        found_scv = False
        for i, m in enumerate(result.messages):
            c = str(m.get('content', ''))
            if 'status_current_variable' in c or '仅供 AI 参考' in c:
                found_scv = True
                idx = c.find('status_current_variable')
                if idx == -1:
                    idx = c.find('仅供 AI 参考')
                print(f'MESSAGES[{i}] @{idx}:')
                print(c[max(0, idx-150):idx+500])
        if not found_scv:
            print('NOT FOUND in messages')
        # 宏未替换残留检查
        print()
        print('=== 未替换宏残留 ===')
        import re
        leftover = 0
        for i, m in enumerate(result.messages):
            c = str(m.get('content', ''))
            hits = re.findall(r'{{[^}]+}}', c)
            if hits:
                leftover += len(hits)
                print(f'MESSAGES[{i}] leftover macros: {hits[:5]}')
        if not leftover:
            print('none (all macros resolved)')
    finally:
        db.close()

asyncio.run(main())
