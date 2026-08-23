# -*- coding: utf-8 -*-
"""检查 messages[2] 段落顺序与完整性"""
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

SESSION_ID = 'c0c2adae-8d41-4601-a1c3-dcf4f62caf1a'

async def main():
    db = SessionLocal()
    try:
        s = db.query(CharacterChatSession).filter(CharacterChatSession.id == SESSION_ID).first()
        char = db.query(Character).filter(Character.id == s.character_id).first()
        user = db.query(User).filter(User.id == s.user_id).first()
        req = PromptAssemblyRequest(
            db=db, user=user, char=char, session_id=SESSION_ID, branch_id=None,
            message='x', model='deepseek-v4-flash', user_nickname='admin',
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
        # 打印最后一条 user 消息（应含 MVU user tail 注入）
        for i in range(len(r.messages) - 1, -1, -1):
            if r.messages[i].get('role') == 'user':
                c = str(r.messages[i].get('content', ''))
                print(f'=== LAST USER MESSAGES[{i}] len={len(c)} ===')
                print('tail:', repr(c[-500:]))
                print('has 变量更新指令:', '变量更新指令' in c)
                print('has <UpdateVariable>:', '<UpdateVariable>' in c)
                break
        c = str(r.messages[2].get('content', ''))
        print('msg2 len:', len(c))
        for kw in ['<互联网', '<猫神说话格式强调>', '【当前变量状态】', '变量更新规则', '变量输出格式', '<UpdateVariable>']:
            print(repr(kw), '@', c.find(kw))
        print('--- msg2 末尾 800 ---')
        print(c[-800:])
        # 角色卡原始数据检查
        import json
        ext = char.extensions
        if isinstance(ext, str):
            ext = json.loads(ext) if ext else {}
        raw = (ext or {}).get('palink_raw_card_data') or {}
        if isinstance(raw, str):
            raw = json.loads(raw) if raw else {}
        data = raw.get('data') or raw
        if isinstance(data, dict):
            print('--- raw card fields ---')
            print('description len:', len(data.get('description') or ''))
            print('personality len:', len(data.get('personality') or ''))
            print('scenario len:', len(data.get('scenario') or ''))
            print('mes_example len:', len(data.get('mes_example') or ''))
            print('first_mes len:', len(data.get('first_mes') or ''))
    finally:
        db.close()

asyncio.run(main())
