# -*- coding: utf-8 -*-
"""P93b — 记忆预算扫描（走**生产真实调用路径**：MemoryService.get_context + build_memory_context）

⚠️ 作废说明：P90 曾用「大预算检索 + 自己写 render_at_budget 截断」得到 47.4%，
   该数字是**探针自身的渲染函数失真**造成的，已作废。本探针一律走
   `svc.get_context(max_tokens=B)` + `build_memory_context(max_tokens=B)`，
   与 roleplay_prompt_assembly 里的调用完全一致
   （生产还会再加 NEIGHBOR_EXTRA_RATIO=0.3 的额度，这里用 render=主预算×1.3 对齐）。

口径：
  - 块级证据命中：qa2 每题的 evidence 前 12 字是否真出现在注入文本里
  - 消息级命中  ：evidence 所在 message_id 是否出现在检索结果里（参考值 94.7%）
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
from app.memory_module.config import memory_config as C


async def sweep(db, sess, branch_id, char_id, qa, msgs, last_ti, budgets, label_prefix=""):
    from app.memory_module.service import MemoryService
    svc = MemoryService(db, enable_cache=False)
    excl = [msgs[k]["id"] for k in range(max(0, last_ti - 5), len(msgs))]
    out = []
    for B in budgets:
        # 与生产逐字对齐：get_context(max_tokens=B) → 邻居扩展(B×1.3) → build_memory_context(B×1.3)
        render = int(B * (1 + C.NEIGHBOR_EXTRA_RATIO)) if C.NEIGHBOR_EXPAND else B
        hit = msg_hit = 0
        vol = 0
        for item in qa:
            ctx = await svc.get_context(
                user_id=sess.user_id, query=item["q"], session_id=sess.id,
                max_tokens=B, memory_mode="vector",
                exclude_message_ids=excl, character_id=char_id,
                branch_scopes=[(branch_id, None)] if branch_id else [])
            txt = build_memory_context(ctx, max_tokens=render)
            vol += len(txt) // 2
            if (item.get("evidence") or "")[:12] in txt:
                hit += 1
            if item.get("src_msg_id") in {getattr(m, "message_id", None) for m in (ctx.memories or [])}:
                msg_hit += 1
        db.rollback()
        out.append((B, hit / len(qa), msg_hit / len(qa), vol / len(qa)))
        print(f"  {label_prefix}预算{B:<6} 块级命中={hit/len(qa)*100:5.1f}%  "
              f"消息级={msg_hit/len(qa)*100:5.1f}%  平均注入={vol/len(qa):.0f} 内部单位 "
              f"(≈{vol/len(qa)*1.37:.0f} 真实tok)")
    return out


async def main():
    db = sessionmaker(bind=create_engine(os.environ["DATABASE_URL"]))()
    from app.models.character import CharacterChatSession, CharacterChatSessionBranch, CharacterChatMessage

    sess = db.query(CharacterChatSession).filter(CharacterChatSession.id.like("f25daab6%")).first()
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
    print(f"[data] msgs={len(msgs)} 题集={len(qa)}  "
          f"NEIGHBOR_EXPAND={C.NEIGHBOR_EXPAND} EXTRA_RATIO={C.NEIGHBOR_EXTRA_RATIO}")

    budgets = [750, 1500, 2500, 4000, 6000, 8000, 12000]
    print("\n" + "=" * 100)
    print("【记忆预算扫描 · 生产真实路径】档位表 _MEMORY_BUDGET_LEVEL_INTERNAL_UNITS 现为 (750,4000,6000,8000)")
    print("=" * 100)
    t0 = time.time()
    base = await sweep(db, sess, b.id, char_id, qa, msgs, last_ti, budgets, "现状 ")
    print(f"  ({time.time()-t0:.0f}s)")

    print("\n  ── 关掉邻居扩展后重扫（NEIGHBOR_EXPAND=false）──")
    C.NEIGHBOR_EXPAND = False
    t0 = time.time()
    noneigh = await sweep(db, sess, b.id, char_id, qa, msgs, last_ti, budgets, "无邻居")
    print(f"  ({time.time()-t0:.0f}s)")
    C.NEIGHBOR_EXPAND = True

    print("\n" + "=" * 100)
    print("【对比：邻居扩展到底是赚是亏】")
    print("=" * 100)
    print(f"{'预算':<8}{'现状 命中':>12}{'现状 体积':>12}{'无邻居 命中':>14}{'无邻居 体积':>14}{'Δ命中':>10}{'Δ体积':>10}")
    for (B, h1, _m1, v1), (_B, h2, _m2, v2) in zip(base, noneigh):
        print(f"{B:<8}{h1*100:>11.1f}%{v1:>12.0f}{h2*100:>13.1f}%{v2:>14.0f}"
              f"{(h2-h1)*100:>9.1f}pp{(v2-v1)/max(1,v1)*100:>9.1f}%")
    print("-" * 100)
    print("注：体积单位是内部单位（len//2），×1.37 才是真实 token。")
    try:
        db.close()
    except Exception:
        pass


asyncio.run(main())
