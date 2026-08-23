"""一次性脚本：全量导出 character_chat_messages 到 JSON（分离存储迁移前置备份）。

用法（在 backend 容器内执行，参照 _clean_msg_think_blocks.py 模式）：
    docker cp backend/scripts/_export_messages_backup_20260823.py palink-ai-backend-1:/tmp/
    docker exec -w /app palink-ai-backend-1 python /tmp/_export_messages_backup_20260823.py /tmp/_messages_backup_20260823.json
    docker cp palink-ai-backend-1:/tmp/_messages_backup_20260823.json _backup/20260823_separate_storage/

stdout 打印总行数 / 含内联块行数（迁移候选摸底）/ extra 带 reasoning 行数 / 文件 SHA256，
供宿主机侧校验传输完整性与迁移规模预估。
"""

import sys
import json
import hashlib
from datetime import datetime, timezone

sys.path.insert(0, "/app")

from sqlalchemy import text

from app.core.database import SessionLocal


def main() -> None:
    out_path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/_messages_backup_20260823.json"
    db = SessionLocal()
    try:
        total = db.execute(text("SELECT COUNT(*) FROM character_chat_messages")).scalar()
        rows = db.execute(
            text("SELECT * FROM character_chat_messages ORDER BY id")
        ).mappings().all()

        think_like = db.execute(
            text("SELECT COUNT(*) FROM character_chat_messages WHERE content LIKE :p"),
            {"p": "%<think%"},
        ).scalar()
        reasoning_extra = db.execute(
            text("SELECT COUNT(*) FROM character_chat_messages WHERE extra LIKE :p"),
            {"p": "%reasoning%"},
        ).scalar()

        payload = {
            "exported_at": datetime.now(timezone.utc).isoformat(),
            "table": "character_chat_messages",
            "total": int(total or 0),
            "rows": [dict(r) for r in rows],
        }
        data = json.dumps(payload, ensure_ascii=False, default=str)
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(data)
        digest = hashlib.sha256(data.encode("utf-8")).hexdigest()
        print(
            "EXPORT_OK total=%d think_like=%d extra_reasoning=%d sha256=%s path=%s"
            % (int(total or 0), int(think_like or 0), int(reasoning_extra or 0), digest, out_path)
        )
    finally:
        db.close()


if __name__ == "__main__":
    main()
