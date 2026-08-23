# -*- coding: utf-8 -*-
"""复现 2178 时刻的模型调用，观察模型真实返回"""
import sys
sys.stdout.reconfigure(encoding='utf-8')
import asyncio
import json

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
from app.core import settings

SESSION_ID = '389cae42-d42b-4215-94c7-d671aa9c5cfd'
BRANCH_ID = 'a2901ca4-5c3b-4352-a67c-524f5c304d35'

async def main():
    db = SessionLocal()
    try:
        s = db.query(CharacterChatSession).filter(CharacterChatSession.id == SESSION_ID).first()
        char = db.query(Character).filter(Character.id == s.character_id).first()
        user = db.query(User).filter(User.id == s.user_id).first()
        req = PromptAssemblyRequest(
            db=db, user=user, char=char, session_id=SESSION_ID,
            branch_id=BRANCH_ID,
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
        # 读 provider
        with open('/app/data/providers.json', encoding='utf-8') as f:
            providers = json.load(f)
        prov = providers[0]
        import httpx
        payload = {
            "model": "deepseek-v4-flash",
            "messages": [{"role": m.get("role", "user"), "content": str(m.get("content", ""))} for m in r.messages],
            "max_tokens": 16384,
            "temperature": 0.7,
            "stream": True,
        }
        print('=== 请求概况 ===')
        total_chars = sum(len(str(m.get('content', ''))) for m in r.messages)
        print('messages:', len(r.messages), '总字符:', total_chars, '≈tokens:', int(total_chars * 0.7))
        print('=== 开始调用模型 (stream) ===')
        async with httpx.AsyncClient(timeout=120) as client:
            async with client.stream("POST", prov["base_url"].rstrip('/') + '/chat/completions',
                                     headers={"Authorization": f"Bearer {prov['api_key']}"},
                                     json=payload) as resp:
                print('HTTP status:', resp.status_code)
                content_parts = []
                reasoning_parts = []
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
                    choice = chunk.get('choices', [{}])[0] if chunk.get('choices') else {}
                    delta = choice.get('delta', {}) or {}
                    if delta.get('reasoning'):
                        reasoning_parts.append(delta['reasoning'])
                    if delta.get('content'):
                        content_parts.append(delta['content'])
                print('=== 结果 ===')
                print('reasoning len:', len(''.join(reasoning_parts)))
                print('content len:', len(''.join(content_parts)))
                print('reasoning head:', repr(''.join(reasoning_parts)[:200]))
                print('content head:', repr(''.join(content_parts)[:300]))
                print('TOTAL tokens:', (chunk.get('usage') or {}).get('total_tokens', 'N/A'))
    finally:
        db.close()

asyncio.run(main())
