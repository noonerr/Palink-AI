"""复核 Step0/1 报告的 DB 声明（用后即删）。"""
import sys
sys.path.insert(0, "/app")
from app.core.database import SessionLocal
from sqlalchemy import text

db = SessionLocal()
r = db.execute(text("""
    SELECT count(*) AS total,
           sum(CASE WHEN content LIKE '%<think>%' OR content LIKE '%</think>%' THEN 1 ELSE 0 END) AS inline_think,
           sum(CASE WHEN extra LIKE '%\"reasoning\"%' THEN 1 ELSE 0 END) AS with_reasoning
    FROM character_chat_messages WHERE role='assistant'
""")).fetchone()
print(f"assistant 总数={r.total}, 内联think={r.inline_think}, extra含reasoning={r.with_reasoning}")
rows = db.execute(text("""
    SELECT id, length(content) AS clen FROM character_chat_messages
    WHERE role='assistant' AND (content LIKE '%<think>%' OR content LIKE '%</think>%')
""")).fetchall()
for row in rows:
    print(f"  含think行: id={row.id} len={row.clen}")
db.close()
