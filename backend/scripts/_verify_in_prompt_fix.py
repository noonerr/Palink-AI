"""修复验证（IN_PROMPT 路径）：装配断言 + 真实模型调用。

模拟 BubbleDialogue 插件真实链路：setExtensionPrompt(position=0=IN_PROMPT, depth=0, role=0=system)
→ WS extension_prompts=[{identifier, content, position:0, depth:0, role:'system'}] → 后端装配。

断言：
  1. 注入文本在 messages[0]（system prompt）content 内
  2. messages 末尾无注入条目（最后一条仍是 user）
  3. 真实模型调用 3 次全部有正文

用法：docker exec palink-ai-backend-1 python /app/scripts/_verify_in_prompt_fix.py
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

SESSION_ID = "fba95ef7-21ca-4d66-b623-3ec4b73d6f50"
CHAR_ID = "1641066c-951b-4965-8947-14cc13d6cf51"
BRANCH_ID = "787041f7-7e33-460a-9369-fde748464db4"
USER_ID = 1
MESSAGE = "666"
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
情绪字段必须从固定池中选取（开心、欢喜、愤怒、难过、紧张、平静、害羞、喜欢等）。
情绪字段不能省略，必须填写。禁止使用其他情绪词，禁止自造新词。
禁止使用以上列表之外的词汇。
</now_plot>"""


async def build():
    db = SessionLocal()
    db.commit()
    user = db.query(User).filter(User.id == USER_ID).first()
    char = db.query(Character).filter(Character.id == CHAR_ID).first()
    req = PromptAssemblyRequest(
        db=db, user=user, char=char,
        session_id=SESSION_ID, branch_id=BRANCH_ID,
        message=MESSAGE, model=MODEL,
        include_user_message=False, max_tokens=16384,
        extension_prompts=[
            {
                "identifier": "bubble-dialogue-format",
                "content": INJECTION,
                "position": 0,   # IN_PROMPT（BubbleDialogue setExtensionPrompt 真实参数）
                "depth": 0,
                "role": "system",
                "scan": False,
            }
        ],
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
    return await assemble_roleplay_prompt(req, deps)


async def main() -> None:
    assembly = await build()
    messages = assembly.messages

    # 断言 1：注入在 messages[0] 内
    m0 = messages[0]
    assert m0["role"] == "system" and "对话渲染格式规范" in (m0.get("content") or ""), \
        f"注入未进 messages[0]！role={m0['role']} head={str(m0.get('content'))[:80]!r}"
    print(f"[PASS] 注入已并入 system prompt（messages[0]，len={len(m0['content'])}）")

    # 断言 2：末尾不是注入（最后一条应仍是 user）
    last = messages[-1]
    assert "对话渲染格式规范" not in str(last.get("content", "")), \
        f"注入仍在末尾！last role={last['role']}"
    print(f"[PASS] 末尾无注入（last role={last['role']}）")

    # 断言 3：真实模型 3 次
    ok = 0
    for i in range(3):
        content_parts, reasoning_parts = [], []
        async for chunk in stream_text_completion(
            model_id=MODEL, messages=[dict(m) for m in messages], temperature=0.70,
            max_tokens=16384, timeout=120.0, user_id=USER_ID, reasoning_effort="auto",
        ):
            if chunk.get("content"):
                content_parts.append(chunk["content"])
            if chunk.get("reasoning"):
                reasoning_parts.append(chunk["reasoning"])
            if sum(len(p) for p in content_parts) > 400:
                break
        content = "".join(content_parts)
        reasoning = "".join(reasoning_parts)
        status = "OK" if content else "EMPTY"
        if content:
            ok += 1
        print(f"[{i+1}] {status} c={len(content)} r={len(reasoning)}")
        if i == 0 and content:
            print(f"head={content[:120]!r}")
    assert ok == 3, f"模型成功率 {ok}/3"
    print(f"[PASS] 模型 3/3 正常输出")


asyncio.run(main())
