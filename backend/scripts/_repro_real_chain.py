# -*- coding: utf-8 -*-
"""在真实后端链路（stream_text_completion / openai SDK / timeout=30）复现第二轮失败"""
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
from app.services.inference_dispatcher import stream_text_completion

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
        for attempt in (1, 2):
            t0 = time.time()
            content, reasoning, usage = '', '', {}
            err = None
            try:
                stream = stream_text_completion(
                    model_id='deepseek-v4-flash',
                    messages=r.messages,
                    temperature=0.7,
                    top_p=0.95,
                    max_tokens=16384,
                    timeout=30.0,          # 与 websocket.py:846 完全一致
                    request_id=SESSION_ID,
                    user_id=user.id,
                    enable_thinking=None,   # 与生产一致
                    reasoning_effort='auto', # 与生产一致
                )
                first_tok_ts = None
                async for delta in stream:
                    if delta.get('type') == 'queue':
                        continue
                    if delta.get('usage'):
                        usage = delta['usage']
                        continue
                    if delta.get('reasoning'):
                        if first_tok_ts is None:
                            first_tok_ts = time.time()
                        reasoning += delta['reasoning']
                    if delta.get('content'):
                        if first_tok_ts is None:
                            first_tok_ts = time.time()
                        content += delta['content']
                print(f'[attempt {attempt}] OK total=%.1fs first_tok=%s reasoning=%d content=%d usage=%s' % (
                    time.time() - t0,
                    ('%.1fs' % (first_tok_ts - t0)) if first_tok_ts else 'NONE',
                    len(reasoning), len(content),
                    {k: usage.get(k) for k in ('completion_tokens',)}))
            except Exception as e:
                err = e
                print(f'[attempt {attempt}] EXCEPTION total=%.1fs: %s: %s' % (
                    time.time() - t0, type(e).__name__, str(e)[:300]))
            if err is None:
                break
            await asyncio.sleep(3)
    finally:
        db.close()

asyncio.run(main())
