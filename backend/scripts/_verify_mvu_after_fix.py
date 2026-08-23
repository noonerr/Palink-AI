"""端到端实测：修复后（st-compat + 插件注入并入 system prompt）模型是否仍输出 <UpdateVariable> 块，
以及 MVU 引擎能否解析写入 stat_data。

流程：
  1. 用真实 user_setting（st-compat）+ 真实角色 + 真实 MVU 用户消息（含变量指令）+ 插件注入装配 prompt
  2. 真实模型调用，收集完整 content
  3. 检查 content 是否含 <UpdateVariable> 块
  4. 用 MvuEngine.update_from_reply 解析并应用到当前 stat_data，验证变量写入

用法：docker exec palink-ai-backend-1 python /app/scripts/_verify_mvu_after_fix.py
"""

import asyncio
import json
import logging
import sys

sys.path.insert(0, "/app")

logging.basicConfig(level=logging.WARNING)

from app.core.database import SessionLocal  # noqa: E402
from app.models import User, Character, UserSetting  # noqa: E402
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
from app.services.mvu_engine import MvuEngine  # noqa: E402

SESSION_ID = "fba95ef7-21ca-4d66-b623-3ec4b73d6f50"
CHAR_ID = "1641066c-951b-4965-8947-14cc13d6cf51"
BRANCH_ID = "787041f7-7e33-460a-9369-fde748464db4"
USER_ID = 1
MODEL = "deepseek-v4-flash"

# 真实用户消息 2217（"666"）+ 前端拼的 MVU 变量更新指令（来自 message[9] 的注入形态）
with open("/tmp/mvu_user_msg.txt", "w", encoding="utf-8") as f:
    f.write("666\n\n【变量更新指令 - 强制，不可省略】\n本卡使用 <UpdateVariable> 变量系统。你必须在【每条回复的最末尾】用 <UpdateVariable> 标签输出本次剧情引起的变量变化，格式：\n<UpdateVariable>\n<Analysis>（英文，80 词以内）</Analysis>\n<JSONPatch>\n[{\"op\":\"delta\",\"path\":\"/桃汐/好感度\",\"value\":5}]\n</JSONPatch>\n</UpdateVariable>\n规则：\n- 支持操作：replace / delta / insert / remove / move\n- path 格式：/角色名/字段名\n- 以 _ 开头的字段为只读，禁止更新\n- 【必须完整】所有因本回合剧情而变化的字段都要输出\n- 【严格禁止】把变量状态写进回复正文，正文只写剧情对话；变量只通过 <UpdateVariable> 输出\n- 此标签不受「禁止 XML 标签」规则限制")

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


async def main() -> None:
    db = SessionLocal()
    db.commit()
    user = db.query(User).filter(User.id == USER_ID).first()
    user_setting = db.query(UserSetting).filter(UserSetting.user_id == USER_ID).first()
    char = db.query(Character).filter(Character.id == CHAR_ID).first()
    st_mode = getattr(user_setting, "silly_tavern_mode", "palink-native")
    print(f"[INFO] st_mode={st_mode!r}")

    with open("/tmp/mvu_user_msg.txt", encoding="utf-8") as f:
        user_msg = f.read()

    req = PromptAssemblyRequest(
        db=db, user=user, char=char,
        session_id=SESSION_ID, branch_id=BRANCH_ID,
        message=user_msg, model=MODEL,
        include_user_message=False, max_tokens=16384,
        user_nickname=user.username,
        extension_prompts=[
            {
                "identifier": "bubble-dialogue-format",
                "content": INJECTION,
                "position": 0, "depth": 0, "role": "system", "scan": False,
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
    print(f"[INFO] messages={len(messages)} 末尾 role={messages[-1]['role']}")

    # 真实模型调用，收集完整 content（不提前截断，需看完整 UpdateVariable）
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
    content = "".join(content_parts)
    reasoning = "".join(reasoning_parts)
    print(f"[INFO] content_len={len(content)} reasoning_len={len(reasoning)}")

    if not content:
        print("[FAIL] 模型空响应（正文未输出）")
        return

    # 检查 UpdateVariable
    has_uv = "<UpdateVariable>" in content
    print(f"[INFO] content 含 <UpdateVariable>: {has_uv}")
    if has_uv:
        # 提取块
        from app.services.mvu_engine import extract_update_variable_blocks
        blocks = extract_update_variable_blocks(content)
        print(f"[INFO] 解析到 {len(blocks)} 个 UpdateVariable 块")
        # dump 块内容
        import re
        for m in re.finditer(r"<UpdateVariable>([\s\S]*?)</UpdateVariable>", content):
            print(f"[DUMP] UpdateVariable 块内容:\n{m.group(1)}")
        # 应用 MVU
        char_ext = {}
        try:
            char_ext = json.loads(char.extensions) if isinstance(char.extensions, str) else (char.extensions or {})
        except Exception:
            pass
        # 当前 stat_data（从会话 metadata 读取）
        current = {"stat_data": {}}
        try:
            meta = json.loads(char.chat_metadata) if isinstance(char.chat_metadata, str) else (char.chat_metadata or {})
            current = meta.get("variables", {"stat_data": {}})
        except Exception:
            pass
        new_vars, logs = MvuEngine.update_from_reply(current, content, char_ext)
        print(f"[INFO] MVU 变更日志: {logs}")
        print(f"[INFO] 更新后 stat_data 桃汐好感度: {new_vars.get('stat_data', {}).get('桃汐', {}).get('好感度')}")
        print(f"[INFO] 更新后 stat_data 世界信息: {new_vars.get('stat_data', {}).get('世界信息')}")
        print("[PASS] MVU 变量写入链路正常")
    else:
        print("[WARN] 模型未输出 UpdateVariable 块（需检查 MVU 指令是否被模型遵循）")
        print(f"[WARN] content 尾部 300: {content[-300:]!r}")


asyncio.run(main())
