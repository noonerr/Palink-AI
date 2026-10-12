"""探针 v8：确认 assemble 内 build_worldbook_context 是否抛异常被 except 吞掉。
只读。
"""
import asyncio
import os
import sys
import traceback

sys.path.insert(0, "/app")
os.environ.setdefault("DATABASE_URL", "postgresql+psycopg://ai_user:ai_pass@db:5432/ai_hub")

from sqlalchemy import create_engine
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

_orig_wb = R.build_worldbook_context


def patched_wb(**kwargs):
    print(">>> build_worldbook_context 被调用")
    try:
        res = _orig_wb(**kwargs)
    except Exception:
        print(">>> build_worldbook_context 抛异常：")
        traceback.print_exc()
        raise
    print(f">>> 返回 text={len(res.text or '')} depth={len(res.depth_entries)} "
          f"activated={len([r for r in res.debug_report if r.status == 'activated'])}")
    for d, c, role in res.depth_entries:
        print(f"      depth={d} role={role} len={len(c)} :: {c[:56]!r}")
    return res


async def main():
    R.build_worldbook_context = patched_wb
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
    req = R.PromptAssemblyRequest(
        db=db, user=user, char=char, session_id=SES, branch_id=branch.id,
        message="", images=[], model="", user_nickname=user.username,
        response_length=None, max_tokens=None, smart_card_trigger=False,
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
    print()
    print("报告里 worldbook / error 行：")
    for it in asm.report:
        if it.key == "worldbook" or it.status == "error" or it.key == "worldbook_depth":
            print(f"  {it.key:<26} {it.status:<10} {str(it.detail)[:160]}")
    db.close()


asyncio.run(main())