# -*- coding: utf-8 -*-
"""模拟 a5aee696 会话当前提示词，统计规模与异常内容"""
import sys
sys.stdout.reconfigure(encoding='utf-8')
import asyncio

from app.core.database import SessionLocal
from app.models import CharacterChatSession, Character, User
from app.services.roleplay_prompt_assembly import (
    PromptAssemblyRequest, PromptAssemblyDeps, assemble_roleplay_prompt,
)
from app.api.character_ext import (
    _build_char_system_prompt, _replace_placeholders, _get_full_branch_history,
    _get_ancestor_branch_ids, _contains_chinese, _apply_regex_scripts,
    _apply_plugin_regex_scripts, _apply_prompt_regex_to_messages,
)

SESSION_ID = '389cae42-d42b-4215-94c7-d671aa9c5cfd'

async def main():
    db = SessionLocal()
    try:
        s = db.query(CharacterChatSession).filter(CharacterChatSession.id == SESSION_ID).first()
        char = db.query(Character).filter(Character.id == s.character_id).first()
        user = db.query(User).filter(User.id == s.user_id).first()
        print('char:', char.name)
        req = PromptAssemblyRequest(
            db=db, user=user, char=char, session_id=SESSION_ID,
            branch_id='a2901ca4-5c3b-4352-a67c-524f5c304d35',
            message='666', model='deepseek-v4-flash', user_nickname='admin',
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
        r = await assemble_roleplay_prompt(req, deps)
        total = 0
        print('=== messages ===')
        for i, m in enumerate(r.messages):
            c = str(m.get('content', ''))
            total += len(c)
            role = m.get('role')
            flag = ''
            if len(c) > 5000:
                flag = '  <== 超长!'
            if 'Error: 模型未返回' in c:
                flag = '  <== Error 消息!'
            if '变量更新指令' in c:
                flag = '  <== 含 MVU user tail'
            print(f'[{i}] {role} len={len(c)}{flag}')
        print('总字符:', total)
        print('估计 tokens（中文约 1 字≈0.6-0.7 token）:', int(total * 0.7))
        print()
        print('=== system_prompt ===')
        print('len:', len(r.system_prompt))
        print('head:', r.system_prompt[:150].replace(chr(10), ' '))
        print('=== effective_max_tokens ===', r.effective_max_tokens)
        print('=== stop_sequences ===', r.stop_sequences)
        # 检查是否有重复注入 user tail（潜在 bug）
        for i, m in enumerate(r.messages):
            if m.get('role') == 'user':
                c = str(m.get('content', ''))
                if c.count('变量更新指令') > 1:
                    print(f'!! MESSAGES[{i}] user tail 重复注入 {c.count("变量更新指令")} 次')
    finally:
        db.close()

asyncio.run(main())
