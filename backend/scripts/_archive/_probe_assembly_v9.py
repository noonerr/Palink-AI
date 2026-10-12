"""探针 v9：打印 assemble 实际传给 build_worldbook_context 的全部参数，
再逐个替换成 v6 直调能命中的值，定位让 activated 归零的那个参数。只读。
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

_orig_wb = R.build_worldbook_context
CAPTURED = []


def patched_wb(**kwargs):
    CAPTURED.append(dict(kwargs))
    return _orig_wb(**kwargs)


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
    await R.assemble_roleplay_prompt(req, deps)

    kw = CAPTURED[0]
    print("=" * 78)
    print("assemble 实际传入的参数：")
    for k in sorted(kw):
        v = kw[k]
        if k in ("db", "character", "recent_messages"):
            if k == "recent_messages":
                print(f"  {k}: len={len(v or [])}")
            continue
        print(f"  {k}: {v!r}")

    print("=" * 78)
    print("逐参数替换试验（基线 = assemble 实参）：")
    base = dict(kw)
    res = _orig_wb(**base)
    print(f"  {'baseline':<44} act={len([r for r in res.debug_report if r.status=='activated']):<3} depth={len(res.depth_entries)}")

    trials = [
        ("recent_messages=None", {"recent_messages": None}),
        ("recent_messages=[]", {"recent_messages": []}),
        ("chat_length=None", {"chat_length": None}),
        ("enable_timed_effects=False", {"enable_timed_effects": False}),
        ("trigger_type=None", {"trigger_type": None}),
        ("character_name='露缇雅'", {"character_name": "露缇雅"}),
        ("persona_description=None", {"persona_description": None}),
        ("group_chars=None", {"group_chars": None}),
        ("max_context_tokens=None", {"max_context_tokens": None}),
        ("world_info_budget=100.0", {"world_info_budget": 100.0}),
        ("world_info_budget_cap=999999", {"world_info_budget_cap": 999999}),
        ("include_names=False", {"include_names": False}),
        ("world_info_depth=999", {"world_info_depth": 999}),
    ]
    for label, over in trials:
        kw2 = dict(base)
        kw2.update(over)
        try:
            r = _orig_wb(**kw2)
        except Exception as e:
            print(f"  {label:<44} EXC {e}")
            continue
        act = len([x for x in r.debug_report if x.status == "activated"])
        print(f"  {label:<44} act={act:<3} depth={len(r.depth_entries)} text={len(r.text or '')}")
    db.close()


asyncio.run(main())