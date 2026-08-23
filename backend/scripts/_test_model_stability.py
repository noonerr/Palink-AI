# -*- coding: utf-8 -*-
"""连续调用模型 5 次，统计空/异常响应率"""
import sys
sys.stdout.reconfigure(encoding='utf-8')
import asyncio
import json
import httpx

PROVIDER_FILE = '/app/data/providers.json'

async def call_once(client, base_url, api_key, model, messages, idx):
    payload = {
        "model": model,
        "messages": messages,
        "max_tokens": 1024,
        "temperature": 0.7,
        "stream": True,
    }
    content_parts = []
    reasoning_parts = []
    finish_reason = 'N/A'
    http_status = 0
    try:
        async with client.stream("POST", base_url.rstrip('/') + '/chat/completions',
                                 headers={"Authorization": f"Bearer {api_key}"},
                                 json=payload) as resp:
            http_status = resp.status_code
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
                if choice.get('finish_reason'):
                    finish_reason = choice['finish_reason']
    except Exception as e:
        print(f'[#{idx}] EXCEPTION: {type(e).__name__}: {str(e)[:120]}')
        return
    cl = len(''.join(content_parts))
    rl = len(''.join(reasoning_parts))
    status = 'OK' if cl > 0 else ('ONLY-REASONING' if rl > 0 else 'EMPTY!!')
    print(f'[#{idx}] http={http_status} finish={finish_reason} content={cl} reasoning={rl} -> {status}')
    if cl == 0 and rl > 0:
        print(f'    reasoning head: {repr("".join(reasoning_parts)[:120])}')

async def main():
    with open(PROVIDER_FILE, encoding='utf-8') as f:
        providers = json.load(f)
    prov = providers[0]
    base_url = prov['base_url']
    api_key = prov['api_key']
    model = 'deepseek-v4-flash'
    print(f'base_url={base_url} model={model}')
    # 测试 A: 简单 prompt
    simple_msgs = [{"role": "user", "content": "你好，请回复一句话。"}]
    # 测试 B: 模拟 2178 时刻的提示词（含长 worldbook + 历史 + tail）
    print('=== A: 简单 prompt x5 ===')
    async with httpx.AsyncClient(timeout=120) as client:
        for i in range(5):
            await call_once(client, base_url, api_key, model, simple_msgs, i)
    print('=== B: 模拟对话 prompt x3 ===')
    conv_msgs = [
        {"role": "system", "content": "你是我被猫娘包围了！的角色扮演系统。你必须在回复末尾用 <UpdateVariable> 输出变量更新。"},
        {"role": "user", "content": "开始"},
        {"role": "assistant", "content": "<think>开场思考</think>阳光正好，桃汐在街角等你。\n<UpdateVariable>\n<Analysis>no change</Analysis>\n<JSONPatch>\n[{\"op\":\"delta\",\"path\":\"/桃汐/好感度\",\"value\":1}]\n</JSONPatch>\n</UpdateVariable>"},
        {"role": "user", "content": "我爱你桃子\n\n【变量更新指令 - 强制，不可省略】\n本卡使用 <UpdateVariable> 变量系统。你必须在【每条回复的最末尾】用 <UpdateVariable> 标签输出本次剧情引起的变量变化"},
    ]
    async with httpx.AsyncClient(timeout=120) as client:
        for i in range(3):
            await call_once(client, base_url, api_key, model, conv_msgs, i)

asyncio.run(main())
