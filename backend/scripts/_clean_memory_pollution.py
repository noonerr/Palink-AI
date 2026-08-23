"""一次性脚本：清理历史脏记忆（<UpdateVariable>/<think> 功能块污染）。

背景（2026-08-18）：
- 此前 assistant 回复的 full_content 未经清洗直接写入 conversation_memories，
  <UpdateVariable>(含 <Analysis>/<JSONPatch>) 与 <thinking> 功能块整块进入记忆库。
- 修复后新写入已走 clean_memory_content()，但存量脏记录仍在，需本脚本清洗。

行为：
- 只处理 role='assistant' 的记录（脏注入源头是 assistant full_content，user 消息不动）。
- 对每条 content 运行 clean_memory_content()：
  - 清洗后为空（整条都是功能块）→ 删除该条（无剧情内容的记忆无检索价值）。
  - 清洗后内容变化 → 更新 content 并用当前嵌入模型重算 embedding（保语义一致）。
- 输出统计摘要。

用法（在 backend 容器内执行）：
    docker cp backend/scripts/_clean_memory_pollution.py palink-ai-backend-1:/tmp/
    docker exec -w /app palink-ai-backend-1 python /tmp/_clean_memory_pollution.py
"""

import sys
import json
import logging

sys.path.insert(0, "/app")

from sqlalchemy import text
from app.core.database import SessionLocal
from app.utils import clean_memory_content
from app.memory_module.embedder import embed_text

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("clean_memory_pollution")


def main() -> None:
    db = SessionLocal()
    try:
        rows = db.execute(
            text(
                "SELECT id, role, content FROM conversation_memories "
                "WHERE role = 'assistant' ORDER BY id"
            )
        ).fetchall()

        total = len(rows)
        cleaned = 0
        deleted = 0
        reembedded = 0
        unchanged = 0

        for row in rows:
            mem_id = row.id
            raw = row.content or ""
            new = clean_memory_content(raw)

            if new == raw.strip():
                unchanged += 1
                continue

            if not new.strip():
                db.execute(
                    text("DELETE FROM conversation_memories WHERE id = :id"),
                    {"id": mem_id},
                )
                deleted += 1
                logger.info("DELETED id=%d (content was all metadata)", mem_id)
                continue

            try:
                embedding = embed_text(new)
                emb_list = (
                    embedding.tolist()[0]
                    if len(embedding.shape) > 1
                    else embedding.tolist()
                )
                embedding_json = json.dumps(emb_list)
                db.execute(
                    text(
                        "UPDATE conversation_memories "
                        "SET content = :content, embedding = :embedding, "
                        "tokens_count = :tokens WHERE id = :id"
                    ),
                    {
                        "content": new,
                        "embedding": embedding_json,
                        "tokens": len(new) // 2,
                        "id": mem_id,
                    },
                )
                cleaned += 1
                reembedded += 1
                logger.info("CLEANED id=%d (embedded, %d chars)", mem_id, len(new))
            except Exception as e:
                db.rollback()
                logger.error("FAILED id=%d: %s (kept original)", mem_id, e)

        db.commit()
        logger.info(
            "SUMMARY: total=%d cleaned=%d deleted=%d reembedded=%d unchanged=%d",
            total, cleaned, deleted, reembedded, unchanged,
        )
    finally:
        db.close()


if __name__ == "__main__":
    main()