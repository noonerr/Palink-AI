"""决定性实验：验证 BubbleDialogue 插件注入是否导致第二轮空响应。

实验设计：
  A 组（对照）：真实装配的第二轮 prompt（无插件注入）
  B 组（实验）：同 A，但模拟 BubbleDialogue 插件的 in_chat depth=0 system 注入
               （格式规则 + 情绪词约束，含 <now_plot> 标签规则）
  分别调用 stream_text_completion（deepseek-v4-flash，参数对齐真实日志），
  观察两组的 content/reasoning 行为差异。

用法：docker exec palink-ai-backend-1 python /app/scripts/_experiment_plugin_injection.py
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

# BubbleDialogue v7.1 默认注入文本（格式规则三段式 + 情绪词约束），
# 对齐插件 buildInjectionPrompt：ruleText + '\n\n' + moodText
BUBBLE_INJECTION = """[对话渲染格式规范]
当角色产生想法、进行对白、突然的反应或者有莫名的声音、奇怪的低语出现时必须严格使用以下格式（全部在同一行内）：

@bubble:角色名|情绪|[对白]

格式规则：
1. @bubble: 是固定前缀，不可更改
2. 角色名、情绪、台词之间用 | 分隔，全部在一行内
3. 角色名必须输出完整全名，不允许省略
4. 角色名是头像关联的唯一标识，每次输出必须完全一致
13. 情绪字段不能省略，必须填写

[正文标签规则]
<content> 标签外面必须包一层 <now_plot> 标签。

[背景标签规则（强制）]
场景切换时，必须在 <content> 内的正文开头输出背景标签：
- 格式: <background scene="场景名" />

输出结构：
<now_plot>
<content>
（正文内容）
</content>
</now_plot>

[情绪词约束]
对话格式中情绪字段必须从以下固定池中选取（2-3字词），禁止自造新词：
喜悦组：开心、欢喜、欣喜、愉悦、满足、幸福、甜蜜、狂喜、兴奋、雀跃、畅快、陶醉、得意、骄傲、自豪、自信
愤怒组：愤怒、暴怒、气愤、愤慨、暴躁、怨恨、敌意、恼火、窝火、生气、烦躁、烦闷
悲伤组：难过、伤心、心酸、忧伤、惆怅、失落、低落、沮丧、悲伤、心痛、悲痛、痛苦、委屈、不甘、失望、受伤、孤独、寂寞、落寞
紧张组：焦虑、紧张、不安、忐忑、担忧、慌张、焦躁、害怕、恐惧、惊恐、畏惧、胆怯、心慌、警惕、戒备
平和组：平静、淡然、冷静、沉稳、从容、坦然、淡定、温馨、舒畅、惬意、温暖、欣慰、释然、感动、感恩
害羞组：害羞、尴尬、窘迫、难堪、困惑、迷茫、疑惑、纠结、犹豫、无奈、无语
嫌弃组：厌恶、嫌弃、鄙视、反感、排斥、抗拒、不屑、冷淡、冷漠、疏离、麻木
爱恋组：喜欢、爱慕、迷恋、倾慕、宠溺、依恋、心动、认真
情绪字段不能省略，必须填写。禁止使用其他情绪词，禁止自造新词。
</now_plot>"""


async def assemble_second_turn():
    db = SessionLocal()
    try:
        db.commit()  # 重置事务状态，规避脚本环境事务关闭问题
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
    finally:
        pass  # 保持 db 打开，装配返回后关闭


async def run_group(name: str, messages: list) -> None:
    content_parts: list[str] = []
    reasoning_parts: list[str] = []
    usage = None
    print(f"\n===== [{name}] messages={len(messages)} =====")
    try:
        async for chunk in stream_text_completion(
            model_id=MODEL,
            messages=messages,
            temperature=0.70,
            max_tokens=16384,
            timeout=120.0,
            user_id=USER_ID,
            reasoning_effort="auto",
        ):
            if chunk.get("content"):
                content_parts.append(chunk["content"])
            if chunk.get("reasoning"):
                reasoning_parts.append(chunk["reasoning"])
            if chunk.get("usage"):
                usage = chunk["usage"]
            # 收流保护：正文超 1500 字符即提前结束（足以判断行为差异）
            if sum(len(p) for p in content_parts) > 1500:
                break
    except Exception as exc:
        print(f"[{name}] EXC: {type(exc).__name__}: {exc}")
    content = "".join(content_parts)
    reasoning = "".join(reasoning_parts)
    print(f"[{name}] content_len={len(content)} reasoning_len={len(reasoning)}")
    print(f"[{name}] reasoning_head={reasoning[:300]!r}")
    print(f"[{name}] reasoning_tail={reasoning[-200:]!r}")
    print(f"[{name}] content_head={content[:300]!r}")
    if usage:
        print(f"[{name}] usage={usage}")


async def main() -> None:
    assembly = await assemble_second_turn()
    base_messages = [dict(m) for m in assembly.messages]
    print("=== 装配完成（第二轮真实 prompt） ===")
    for i, m in enumerate(base_messages):
        c = m.get("content") or ""
        if isinstance(c, list):
            c = str(c)
        print(f"  [{i}] role={m.get('role')} len={len(c)}")
    # 还原 BubbleDialogue：position=in_chat(1) depth=0 role=system → 插到最末尾
    inj_messages = [dict(m) for m in base_messages]
    inj_messages.insert(len(inj_messages) - 0, {"role": "system", "content": BUBBLE_INJECTION})

    await run_group("A-无注入(对照)", base_messages)
    await run_group("B-模拟插件注入", inj_messages)


asyncio.run(main())
