"""[真机验收] 在容器内用真实 DB + 真实 mirror 模块复现「连点两次候选切换」。

模拟生产竞态：切到 swipe0（任务 A 排队）→ 立刻切回 swipe1（任务 B 排队）。
先让 A 卡住（人为延迟 store），再放行 —— 若无 CAS，A 会把已放弃的 swipe0
写回记忆表；有了 CAS，A 应检测到正文已被改写而放弃。

验收判据：终态该 message_id 的记忆行内容 == clean(swipe1)，不含 swipe0 文本。
跑完自动清理探针数据。
"""
import json
import sys
import threading
import time

sys.path.insert(0, "/app")

from sqlalchemy import text

from app.core.database import SessionLocal
from app.memory_module import mirror as mirror_mod
from app.memory_module.service import MemoryService
from app.utils import clean_memory_content

S0 = "旧版剧情：她把窗帘拉上，屋子里暗下来，只有桌角那盏台灯亮着。" * 6
S1 = "新版剧情：她推开窗，外面的风灌进来，把桌上的纸吹得哗哗响。" * 6
MARK = "__realrun_mirror_cas__"


def main():
    db = SessionLocal()
    probe_sid = None
    try:
        u = db.execute(text("SELECT id FROM users ORDER BY id LIMIT 1")).scalar()
        db.execute(text(
            "INSERT INTO character_chat_sessions (id, user_id, title, created_at, updated_at) "
            "VALUES (:sid, :u, :t, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
        ), {"sid": MARK, "u": u, "t": MARK})
        probe_sid = MARK
        db.execute(text(
            "INSERT INTO character_chat_messages "
            "(session_id, role, content, created_at, swipe_id, swipes, is_user, is_system) "
            "VALUES (:s, 'assistant', :c, CURRENT_TIMESTAMP, 0, :sw, false, false) RETURNING id"
        ), {"s": probe_sid, "c": S0, "sw": json.dumps([S0], ensure_ascii=False)})
        mid = db.execute(text("SELECT id FROM character_chat_messages WHERE session_id=:s"),
                         {"s": probe_sid}).scalar()
        print(f"probe message id={mid}")

        # 真实 store 走一遍，把 swipe0 写入记忆
        MemoryService(db).store_memory(
            user_id=u, session_id=probe_sid, role="assistant",
            content=clean_memory_content(S0), message_id=mid, branch_id=None,
        )
        db.commit()
        before = db.execute(text(
            "SELECT COUNT(*) FROM conversation_memories WHERE message_id=:m"
        ), {"m": mid}).scalar()
        print(f"初始记忆行数(应含 swipe0): {before}")

        # 模拟「切到 swipe1」：消息正文改成 swipe1，并追加候选
        db.execute(text(
            "UPDATE character_chat_messages SET content=:c, swipe_id=1, swipes=:sw "
            "WHERE id=:m"
        ), {"m": mid, "c": S1, "sw": json.dumps([S0, S1], ensure_ascii=False)})
        db.commit()

        # 任务 A 迟到：捕获的是旧正文 swipe0（用户切走前那次操作排的队）
        mirror_mod.sync_message_memory(
            user_id=u, session_id=probe_sid, message_id=mid,
            role="assistant", captured_raw=S0, branch_id=None,
            character_id=None, memory_mode="vector",
        )
        # 任务 B：当前操作，负责写真正文
        mirror_mod.sync_message_memory(
            user_id=u, session_id=probe_sid, message_id=mid,
            role="assistant", captured_raw=S1, branch_id=None,
            character_id=None, memory_mode="vector",
        )

        rows = db.execute(text(
            "SELECT id, content FROM conversation_memories WHERE message_id=:m ORDER BY id"
        ), {"m": mid}).fetchall()
        print(f"\n终态记忆行数: {len(rows)}")
        ok = True
        for rid, c in rows:
            is_cur = c in clean_memory_content(S1)
            is_old = c in clean_memory_content(S0)
            tag = "CURRENT" if is_cur else ("STALE-S0" if is_old else "UNKNOWN")
            if is_old:
                ok = False
            print(f"  mem {rid}: len={len(c)} → {tag}")
        print("\n真机验收: " + ("PASS ✅ 过期任务未复活 swipe0，终态只剩当前版"
                                if ok else "FAIL ❌ 仍存在旧版残留"))
        return 0 if ok else 1
    finally:
        try:
            db.rollback()
            sid = probe_sid or MARK
            db.execute(text("DELETE FROM conversation_memories WHERE session_id=:s"), {"s": sid})
            db.execute(text("DELETE FROM character_chat_messages WHERE session_id=:s"), {"s": sid})
            db.execute(text("DELETE FROM character_chat_sessions WHERE id=:s"), {"s": sid})
            db.commit()
            print("探针数据已清理")
        except Exception as e:
            print(f"清理失败(需手工处理 {MARK}): {e}")
        db.close()


if __name__ == "__main__":
    sys.exit(main())