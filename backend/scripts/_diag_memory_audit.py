"""[MEM-AUDIT] 向量记忆全链体检（只读）。

一次性复核 7 个已知问题点的实测口径，供变更前后对比：
  #1 世界书向量表维度 vs 嵌入器维度
  #2 语义检索的会话隔离（传 session_id 的召回边界）
  #3 装配侧记忆门控（_memory_gate_should_skip）在真实模型下的判定
  #4 用户的 memory_mode 分布（rule 无向量召回）
  #5 孤儿记忆（session_id 在三张会话表都查不到）
  #6 MIN_SIMILARITY 的实际判别力（无关查询的分数下限）
  #7 嵌入器降级链的维度契约

用法（容器内，只读；不会写入任何行）：
    docker exec -w /app -e PYTHONPATH=/app palink-ai-backend-1 \
        python scripts/_diag_memory_audit.py

注意：本脚本不修改数据库，只做 SELECT 与被回滚的探测性 INSERT。
"""
import json
import numpy as np
from sqlalchemy import text

from app.core.database import SessionLocal
from app.memory_module.config import memory_config
from app.memory_module.embedder import get_embedder, embed_text, FastEmbedEmbedder, SimpleHashEmbedder
from app.memory_module.storage import MemoryStorage
from app.services import roleplay_prompt_assembly as rpa

SEP = "=" * 72


def h(title: str):
    print(f"\n{SEP}\n{title}\n{SEP}")


db = SessionLocal()

# ── #1 世界书向量表维度 ───────────────────────────────────────────────
h("#1 世界书向量表维度 vs 嵌入器维度")
row = db.execute(text("""
    SELECT format_type(a.atttypid, a.atttypmod) AS coltype
    FROM pg_attribute a
    WHERE a.attrelid = 'world_book_entry_vectors'::regclass AND a.attname = 'embedding'
""")).first()
print(f"  表列 embedding 类型      = {row.coltype if row else '表不存在'}")
print(f"  memory_config.VECTOR_DIMENSION = {memory_config.VECTOR_DIMENSION}")
emb = embed_text("探针")
print(f"  嵌入器实际输出维度       = {np.array(emb).shape}")
n_rows = db.execute(text("SELECT count(*) FROM world_book_entry_vectors")).scalar()
n_vec_entries = db.execute(text(
    "SELECT count(*) FROM world_book_stages WHERE vectorized IS TRUE")).scalar()
print(f"  表内行数 = {n_rows}；vectorized=True 的世界书条目 = {n_vec_entries}")
if n_vec_entries:
    try:
        db.execute(
            text("INSERT INTO world_book_entry_vectors (entry_id, content_hash, embedding) "
                 "VALUES (:e, 'probe', CAST(:v AS vector))"),
            {"e": "__probe__", "v": "[" + ",".join(["0.1"] * 1024) + "]"})
        db.rollback()
        print("  ⚠ 1024 维写入未报错——需人工复核")
    except Exception as e:
        db.rollback()
        print(f"  写入 1024 维 -> {type(e).__name__}: {str(e).splitlines()[0]}")

# ── #2 会话隔离 ──────────────────────────────────────────────────────
h("#2 语义检索的会话隔离")
st = MemoryStorage(db)
uid = db.execute(text("SELECT user_id FROM conversation_memories GROUP BY 1 ORDER BY count(*) DESC LIMIT 1")).scalar()
emb_l = np.array(embed_text("音符公式"), dtype=np.float32).reshape(-1).tolist()
for label, sid in (("全新 session", "PROBE-FRESH-AUDIT"),
                   ("不传 session", None),
                   ("真实存在的会话", db.execute(text(
                       "SELECT session_id FROM conversation_memories WHERE user_id=:u "
                       "ORDER BY created_at DESC LIMIT 1"), {"u": uid}).scalar())):
    hits = st.semantic_search(user_id=uid, query_embedding=emb_l, limit=50,
                              min_similarity=memory_config.MIN_SIMILARITY, session_id=sid)
    print(f"  {label:<16} -> 命中 {len(hits)} 条")

# ── #3 记忆门控 ──────────────────────────────────────────────────────
h("#3 装配侧记忆门控（真实模型）")
print("  门控语义（2026-09-22 修正后）：历史被窗口裁剪 → 必须检索；"
      "未裁剪且装得进预算 → 跳过")
for model in (None, "deepseek-v4-flash"):
    budget = rpa._compute_prompt_token_budget(model, 4096)
    reserve = rpa._DEFAULT_HISTORY_RESERVE
    print(f"  model={model!r:<20} token_budget={budget}")
    for sys_tok in (3000, 8000):
        # 未裁剪：仍按预算比较（短会话省 token 行为保留）
        skip_ok = rpa._memory_gate_should_skip(
            sys_tok, 0, max(budget - sys_tok - reserve - 1, 0), reserve, budget,
            history_truncated=False)
        # 已裁剪：无论预算多宽都必须检索
        skip_trunc = rpa._memory_gate_should_skip(
            sys_tok, 0, 0, reserve, budget, history_truncated=True)
        print(f"      sys≈{sys_tok:<6} 未裁剪→skip={skip_ok}   已裁剪→skip={skip_trunc}")
print("  当前各会话最大历史字符数 =", db.execute(text(
    "SELECT coalesce(max(c),0) FROM (SELECT sum(length(content)) c FROM character_chat_messages "
    "WHERE (is_hidden IS NOT TRUE) GROUP BY session_id) t")).scalar())
print("  历史窗口上限（单聊）= ", end="")
try:
    from app.core.config import settings
    print(int(getattr(settings, "CHARACTER_CHAT_HISTORY_LIMIT", 24) or 24), "条")
except Exception as e:
    print("读取失败", e)

# ── #4 memory_mode 分布 ──────────────────────────────────────────────
h("#4 memory_mode 分布（rule = 只取最近 5 条，不做语义检索）")
for mode, n in db.execute(text("SELECT memory_mode, count(*) FROM user_settings GROUP BY 1 ORDER BY 2 DESC")):
    print(f"  {mode:<10} {n}")

# ── #5 孤儿记忆 ──────────────────────────────────────────────────────
h("#5 孤儿记忆（三张会话表全查不到）")
Q_ORPHAN = """
FROM conversation_memories m
WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = m.session_id)
  AND NOT EXISTS (SELECT 1 FROM character_chat_sessions c WHERE c.id = m.session_id)
  AND NOT EXISTS (SELECT 1 FROM group_chat_sessions g WHERE g.id = m.session_id)
"""
total, orphan = db.execute(text(
    f"SELECT (SELECT count(*) FROM conversation_memories), (SELECT count(*) {Q_ORPHAN})")).first()
print(f"  总行数={total} 孤儿={orphan}")
for day, uid_, n in db.execute(text(
        f"SELECT date_trunc('day', m.created_at), m.user_id, count(*) {Q_ORPHAN} "
        "GROUP BY 1, 2 ORDER BY 1")):
    print(f"    {day.date()}  user={uid_}  {n} 条")

# ── #6 判别力 ────────────────────────────────────────────────────────
h("#6 MIN_SIMILARITY 实际判别力")
rows = db.execute(text(
    "SELECT id, content, embedding FROM conversation_memories "
    "WHERE user_id = :u AND embedding IS NOT NULL"), {"u": uid}).fetchall()
mats = [(r.id, np.array(json.loads(r.embedding), dtype=np.float32)) for r in rows]
print(f"  user={uid} 向量行数={len(mats)}  MIN_SIMILARITY={memory_config.MIN_SIMILARITY}")
cases = [("相关-声波公式", "给我看看那个声波公式"), ("相关-打招呼", "你好"),
         ("无关-量子色动力学", "完全不相关的量子色动力学"),
         ("无关-法国首都", "法国的首都是哪里"),
         ("无关-天气预报", "今天上海天气怎么样")]
for label, q in cases:
    qv = np.array(embed_text(q), dtype=np.float32).reshape(-1)
    sims = sorted((float(np.dot(qv, v) / (np.linalg.norm(qv) * np.linalg.norm(v) + 1e-9)) for _, v in mats),
                  reverse=True)
    for thr in (0.3, 0.5, 0.6):
        print(f"  {label:<18} top1={sims[0]:.3f}  阈值{thr} → 过阈值 {sum(1 for s in sims if s >= thr)} 条")

# ── #7 降级链维度契约 ────────────────────────────────────────────────
h("#7 嵌入器降级链维度契约")
e = get_embedder()
print(f"  当前嵌入器 = {type(e).__name__}  .dimension 报告 = {e.dimension}")
try:
    fe = FastEmbedEmbedder()
    print(f"  FastEmbed 可加载，dimension = {fe.dimension}")
except Exception as ex:
    print(f"  FastEmbed 不可加载: {str(ex).splitlines()[0][:90]}")
print(f"  SimpleHash 兜底 dimension = {SimpleHashEmbedder().dimension}")
print("  降级期后果：512/384 维向量写入 TEXT 列不报错；后续 1024 维查询 "
      "np.dot 抛 ValueError，被 storage.semantic_search 逐行 except → continue（静默丢弃）")
dims = db.execute(text(
    "SELECT jsonb_array_length(embedding::jsonb) AS dim, count(*) FROM conversation_memories "
    "WHERE embedding IS NOT NULL GROUP BY 1 ORDER BY 2 DESC"))
print("  现存向量维度分布：", [(d, n) for d, n in dims] or "（空）")

db.close()
print(f"\n{SEP}\n体检完成（未写入任何持久化数据）\n{SEP}")
