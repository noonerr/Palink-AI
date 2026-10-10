"""探针 v17：叠加验证两个修复。
(1) 缩进修复 → text 为空时 depth 条目仍被收集
(2) in-chat 标记 → 收集到的 depth 条目不被动态裁剪二次裁掉
方法：monkeypatch 把 budget 强制为 100%，跑真实 assemble_roleplay_prompt。
只读，不写库。
"""
import asyncio
import os
import sys

sys.path.insert(0, "/app")
os.environ.setdefault("DATABASE_URL", "postgresql+psycopg://ai_user:ai_pass@db:5432/ai_hub")

from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from app.models.character import Character, CharacterChatSession, CharacterChatSessionBranch
from app.models.user import User
from app.services import roleplay_prompt_assembly as R
from app.api.character_ext import (
    _apply_plugin_regex_scripts,
    _apply_regex_scripts,
    _apply_prompt_regex_to_messages,
    _build_char_system_prompt,
    _get_full_branch_history,
    _replace_placeholders,
    _get_ancestor_branch_ids,
    _contains_chinese,
)

CHAR = "c44f2ae6-5922-454d-8069-06ba48dc4408"
SES = "40d9b7cc-fd8c-49dc-91de-3f4ed640c4ff"

# 强制 budget=100%：包一层，把装配读到的 world_info_settings 覆盖掉
_orig_override = R._get_openai_max_context_override


class _Fake:
    """冒充 UserSetting，让 _get_openai_max_context_override 之外读不到 25%"""


async def main():
    eng = create_engine(os.environ["DATABASE_URL"])
    S = sessionmaker(bind=eng)
    db = S()
    char = db.query(Character).filter(Character.id == CHAR).first()
    sess = db.query(CharacterChatSession).filter(CharacterChatSession.id == SES).first()
    user = db.query(User).filter(User.id == sess.user_id).first()
    branch = (
        db.query(CharacterChatSessionBranch)
        .filter(CharacterChatSessionBranch.session_id == SES)
        .first()
    )
    model = db.execute(
        text(
            "SELECT model FROM character_chat_messages WHERE session_id = :s "
            "AND role='assistant' AND model IS NOT NULL ORDER BY created_at DESC LIMIT 1"
        ),
        {"s": SES},
    ).scalar()

    # 拦截 build_worldbook_context，把 budget 改成 100%
    _orig_wb = R.build_worldbook_context

    def wb100(**kwargs):
        kwargs["world_info_budget"] = 100.0
        return _orig_wb(**kwargs)

    R.build_worldbook_context = wb100

    req = R.PromptAssemblyRequest(
        db=db, user=user, char=char, session_id=SES, branch_id=branch.id,
        message="", images=[], model=model, user_nickname=user.username,
        response_length=None, max_tokens=2048, smart_card_trigger=False,
        smart_card_context=None, context_template_name=None, include_user_message=False,
    )
    deps = R.PromptAssemblyDeps(
        build_system_prompt=_build_char_system_prompt,
        replace_placeholders=_replace_placeholders,
        get_full_branch_history=_get_full_branch_history,
        get_ancestor_branch_ids=_get_ancestor_branch_ids,
        contains_chinese=_contains_chinese,
        apply_plugin_regex_scripts=_apply_plugin_regex_scripts,
        apply_regex_scripts=_apply_regex_scripts,
        apply_prompt_regex_to_messages=_apply_prompt_regex_to_messages,
    )
    asm = await R.assemble_roleplay_prompt(req, deps)
    print("=" * 74)
    print("budget=100% 下的真实装配结果")
    print("=" * 74)
    joined = "\n".join(
        m.get("content") if isinstance(m.get("content"), str) else str(m.get("content"))
        for m in asm.messages
    )
    for probe in ("<cg", "插图触发", "变量输出格式", "变量更新规则", "UpdateVariable"):
        print(f"  prompt 含 {probe!r}: {probe in joined}")
    print()
    print("最终 messages:", len(asm.messages))
    for i, m in enumerate(asm.messages):
        c = m.get("content")
        c = c if isinstance(c, str) else str(c)
        inject = " ★in-chat注入" if m.get("_palink_in_chat_injection") else ""
        print(f"  [{i}] {m.get('role'):<9} len={len(c):<5}{inject} {c[:50]!r}")
    print()
    for it in asm.report:
        if it.key in ("worldbook", "depth_prompt", "worldbook_depth", "dynamic_ordering"):
            print(f"  {it.key:<18} {it.status:<10} {str(it.detail)[:100]}")
    db.close()


asyncio.run(main())