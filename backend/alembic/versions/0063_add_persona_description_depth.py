"""补 0063：personas.persona_description_depth 纳入 alembic 链

Revision ID: 0063_add_persona_description_depth
Revises: 0062_drop_st_mode_theme_columns
Create Date: 2026-09-20

ST 1.18.0 persona_description_depth（personas.js:632）：仅 AT_DEPTH(4) 位置时生效，
表示人设注入到「从消息末尾往回数第 N 条」之前。

该列此前只进了 core/migrations.py 的 _RUNTIME_COMPAT_COLUMNS 补列清单，
没有对应迁移 → alembic head 停在 0062 而 ORM 已有此列，链与模型不一致。
本迁移补齐，使 alembic 重新成为权威。

列形状与 ORM（app/models/persona.py:38 Column(Integer, default=4)）及补列清单
（sa.Integer()）三者同构：可空、无 server_default。ORM 侧 default=4 仅在 Python
插入时生效；读取侧已按 NULL 兜底（api/personas.py:67、
services/roleplay_prompt_assembly.py:4488 均走 getattr + None 判定），
故存量行为 NULL 不改变任何注入深度。
"""
from alembic import op
import sqlalchemy as sa


revision = '0063_add_persona_description_depth'
down_revision = '0062_drop_st_mode_theme_columns'
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table_name not in inspector.get_table_names():
        return False
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    # 幂等：未重启过补列扫描的库在此建列；已建过的（RUNTIME_COMPAT 扫描先行）跳过。
    if not _column_exists("personas", "persona_description_depth"):
        op.add_column(
            "personas",
            sa.Column("persona_description_depth", sa.Integer(), nullable=True),
        )


def downgrade() -> None:
    if _column_exists("personas", "persona_description_depth"):
        op.drop_column("personas", "persona_description_depth")
    # 注意：core/migrations.py 的 _RUNTIME_COMPAT_COLUMNS 仍含此列，
    # 下次 worker 启动会把空列补回来（值为 NULL，无功能影响）。
