# -*- coding: utf-8 -*-
"""P91 — 向量引擎选型实测（本地 Ollama，零付费 / 零 LLM 生成）

比较候选嵌入模型在同一份真实语料 + 同一份真实题集上的：
  1) 检索质量：top1 / top3 / top10、以及"注入集合命中率"（按内部预算截断）
  2) 成本：吞吐（条/秒）、单条均值、长文本批量耗时
  3) 向量维度 / 模型体积（决定内存与 CPU 占用）

只读：不写库、不重嵌、不改任何配置。
"""
import argparse
import json
import os
import sys
import time
import urllib.request

import numpy as np

sys.path.insert(0, "/app")
os.environ.setdefault("DATABASE_URL", "postgresql+psycopg://ai_user:ai_pass@db:5432/ai_hub")
OLLAMA = os.environ.get("OLLAMA_HOST", "http://ollama:11434")

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


def ollama_embed(model, texts, batch=32):
    """调用 /api/embed，返回 (np.ndarray[n,dim], 毫秒)。"""
    out = []
    t0 = time.time()
    for i in range(0, len(texts), batch):
        chunk = texts[i:i + batch]
        payload = json.dumps({"model": model, "input": chunk}).encode("utf-8")
        req = urllib.request.Request(
            OLLAMA + "/api/embed", data=payload,
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=300) as r:
            data = json.loads(r.read().decode("utf-8"))
        out.extend(data["embeddings"])
    ms = (time.time() - t0) * 1000
    return np.array(out, dtype=np.float32), ms


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", default="bge-m3,qwen3-embedding:0.6b")
    ap.add_argument("--session", default="f25daab6")
    ap.add_argument("--branch", default="30251f44")
    ap.add_argument("--qa", default="/tmp/qa2.json")
    ap.add_argument("--limit", type=int, default=400, help="语料取最近 N 条记忆行")
    args = ap.parse_args()

    db = sessionmaker(bind=create_engine(os.environ["DATABASE_URL"]))()
    from app.models.character import CharacterChatSession, CharacterChatSessionBranch

    sess = db.query(CharacterChatSession).filter(
        CharacterChatSession.id.like(args.session + "%")).first()
    b = db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.session_id == sess.id,
        CharacterChatSessionBranch.id.like(args.branch + "%")).first()

    rows = db.execute(
        __import__("sqlalchemy").text(
            "SELECT id, message_id, content FROM conversation_memories "
            "WHERE session_id = :s ORDER BY id DESC LIMIT :n"),
        {"s": sess.id, "n": args.limit}).fetchall()
    corpus = [r[2] or "" for r in rows]
    corpus_mid = [r[1] for r in rows]
    corpus = [c for c in corpus if c.strip()]
    print(f"[data] 语料 {len(corpus)} 条，来自 session={sess.id[:8]}")

    qa = []
    if args.qa and os.path.exists(args.qa):
        qa = json.load(open(args.qa, encoding="utf-8"))
    print(f"[data] 题集 {len(qa)} 题")

    queries = [q["q"] for q in qa]
    golds = [q.get("evidence", "")[:12] for q in qa]

    models = [m.strip() for m in args.models.split(",") if m.strip()]

    print("\n" + "=" * 104)
    print("【嵌入模型实测】同一语料 / 同一题集 / 同一机器（容器内 Ollama，纯 CPU）")
    print("=" * 104)

    summary = []
    for model in models:
        try:
            tc0 = time.time()
            C, ms_c = ollama_embed(model, corpus)
            Q, ms_q = ollama_embed(model, queries)
            total_ms = (time.time() - tc0) * 1000
        except Exception as e:
            print(f"  {model}: FAILED {e}")
            continue
        dim = C.shape[1]
        # cosine
        Cn = C / (np.linalg.norm(C, axis=1, keepdims=True) + 1e-9)
        Qn = Q / (np.linalg.norm(Q, axis=1, keepdims=True) + 1e-9)
        sim = Qn @ Cn.T                      # [nq, ncorpus]

        def metrics(budget_units=None):
            """budget_units: 内部预算(len//2)，模拟注入集合；None = 纯排名指标。"""
            top1 = top3 = top10 = inj = 0
            n = len(golds)
            for i in range(n):
                order = np.argsort(-sim[i])
                hit = None
                for rank, idx in enumerate(order, start=1):
                    if golds[i] and golds[i] in corpus[idx]:
                        hit = rank
                        break
                if hit == 1: top1 += 1
                if hit and hit <= 3: top3 += 1
                if hit and hit <= 10: top10 += 1
                if budget_units:
                    used, ok = 0, False
                    for idx in order[:200]:
                        c = len(corpus[idx]) // 2
                        if used + c > budget_units:
                            continue
                        used += c
                        if golds[i] and golds[i] in corpus[idx]:
                            ok = True
                            break
                    inj += 1 if ok else 0
                else:
                    inj = None
            return top1 / n, top3 / n, top10 / n, (inj / n if inj is not None else None)

        t1, t3, t10, _ = metrics(None)
        _, _, _, inj4 = metrics(4000)
        _, _, _, inj8 = metrics(8000)
        n_chars = sum(len(c) for c in corpus)
        summary.append({
            "model": model, "dim": dim,
            "corpus_ms": ms_c, "query_ms": ms_q,
            "per_query_ms": ms_q / max(1, len(queries)),
            "kchar_per_s": (n_chars / 1000) / (ms_c / 1000),
            "top1": t1, "top3": t3, "top10": t10,
            "inj4000": inj4, "inj8000": inj8,
        })
        print(f"\n  ── {model} ──")
        print(f"     维度={dim}  语料嵌入 {ms_c:.0f}ms（{len(corpus)}条/{n_chars}字，"
              f"{summary[-1]['kchar_per_s']:.1f} 千字/秒）  查询嵌入 {ms_q:.0f}ms "
              f"（{len(queries)}条，单条 {summary[-1]['per_query_ms']:.0f}ms）")
        print(f"     top1={t1*100:.1f}%  top3={t3*100:.1f}%  top10={t10*100:.1f}%   "
              f"注入命中@4000={inj4*100:.1f}%  @8000={inj8*100:.1f}%")

    print("\n" + "=" * 104)
    print("【横向对比】")
    print("=" * 104)
    print(f"{'模型':<24}{'维度':>6}{'千字/秒':>10}{'单条查询':>10}{'top1':>8}{'top3':>8}{'注入@4000':>10}{'注入@8000':>10}")
    for s in summary:
        print(f"{s['model']:<24}{s['dim']:>6}{s['kchar_per_s']:>10.1f}{s['per_query_ms']:>9.0f}ms"
              f"{s['top1']*100:>7.1f}%{s['top3']*100:>7.1f}%{s['inj4000']*100:>9.1f}%{s['inj8000']*100:>9.1f}%")
    print("-" * 104)
    print("注：'注入命中' 按生产口径（内部预算 len//2、超限整条跳过）模拟 build_memory_context。")
    try:
        db.close()
    except Exception:
        pass


if __name__ == "__main__":
    main()
