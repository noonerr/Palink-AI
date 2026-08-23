"""一次性脚本：清理 character_chat_messages 中模型直接写进 content 的思维链块。

背景（2026-08-18）：
- 模型可能把思维链直接写进 content（reasoning 字段为空，content 里带
  <think>...</think> 块），此前入库未剥离 → 消息正文带思维链 → 前端显示"思维链泄露"。
- 修复后新写入已剥离（websocket.py / character_ext.py 的 [THINK-IN-CONTENT-FIX]），
  本脚本清理存量污染消息。

行为：
- 扫描 character_chat_messages 中 content 含 <think 或 <thinking 的记录。
- 剥离 <think>...</think> 块（含 <thinking>...</thinking>，大小写不敏感）。
- 剥离后为空（纯思维链无正文）→ 保留原始（避免破坏消息结构）。
- 输出统计摘要。

用法（在 backend 容器内执行）：
    docker cp backend/scripts/_clean_msg_think_blocks.py palink-ai-backend-1:/tmp/
    docker exec -w /app palink-ai-backend-1 python /tmp/_clean_msg_think_blocks.py
"""

import sys
import re
import logging

sys.path.insert(0, "/app")

from sqlalchemy import text
from app.core.database import SessionLocal

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("clean_msg_think_blocks")

_THINK_RE = re.compile(r"<think[\s\S]*?</think\s*>", re.IGNORECASE)


def main() -> None:
    db = SessionLocal()
    try:
        rows = db.execute(
            text(
                "SELECT id, content FROM character_chat_messages "
                "WHERE content LIKE '%<think%' OR content LIKE '%<thinking%' "
                "ORDER BY id"
            )
        ).fetchall()

        total = len(rows)
        cleaned = 0
        kept = 0
        failed = 0

        for row in rows:
            mid = row.id
            raw = row.content or ""
            new = _THINK_RE.sub("", raw).strip()
            if new == raw.strip():
                kept += 1
                continue
            if not new:
                # 纯思维链无正文：保留原始，避免破坏消息结构
                kept += 1
                logger.info("KEPT id=%d (pure think block, no body)", mid)
                continue
            try:
                db.execute(
                    text("UPDATE character_chat_messages SET content = :c WHERE id = :id"),
                    {"c": new, "id": mid},
                )
                cleaned += 1
                logger.info("CLEANED id=%d (%d -> %d chars)", mid, len(raw), len(new))
            except Exception as e:
                db.rollback()
                failed += 1
                logger.error("FAILED id=%d: %s", mid, e)

        db.commit()
        logger.info(
            "SUMMARY total=%d cleaned=%d kept=%d failed=%d",
            total, cleaned, kept, failed,
        )
    finally:
        db.close()


if __name__ == "__main__":
    main()