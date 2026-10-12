"""[P81] 记忆/上下文注入的**配置现状快照**（只读）。

回答一个问题：**现在这些旋钮到底拧在哪、值不值得拧、拧了有没有用**。

产出四块：
  1. 生效配置值（含 EFFECTIVE_* 派生值，避免"以为改了其实没生效"）
  2. 死配置检测 —— 定义了但代码里没有消费点的项（调了不生效，是陷阱）
  3. 线上真实分布 —— memory_mode / memory_budget_level / 记忆库规模
  4. MIN_SIMILARITY 判别力抽样 —— 阈值到底卡掉了多少

用法（容器内）：
    docker exec -w /app -e PYTHONIOENCODING=utf-8 -e PYTHONPATH=/app \
        palink-ai-backend-1 python -u scripts/_probe_mem_cfg_snapshot.py
"""
from __future__ import annotations

import inspect
import json
import os
from sqlalchemy import text

from app.core.database import SessionLocal
from app.memory_module.config import memory_config
from app.memory_module.embedder import embed_text, get_embedder
from app.memory_module import config as cfg_mod
from app.memory_module import retriever as retr_mod
from app.memory_module import storage as st_mod
from app.memory_module import service as svc_mod

try:
    from app.core.config import settings
except Exception:  # pragma: no cover
    settings = None

SEP = "=" * 78


def h(t: str) -> None:
    print(f"\n{SEP}\n{t}\n{SEP}")


db = SessionLocal()

# ── 1. 生效配置值 ────────────────────────────────────────────────────
h("1. 生效配置值（含派生值）")
keys = [
    "EMBEDDING_PROVIDER", "OLLAMA_MODEL", "OLLAMA_HOST", "VECTOR_DIMENSION",
    "MIN_SIMILARITY", "MAX_MEMORIES_PER_QUERY",
    "SEMANTIC_WEIGHT", "TIME_WEIGHT", "IMPORTANCE_WEIGHT",
    "CHUNK_STRATEGY", "SEMANTIC_CHUNKING", "CHUNK_TRIGGER_CHARS",
    "CHUNK_MIN_CHARS", "CHUNK_MAX_CHARS", "CHUNK_TARGET_CHARS",
    "QUERY_MODE", "QUERY_MIN_CHARS", "QUERY_FALLBACK_CHARS",
    "HYBRID_WEIGHT", "HYBRID_KW_CANDIDATES", "HYBRID_KW_MIN_COVERAGE", "HYBRID_RRF_K",
    "NEIGHBOR_EXPAND", "NEIGHBOR_EXTRA_RATIO", "NEIGHBOR_MAX_ADDS",
    "EMBED_BACKFILL_INTERVAL",
]
for k in keys:
    print(f"  {k:<28} = {getattr(memory_config, k, 'N/A')}")

print("\n  ── 派生（EFFECTIVE_*，随切分策略切换）──")
print(f"  IS_SENTENCE_LEVEL            = {memory_config.IS_SENTENCE_LEVEL}")
print(f"  EFFECTIVE_STM_LIMIT          = {memory_config.EFFECTIVE_STM_LIMIT}")
print(f"  EFFECTIVE_STM_EXCLUDE_FACTOR = {memory_config.EFFECTIVE_STM_EXCLUDE_FACTOR}")
print(f"  EFFECTIVE_CANDIDATE_LIMIT    = {memory_config.EFFECTIVE_CANDIDATE_LIMIT}")
print(f"  EFFECTIVE_NEIGHBOR_RADIUS    = {memory_config.EFFECTIVE_NEIGHBOR_RADIUS}")

if settings is not None:
    for k in ("CHAT_HISTORY_LIMIT", "CHARACTER_CHAT_HISTORY_LIMIT", "SUMMARY_MODEL"):
        print(f"  [core] {k:<24} = {getattr(settings, k, 'N/A')}")

try:
    from app.services import roleplay_prompt_assembly as rpa
    print(f"  [rpa] 预算档位表(内部单位)     = {rpa._MEMORY_BUDGET_LEVEL_INTERNAL_UNITS}")
    print(f"  [rpa] 默认档 index=1           = {rpa._MEMORY_BUDGET_LEVEL_INTERNAL_UNITS[1]}")
    print(f"  [rpa] 预算占总量上限           = {rpa._MEMORY_BUDGET_MAX_SHARE:.0%}")
except Exception as e:
    print(f"  [rpa] 读取失败: {type(e).__name__}")

# ── 2. 死配置检测 ────────────────────────────────────────────────────
h("2. 死配置检测（定义了但没人消费 = 调了不生效）")
srcs = {
    "config.py": inspect.getsource(cfg_mod),
    "retriever.py": inspect.getsource(retr_mod),
    "storage.py": inspect.getsource(st_mod),
    "service.py": inspect.getsource(svc_mod),
}
for name in ("SEMANTIC_WEIGHT", "TIME_WEIGHT", "IMPORTANCE_WEIGHT",
             "MAX_MEMORIES_PER_QUERY", "NEIGHBOR_MAX_ADDS", "CHUNK_TARGET_CHARS"):
    # 使用点必然形如 `memory_config.NAME`（带点）；定义行是 `NAME: float = ...`（无点）
    # ⇒ 用 ".NAME" 精确匹配，避免把注释里的提及算成消费点
    uses = []
    needle = "." + name
    for f, s in srcs.items():
        n = s.count(needle)
        if n > 0:
            uses.append(f"{f}×{n}")
    flag = "  ⚠ 死配置（仅定义，无消费）" if not uses else ""
    print(f"  {name:<26} 消费点: {', '.join(uses) if uses else '无'}{flag}")

print("\n  注：_score_candidates 的权重是**硬编码** 0.6/0.2/0.2（retriever.py:434-438），")
print("      与 config 里的 SEMANTIC/TIME/IMPORTANCE_WEIGHT **无关**。")

# ── 3. 线上真实分布 ──────────────────────────────────────────────────
h("3. 线上真实分布")


def q(sql: str):
    try:
        return db.execute(text(sql)).fetchall()
    except Exception as e:
        # 必须回滚：PG 事务一旦中止，后续所有查询都会 InFailedSqlTransaction
        try:
            db.rollback()
        except Exception:
            pass
        print(f"    ⚠ 查询失败: {str(e).splitlines()[0][:100]}")
        return []


print("  [user_settings] memory_mode：")
for r in q("SELECT memory_mode, count(*) FROM user_settings GROUP BY 1 ORDER BY 2 DESC"):
    note = "  ← 不做向量检索，只有 STM" if r[0] == "rule" else ""
    print(f"    {str(r[0]):<10} {r[1]}{note}")

print("  [user_settings] memory_budget_level（0=750 1=4000 2=6000 3=8000 内部单位）：")
_lvl = {0: 750, 1: 4000, 2: 6000, 3: 8000}
for r in q("SELECT memory_budget_level, count(*) FROM user_settings "
           "GROUP BY 1 ORDER BY 2 DESC"):
    v = r[0]
    print(f"    {str(v):<10} {r[1]}   档位={_lvl.get(v, '默认→4000')}")

print("  [conversation_memories] 库规模：")
for r in q("SELECT count(*) AS n, count(*) FILTER (WHERE embedding IS NULL) AS null_vec, "
           "count(DISTINCT session_id) AS sessions, count(DISTINCT user_id) AS users "
           "FROM conversation_memories"):
    print(f"    总行={r[0]}  NULL向量={r[1]}  会话数={r[2]}  用户数={r[3]}")

print("  记忆行最多的 5 个会话（检索成本与候选池压力的来源）：")
for r in q("SELECT session_id, count(*) n FROM conversation_memories "
           "WHERE session_id IS NOT NULL GROUP BY 1 ORDER BY n DESC LIMIT 5"):
    print(f"    {str(r[0])[:40]:<40} {r[1]} 行")

print("  向量维度分布（应与 VECTOR_DIMENSION 一致，不一致=静默少召回）：")
for r in q("SELECT vector_dims(embedding) AS dim, count(*) "
           "FROM conversation_memories WHERE embedding IS NOT NULL "
           "GROUP BY 1 ORDER BY 2 DESC LIMIT 5"):
    print(f"    dim={r[0]}  {r[1]} 行")
print(f"    （memory_config.VECTOR_DIMENSION = {memory_config.VECTOR_DIMENSION}；"
      f"不一致的存量行会被静默跳过）")

# ── 4. MIN_SIMILARITY 判别力抽样 ─────────────────────────────────────
h("4. MIN_SIMILARITY 判别力抽样（阈值到底卡掉多少）")
try:
    e = get_embedder()
    print(f"  当前嵌入器 = {type(e).__name__}  dim = {getattr(e, 'dimension', '?')}")
except Exception as ex:
    print(f"  嵌入器读取失败: {type(ex).__name__}")

row = q("SELECT user_id FROM conversation_memories GROUP BY 1 ORDER BY count(*) DESC LIMIT 1")
uid = row[0][0] if row else None
if uid is None:
    print("  库内无记忆，跳过")
else:
    rows = q("SELECT content, embedding FROM conversation_memories "
             f"WHERE user_id = {int(uid)} AND embedding IS NOT NULL")
    import numpy as np
    mats = []
    for r in rows:
        try:
            mats.append(np.array(json.loads(r[1]), dtype=np.float32))
        except Exception:
            try:
                mats.append(np.array(r[1], dtype=np.float32))
            except Exception:
                continue
    print(f"  抽样用户={uid}  向量行={len(mats)}  MIN_SIMILARITY={memory_config.MIN_SIMILARITY}")
    cases = [
        ("相关-回指前文", "你之前跟我说过的那个小玩具是什么"),
        ("相关-专名", "声波公式"),
        ("无关-天气", "今天上海天气怎么样"),
        ("无关-地理", "法国的首都是哪里"),
    ]
    import numpy as np  # noqa: F811
    for label, qs in cases:
        qv = np.array(embed_text(qs), dtype=np.float32).reshape(-1)
        n = np.linalg.norm(qv)
        if n == 0 or not mats:
            continue
        sims = sorted((float(np.dot(qv, v) / (np.linalg.norm(v) * n + 1e-9)) for v in mats),
                      reverse=True)
        counts = " / ".join(
            f"{thr}→{sum(1 for s in sims if s >= thr)}" for thr in (0.3, 0.4, 0.5, 0.6))
        print(f"    {label:<14} top1={sims[0]:.3f}  过阈值条数: {counts}")

print("\n  读法：若「相关」类 top1 都 < 0.5 ⇒ 阈值正在杀死召回（候选饥饿）；")
print("        若「无关」类在 0.4 就有大量通过 ⇒ 降阈值会引入噪声，需权衡。")

db.close()
print(f"\n{SEP}\nP81 完成（只读）\n{SEP}")
