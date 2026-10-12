"""探针 v7：把 _collect_prompt_sources 的分类结果打出来，
看 depth 注入后的消息在裁剪前被识别成什么 identifier / priority / trimmable。只读。
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

_orig_collect = R._collect_prompt_sources


def patched_collect(messages, char):
    srcs = _orig_collect(messages, char)
    print("=" * 78)
    print("裁剪前 _collect_prompt_sources →", len(srcs), "个 source / messages:", len(messages))
    for s in srcs:
        c = s.content if isinstance(s.content, str) else str(s.content)
        flags = []
        if "<cg" in c:
            flags.append("CG")
        if "UpdateVariable" in c or "mvu_update" in c or "变量输出格式" in c:
            flags.append("MVU")
        print(f"  idx={s.message_index:<3} id={s.identifier:<22} prio={s.priority:<4} "
              f"trim={str(s.trimmable):<5} tok={s.token_count:<6} {','.join(flags):<8} "
              f"{c[:44]!r}")
    print("=" * 78)
    return srcs


async def main():
    R._collect_prompt_sources = patched_collect
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
    print("最终 messages:", len(asm.messages))
    joined = "\n".join(
        m.get("content") if isinstance(m.get("content"), str) else str(m.get("content"))
        for m in asm.messages
    )
    for probe in ("<cg", "UpdateVariable", "变量输出格式", "插图触发"):
        print(f"  最终 prompt 含 {probe!r}: {probe in joined}")
    db.close()


asyncio.run(main())