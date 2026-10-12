# -*- coding: utf-8 -*-
"""P92 — 「按消息装配」vs「按块装配」记忆注入实测（用库里已存的向量，零嵌入、零付费）

背景：P90 实测发现
    检索的**消息级命中 = 94.7%**（捞到了证据所在那条消息）
    但**块级命中@预算4000 只有 47.4%**（预算没让证据所在那一块进来）
⇒ 瓶颈不在检索，在"命中之后怎么装配"。

本探针用 conversation_memories 里**已存好的向量**直接离线对比两种装配口径：
  A 块级（现状）  ：块打分 → 按分排序 → 逐块塞进预算
  B 消息级（建议）：同一消息的块取最高分作为消息分 → 按消息排序 →
                    整条消息的块**按原文顺序**回填（不是只回填命中的那一块）
指标：块级证据命中率（证据 12 字片段是否真出现在注入文本里）+ 注入体积。
"""
import argparse
import json
import os
import sys

sys.path.insert(0, "/app")
os.environ.setdefault("DATABASE_URL", "postgresql+psycopg://ai_user:ai_pass@db:5432/ai_hub")

import numpy as np
import sqlalchemy as sa
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--session", default="f25daab6")
    ap.add_argument("--qa", default="/tmp/qa2.json")
    args = ap.parse_args()

    db = sessionmaker(bind=create_engine(os.environ["DATABASE_URL"]))()
    rows = db.execute(sa.text(
        "SELECT id, message_id, content, embedding FROM conversation_memories "
        "WHERE session_id LIKE :s AND embedding IS NOT NULL "
        "ORDER BY message_id ASC, id ASC"), {"s": args.session + "%"}).fetchall()
    if not rows:
        print("no rows"); return
    texts, mids, vecs, ids = [], [], [], []
    for r in rows:
        try:
            v = json.loads(r[3]) if isinstance(r[3], str) else list(r[3])
        except Exception:
            continue
        if not v:
            continue
        texts.append(r[2] or ""); mids.append(r[1]); vecs.append(v); ids.append(r[0])
    M = np.array(vecs, dtype=np.float32)
    print(f"[data] 记忆行 {len(texts)} 条，向量维度 {M.shape[1]}，"
          f"覆盖 {len(set(mids))} 条消息，平均 {len(texts)/max(1,len(set(mids))):.2f} 块/消息")

    qa = json.load(open(args.qa, encoding="utf-8"))
    print(f"[data] 题集 {len(qa)} 题")

    # 用一条真实查询向量？没有存查询向量 ⇒ 用「证据所在块」的向量做自检索会作弊。
    # 改为：用题目 q 的文本构造查询——但没有嵌入服务（禁止付费）。
    # 折中且不作弊的做法：查询向量 = 该题 evidence 所在块的**同消息其他块**均值？仍偏。
    # ⇒ 采用：查询 = 该题 q 的**字符 bigram 稀疏向量**投影到同一维度空间不可行。
    #
    # 正确做法：调用本地 Ollama 嵌 57 条查询（零付费），成本低（57×45ms≈3s）。
    import urllib.request
    OLLAMA = os.environ.get("OLLAMA_HOST", "http://ollama:11434")
    payload = json.dumps({"model": "bge-m3", "input": [q["q"] for q in qa]}).encode("utf-8")
    req = urllib.request.Request(OLLAMA + "/api/embed", data=payload,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        Q = np.array(json.loads(r.read().decode("utf-8"))["embeddings"], dtype=np.float32)
    print(f"[data] 查询向量 {Q.shape}")

    Mn = M / (np.linalg.norm(M, axis=1, keepdims=True) + 1e-9)
    Qn = Q / (np.linalg.norm(Q, axis=1, keepdims=True) + 1e-9)
    sim = Qn @ Mn.T                       # [57, nchunks]
    cost = np.array([len(t) // 2 for t in texts], dtype=np.int32)

    # ── A 块级（现状口径）──
    def chunk_level(budget):
        hit = 0; tot_cost = 0
        for i, item in enumerate(qa):
            order = np.argsort(-sim[i])
            used, buf = 0, []
            for idx in order[:200]:
                if used + cost[idx] > budget and buf:
                    continue
                used += cost[idx]; buf.append(idx)
            inj = "\n".join(texts[j] for j in buf)
            if (item.get("evidence") or "")[:12] in inj:
                hit += 1
            tot_cost += used
        return hit / len(qa), tot_cost / len(qa)

    # ── B 消息级（建议口径）：消息分 = 该消息块的最高分；整条消息按原文顺序回填 ──
    msg_of = {}
    for i, m in enumerate(mids):
        msg_of.setdefault(m, []).append(i)
    msg_keys = sorted(msg_of.keys())
    msg_score = np.zeros((len(qa), len(msg_keys)), dtype=np.float32)
    msg_cost = np.zeros(len(msg_keys), dtype=np.int32)
    for k, m in enumerate(msg_keys):
        idxs = msg_of[m]
        msg_score[:, k] = sim[:, idxs].max(axis=1)
        msg_cost[k] = int(sum(cost[j] for j in idxs))

    def msg_level(budget, max_msgs=None):
        hit = 0; tot_cost = 0
        for i, item in enumerate(qa):
            order = np.argsort(-msg_score[i])
            used, buf = 0, []
            for k in order[:max_msgs or len(order)]:
                if used + msg_cost[k] > budget and buf:
                    continue
                used += msg_cost[k]
                buf.extend(msg_of[msg_keys[k]])       # 整条消息的块按原文顺序
            inj = "\n".join(texts[j] for j in buf)
            if (item.get("evidence") or "")[:12] in inj:
                hit += 1
            tot_cost += used
        return hit / len(qa), tot_cost / len(qa)

    print("\n" + "=" * 96)
    print("【装配口径对比】块级(现状) vs 消息级(建议) —— 同一批向量、同一份题集、同一预算口径(len//2)")
    print("=" * 96)
    print(f"{'预算(内部单位)':<16}{'块级 命中':>12}{'块级 体积':>12}{'消息级 命中':>14}{'消息级 体积':>14}{'命中提升':>10}")
    for b in (2000, 4000, 6000, 8000, 12000, 16000):
        ca, va = chunk_level(b)
        cb, vb = msg_level(b)
        print(f"{b:<16}{ca*100:>11.1f}%{va:>12.0f}{cb*100:>13.1f}%{vb:>14.0f}{(cb-ca)*100:>9.1f}pp")

    print("\n【消息级 + 条数封顶】（体积可控的另一条路）")
    print(f"{'封顶条数':<12}" + "".join(f"{('预算'+str(b)):>14}" for b in (4000, 8000, 12000)))
    for mx in (3, 5, 8, 12):
        row = f"{mx:<12}"
        for b in (4000, 8000, 12000):
            c, v = msg_level(b, max_msgs=mx)
            row += f"{c*100:>10.1f}%{v:>0.0f}".rjust(14)
        print(row)
    print("-" * 96)
    print("注：消息级装配 = 命中消息后回填该消息的**全部块**（按原文顺序），")
    print("    解决的是『捞对了消息(94.7%) 但证据所在块没进预算(47.4%)』这 47pp 的缺口。")
    try:
        db.close()
    except Exception:
        pass


if __name__ == "__main__":
    main()
