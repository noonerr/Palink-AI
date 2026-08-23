"""大样本对照：区分「末尾 system 注入」与「网关间歇性空响应」。

组别（各 5 次）：
  A. 无注入（基线）
  B. 修复后注入（in_chat depth=0，结尾闭合标签已被防护剥离）
  C. depth=1 注入（末条消息之前）
若 B 失败率显著高于 A/C → 「system 消息作为最后一条」本身是诱因，
修复应调整 depth=0 的插入语义；若三者相近 → 剩余失败为网关间歇性。

用法：docker exec palink-ai-backend-1 python /app/scripts/_experiment_sampling.py
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
N = 5

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
情绪字段不能省略，必须填写。禁止使用其他情绪词，禁止自造新词。"""


async def build_messages(extension_prompts=None):
    db = SessionLocal()
    db.commit()
    user = db.query(User).filter(User.id == USER_ID).first()
    char = db.query(Character).filter(Character.id == CHAR_ID).first()
    req = PromptAssemblyRequest(
        db=db, user=user, char=char,
        session_id=SESSION_ID, branch_id=BRANCH_ID,
        message=MESSAGE, model=MODEL,
        include_user_message=False, max_tokens=16384,
        extension_prompts=extension_prompts or [],
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
    return (await assemble_roleplay_prompt(req, deps)).messages


async def run_once(messages: list) -> dict:
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
        if sum(len(p) for p in content_parts) > 400:
            break
    return {
        "content": "".join(content_parts),
        "reasoning": "".join(reasoning_parts),
        "completion": usage.get("completion_tokens") if usage else None,
    }


async def sample(name: str, messages: list) -> None:
    ok = 0
    details = []
    for i in range(N):
        r = await run_once(messages)
        success = bool(r["content"])
        if success:
            ok += 1
        details.append(f"{'OK' if success else 'EMPTY'}(c={len(r['content'])},r={len(r['reasoning'])},tk={r['completion']})")
    print(f"[{name}] {ok}/{N} 成功 | {' '.join(details)}")


async def main() -> None:
    base = await build_messages()

    b_msgs = await build_messages(extension_prompts=[{
        "identifier": "bubble-dialogue-format",
        "content": INJECTION + "\n</now_plot>",  # 防护会剥离结尾闭合标签
        "position": 1, "depth": 0, "role": "system", "scan": False,
    }])
    # 确认防护生效
    inj = [m for m in b_msgs if "对话渲染格式规范" in str(m.get("content", ""))][-1]
    assert not inj["content"].rstrip().split("\n")[-1].strip().startswith("</"), "防护未生效"

    c_msgs = [dict(m) for m in base]
    c_msgs.insert(len(c_msgs) - 1, {"role": "system", "content": INJECTION})

    await sample("A-无注入", base)
    await sample("B-末尾注入(防护后)", b_msgs)
    await sample("C-depth1注入", c_msgs)


asyncio.run(main())
