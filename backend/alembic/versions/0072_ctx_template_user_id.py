"""补 0072：context_templates 属主列（预设模板库 2026-10-25）

Revision ID: 0072_ctx_template_user_id
Revises: 0071_ccm_role_not_null_check
Create Date: 2026-10-25

背景：预设模板库要求普通用户能导入并只看到自己的 context 模板。此前
`context_templates` **没有属主字段**（全局共享），写操作被 PENTEST-2026-09-02
收口到 admin（见 api/context_templates.py），普通用户导入不了。本迁移补
`user_id` 可空列：

1. user_id     Integer，NULL = 内置（is_builtin=True）或 2026-10-25 之前建的历史
               共享行；非 NULL = 该用户私人模板（导入/自建）。
2. ix_context_templates_user_id 索引（按属主过滤列表的查询路径）。

**不动 `name` 的唯一约束**：装配按 name 查模板
（services/roleplay_prompt_assembly.py:_load_context_template），改成
(user_id, name) 唯一会让同名行产生歧义；导入侧撞名统一加 " (imported)" 后缀
（api/preset_library.py:_unique_context_name）。

**不加外键约束**（有意）：存量行全部 NULL，加 FK 在生产（PostgreSQL）要走
ADD CONSTRAINT 全表校验、在 sqlite 会触发 batch 重建整表；而本列只在应用层
参与归属过滤，不依赖数据库级引用完整性。fresh 库由 Base.metadata.create_all
按模型定义直接带 FK（模型里声明了 ForeignKey("users.id")），两条路径语义一致。

幂等：inspector 先查列是否在场，已在则整段 no-op（fresh 库 create_all 先行，
迁移必然 no-op）。downgrade 只卸列/索引，不改数据（属主信息丢了无法重建，属
有损回退，但列本身可逆）。
"""
from alembic import op
import sqlalchemy as sa


revision = '0072_ctx_template_user_id'
down_revision = '0071_ccm_role_not_null_check'
branch_labels = None
depends_on = None

_TABLE = "context_templates"
_COLUMN = "user_id"
_INDEX = "ix_context_templates_user_id"


def _table_exists(table_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return table_name in inspector.get_table_names()


def _column_present(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return column_name in {c["name"] for c in inspector.get_columns(table_name)}


def _index_present(table_name: str, index_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return index_name in {i["name"] for i in inspector.get_indexes(table_name)}


def upgrade() -> None:
    if not _table_exists(_TABLE):
        return
    if _column_present(_TABLE, _COLUMN):
        return

    # sqlite 走 batch（env.py 全局 render_as_batch 配合，0001/0029/0042/0071 同款），
    # postgres 为直通 ALTER TABLE ADD COLUMN（nullable，无表重写）。
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.add_column(sa.Column(_COLUMN, sa.Integer(), nullable=True))
        batch_op.create_index(_INDEX, [_COLUMN])


def downgrade() -> None:
    if not _table_exists(_TABLE):
        return
    if not _column_present(_TABLE, _COLUMN):
        return

    # 先摘索引再卸列：sqlite 的 batch 重建会把残留索引一起带走，顺序颠倒会
    # 在重建时找不到索引名。
    if _index_present(_TABLE, _INDEX):
        op.drop_index(_INDEX, table_name=_TABLE)
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.drop_column(_COLUMN)
