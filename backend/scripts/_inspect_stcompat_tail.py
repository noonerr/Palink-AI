"""st-compat 模式下最终 messages 角色序列（确认末尾形态：user 收尾，无 system 残尾）。

同时输出每条的前 50 字符便于判断。
"""

import asyncio
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

SESSION_ID = "fba95ef7-21ca-4d66-b623-3ec4b73d6f50"
CHAR_ID = "1641066c-951b-4965-8947-14cc13d6cf51"
BRANCH_ID = "787041f7-7e33-460a-9369-fde748464db4"
USER_ID = 1
MESSAGE = "666"

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
    req = PromptAssemblyRequest(
        db=db, user=user, char=char,
        session_id=SESSION_ID, branch_id=BRANCH_ID,
        message=MESSAGE, model="deepseek-v4-flash",
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
    a = await assemble_roleplay_prompt(req, deps)
    print(f"[INFO] st_mode={getattr(user_setting, 'silly_tavern_mode', '?')!r} messages={len(a.messages)}")
    print("角色序列:")
    for i, m in enumerate(a.messages):
        c = str(m.get("content", ""))
        print(f"  [{i}] {m['role']:9s} len={len(c):5d} {c[:45]!r}")
    last = a.messages[-1]
    print(f"\n最后一条: role={last['role']} —— {'USER 收尾，正常' if last['role']=='user' else '⚠ 非 user 收尾'}")

    # 检查末尾连续 system 消息
    sys_tail = 0
    for m in reversed(a.messages):
        if m["role"] == "system":
            sys_tail += 1
        else:
            break
    print(f"末尾连续 system 消息数: {sys_tail} —— {'正常' if sys_tail == 0 else '⚠ 有 system 残尾'}")
    if sys_tail > 0:
        for m in a.messages[-sys_tail:]:
            print(f"    tail system: {str(m.get('content'))[:80]!r}")


asyncio.run(main())
