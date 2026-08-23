# -*- coding: utf-8 -*-
"""复现 2199 轮（第二轮）的模型调用：历史含 2198（双think正文），观察 reasoning-only 机制"""
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

SESSION_ID = '1b955bdd-d836-4d1d-8827-792e3ee4d884'

async def main():
    db = SessionLocal()
    try:
        s = db.query(CharacterChatSession).filter(CharacterChatSession.id == SESSION_ID).first()
        print('branch_id:', s.branch_id if hasattr(s, 'branch_id') else 'N/A')
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
            providers = json.load(f)
        prov = providers[0]
        import httpx
        payload = {
            "model": "deepseek-v4-flash",
            "messages": [{"role": m.get("role", "user"), "content": str(m.get("content", ""))} for m in r.messages],
            "max_tokens": 16384,
            "temperature": 0.7,
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        print('=== 请求概况 ===')
        total_chars = sum(len(str(m.get('content', ''))) for m in r.messages)
        print('messages:', len(r.messages), '总字符:', total_chars)
        # 打印最后一条 user 消息尾部（确认 MVU 指令在）
        for m in reversed(r.messages):
            if m.get('role') == 'user':
                print('last user tail:', repr(str(m.get('content', ''))[-260:]))
                break
        print('=== 调用模型 (stream, 思考开) ===')
        import time
        t0 = time.time()
        content_parts, reasoning_parts = [], []
        usage, finish = None, None
        async with httpx.AsyncClient(timeout=300) as client:
            async with client.stream("POST", prov["base_url"].rstrip('/') + '/chat/completions',
                                     headers={"Authorization": f"Bearer {prov['api_key']}"},
                                     json=payload) as resp:
                print('HTTP status:', resp.status_code)
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
                    # content 可能不在 choices[0]（有的网关放 delta.content）
                        cd = delta.get('content')
                        if cd:
                            content_parts.append(cd)
        print('=== 结果 (%.1fs) ===' % (time.time() - t0))
        print('finish_reason:', finish)
        print('reasoning len:', len(''.join(reasoning_parts)))
        print('content len:', len(''.join(content_parts)))
        print('usage:', usage)
        print('reasoning tail:', repr(''.join(reasoning_parts)[-300:]))
        print('content head:', repr(''.join(content_parts)[:300]))
    finally:
        db.close()

asyncio.run(main())
