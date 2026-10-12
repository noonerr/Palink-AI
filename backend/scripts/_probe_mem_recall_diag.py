"""[P80] 记忆召回失败归因探针（只读，不改任何数据）。

目的
────
把"检索没召回"这件事**拆成可归因的四类**，避免靠猜调参：

    ABSENT           目标消息的记忆行根本不存在（题集标注错 / 该消息未入库）
    THRESHOLD_KILLED 存在，但相似度 < MIN_SIMILARITY(0.5)，被 SQL 硬过滤挡在候选池外
    TOPK_KILLED      过了阈值，但排名 > CANDIDATE_LIMIT(50)，被 top-K 截断
    IN_POOL          进了候选池（再单独看是否真的被注入）

这四类的修法完全不同（建库 / 降阈值 / 扩池 / 加查询多样性），
在区分之前调任何参数都是猜。

用法（容器内）
────────────
    MSYS_NO_PATHCONV=1 docker cp scripts/_probe_mem_recall_diag.py palink-ai-backend-1:/tmp/
    MSYS_NO_PATHCONV=1 docker cp qa2.json palink-ai-backend-1:/tmp/qa2.json
    docker exec -w /app -e PYTHONIOENCODING=utf-8 -e PYTHONPATH=/app \
        palink-ai-backend-1 python -u /tmp/_probe_mem_recall_diag.py \
        --qa /tmp/qa2.json [--session <sid>] [--limit 57] [--with-inject]

⚠️ 参数一致性（AGENTS.md 验证纪律：探针参数必须与生产调用点一致）
   生产调用点 = roleplay_prompt_assembly.py:5752-5808。本脚本开头会打印全部
   相关参数，操作者必须逐项与生产核对后再采信结论。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import time
from collections import Counter

import numpy as np
from sqlalchemy import text

from app.core.database import SessionLocal
from app.memory_module.config import memory_config
from app.memory_module.embedder import embed_text
from app.memory_module.storage import MemoryStorage

SEP = "=" * 78


def _prod_params() -> dict:
    """生产口径参数（来源：rpa:5752-5808 + memory_module/config.py）。"""
    return {
        "max_tokens(检索, 内部单位 len//2)": 4000,
        "render_tokens(渲染)": 4000 + int(4000 * memory_config.NEIGHBOR_EXTRA_RATIO),
        "memory_mode": "vector",
        "exclude_message_ids": "最近 5 条",
        "CHUNK_STRATEGY": memory_config.CHUNK_STRATEGY,
        "EFFECTIVE_CANDIDATE_LIMIT": memory_config.EFFECTIVE_CANDIDATE_LIMIT,
        "MIN_SIMILARITY": memory_config.MIN_SIMILARITY,
        "HYBRID_WEIGHT": memory_config.HYBRID_WEIGHT,
        "HYBRID_RRF_K": memory_config.HYBRID_RRF_K,
        "HYBRID_KW_CANDIDATES": memory_config.HYBRID_KW_CANDIDATES,
        "HYBRID_KW_MIN_COVERAGE": memory_config.HYBRID_KW_MIN_COVERAGE,
        "NEIGHBOR_EXTRA_RATIO": memory_config.NEIGHBOR_EXTRA_RATIO,
        "VECTOR_DIMENSION": memory_config.VECTOR_DIMENSION,
        "OLLAMA_MODEL": memory_config.OLLAMA_MODEL,
    }


def _embed(q: str) -> list:
    v = embed_text(q)
    return v.tolist()[0] if len(np.array(v).shape) > 1 else np.array(v).tolist()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--qa", required=True, help="题集 JSON（qa2.json 格式）")
    ap.add_argument("--session", default=None, help="会话 id；不传则取记忆最多的会话")
    ap.add_argument("--user", type=int, default=None)
    ap.add_argument("--limit", type=int, default=0, help="只跑前 N 题（0=全部）")
    ap.add_argument("--with-inject", action="store_true",
                    help="额外走一次 MemoryService.get_context，检查是否真的被注入")
    ap.add_argument("--ab-neighbor", action="store_true",
                    help="对 NEIGHBOR_EXPAND 做 on/off 配置对照（纯配置 A/B，不改代码）")
    args = ap.parse_args()

    db = SessionLocal()
    st = MemoryStorage(db)

    print(SEP)
    print("[P80] 记忆召回失败归因探针 —— 生产参数一致性核对（逐项对照 rpa:5752-5808）")
    print(SEP)
    for k, v in _prod_params().items():
        print(f"  {k:<36} = {v}")

    # ── 定位会话 / 用户 ──────────────────────────────────────────────
    if args.session:
        sid = args.session
        uid = args.user or db.execute(
            text("SELECT user_id FROM conversation_memories WHERE session_id=:s "
                 "GROUP BY 1 ORDER BY count(*) DESC LIMIT 1"), {"s": sid}).scalar()
    else:
        row = db.execute(text(
            "SELECT session_id, user_id, count(*) n FROM conversation_memories "
            "WHERE session_id IS NOT NULL GROUP BY 1,2 ORDER BY n DESC LIMIT 1")).first()
        if not row:
            print("库内无任何记忆行，退出"); return 1
        sid, uid = row[0], args.user or row[1]

    n_mem = db.execute(text(
        "SELECT count(*) FROM conversation_memories WHERE session_id=:s"), {"s": sid}).scalar()
    print(f"\n  会话 = {sid}\n  用户 = {uid}\n  该会话记忆行数 = {n_mem}")

    with open(args.qa, "r", encoding="utf-8") as f:
        qa = json.load(f)
    if args.limit:
        qa = qa[: args.limit]
    print(f"  题数 = {len(qa)}")

    # 生产口径的 exclude（最近 5 条消息）—— 仅 --with-inject 时用
    try:
        excl = [r[0] for r in db.execute(text(
            "SELECT id FROM character_chat_messages WHERE session_id=:s "
            "ORDER BY created_at DESC, id DESC LIMIT 5"), {"s": sid})]
    except Exception as e:
        print(f"  ⚠ 取最近消息失败（exclude 置空）: {str(e).splitlines()[0]}")
        excl = []

    # ── 逐题诊断 ─────────────────────────────────────────────────────
    print(f"\n{SEP}\n逐题诊断\n{SEP}")
    hdr = f"{'qid':>4} {'归因':<17} {'rank':>5} {'sim':>6} {'kwcov':>6} {'uniqMsg':>8} {'maxClu':>7} {'inj':>4}"
    print(hdr)
    print("-" * len(hdr))

    cls_counter = Counter()
    agg = {"on": [], "off": []}
    sims_in_pool, ranks, kills = [], [], Counter()
    svc = None
    if args.with_inject:
        from app.memory_module.service import MemoryService
        # ⚠️ **必须关缓存**：MemoryService 的缓存键（service.py:198）只含
        #    user/session/char/branch/scope/query/exclude/memory_mode/max_tokens，
        #    **不含** NEIGHBOR_EXPAND / MIN_SIMILARITY / HYBRID_WEIGHT / CANDIDATE_LIMIT。
        #    ⇒ 同一 query 在 60s TTL 内会返回旧结果，配置 A/B 会被缓存 100% 掩盖
        #    （实测：on/off 两臂输出逐字节相同）。这也是线上"改了配置没反应"的一个来源。
        svc = MemoryService(db, enable_cache=False)
        print("  ⚠ 已关闭 MemoryService 缓存（enable_cache=False），否则配置 A/B 会被掩盖")

    for item in qa:
        qid = item.get("qid")
        src = item.get("src_msg_id")
        qtext = item.get("q") or ""
        ev = (item.get("evidence") or "").strip()

        emb = _embed(qtext)
        # limit 极大 + min_similarity 取负 ⇒ 拿到**无阈值、无截断**的全量排序
        allrows = st.semantic_search(
            user_id=uid, query_embedding=emb, limit=100000,
            min_similarity=-1.0, session_id=sid,
        )

        # 目标记忆行：优先 evidence 命中，其次同 message_id 的任意行
        tgt_idx, tgt_sim, tgt_id = None, None, None
        for i, (m, s) in enumerate(allrows):
            if m.message_id == src:
                if tgt_idx is None:
                    tgt_idx, tgt_sim, tgt_id = i, s, m.id
                if ev and ev[:12] and ev[:12] in (m.content or ""):
                    tgt_idx, tgt_sim, tgt_id = i, s, m.id
                    break

        # 该消息在库里到底有没有记忆行（判断是否 ABSENT）
        has_row = db.execute(text(
            "SELECT count(*) FROM conversation_memories WHERE session_id=:s "
            "AND message_id=:m"), {"s": sid, "m": src}).scalar() or 0

        kw_pool = st.keyword_search(
            user_id=uid, query_text=qtext, limit=memory_config.HYBRID_KW_CANDIDATES,
            min_coverage=0.0, session_id=sid,
        )
        kw_cov = 0.0
        for m, cov in kw_pool:
            if m.message_id == src:
                kw_cov = max(kw_cov, cov)
                break

        top = allrows[: memory_config.EFFECTIVE_CANDIDATE_LIMIT]
        uniq = len({(m.message_id or m.id) for m, _ in top})
        if top:
            c = Counter((m.message_id or m.id) for m, _ in top)
            maxclu = max(c.values()) / len(top)
        else:
            maxclu = 0.0

        if not has_row:
            cls = "ABSENT"
        elif tgt_idx is None:
            cls = "ABSENT"          # 有行但全量排序里都没有 ⇒ 被作用域过滤掉了
        elif tgt_sim < memory_config.MIN_SIMILARITY:
            cls = "THRESHOLD_KILLED"
            kills["threshold"] += 1
        elif (tgt_idx + 1) > memory_config.EFFECTIVE_CANDIDATE_LIMIT:
            cls = "TOPK_KILLED"
            kills["topk"] += 1
        else:
            cls = "IN_POOL"
            sims_in_pool.append(tgt_sim)
        ranks.append((tgt_idx + 1) if tgt_idx is not None else -1)
        cls_counter[cls] += 1

        inj = "-"
        if args.with_inject and svc is not None:
            arms = (("on", True), ("off", False)) if args.ab_neighbor else (("on", True),)
            for tag, nb in arms:
                memory_config.NEIGHBOR_EXPAND = nb
                try:
                    ctx = asyncio.run(svc.get_context(
                        user_id=uid, query=qtext, session_id=sid,
                        max_tokens=4000, memory_mode="vector",
                        exclude_message_ids=excl or None,
                    ))
                    mems = ctx.memories or []
                    n = len(mems)
                    units = sum(m.tokens_count or (len(m.content) // 2) for m in mems)
                    ids = [(m.message_id if m.message_id is not None else m.id) for m in mems]
                    u = len(set(ids))
                    mc = (max(Counter(ids).values()) / n) if n else 0.0
                    hit = any(m.message_id == src for m in mems)
                    agg[tag].append((n, units, u, mc, hit))
                    if tag == "on":
                        inj = "Y" if hit else "N"
                        if cls == "IN_POOL" and not hit:
                            cls_counter["IN_POOL_NOT_INJECTED"] += 1
                except Exception as e:
                    if tag == "on":
                        inj = f"E:{type(e).__name__}"
                    print(f"    ⚠ get_context({tag}) 失败: {type(e).__name__}: {str(e).splitlines()[0][:80]}")
            memory_config.NEIGHBOR_EXPAND = True

        print(f"{qid:>4} {cls:<17} "
              f"{ranks[-1] if ranks[-1] > 0 else '-':>5} "
              f"{tgt_sim if tgt_sim is not None else float('nan'):>6.3f} "
              f"{kw_cov:>6.2f} {uniq:>8} {maxclu:>6.0%} {inj:>4}")

    # ── 汇总 ─────────────────────────────────────────────────────────
    print(f"\n{SEP}\n汇总（n={len(qa)}）\n{SEP}")
    for k in ("ABSENT", "THRESHOLD_KILLED", "TOPK_KILLED", "IN_POOL", "IN_POOL_NOT_INJECTED"):
        if cls_counter.get(k):
            print(f"  {k:<22} {cls_counter[k]:>4}  ({cls_counter[k]/max(len(qa),1):.1%})")

    cand = cls_counter.get("IN_POOL", 0)
    print(f"\n  候选池命中（可召回上限）        = {cand}/{len(qa)} = {cand/max(len(qa),1):.1%}")
    if sims_in_pool:
        a = np.array(sims_in_pool)
        print(f"  进池题目的 target sim           = 均值 {a.mean():.3f} / 中位 {np.median(a):.3f} / min {a.min():.3f}")
    ok = [r for r in ranks if r > 0]
    if ok:
        a = np.array(ok)
        print(f"  target 全量排名                 = 中位 {np.median(a):.0f} / 均值 {a.mean():.0f} / max {a.max()}")

    if agg["on"]:
        print(f"\n{SEP}\n配置 A/B：NEIGHBOR_EXPAND on（现状）vs off\n{SEP}")
        print(f"  {'臂':<6} {'命中率':>8} {'注入条数':>8} {'注入单位':>8} {'唯一msg':>8} {'最大单簇':>8}")
        for tag in ("on", "off"):
            rows = agg[tag]
            if not rows:
                continue
            a = np.array(rows, dtype=float)
            print(f"  {tag:<6} {a[:, 4].mean():>7.1%} {a[:, 0].mean():>8.1f} "
                  f"{a[:, 1].mean():>8.0f} {a[:, 2].mean():>8.1f} {a[:, 3].mean():>7.0%}")
        if agg["off"]:
            on, off = np.array(agg["on"], dtype=float), np.array(agg["off"], dtype=float)
            print(f"\n  关掉邻居扩展的净效果：命中 {on[:,4].mean():.1%} → {off[:,4].mean():.1%}"
                  f"（{(off[:,4].mean()-on[:,4].mean())*100:+.1f}pp），"
                  f"注入 {on[:,1].mean():.0f} → {off[:,1].mean():.0f} 单位"
                  f"（{(off[:,1].mean()/max(on[:,1].mean(),1)-1)*100:+.1f}%）")
            print("  ⚠ 若关掉后命中不降而注入量明显下降 ⇒ 邻居扩展是纯成本，可直接关。")
            print("  ⚠ 若关掉后命中下降 ⇒ 邻居在补召回，应改调 NEIGHBOR_MAX_ADDS / RADIUS 而非全关。")

    print(f"\n{SEP}\n怎么读这张表（修法完全不同，别混）\n{SEP}")
    print("""  ABSENT 占多数        → 题集标注的消息没进记忆库 / 被作用域过滤。先修入库或修题集，
                          检索侧怎么调都没用。
  THRESHOLD_KILLED 多  → MIN_SIMILARITY(0.5) 把目标挡在外面。这才是"预算没用满"的真因，
                          与预算无关。候选修法：降阈值 / 换查询构造 / 上下文锚定后重嵌。
  TOPK_KILLED 多       → 目标过了阈值但排不进前 50。修法：扩候选池 / 加查询多样性。
  IN_POOL 多但不注入   → 排序或贪婪填充的问题（RRF 权重 / 预算 / 消费顺序）。
  三者都不多           → 失败集中在"词汇鸿沟"（提问与原文无字面重合），
                          走查询扩展 / 多路查询 / HyDE，不要再去调权重与预算。""")

    db.close()
    print(f"\n{SEP}\nP80 完成（只读，未写入任何数据）\n{SEP}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
