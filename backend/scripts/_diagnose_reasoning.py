"""诊断：修复后模型 reasoning 469 字符但 content 仍空。打印 reasoning 全文判断卡点。

用法：docker exec palink-ai-backend-1 python /app/scripts/_diagnose_reasoning.py
"""

import asyncio
import logging
import sys

sys.path.insert(0, "/app")

logging.basicConfig(level=logging.WARNING)

from app.core.database import SessionLocal  # noqa: E402
from app.models import User, Character  # noqa: E402
from app.services.roleplay_prompt_assembly import (  # noqa: E402
    PromptAssemblyDeps,
    PromptAssemblyRequest,
    assemble_roleplay_prompt,
)
from app.api.character_ext import (  # noqa: E402
    _apply_plugin_regex_scripts,
    _apply_regex_scripts,
    _apply_prompt_regex_to_messages,
    _get_full_branch_history,
    _get_ancestor_branch_ids,
    _contains_chinese,
    _replace_placeholders,
    _build_char_system_prompt,
)
from app.services.inference_dispatcher import stream_text_completion  # noqa: E402

SESSION_ID = "93e9b2ee-fbe5-41eb-ba5f-652cf7ca89b4"
CHAR_ID = "c21c3512-7d38-4177-a55f-742afabe5ca6"
BRANCH_ID = "280e5bec-1162-4b19-9157-a7587a155c89"
USER_ID = 1
MESSAGE = "桃子我爱你"
MODEL = "deepseek-v4-flash"

INJECTION = """[对话渲染格式规范]
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
情绪字段必须从固定池中选取（开心、欢喜、愤怒、难过、紧张、平静、害羞、喜欢等），禁止自造新词。
情绪字段不能省略，必须填写。禁止使用其他情绪词，禁止自造新词。
</now_plot>"""


async def build_messages(with_injection: bool):
    db = SessionLocal()
    db.commit()
    user = db.query(User).filter(User.id == USER_ID).first()
    char = db.query(Character).filter(Character.id == CHAR_ID).first()
    kwargs = {}
    if with_injection:
        kwargs["extension_prompts"] = [
            {
                "identifier": "bubble-dialogue-format",
                "content": INJECTION,
                "position": 1,
                "depth": 0,
                "role": "system",
                "scan": False,
            }
        ]
    req = PromptAssemblyRequest(
        db=db, user=user, char=char,
        session_id=SESSION_ID, branch_id=BRANCH_ID,
        message=MESSAGE, model=MODEL,
        include_user_message=False, max_tokens=16384,
        **kwargs,
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
    assembly = await assemble_roleplay_prompt(req, deps)
    return assembly.messages


async def run_once(name: str, messages: list) -> bool:
    content_parts: list[str] = []
    reasoning_parts: list[str] = []
    usage = None
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
        if sum(len(p) for p in content_parts) > 500:
            break
    content = "".join(content_parts)
    reasoning = "".join(reasoning_parts)
    ok = bool(content)
    print(f"\n[{name}] {'OK' if ok else 'EMPTY'} content_len={len(content)} reasoning_len={len(reasoning)} completion={usage.get('completion_tokens') if usage else '?'}")
    if not ok:
        print(f"[{name}] FULL reasoning:\n{reasoning}")
    else:
        print(f"[{name}] content_head={content[:150]!r}")
    return ok


async def main() -> None:
    # 修复后的注入组 × 3 次（对齐真实链路重试语义，观察成功率与 reasoning 内容）
    msgs = await build_messages(with_injection=True)
    results = []
    for i in range(3):
        results.append(await run_once(f"FIXED-INJ-{i+1}", msgs))
    print(f"\n=== 修复后注入组成功率: {sum(results)}/3 ===")
    # 无注入基线 × 1（确认基线仍稳）
    base_msgs = await build_messages(with_injection=False)
    await run_once("BASELINE-NOINJ", base_msgs)


asyncio.run(main())
