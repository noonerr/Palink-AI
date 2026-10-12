"""探针 v4：bisect 装配层参数，找出「直调 12 条 vs 装配 0 条」的差异源。
同时打印装配默认值与卡片原始 character_book 的对照。只读。
"""
import json
import os
import sys

sys.path.insert(0, "/app")
os.environ.setdefault("DATABASE_URL", "postgresql+psycopg://ai_user:ai_pass@db:5432/ai_hub")

from sqlalchemy import create_engine
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
print("session.character_id =", repr(sess.character_id), "| char.id =", repr(char.id))
print("match:", sess.character_id == char.id)
print()

base = dict(
    db=db,
    session_id=SES,
    user_id=user.id,
    recent_messages=[{"role": "user", "name": "admin", "is_user": True, "content": "现在怎么办？"}],
    character=char,
    chat_length=4,
)


def run(label, **over):
    kw = dict(base)
    kw.update(over)
    r = build_worldbook_context(**kw)
    act = [x for x in r.debug_report if x.status == "activated"]
    trimmed = [x for x in r.debug_report if x.status == "trimmed"]
    errs = [(x.status, x.reason) for x in r.debug_report if x.status not in ("activated", "trimmed", "skipped")]
    print(f"{label:<52} activated={len(act):<3} trimmed={len(trimmed):<3} "
          f"depth={len(r.depth_entries):<3} text_len={len(r.text or '')} errs={errs[:2]}")
    return r


run("baseline(全部装配默认)")
run("world_info_depth=None", world_info_depth=None)
run("world_info_depth=4", world_info_depth=4)
run("world_info_depth=999", world_info_depth=999)
run("budget=100%", world_info_budget=100.0)
run("budget=25%(默认)", world_info_budget=25.0)
run("include_names=False", world_info_include_names=False)
run("max_context_tokens=200000", max_context_tokens=200000)

print()
print("### 用户 world_info_settings（装配里 4638-4700 读的就是它）")
from app.models.user import UserSetting

us = db.query(UserSetting).filter(UserSetting.user_id == user.id).first()
wis = {}
if us is not None:
    raw = getattr(us, "world_info_settings", None) or "{}"
    try:
        wis = json.loads(raw) if isinstance(raw, str) else dict(raw)
    except Exception as e:
        print("  parse fail:", e)
for k in sorted(wis):
    print(f"  {k} = {wis[k]!r}")

print()
print("### 卡片原始 character_book 条目（前 25 条关键字段）")
raw = char.palink_raw_card_data
try:
    data = json.loads(raw) if isinstance(raw, str) else (raw or {})
except Exception as e:
    print("  card json parse fail:", e, "| len =", len(raw or ""))
    data = {}
book = (data.get("data") or {}).get("character_book") or data.get("character_book") or {}
entries = book.get("entries") or []
print("  character_book entries:", len(entries))
for e in entries[:25]:
    print(f"    idx={e.get('order')} enabled={e.get('enabled')} const={e.get('constant')} "
          f"pos={e.get('position')} depth={e.get('depth')} sel={e.get('selective')} "
          f"keys={str(e.get('keys'))[:30]} t={str(e.get('comment'))[:28]!r} len={len(e.get('content') or '')}")
db.close()