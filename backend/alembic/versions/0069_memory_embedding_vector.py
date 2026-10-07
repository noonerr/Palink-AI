"""conversation_memories.embedding：TEXT → pgvector vector(N)（向量检索去时间预筛 2026-10-07）

Revision ID: 0069_memory_embedding_vector
Revises: 0068_add_mvu_secondary_params
Create Date: 2026-10-07

背景（实测，见 docs/_active/report/REPORT_线上三问题排查…2026-10-07.md 的后续研究）：
``semantic_search`` 的实现是 ``SELECT … ORDER BY created_at DESC LIMIT 200`` 再把每行
22.7KB 的 JSON 向量文本搬进 Python 逐行 ``json.loads`` 算余弦。两个后果：

1. **召回天花板**：语义检索实际只在"最近 200 条"里做。实测用户级 614 行候选里
   151 条过阈值（≥0.5），窗口只覆盖到 79 条 ⇒ **48% 该召回的记忆看不见**；
   top50 里有 22 条窗口取不到。主力会话已 192 行，距天花板仅 8 行。
2. **每轮搬 4.17MB** 文本 + 42ms 解析，而库内精确算同一批只要 2.6ms。

本修订把列转为 pgvector ``vector(N)``，检索改库内 ``<=>`` 精确 top-K。
**故意不建 HNSW/IVFFlat**：pgvector 索引扫描是"先取近邻再套 WHERE"，在
user_id/session_id 这类高选择性过滤下会少返甚至返 0 条 —— 那会伪装成
"用户没历史"，是本项目最坑的静默失效形态。千行量级暴力算就是毫秒级。

⚠️ 生产 ``RUN_MIGRATIONS_ON_STARTUP=false``（docker-compose.yml:169），启动时 alembic
**不执行**。真正让变更落库的是 ``memory_module/storage.py`` 的
``MemoryStorage._migrate_embedding_column()`` 运行时通道（与 0067 靠
``_RUNTIME_COMPAT_COLUMNS`` 落库同理）。本件负责把变更记进 schema 历史，
手工 ``alembic upgrade head`` 时用它。

幂等：先查列的真实类型，已是 vector(N) 直接跳过；维度与配置不符时**只告警不改类型**
（重打列会作废整列存量向量，那是 reembed 脚本的活，不是迁移的活）。
"""
import os

import sqlalchemy as sa
from alembic import op

revision = "0069_memory_embedding_vector"
down_revision = "0068_add_mvu_secondary_params"
branch_labels = None
depends_on = None

_COLUMN_TYPE_SQL = """
    SELECT a.atttypid::regtype::text AS type_text
    FROM pg_attribute a
    JOIN pg_class r ON r.oid = a.attrelid
    WHERE r.relname = 'conversation_memories'
      AND a.attname = 'embedding' AND a.attnum > 0
"""


def _target_dim() -> int:
    """契约维度：与 app/memory_module/config.py 取同一个环境变量、同一个默认值。"""
    return int(os.getenv("MEMORY_VECTOR_DIMENSION", "512"))


def _is_postgres(bind) -> bool:
    return bind.dialect.name == "postgresql"


def _table_exists(bind, table_name: str) -> bool:
    return table_name in sa.inspect(bind).get_table_names()


def _column_type(bind) -> str:
    row = bind.execute(sa.text(_COLUMN_TYPE_SQL)).fetchone()
    return str(row[0] or "") if row else ""


def upgrade() -> None:
    bind = op.get_bind()
    if not _is_postgres(bind):
        return  # SQLite 走 Python 余弦路径，无向量列
    if not _table_exists(bind, "conversation_memories"):
        return

    dim = _target_dim()
    if dim <= 0:
        return

    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    current = _column_type(bind)
    if current.startswith("vector("):
        if current != f"vector({dim})":
            # 换嵌入模型导致的维度漂移：绝不自动重打列（那会清空存量向量）。
            print(
                f"[VEC-PG] conversation_memories.embedding 是 {current}，"
                f"配置要 {dim} 维：请跑 scripts/reembed_all_to_bge_m3.py 重嵌。"
            )
        return

    # 维度不符的行先置 NULL：一条降级期写入的 512 维向量不该阻塞全库 ALTER。
    # 逗号计数对 json.dumps 产出的纯数字数组成立（浮点字面量不含逗号）。
    bad = bind.execute(sa.text(
        f"""
        SELECT count(*) FROM conversation_memories
        WHERE embedding IS NOT NULL
          AND (length(embedding) - length(replace(embedding, ',', ''))) + 1 <> {dim}
        """
    )).scalar()
    if bad:
        bind.execute(sa.text(
            f"""
            UPDATE conversation_memories
            SET embedding = NULL
            WHERE embedding IS NOT NULL
              AND (length(embedding) - length(replace(embedding, ',', ''))) + 1 <> {dim}
            """
        ))
        print(f"[VEC-PG] {bad} 行向量维度 ≠ {dim}，已置 NULL（正文行保留，不丢内容）")

    bind.execute(sa.text(
        f"ALTER TABLE conversation_memories "
        f"ALTER COLUMN embedding TYPE vector({dim}) "
        f"USING embedding::vector({dim})"
    ))


def downgrade() -> None:
    bind = op.get_bind()
    if not _is_postgres(bind):
        return
    if not _table_exists(bind, "conversation_memories"):
        return
    if not _column_type(bind).startswith("vector("):
        return
    # 回到 TEXT：vector 的文本表示恰好是合法 JSON 数组，读侧 _parse_vector_cell 两种形态都吃
    bind.execute(sa.text(
        "ALTER TABLE conversation_memories ALTER COLUMN embedding TYPE text "
        "USING embedding::text"
    ))
