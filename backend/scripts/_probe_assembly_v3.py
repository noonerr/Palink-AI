"""探针 v3：定位 (a) 装配结果里 UpdateVariable 的来源；
(b) 世界书为何 0 命中；(c) 卡片绑定了哪些书。只读。
"""
import os
import sys

sys.path.insert(0, "/app")
os.environ.setdefault("DATABASE_URL", "postgresql+psycopg://ai_user:ai_pass@db:5432/ai_hub")

from sqlalchemy import create_engine, or_
from sqlalchemy.orm import sessionmaker

from app.models.character import Character, CharacterChatSession
from app.models.user import User
from app.models.worldbook import WorldBook, WorldBookStage
from app.services.worldbook_service import build_worldbook_context

CHAR = "c44f2ae6-5922-454d-8069-06ba48dc4408"
SES = "40d9b7cc-fd8c-49dc-91de-3f4ed640c4ff"

eng = create_engine(os.environ["DATABASE_URL"])
S = sessionmaker(bind=eng)
db = S()
char = db.query(Character).filter(Character.id == CHAR).first()
sess = db.query(CharacterChatSession).filter(CharacterChatSession.id == SES).first()
user = db.query(User).filter(User.id == sess.user_id).first()

print("### 卡绑定的世界书（character_id = 卡 id）")
books = db.query(WorldBook).filter(WorldBook.character_id == CHAR).all()
for b in books:
    n = db.query(WorldBookStage).filter(WorldBookStage.world_book_id == b.id).count()
    print(f"  id={b.id} name={b.name!r} char={b.character_id} stages={n}")

print()
print("### 该用户全部世界书")
for b in db.query(WorldBook).filter(WorldBook.user_id == user.id).all():
    n = db.query(WorldBookStage).filter(WorldBookStage.world_book_id == b.id).count()
    print(f"  id={b.id} name={b.name!r} char={b.character_id} stages={n}")

print()
print("### 直调 build_worldbook_context（参数尽量模仿 assemble）")
res = build_worldbook_context(
    db=db,
    session_id=SES,
    user_id=user.id,
    recent_messages=[{"role": "user", "name": "admin", "is_user": True, "content": "现在怎么办？"}],
    character=char,
    chat_length=4,
)
print("  text len:", len(res.text or ""))
print("  activated:", len([r for r in res.debug_report if r.status == "activated"]))
print("  depth_entries:", len(res.depth_entries))
for r in res.debug_report:
    if r.status == "activated":
        print(f"    [{r.entry_id[:8]}] src={r.lore_source} reason={r.reason} title={r.title!r}")
db.close()