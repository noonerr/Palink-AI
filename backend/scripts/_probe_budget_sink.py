# -*- coding: utf-8 -*-
"""P93 — 「47.4% vs 71.9%」缺口归因：预算被谁吃掉了？

P92 用同一批向量的纯余弦 oracle 得到块级命中 71.9%@4000，
而走生产 MemoryService 实测只有 47.4%@4000 ⇒ 中间 24.5pp 是被生产链路吃掉。
候选嫌疑（均为可配置旋钮）：
  ① NEIGHBOR_EXPAND / NEIGHBOR_MAX_ADDS=4 / NEIGHBOR_EXTRA_RATIO=0.3
     —— 命中块的 ±邻居，2026-10-11 报告已实测它占注入 26.4% 且命中 0 提升
  ② STM（短期记忆，无条件前置的最近 5 条）—— 与问题无关但吃预算
  ③ HYBRID_WEIGHT=0.7 的关键词融合改变了排序
  ④ BLOCK_CANDIDATE_LIMIT=50 的候选池
本探针逐个关/调，用同一份 qa2 题集量块级证据命中率，定位预算黑洞。
只读、零付费（嵌入走本地 Ollama）。
"""
import asyncio
import json
import os
import sys
import time

sys.path.insert(0, "/app")
os.environ.setdefault("DATABASE_URL", "postgresql+psycopg://ai_user:ai_pass@db:5432/ai_hub")

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from app.utils import build_memory_context


async def run_pass(db, user_id, sess_id, branch_id, char_id, qa, msgs, last_ti, label):
    from app.memory_module.service import MemoryService
    svc = MemoryService(db, enable_cache=False)
    excl = [msgs[k]["id"] for k in range(max(0, last_ti - 5), len(msgs))]
    hit = 0
    vol = 0
    for item in qa:
        ctx = await svc.get_context(
            user_id=user_id, query=item["q"], session_id=sess_id,
            max_tokens=5200, memory_mode="vector",
            exclude_message_ids=excl, character_id=char_id,
            branch_scopes=[(branch_id, None)] if branch_id else [])
        txt = build_memory_context(ctx, max_tokens=5200)
        vol += len(txt) // 2
        if (item.get("evidence") or "")[:12] in txt:
            hit += 1
    db.rollback()
    print(f"  {label:<38} 块级命中={hit/len(qa)*100:5.1f}%   平均注入={vol/len(qa):.0f} 内部单位")
    return hit / len(qa)


async def main():
    db = sessionmaker(bind=create_engine(os.environ["DATABASE_URL"]))()
    from app.models.character import CharacterChatSession, CharacterChatSessionBranch, CharacterChatMessage
    from app.memory_module.config import memory_config as C

    sess = db.query(CharacterChatSession).filter(
        CharacterChatSession.id.like("f25daab6%")).first()
    b = db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.session_id == sess.id,
        CharacterChatSessionBranch.id.like("30251f44%")).first()
    rows = (db.query(CharacterChatMessage)
            .filter(CharacterChatMessage.session_id == sess.id,
                    CharacterChatMessage.branch_id == b.id)
            .order_by(CharacterChatMessage.created_at.asc(), CharacterChatMessage.id.asc()).all())
    msgs = [{"id": m.id, "role": m.role, "text": m.content or ""} for m in rows if not m.is_hidden]
    turn_idx = [i for i, m in enumerate(msgs) if m["role"] == "user"]
    last_ti = turn_idx[-1]
    qa = json.load(open("/tmp/qa2.json", encoding="utf-8"))
    char_id = str(sess.character_id)
    print(f"[data] msgs={len(msgs)} 题集={len(qa)} 预算固定 5200（=4000 主预算 + 30% 邻居额度，与生产一致）")

    print("\n" + "=" * 92)
    print("【预算黑洞归因】逐个关旋钮，看块级证据命中率怎么变")
    print("=" * 92)

    orig = {
        "NEIGHBOR_EXPAND": C.NEIGHBOR_EXPAND,
        "NEIGHBOR_MAX_ADDS": C.NEIGHBOR_MAX_ADDS,
        "NEIGHBOR_EXTRA_RATIO": C.NEIGHBOR_EXTRA_RATIO,
        "BLOCK_STM_LIMIT": C.BLOCK_STM_LIMIT,
        "HYBRID_WEIGHT": C.HYBRID_WEIGHT,
        "BLOCK_CANDIDATE_LIMIT": C.BLOCK_CANDIDATE_LIMIT,
    }
    print(f"  基线配置: {orig}")

    await run_pass(db, sess.user_id, sess.id, b.id, char_id, qa, msgs, last_ti,
                   "① 基线（生产现状）")

    C.NEIGHBOR_EXPAND = False
    await run_pass(db, sess.user_id, sess.id, b.id, char_id, qa, msgs, last_ti,
                   "② 关邻居扩展（NEIGHBOR_EXPAND=false）")
    C.NEIGHBOR_EXPAND = orig["NEIGHBOR_EXPAND"]

    C.BLOCK_STM_LIMIT = 0
    await run_pass(db, sess.user_id, sess.id, b.id, char_id, qa, msgs, last_ti,
                   "③ 关 STM（BLOCK_STM_LIMIT=0）")
    C.BLOCK_STM_LIMIT = orig["BLOCK_STM_LIMIT"]

    C.NEIGHBOR_EXPAND = False
    C.BLOCK_STM_LIMIT = 0
    await run_pass(db, sess.user_id, sess.id, b.id, char_id, qa, msgs, last_ti,
                   "④ 邻居 + STM 全关")
    C.NEIGHBOR_EXPAND = orig["NEIGHBOR_EXPAND"]; C.BLOCK_STM_LIMIT = orig["BLOCK_STM_LIMIT"]

    C.HYBRID_WEIGHT = 0.0
    await run_pass(db, sess.user_id, sess.id, b.id, char_id, qa, msgs, last_ti,
                   "⑤ 纯向量（HYBRID_WEIGHT=0）")
    C.HYBRID_WEIGHT = orig["HYBRID_WEIGHT"]

    C.BLOCK_CANDIDATE_LIMIT = 200
    await run_pass(db, sess.user_id, sess.id, b.id, char_id, qa, msgs, last_ti,
                   "⑥ 候选池 50→200")
    C.BLOCK_CANDIDATE_LIMIT = orig["BLOCK_CANDIDATE_LIMIT"]

    print("-" * 92)
    print("读法：哪一档把命中率拉回 P92 纯余弦 oracle 的 71.9%，预算就是被它吃掉的。")
    try:
        db.close()
    except Exception:
        pass


asyncio.run(main())
