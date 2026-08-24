"""用户拍板（2026-08-24）：一次性清理存量孤儿向量记忆。

判定条件：session_id 不存在于 character_chat_sessions 也不存在于 sessions
且非 st-vec:: 前缀。执行前后各打印计数。
"""

import sys

sys.path.insert(0, "/app")

from sqlalchemy import text

from app.core.database import SessionLocal

ORPHAN_WHERE = (
    "WHERE session_id NOT IN (SELECT id::text FROM character_chat_sessions) "
    "AND session_id NOT IN (SELECT id::text FROM sessions) "
    "AND session_id NOT LIKE 'st-vec::%'"
)


def main() -> None:
    db = SessionLocal()
    try:
        before = db.execute(text(f"SELECT COUNT(*) FROM conversation_memories {ORPHAN_WHERE}")).scalar()
        total_before = db.execute(text("SELECT COUNT(*) FROM conversation_memories")).scalar()
        print(f"orphan rows before: {before} (total memories: {total_before})")
        result = db.execute(text(f"DELETE FROM conversation_memories {ORPHAN_WHERE}"))
        db.commit()
        after = db.execute(text(f"SELECT COUNT(*) FROM conversation_memories {ORPHAN_WHERE}")).scalar()
        total_after = db.execute(text("SELECT COUNT(*) FROM conversation_memories")).scalar()
        print(f"deleted: {result.rowcount}; orphan rows after: {after}; total memories now: {total_after}")
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == "__main__":
    main()
