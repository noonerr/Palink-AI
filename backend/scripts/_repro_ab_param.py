# -*- coding: utf-8 -*-
"""对照实验：max_completion_tokens vs max_tokens —— 定位第二轮 reasoning-only 的参数根因"""
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

SESSION_ID = '1b955bdd-d836-4d1d-8827-792e3ee4d884'

async def call(payload, label, prov):
    import httpx
    t0 = time.time()
    content_parts, reasoning_parts, usage, finish = [], [], None, None
    async with httpx.AsyncClient(timeout=300) as client:
        async with client.stream("POST", prov["base_url"].rstrip('/') + '/chat/completions',
                                 headers={"Authorization": f"Bearer {prov['api_key']}"},
                                 json=payload) as resp:
            async for line in resp.aiter_lines():
                if not line.startswith('data:'):
                    continue
                data = line[5:].strip()
                if data == '[DONE]':
                    break
                try:
                    chunk = json.loads(data)
                except Exception:
                    continue
                if chunk.get('usage'):
                    usage = chunk['usage']
                ch = chunk.get('choices') or [{}]
                if ch:
                    choice = ch[0]
                    if choice.get('finish_reason'):
                        finish = choice['finish_reason']
                    delta = choice.get('delta', {}) or {}
                    rd = delta.get('reasoning_content') or delta.get('reasoning')
                    if rd:
                        reasoning_parts.append(rd)
                    cd = delta.get('content')
                    if cd:
                        content_parts.append(cd)
    print(f'[{label}] %.1fs finish=%s reasoning=%d content=%d usage=%s' % (
        time.time() - t0, finish, len(''.join(reasoning_parts)), len(''.join(content_parts)),
        {k: usage.get(k) for k in ('completion_tokens', 'total_tokens') if usage}))
    if not content_parts:
        print(f'[{label}] reasoning tail:', repr(''.join(reasoning_parts)[-200:]))
    return bool(content_parts)

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
        with open('/app/data/providers.json', encoding='utf-8') as f:
            prov = json.load(f)[0]
        base_msgs = [{"role": m.get("role", "user"), "content": str(m.get("content", ""))} for m in r.messages]

        # 实验1: max_completion_tokens（后端 deepseek reasoning_on 实际发送的参数）
        await call({
            "model": "deepseek-v4-flash", "messages": base_msgs,
            "max_completion_tokens": 16384, "temperature": 0.7,
            "stream": True, "stream_options": {"include_usage": True},
        }, 'max_completion_tokens=16384', prov)

        await asyncio.sleep(2)

        # 实验2: max_tokens（复现成功的参数）
        await call({
            "model": "deepseek-v4-flash", "messages": base_msgs,
            "max_tokens": 16384, "temperature": 0.7,
            "stream": True, "stream_options": {"include_usage": True},
        }, 'max_tokens=16384', prov)
    finally:
        db.close()

asyncio.run(main())
