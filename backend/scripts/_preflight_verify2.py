"""复核：重切是否已执行 + 备份改写 /tmp。"""
import sys
sys.path.insert(0, "/app")
import json
from datetime import datetime

from app.core.database import SessionLocal
from sqlalchemy import text

db = SessionLocal()

stats = db.execute(text("""
    SELECT count(*) AS total,
           sum(CASE WHEN topics::text LIKE '%"​#chunk"%' OR topics::text LIKE '%"#chunk"%' THEN 1 ELSE 0 END) AS chunked,
           sum(CASE WHEN role='assistant' AND length(content) > 450 THEN 1 ELSE 0 END) AS long_assistant,
           min(created_at) AS oldest, max(created_at) AS newest
    FROM conversation_memories
""")).fetchone()
print(f"记忆总数={stats.total}, 带块标记={stats.chunked}, 长正文(>450)={stats.long_assistant}")
print(f"时间跨度: {stats.oldest} ~ {stats.newest}")

recent = db.execute(text("""
    SELECT id, session_id, created_at, length(content) AS clen,
           left(replace(content, chr(10), ' '), 60) AS head
    FROM conversation_memories
    WHERE created_at > '2026-08-22'
    ORDER BY created_at ASC LIMIT 40
""")).fetchall()
print(f"\n今天新增/变动 {len(recent)} 条:")
for r in recent:
    print(f"  id={r.id} {str(r.created_at)[5:19]} len={r.clen} [{r.head}]")

# 备份到 /tmp（避开权限问题）
rows = db.execute(text("""
    SELECT * FROM conversation_memories WHERE role='assistant'
""")).fetchall()
out = []
for row in rows:
    out.append({
        "id": row.id, "user_id": row.user_id, "session_id": row.session_id,
        "branch_id": getattr(row, "branch_id", None), "role": row.role,
        "content": row.content, "importance_score": row.importance_score,
        "topics": row.topics, "tokens_count": row.tokens_count,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "embedding": row.embedding,
    })
with open("/tmp/_memories_backup_20260822.json", "w", encoding="utf-8") as f:
    json.dump({"exported_at": datetime.utcnow().isoformat(), "count": len(out), "rows": out},
              f, ensure_ascii=False)
import os
print(f"\n备份写出: /tmp/_memories_backup_20260822.json ({os.path.getsize('/tmp/_memories_backup_20260822.json')} 字节, {len(out)} 行)")
db.close()
