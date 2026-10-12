"""探针 v13：同一份装配，只把 world_info_budget 从 25 提到 100，
验证缩进修复后 depth 条目（含 <cg>）确实能进 prompt。只读，不写库。
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
from app.models.system import UserSetting
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

# 强制 budget=100%（内存 monkeypatch，不落库）
_orig_override = R._get_openai_max_context_override


def force_budget(db, session_id, user_id, char, **kw):
    return 100.0


_orig_ro = R._get_openai_max_context_override


async def run(db, char, sess, user, branch, model, budget_pct):
    # 拦截 world_info_settings 读取，直接改写 wi_budget
    import app.services.roleplay_prompt_assembly as RR

    src = RR._get_openai_max_context_override

    class _FakeUS:
        silly_tavern_settings = None

    # 简单做法：直接 monkeypatch UserSetting 查询不现实，改为构造 fake user_setting
    return None


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

    # 直接调 build_worldbook_context 模拟"预算充足"，验证 depth 通路本身是通的
    from app.services.worldbook_service import build_worldbook_context

    for pct in (25.0, 100.0):
        r = build_worldbook_context(
            db=db, session_id=SES, user_id=user.id,
            recent_messages=[{"role": "user", "name": "admin", "is_user": True, "content": "hi"}],
            character=char, chat_length=52,
            max_context_tokens=R._get_model_context_window(model),
            world_info_budget=pct, world_info_budget_cap=0,
        )
        act = len([x for x in r.debug_report if x.status == "activated"])
        cg = any("<cg" in c for _, c, _ in r.depth_entries)
        print(f"budget={pct:>5.0f}%  ctx={R._get_model_context_window(model)}  "
              f"→ 实际预算={int(R._get_model_context_window(model) * pct / 100)}  "
              f"激活={act}  depth={len(r.depth_entries)}  含<cg>规范={cg}")
        for d, c, role in r.depth_entries:
            mark = " <<< CG 规范" if "<cg" in c else ""
            print(f"      depth={d} len={len(c):<5}{mark} {c[:46]!r}")
    db.close()


asyncio.run(main())