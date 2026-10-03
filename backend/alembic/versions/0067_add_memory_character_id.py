"""conversation_memories.character_id：向量记忆补角色维度（跨角色串味修复 2026-10-03）

Revision ID: 0067_add_memory_character_id
Revises: 0066_extension_prompt_source_key
Create Date: 2026-10-03

背景（[T-跨卡串味]）：``conversation_memories`` 只有 user_id / session_id，
完全没有角色维度。会话表 ``character_chat_sessions.character_id`` 有（并建了
``idx_ccs_character_user``），但记忆表不记。于是：

    storage.semantic_search 的分支3（session_id 传空时）
        WHERE user_id = :user_id
    → 退化成用户级全量召回，A 卡的会话硬塞 B 卡的记忆。

本次仅新增一个可空列（纯新增，无数据改写）：

- ``character_id TEXT NULL``
  - NULL = 无角色归属（普通聊天 / ST 向量集合 / 存量行），行为不变；
  - 非 NULL = 该条记忆属于哪个角色会话。

为什么 nullable=True：
存量行没有这个值，且本项目**没有存量用户**，不做回填（记忆行 → 会话 →
character 的 JOIN 回填留给将来需要时按需补，不在本迁移内做）。

索引：``idx_memory_character_user ON (character_id, user_id)``，
与 ``idx_ccs_character_user`` 同序同构 —— 检索侧分支3 走
``WHERE user_id = :u AND character_id = :c``，该复合索引同时覆盖
user_id 单列查询方向。

幂等：upgrade 先查列存在再 ADD，重复执行安全（对齐 0061 / 0066 的做法）。
回滚：downgrade 先删索引再 drop 列。
"""
from alembic import op
import sqlalchemy as sa


revision = '0067_add_memory_character_id'
down_revision = '0066_extension_prompt_source_key'
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table_name not in inspector.get_table_names():
        return False
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def _index_exists(index_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "conversation_memories" not in inspector.get_table_names():
        return False
    return any(ix["name"] == index_name for ix in inspector.get_indexes("conversation_memories"))


def upgrade() -> None:
    if not _column_exists("conversation_memories", "character_id"):
        op.add_column(
            "conversation_memories",
            sa.Column("character_id", sa.String(), nullable=True),
        )
    # 复合索引 (character_id, user_id)：与会话表 idx_ccs_character_user 同序同构，
    # 兼顾分支3 的 user_id + character_id 过滤与 user_id 单列方向。
    if not _index_exists("idx_memory_character_user"):
        op.create_index(
            "idx_memory_character_user",
            "conversation_memories",
            ["character_id", "user_id"],
        )


def downgrade() -> None:
    if _index_exists("idx_memory_character_user"):
        op.drop_index("idx_memory_character_user", table_name="conversation_memories")
    if _column_exists("conversation_memories", "character_id"):
        op.drop_column("conversation_memories", "character_id")
