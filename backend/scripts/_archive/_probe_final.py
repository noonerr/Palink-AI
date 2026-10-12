"""探针 v12：端到端 —— 用真实模型名跑装配，看 <cg>/MVU 规范是否进 prompt。只读。
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

_orig_wb = R.build_worldbook_context


def patched_wb(**kwargs):
    r = _orig_wb(**kwargs)
    print(f"[WB] max_context_tokens={kwargs.get('max_context_tokens')} "
          f"budget%={kwargs.get('world_info_budget')} "
          f"→ 激活={len([x for x in r.debug_report if x.status == 'activated'])} "
          f"depth={len(r.depth_entries)} text={len(r.text or '')}")
    for d, c, role in r.depth_entries:
        flag = "CG!" if "<cg" in c else ""
        print(f"      depth={d} role={role} len={len(c):<5} {flag} {c[:52]!r}")
    return r


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
    model = db.execute(
        text(
            "SELECT model FROM character_chat_messages WHERE session_id = :s "
            "AND role='assistant' AND model IS NOT NULL ORDER BY created_at DESC LIMIT 1"
        ),
        {"s": SES},
    ).scalar()
    print("真实模型:", model)
    print("=" * 78)

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
    print("=" * 78)
    joined = "\n".join(
        m.get("content") if isinstance(m.get("content"), str) else str(m.get("content"))
        for m in asm.messages
    )
    print("最终 messages:", len(asm.messages))
    for probe in ("<cg", "插图触发", "变量输出格式", "UpdateVariable", "变量更新规则"):
        print(f"  prompt 含 {probe!r}: {probe in joined}")
    print()
    for it in asm.report:
        if it.key in ("worldbook", "depth_prompt", "worldbook_depth", "dynamic_ordering", "mvu_user_tail"):
            print(f"  {it.key:<20} {it.status:<10} {str(it.detail)[:110]}")
    db.close()


asyncio.run(main())