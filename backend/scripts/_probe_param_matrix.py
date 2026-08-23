# -*- coding: utf-8 -*-
"""对照实验：不同参数组合直连 opencode.ai，定位空响应触发条件"""
import sys
sys.stdout.reconfigure(encoding='utf-8')
import asyncio
import json
import httpx

PROV = json.load(open('/app/data/providers.json', encoding='utf-8'))[0]
URL = PROV['base_url'].rstrip('/') + '/chat/completions'
HDR = {'Authorization': f"Bearer {PROV['api_key']}"}
MSG = [{'role': 'user', 'content': 'hi'}]

async def stream_call(payload, label):
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            async with client.stream('POST', URL, headers=HDR, json=payload) as resp:
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
                print(f'[{label}] status={resp.status_code} content={len(content)} reasoning={len(reasoning)}')
    except Exception as e:
        print(f'[{label}] EXC {type(e).__name__}: {str(e)[:100]}')

async def non_stream_call(payload, label):
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            r = await client.post(URL, headers=HDR, json=payload)
            txt = r.text
            print(f'[{label}] status={r.status_code} len={len(txt)} head={txt[:120]!r}')
    except Exception as e:
        print(f'[{label}] EXC {type(e).__name__}: {str(e)[:100]}')

async def main():
    # 1. 我们的生产参数：max_completion_tokens=16384 + stream
    await stream_call({
        'model': 'deepseek-v4-flash', 'messages': MSG,
        'max_completion_tokens': 16384, 'temperature': 0.7,
        'stream': True, 'stream_options': {'include_usage': True},
    }, 'A: max_completion_tokens=16384 stream')
    await asyncio.sleep(1)
    # 2. 简单参数：max_tokens=2048 + stream
    await stream_call({
        'model': 'deepseek-v4-flash', 'messages': MSG,
        'max_tokens': 2048, 'temperature': 0.7,
        'stream': True,
    }, 'B: max_tokens=2048 stream')
    await asyncio.sleep(1)
    # 3. 非流式 + max_tokens=2048
    await non_stream_call({
        'model': 'deepseek-v4-flash', 'messages': MSG,
        'max_tokens': 2048, 'temperature': 0.7,
    }, 'C: max_tokens=2048 non-stream')
    await asyncio.sleep(1)
    # 4. 非流式 + max_completion_tokens=16384
    await non_stream_call({
        'model': 'deepseek-v4-flash', 'messages': MSG,
        'max_completion_tokens': 16384, 'temperature': 0.7,
    }, 'D: max_completion_tokens=16384 non-stream')

asyncio.run(main())