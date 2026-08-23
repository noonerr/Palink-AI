"""端到端验证：修复后的完整链路（装配 + in_chat depth=0 插件注入 + 真实模型）。

模拟前端 BubbleDialogue 插件（对话渲染系统 v7.1）的真实注入形态：
  extension_prompts=[{identifier:'bubble-dialogue-format', position:1(IN_CHAT),
                      depth:0, role:'system', content:...以 </now_plot> 结尾}]
预期（修复后）：
  1. [INJ-CLOSE-TAG-GUARD] 日志出现，注入内容结尾闭合标签被剥离
  2. 最终 messages 最末尾注入不以裸闭合标签结尾
  3. 模型正常输出正文（不再空响应）

用法：docker exec palink-ai-backend-1 python /app/scripts/_verify_fix_e2e.py
"""

import asyncio
import logging
import sys

sys.path.insert(0, "/app")

logging.basicConfig(level=logging.INFO, stream=sys.stdout)

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


async def main() -> None:
    db = SessionLocal()
    db.commit()
    user = db.query(User).filter(User.id == USER_ID).first()
    char = db.query(Character).filter(Character.id == CHAR_ID).first()
    req = PromptAssemblyRequest(
        db=db,
        user=user,
        char=char,
        session_id=SESSION_ID,
        branch_id=BRANCH_ID,
        message=MESSAGE,
        model=MODEL,
        include_user_message=False,
        max_tokens=16384,
        extension_prompts=[
            {
                "identifier": "bubble-dialogue-format",
                "content": INJECTION,
                "position": 1,   # IN_CHAT
                "depth": 0,      # 紧贴最新消息（插件真实配置）
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
    assembly = await assemble_roleplay_prompt(req, deps)
    messages = assembly.messages

    # 断言 1：注入存在
    injected = [m for m in messages if "对话渲染格式规范" in str(m.get("content", ""))]
    assert injected, "注入条目丢失！"
    inj_content = injected[-1]["content"]
    # 断言 2：结尾不再以裸闭合标签行结尾
    assert not inj_content.rstrip().endswith(">") or "\n" in inj_content.rstrip(), inj_content[-60:]
    last_line = inj_content.rstrip().split("\n")[-1].strip()
    assert not last_line.startswith("</"), f"结尾仍是裸闭合标签: {last_line!r}"
    print(f"[PASS] 注入防护生效，注入条目结尾行: {last_line[:50]!r}")
    print(f"[INFO] messages 总数: {len(messages)}，注入位置 role={injected[-1]['role']}")

    # 断言 3：真实模型调用正常输出
    content_parts: list[str] = []
    reasoning_parts: list[str] = []
    async for chunk in stream_text_completion(
        model_id=MODEL, messages=messages, temperature=0.70,
        max_tokens=16384, timeout=120.0, user_id=USER_ID,
        reasoning_effort="auto",
    ):
        if chunk.get("content"):
            content_parts.append(chunk["content"])
        if chunk.get("reasoning"):
            reasoning_parts.append(chunk["reasoning"])
        if sum(len(p) for p in content_parts) > 800:
            break
    content = "".join(content_parts)
    reasoning = "".join(reasoning_parts)
    assert content, f"模型仍空响应！reasoning_len={len(reasoning)}"
    print(f"[PASS] 模型正常输出 content_len={len(content)} reasoning_len={len(reasoning)}")
    print(f"[OUT] content_head={content[:200]!r}")


asyncio.run(main())
