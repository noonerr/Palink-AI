# -*- coding: utf-8 -*-
"""直连 opencode.ai 网关，连续 3 次测试是否间歇性空响应"""
import sys
sys.stdout.reconfigure(encoding='utf-8')
import asyncio
import json
import httpx

async def main():
    prov = json.load(open('/app/data/providers.json', encoding='utf-8'))[0]
    async with httpx.AsyncClient(timeout=60) as client:
        for i in range(3):
            try:
                async with client.stream(
                    'POST', prov['base_url'].rstrip('/') + '/chat/completions',
                    headers={'Authorization': f"Bearer {prov['api_key']}"},
                    json={
                        'model': 'deepseek-v4-flash',
                        'messages': [{'role': 'user', 'content': 'hi'}],
                        'max_tokens': 50,
                        'stream': True,
                    },
                ) as resp:
                    print(f'try{i+1} status={resp.status_code}')
                    content = ''
                    reasoning = ''
                    async for line in resp.aiter_lines():
                        if not line.startswith('data:'):
                            continue
                        d = line[5:].strip()
                        if d == '[DONE]':
                            break
                        try:
                            ch = json.loads(d)
                            delta = (ch.get('choices') or [{}])[0].get('delta', {}) or {}
                            content += delta.get('content') or ''
                            reasoning += delta.get('reasoning_content') or delta.get('reasoning') or ''
                        except Exception:
                            pass
                    print(f'  content={len(content)} reasoning={len(reasoning)}')
            except Exception as e:
                print(f'try{i+1} EXC {type(e).__name__}: {str(e)[:120]}')
            await asyncio.sleep(1)

asyncio.run(main())