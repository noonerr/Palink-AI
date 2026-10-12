"""离线端到端探针 v2：走真实装配入口 assemble_roleplay_prompt，
用真实 history / system prompt builder，追踪 <UpdateVariable> / <cg>
规范条目最终是否抵达发给模型的 messages。只读，不写库。
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
    hist = _get_full_branch_history(db, SES, branch.id, limit=60)
    print("char:", char.name, "| branch:", branch.id, "| history:", len(hist))

    req = PromptAssemblyRequest(
        db=db,
        user=user,
        char=char,
        session_id=SES,
        branch_id=branch.id,
        message="",
        images=[],
        model="",
        user_nickname=user.username,
        response_length=None,
        max_tokens=None,
        smart_card_trigger=False,
        smart_card_context=None,
        context_template_name=None,
        include_user_message=False,
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
    msgs = asm.messages
    print("=" * 70)
    print("messages:", len(msgs))
    joined = "\n".join(
        m.get("content") if isinstance(m.get("content"), str) else str(m.get("content"))
        for m in msgs
    )
    for probe in ("UpdateVariable", "<cg", "<CG", "mvu_update", "JSON Patch", "cg_open"):
        print(f"  contains {probe!r}: {probe in joined}")
    print("=" * 70)
    for i, m in enumerate(msgs):
        c = m.get("content")
        c = c if isinstance(c, str) else str(c)
        flags = []
        if "UpdateVariable" in c:
            flags.append("UpdateVariable")
        if "<cg" in c:
            flags.append("CG")
        if "mvu_update" in c:
            flags.append("mvu_update")
        head = c[:80].replace("\n", "\\n")
        print(f"[{i:02d}] {m.get('role'):<9} len={len(c):<6} {','.join(flags):<26} {head}")

    print("=" * 70)
    print("assembly report (worldbook / depth related):")
    for item in getattr(asm, "report", []) or []:
        s = f"{item.kind if hasattr(item, 'kind') else '?'}"
        line = " | ".join(str(getattr(item, f, "")) for f in item.__dataclass_fields__)
        if "depth" in line.lower() or "worldbook" in line.lower() or "UpdateVariable" in line:
            print("  ", line[:220])
    db.close()


asyncio.run(main())