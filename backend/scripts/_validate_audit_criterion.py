"""验证 _audit_memory_mirror 的判据能真正识别 STALE（防假阴性）。

用一次性事务造「当前=swipe1，但记忆里留了 swipe0 的块」的场景，跑 audit()
断言它被标成 STALE；随后整体回滚，不污染生产数据。
"""
import json
import sys

sys.path.insert(0, "/app")
sys.path.insert(0, "/app/scripts")

from sqlalchemy import text

from app.core.database import SessionLocal
from app.models import CharacterChatMessage, CharacterChatSession
from app.utils import clean_memory_content

from _audit_memory_mirror import audit

S0 = "第一版：她抬头看了看窗外的雨，然后轻声说今天不想出门，只想窝在沙发上。" * 3
S1 = "第二版：她把书合上放在床头，拉过被子盖住肩膀，闭上眼睛准备睡觉。" * 3


def main():
    db = SessionLocal()
    try:
        u = db.execute(text("SELECT id FROM users ORDER BY id LIMIT 1")).scalar()
        sess = CharacterChatSession(user_id=u, title="__audit_criterion_probe__")
        db.add(sess)
        db.flush()
        msg = CharacterChatMessage(
            session_id=sess.id, branch_id=None, role="assistant",
            content=S1, is_user=False, is_system=False,
            swipe_id=1, swipes=json.dumps([S0, S1], ensure_ascii=False),
        )
        db.add(msg)
        db.flush()
        mid = msg.id
        # 故意写入「属于已放弃的 swipe0」的块
        db.execute(text(
            "INSERT INTO conversation_memories "
            "(user_id, session_id, branch_id, role, content, embedding, "
            " importance_score, topics, tokens_count, created_at, message_id) "
            "VALUES (:u, :s, NULL, 'assistant', :c, NULL, 0.5, '[]', 0, CURRENT_TIMESTAMP, :m)"
        ), {"u": u, "s": sess.id, "c": clean_memory_content(S0)[:120], "m": mid})
        # 再写入一条当前版的块作为对照
        db.execute(text(
            "INSERT INTO conversation_memories "
            "(user_id, session_id, branch_id, role, content, embedding, "
            " importance_score, topics, tokens_count, created_at, message_id) "
            "VALUES (:u, :s, NULL, 'assistant', :c, NULL, 0.5, '[]', 0, CURRENT_TIMESTAMP, :m)"
        ), {"u": u, "s": sess.id, "c": clean_memory_content(S1)[:120], "m": mid})
        db.commit()

        res = audit(db, verbose=False)
        mine = [x for x in res if x[1] == mid]
        verdicts = sorted(x[2] for x in mine)
        print(f"probe msg={mid} verdicts={verdicts}")
        ok = verdicts == ["CURRENT", "STALE"]
        print("判据验证：" + ("PASS ✅ 能识别 STALE" if ok else "FAIL ❌ 判据失灵"))
        if not ok:
            for x in mine:
                print("   ", x)
        return 0 if ok else 1
    finally:
        # 回滚：不留下探针数据
        db.rollback()
        db.close()


if __name__ == "__main__":
    sys.exit(main())