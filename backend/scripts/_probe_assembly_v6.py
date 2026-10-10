"""探针 v6：装配层内直调 build_worldbook_context（与 assemble 同参），
打印 depth_entries 明细 + budget，确认 depth 条目是在哪一层丢的。只读。
"""
import os
import sys

sys.path.insert(0, "/app")
os.environ.setdefault("DATABASE_URL", "postgresql+psycopg://ai_user:ai_pass@db:5432/ai_hub")

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models.character import Character, CharacterChatSession
from app.models.user import User
from app.models.worldbook import WorldBookStage
from app.services.worldbook_service import build_worldbook_context

CHAR = "c44f2ae6-5922-454d-8069-06ba48dc4408"
SES = "40d9b7cc-fd8c-49dc-91de-3f4ed640c4ff"
BOOK = "0d10b4a2-113e-41fc-84a0-8679839a5dac"

eng = create_engine(os.environ["DATABASE_URL"])
S = sessionmaker(bind=eng)
db = S()
char = db.query(Character).filter(Character.id == CHAR).first()
sess = db.query(CharacterChatSession).filter(CharacterChatSession.id == SES).first()
user = db.query(User).filter(User.id == sess.user_id).first()

print("### 全部 at-depth 条目（position=4）在库里的原始状态")
for e in db.query(WorldBookStage).filter(WorldBookStage.world_book_id == BOOK).all():
    if (e.position or 4) == 4:
        print(f"  idx={e.stage_index:<3} enabled={e.enabled} const={e.constant} "
              f"depth={e.depth} order={e.order} role={e.role} "
              f"ignore_budget={getattr(e, 'ignore_budget', None)} "
              f"sel={e.selective} prob={e.probability}/{e.use_probability} "
              f"len={len(e.content or '')} t={str(e.title)[:26]!r}")

print()
print("### 装配同参调用（budget 25% / max_context_tokens 不传）")
r = build_worldbook_context(
    db=db, session_id=SES, user_id=user.id,
    recent_messages=[{"role": "user", "name": "admin", "is_user": True, "content": "现在怎么办？"}],
    character=char, chat_length=26,
    min_activations=0, min_activations_depth_max=0,
    world_info_character_strategy=1,
    world_info_depth=2, enable_recursive=False,
    world_info_budget=25.0, world_info_budget_cap=0,
)
print("  text:", len(r.text or ""), "| depth_entries:", len(r.depth_entries),
      "| budget_used:", r.budget_used)
for d, c, role in r.depth_entries:
    head = c[:70].replace("\n", "\\n")
    print(f"    depth={d} role={role} len={len(c)} :: {head}")

print()
print("### 对照：budget=100%")
r2 = build_worldbook_context(
    db=db, session_id=SES, user_id=user.id,
    recent_messages=[{"role": "user", "name": "admin", "is_user": True, "content": "现在怎么办？"}],
    character=char, chat_length=26,
    world_info_depth=2, enable_recursive=False,
    world_info_budget=100.0, world_info_budget_cap=0,
)
print("  text:", len(r2.text or ""), "| depth_entries:", len(r2.depth_entries),
      "| budget_used:", r2.budget_used)
db.close()