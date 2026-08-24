"""验收终检：镜像内标签 + DB schema 迁移 + 记忆表状态。"""

import sys

sys.path.insert(0, "/app")

from sqlalchemy import text

ce = open("/app/app/api/character_ext.py", encoding="utf-8").read()
ws = open("/app/app/api/websocket.py", encoding="utf-8").read()
ss = open("/app/app/api/sessions.py", encoding="utf-8").read()
st = open("/app/memory_module/storage.py", encoding="utf-8").read() if False else open("/app/app/memory_module/storage.py", encoding="utf-8").read()

print("TAG MEM-UPSERT (>=2 each):", ce.count("MEM-UPSERT") >= 2 and ws.count("MEM-UPSERT") >= 2)
print("TAG MEM-SYNC-ON-EDIT:", ce.count("MEM-SYNC-ON-EDIT") >= 1 and ss.count("MEM-SYNC-ON-EDIT") >= 1)
print("HELPER delete_by_message_id x4:", all("delete_by_message_id" in x for x in (ce, ws, ss, st)))
print("SCHEMA code message_id INTEGER:", "message_id INTEGER" in st)

from app.core.database import SessionLocal

db = SessionLocal()
try:
    cols = [
        r[0]
        for r in db.execute(
            text(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name='conversation_memories'"
            )
        ).all()
    ]
    print("DB column message_id exists:", "message_id" in cols)
    idx = db.execute(text(
        "SELECT indexname FROM pg_indexes WHERE tablename='conversation_memories' AND indexname='idx_memory_message_id'"
    )).scalar()
    print("DB index idx_memory_message_id exists:", idx is not None)
    n = db.execute(text("SELECT COUNT(*) FROM conversation_memories")).scalar()
    print("memories now:", n)
finally:
    db.close()
