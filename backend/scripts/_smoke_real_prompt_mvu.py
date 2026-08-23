"""用真实 dump 的 messages（用户 2219 那轮的 prompt）多次采样，测模型输出 <UpdateVariable> 块的遵循率。

关键：确认是 prompt/模型问题还是代码问题。
"""

import asyncio
import json
import logging
import sys

sys.path.insert(0, "/app")

logging.basicConfig(level=logging.WARNING)

from app.services.inference_dispatcher import stream_text_completion  # noqa: E402

MODEL = "deepseek-v4-flash"
USER_ID = 1


async def load_messages() -> list:
    with open("/tmp/prompt_dump.json", encoding="utf-8") as f:
        data = json.load(f)
    return [dict(m) for m in data["messages"]]


async def run_once(messages: list) -> dict:
    content_parts: list[str] = []
    reasoning_parts: list[str] = []
    async for chunk in stream_text_completion(
        model_id=MODEL, messages=messages, temperature=0.70,
        max_tokens=16384, timeout=180.0, user_id=USER_ID, reasoning_effort="auto",
    ):
        if chunk.get("content"):
            content_parts.append(chunk["content"])
        if chunk.get("reasoning"):
            reasoning_parts.append(chunk["reasoning"])
    return {"content": "".join(content_parts), "reasoning": "".join(reasoning_parts)}


async def main() -> None:
    messages = await load_messages()
    print(f"[INFO] 真实 dump messages={len(messages)}，末尾 role={messages[-1]['role']}")
    # print 末尾 2 条 role 确认
    for i, m in enumerate(messages[-3:], start=len(messages) - 3):
        print(f"  [{i}] {m['role']}")
    has_block = 0
    for i in range(4):
        r = await run_once(messages)
        content = r["content"]
        ok = bool(content)
        has_uv = "<UpdateVariable>" in content if ok else False
        if has_uv:
            has_block += 1
        print(f"[{i+1}] content_len={len(content)} reasoning_len={len(r['reasoning'])} 有正文={ok} 有UpdateVariable={has_uv}")
        if ok:
            tail = content[-120:].replace("\n", " ")
            print(f"    tail={tail[:100]!r}")
    print(f"\n[结果] 4 次采样中 {has_block} 次输出 UpdateVariable 块")


asyncio.run(main())
