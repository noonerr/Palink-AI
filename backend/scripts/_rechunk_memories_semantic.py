"""存量记忆语义重切一次性脚本（方案 B 配套）。

把历史"整段单向量"的 assistant 长记忆按语义切分重写为小块，
保留原 created_at / branch_id / session_id / importance_score。

用法（容器内执行）:
    python scripts/_rechunk_memories_semantic.py             # dry-run，只打印计划
    python scripts/_rechunk_memories_semantic.py --apply     # 实际落库
    python scripts/_rechunk_memories_semantic.py --limit 20  # 只处理前 N 条

安全机制:
    - 默认 dry-run，必须显式 --apply 才写库
    - 每行独立事务，单行失败跳过不中断
    - 切分结果只有 1 块（无需重切）时跳过该行
"""

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import text  # noqa: E402

from app.core.database import SessionLocal  # noqa: E402
from app.memory_module.config import memory_config as cfg  # noqa: E402
from app.memory_module.semantic_chunker import semantic_split  # noqa: E402
from app.memory_module.storage import _chunk_topics  # noqa: E402
from app.memory_module.embedder import embed_text  # noqa: E402
from app.utils import clean_memory_content  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description="存量记忆语义重切")
    parser.add_argument("--apply", action="store_true", help="实际落库（默认 dry-run）")
    parser.add_argument("--limit", type=int, default=0, help="最多处理 N 条（0=不限）")
    parser.add_argument("--user-id", type=int, default=None, help="只处理指定用户")
    args = parser.parse_args()

    db = SessionLocal()
    try:
        rows = db.execute(text("""
            SELECT id, user_id, session_id, branch_id, role, content,
                   importance_score, topics, tokens_count, created_at, embedding
            FROM conversation_memories
            WHERE role = 'assistant'
            ORDER BY created_at ASC
        """)).fetchall()

        targets = []
        for row in rows:
            content = row.content or ""
            if len(content) <= cfg.CHUNK_MAX_CHARS:
                continue
            topics_raw = row.topics
            topics_list = []
            try:
                topics_list = json.loads(topics_raw) if isinstance(topics_raw, str) else (topics_raw or [])
            except (json.JSONDecodeError, TypeError):
                pass
            if "#chunk" in topics_list:
                continue  # 已是切块，跳过
            if args.user_id is not None and row.user_id != args.user_id:
                continue
            targets.append(row)

        if args.limit > 0:
            targets = targets[:args.limit]

        print(f"扫描完成: assistant 总数={len(rows)}, 待重切={len(targets)}"
              f" (阈值>={cfg.CHUNK_MAX_CHARS}字), 模式={'APPLY' if args.apply else 'DRY-RUN'}")

        processed = skipped_single = failed = 0
        for row in targets:
            cleaned = clean_memory_content(row.content or "")
            chunks = semantic_split(cleaned)
            if len(chunks) <= 1:
                skipped_single += 1
                print(f"  [skip] id={row.id} len={len(row.content)} 切分后仅 1 块")
                continue

            print(f"  [{'apply' if args.apply else 'plan'}] id={row.id} "
                  f"user={row.user_id} len={len(row.content)} -> {len(chunks)} 块: "
                  + " | ".join(f"[{c[:24]}...]" for c in chunks))

            if not args.apply:
                continue

            turn_hash = hashlib.blake2b(
                (chunks[0][:64] + datetime.utcnow().isoformat()).encode("utf-8"),
                digest_size=8,
            ).hexdigest()[:12]
            total = len(chunks)
            try:
                embeddings = embed_text(chunks)
                emb_lists = [embeddings[i].tolist() for i in range(embeddings.shape[0])]
                db.execute(text("DELETE FROM conversation_memories WHERE id = :id"),
                           {"id": row.id})
                for i, chunk in enumerate(chunks):
                    db.execute(text("""
                        INSERT INTO conversation_memories
                        (user_id, session_id, branch_id, role, content, embedding,
                         importance_score, topics, tokens_count, created_at)
                        VALUES (:user_id, :session_id, :branch_id, :role, :content, :embedding,
                                :importance_score, :topics, :tokens_count, :created_at)
                    """), {
                        "user_id": row.user_id,
                        "session_id": row.session_id,
                        "branch_id": row.branch_id,
                        "role": "assistant",
                        "content": chunk,
                        "embedding": json.dumps(emb_lists[i]),
                        "importance_score": row.importance_score or 0.5,
                        "topics": json.dumps(_chunk_topics(turn_hash, i, total)),
                        "tokens_count": len(chunk) // 2,
                        "created_at": row.created_at,
                    })
                db.commit()
                processed += 1
            except Exception as exc:
                db.rollback()
                failed += 1
                print(f"  [FAIL] id={row.id}: {exc}")

        mode = "已落库" if args.apply else "dry-run 未写库"
        print(f"完成({mode}): 重切 {processed} 行, 无需切 {skipped_single}, 失败 {failed}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
