"""补充实验：精确定位空响应触发条件。

已知：in_chat depth=0 注入（以 </now_plot> 结尾）→ 空响应。
待验证：
  C 组：同 B 注入文本，但位置 depth=1（最后一条消息之前）
  D 组：同 B 注入文本，改为 IN_PROMPT（追加到首条 system 末尾）
  E 组：同 B 位置（最末尾），但注入文本去掉结尾的 </now_plot> 行
用法：docker exec palink-ai-backend-1 python /app/scripts/_experiment_plugin_injection2.py
"""

import asyncio
import sys

sys.path.insert(0, "/app")

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

INJECTION_NO_TAIL = INJECTION.rsplit("\n", 1)[0]  # 去掉最后的 </now_plot> 行


async def assemble_second_turn():
    db = SessionLocal()
    db.commit()
    user = db.query(User).filter(User.id == USER_ID).first()
    char = db.query(Character).filter(Character.id == CHAR_ID).first()
    req = PromptAssemblyRequest(
        db=db, user=user, char=char,
        session_id=SESSION_ID, branch_id=BRANCH_ID,
        message=MESSAGE, model=MODEL,
        include_user_message=False, max_tokens=16384,
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


async def run_group(name: str, messages: list) -> None:
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
            if sum(len(p) for p in content_parts) > 800:
                break
    except Exception as exc:
        print(f"[{name}] EXC: {type(exc).__name__}: {exc}")
    content = "".join(content_parts)
    reasoning = "".join(reasoning_parts)
    status = "OK" if content else "EMPTY"
    print(f"[{name}] {status} content_len={len(content)} reasoning_len={len(reasoning)} completion={usage.get('completion_tokens') if usage else '?'}")
    if content:
        print(f"[{name}] content_head={content[:120]!r}")


async def main() -> None:
    assembly = await assemble_second_turn()
    base = [dict(m) for m in assembly.messages]

    # C：depth=1 → 插在最后一条消息之前
    c_msgs = [dict(m) for m in base]
    c_msgs.insert(len(c_msgs) - 1, {"role": "system", "content": INJECTION})
    await run_group("C-depth1(末条之前)", c_msgs)

    # D：IN_PROMPT → 追加到首条 system 末尾
    d_msgs = [dict(m) for m in base]
    d_msgs[0] = {
        "role": "system",
        "content": (d_msgs[0].get("content") or "") + "\n\n" + INJECTION,
    }
    await run_group("D-追加system首条", d_msgs)

    # E：最末尾注入，但内容不带结尾 </now_plot>
    e_msgs = [dict(m) for m in base]
    e_msgs.insert(len(e_msgs), {"role": "system", "content": INJECTION_NO_TAIL})
    await run_group("E-末尾注入无闭合标签", e_msgs)


asyncio.run(main())
