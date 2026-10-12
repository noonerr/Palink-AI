"""清掉判据验证脚本留下的探针数据（标题含 __audit_criterion_probe__ 的会话）。"""
import sys

sys.path.insert(0, "/app")

from sqlalchemy import text

from app.core.database import SessionLocal

MARK = "__audit_criterion_probe__"


def main():
    db = SessionLocal()
    try:
        rows = db.execute(text(
            "SELECT id FROM character_chat_sessions WHERE title = :m"
        ), {"m": MARK}).fetchall()
        if not rows:
            print("no probe sessions found")
            return
        sids = [r[0] for r in rows]
        nm = db.execute(text(
            "DELETE FROM conversation_memories WHERE session_id = ANY(:s)"
        ), {"s": sids}).rowcount
        nmsg = db.execute(text(
            "DELETE FROM character_chat_messages WHERE session_id = ANY(:s)"
        ), {"s": sids}).rowcount
        nbr = db.execute(text(
            "DELETE FROM character_chat_session_branches WHERE session_id = ANY(:s)"
        ), {"s": sids}).rowcount
        nsess = db.execute(text(
            "DELETE FROM character_chat_sessions WHERE id = ANY(:s)"
        ), {"s": sids}).rowcount
        db.commit()
        print(f"cleaned probe data: sessions={nsess} branches={nbr} messages={nmsg} memories={nm}")
    finally:
        db.close()


if __name__ == "__main__":
    main()