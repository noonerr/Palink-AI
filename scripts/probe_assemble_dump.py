"""Read-only probe: dump the REAL assembled prompt for a session.

Run inside the backend container. Does not write to DB.
"""
import asyncio
import json
import sys

sys.path.insert(0, "/app")

from app.database import SessionLocal  # noqa
from app.models import Character, CharacterChatSession, User  # noqa
from app.api.character_ext import (  # noqa
    _build_char_system_prompt,
    _replace_placeholders,
    _get_full_branch_history,
    _contains_chinese,
    _apply_plugin_regex_scripts,
    _apply_regex_scripts,
    _apply_prompt_regex_to_messages,
)
from app.services.roleplay_prompt_assembly import (  # noqa
    PromptAssemblyRequest,
    PromptAssemblyDeps,
    assemble_roleplay_prompt,
)

CHAR_ID = "7b064410-4fd8-4182-a720-840d3a3fe0e9"
SESSION_ID = "2cb171bf-ed64-487c-8c70-1f9d9395bbaa"


async def main():
    db = SessionLocal()
    try:
        char = db.query(Character).filter(Character.id == CHAR_ID).first()
        sess = db.query(CharacterChatSession).filter(CharacterChatSession.id == SESSION_ID).first()
        user = db.query(User).filter(User.id == sess.user_id).first()
        req = PromptAssemblyRequest(
            db=db, user=user, char=char, session_id=SESSION_ID, branch_id="",
            message="开始", images=[], model="deepseek-v4-flash",
            user_nickname=user.username or "用户",
            response_length=None, max_tokens=2048,
        )
        deps = PromptAssemblyDeps(
            build_system_prompt=_build_char_system_prompt,
            replace_placeholders=_replace_placeholders,
            get_full_branch_history=_get_full_branch_history,
            get_ancestor_branch_ids=lambda *a, **k: [],
            contains_chinese=_contains_chinese,
            apply_plugin_regex_scripts=_apply_plugin_regex_scripts,
            apply_regex_scripts=_apply_regex_scripts,
            apply_prompt_regex_to_messages=_apply_prompt_regex_to_messages,
        )
        res = await assemble_roleplay_prompt(req, deps)
        print("### MESSAGE ROLES IN ORDER (role | len | first 90 chars)")
        for i, m in enumerate(res.messages):
            c = m.get("content")
            c = c if isinstance(c, str) else json.dumps(c, ensure_ascii=False)
            print(f"[{i}] {m.get('role')} | {len(c)} | {c[:90]!r}")
        print("\n### LAST MESSAGE FULL TEXT")
        print(repr(res.messages[-1]))
        print("\n### SYSTEM PROMPT (messages[0]) FULL")
        print(res.messages[0].get("content"))
    finally:
        db.close()


asyncio.run(main())
