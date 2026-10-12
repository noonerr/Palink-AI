"""探针 v5：打印真实装配报告**全量**，确认 worldbook depth 条目到底有没有进 messages。
只读，不写库。
"""
import asyncio
import os
import sys

sys.path.insert(0, "/app")
os.environ.setdefault("DATABASE_URL", "postgresql+psycopg://ai_user:ai_pass@db:5432/ai_hub")

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models.character import Character, CharacterChatSession, CharacterChatSessionBranch
from app.models.user import User
from app.services.roleplay_prompt_assembly import (
    PromptAssemblyDeps,
    PromptAssemblyRequest,
    assemble_roleplay_prompt,
)
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
    req = PromptAssemblyRequest(
        db=db, user=user, char=char, session_id=SES, branch_id=branch.id,
        message="", images=[], model="", user_nickname=user.username,
        response_length=None, max_tokens=None, smart_card_trigger=False,
        smart_card_context=None, context_template_name=None, include_user_message=False,
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
    asm = await assemble_roleplay_prompt(req, deps)
    print("=" * 78)
    print("装配报告全量：", len(asm.report), "条 / messages:", len(asm.messages))
    print("=" * 78)
    for it in asm.report:
        d = f"{it.key:<34} {it.status:<12} {str(it.detail)[:150]}"
        print(" ", d)
    print("=" * 78)
    print("messages 概览：")
    for i, m in enumerate(asm.messages):
        c = m.get("content")
        c = c if isinstance(c, str) else str(c)
        print(f"  [{i:02d}] {m.get('role'):<9} len={len(c)}")
    db.close()


asyncio.run(main())