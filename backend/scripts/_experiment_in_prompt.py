"""复现 IN_PROMPT(0) append 到 messages 末尾的真实链路（BubbleDialogue setExtensionPrompt position=0）。

组别（基于真实第二轮 dump 的 10 条 messages，各 3 次）：
  F1: BubbleDialogue 注入（含 </now_plot> 结尾）append 到末尾 —— 当前后端行为
  F2: BubbleDialogue 注入（用户当前配置结尾"禁止使用以上列表之外的词汇。"）append 到末尾
  G : 同 F1 注入但追加到 messages[0]（system prompt）content 末尾 —— 修复方向

用法：docker exec palink-ai-backend-1 python /app/scripts/_experiment_in_prompt.py
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

# 对话渲染系统 v7.1 注入文本（格式规则+情绪词约束），两种结尾配置
INJ_TAIL_CLOSE = """[对话渲染格式规范]
当角色产生想法、进行对白时必须严格使用以下格式：@bubble:角色名|情绪|[对白]

[正文标签规则]
<content> 标签外面必须包一层 <now_plot> 标签。

输出结构：
<now_plot>
<content>
（正文内容）
</content>
</now_plot>

[情绪词约束]
情绪字段必须从固定池中选取（开心、欢喜、愤怒、难过、紧张、平静、害羞、喜欢等）。
情绪字段不能省略，必须填写。禁止使用其他情绪词，禁止自造新词。
禁止使用以上列表之外的词汇。
</now_plot>"""

INJ_TAIL_PLAIN = INJ_TAIL_CLOSE.rsplit("\n", 1)[0]  # 结尾无闭合标签（用户当前配置形态）


async def load_dump_messages() -> list:
    with open("/tmp/prompt_dump.json", encoding="utf-8") as f:
        data = json.load(f)
    return [dict(m) for m in data["messages"]]


async def run_once(name: str, messages: list) -> bool:
    content_parts: list[str] = []
    reasoning_parts: list[str] = []
    usage = None
    try:
        async for chunk in stream_text_completion(
            model_id=MODEL, messages=messages, temperature=0.70,
            max_tokens=16384, timeout=120.0, user_id=USER_ID,
            reasoning_effort="auto",
        ):
            if chunk.get("content"):
                content_parts.append(chunk["content"])
            if chunk.get("reasoning"):
                reasoning_parts.append(chunk["reasoning"])
            if chunk.get("usage"):
                usage = chunk["usage"]
            if sum(len(p) for p in content_parts) > 400:
                break
    except Exception as exc:
        print(f"[{name}] EXC: {type(exc).__name__}: {exc}")
        return False
    content = "".join(content_parts)
    reasoning = "".join(reasoning_parts)
    ok = bool(content)
    print(f"[{name}] {'OK' if ok else 'EMPTY'} c={len(content)} r={len(reasoning)} tk={usage.get('completion_tokens') if usage else '?'}")
    if not ok and reasoning:
        print(f"[{name}] reasoning_tail={reasoning[-120:]!r}")
    return ok


async def main() -> None:
    base = await load_dump_messages()

    async def sample(name: str, messages: list, n: int = 3) -> None:
        ok = 0
        for _ in range(n):
            if await run_once(name, [dict(m) for m in messages]):
                ok += 1
        print(f">>> [{name}] {ok}/{n}")

    # F1: append 末尾（IN_PROMPT 当前后端行为），注入含 </now_plot> 结尾
    f1 = [dict(m) for m in base]
    f1.append({"role": "system", "content": INJ_TAIL_CLOSE})
    await sample("F1-末尾append/闭合标签结尾", f1)

    # F2: append 末尾，注入无闭合标签结尾（当前用户配置形态）
    f2 = [dict(m) for m in base]
    f2.append({"role": "system", "content": INJ_TAIL_PLAIN})
    await sample("F2-末尾append/普通结尾", f2)

    # G: 追加到 messages[0]（system prompt）content 末尾 —— 修复方向
    g = [dict(m) for m in base]
    g[0] = {"role": "system", "content": (g[0].get("content") or "") + "\n\n" + INJ_TAIL_CLOSE}
    await sample("G-systemprompt末尾追加", g)


asyncio.run(main())
