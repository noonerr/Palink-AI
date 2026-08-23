"""起飞前安全检查 + 原始数据备份（只读 + 导出，不改库）。"""
import sys
sys.path.insert(0, "/app")
import json
from datetime import datetime

from app.core.database import SessionLocal
from sqlalchemy import text

db = SessionLocal()

# 1) 目标行统计（与 dry-run 口径一致：assistant、>450字、无 #chunk 标记）
rows = db.execute(text("""
    SELECT id, user_id, session_id, branch_id, role, content,
           importance_score, topics, tokens_count, created_at, embedding
    FROM conversation_memories
    WHERE role = 'assistant'
    ORDER BY created_at ASC
""")).fetchall()

targets = []
already_chunked = 0
for row in rows:
    content = row.content or ""
    if len(content) <= 450:
        continue
    topics_list = []
    try:
        topics_list = json.loads(row.topics) if isinstance(row.topics, str) else (row.topics or [])
    except Exception:
        pass
    if "#chunk" in topics_list:
        already_chunked += 1
        continue
    targets.append({
        "id": row.id, "user_id": row.user_id, "session_id": row.session_id,
        "branch_id": row.branch_id, "role": row.role, "content": row.content,
        "importance_score": row.importance_score, "topics": topics_list,
        "tokens_count": row.tokens_count,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "embedding": json.loads(row.embedding) if row.embedding else None,
    })

print(f"assistant 总数={len(rows)}, 待重切={len(targets)}, 已切块={already_chunked}")

# 2) 导出原始数据备份（含向量），供万一回滚用
out_path = "/app/scripts/_memories_preapply_backup_20260822.json"
with open(out_path, "w", encoding="utf-8") as f:
    json.dump({"exported_at": datetime.utcnow().isoformat(), "rows": targets},
              f, ensure_ascii=False)
print(f"备份已写出: {out_path} ({len(targets)} 行)")

# 3) 嵌入服务可用性（重切依赖 embed_text）
from app.memory_module.embedder import embed_text
import numpy as np
emb = embed_text("起飞前嵌入服务自检")
print(f"嵌入自检: 维度={emb.shape}")

# 4) 总量与体积快照
total = db.execute(text("SELECT count(*), coalesce(sum(length(content)),0) FROM conversation_memories")).fetchone()
print(f"当前记忆表: {total[0]} 行, 总内容 {total[1]} 字符")
db.close()
