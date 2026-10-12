# -*- coding: utf-8 -*-
"""用 openai SDK（复用同一客户端，模拟生产 llm_client 缓存）连续 5 次调用，验证连接复用是否导致空响应"""
import sys
sys.stdout.reconfigure(encoding='utf-8')
import asyncio
import json
import time

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
from app.services.llm_client import get_async_openai_client

SESSION_ID = '1b955bdd-d836-4d1d-8827-792e3ee4d884'

async def main():
    db = SessionLocal()
    try:
        s = db.query(CharacterChatSession).filter(CharacterChatSession.id == SESSION_ID).first()
        char = db.query(Character).filter(Character.id == s.character_id).first()
        user = db.query(User).filter(User.id == s.user_id).first()
        req = PromptAssemblyRequest(
            db=db, user=user, char=char, session_id=SESSION_ID,
            branch_id=None,
            message='（下楼，找到桃汐）我爱你桃子', model='deepseek-v4-flash', user_nickname='admin',
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
        prov = json.load(open('/app/data/providers.json', encoding='utf-8'))[0]
        # 复用同一客户端（模拟生产 llm_client 缓存）
        client = get_async_openai_client(prov['api_key'], prov['base_url'], timeout=60.0)
        msgs = [{'role': m.get('role', 'user'), 'content': str(m.get('content', ''))} for m in r.messages]

        for i in range(5):
            t0 = time.time()
            content = ''
            reasoning = ''
            try:
                stream = await client.chat.completions.create(
                    model='deepseek-v4-flash',
                    messages=msgs,
                    max_completion_tokens=16384,
                    temperature=0.7,
                    stream=True,
                    stream_options={'include_usage': True},
                )
                async for chunk in stream:
                    if not chunk.choices:
                        continue
                    delta = chunk.choices[0].delta
                    rd = getattr(delta, 'reasoning_content', None) or getattr(delta, 'reasoning', None)
                    if rd:
                        reasoning += rd
                    if delta.content:
                        content += delta.content
                print(f'try{i+1} {time.time()-t0:.1f}s content={len(content)} reasoning={len(reasoning)}')
            except Exception as e:
                print(f'try{i+1} EXC {type(e).__name__}: {str(e)[:150]}')
            await asyncio.sleep(2)
    finally:
        db.close()

asyncio.run(main())