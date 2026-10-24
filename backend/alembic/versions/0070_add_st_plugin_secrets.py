"""补 0070：ST 插件 secrets 存储（[API-1] 2026-10-24）

Revision ID: 0070_add_st_plugin_secrets
Revises: 0069_memory_embedding_vector
Create Date: 2026-10-24

背景：/api/secrets/* 八端点自 Task 37 起一直是"安全 stub"（result:False +
Use Palink ConnectionProfiles API），插件存/读 API key 的链路整条死
（REPORT_ST三面一致性差距评估_装配显示与插件API_2026-10-24.md §4 P-1）。
本迁移为真实现建存储层：

st_plugin_secrets（unique(user_id, key) 单槽位）：
1. id            String 主键（uuid4，模型默认值生成）
2. user_id       Integer FK users.id(CASCADE)，全部按 user 隔离
3. key           String  ST secret key 名（如 api_key_custom；也收插件自定义键）
4. value_encrypted Text  Fernet 密文（密钥由 SECRET_KEY 确定性派生），
                         value 永不明文落库
5. label         String  ST SecretState.label / /rename 语义所需（可空，
                         未命名读取侧显示 'Unlabeled'）——该列是最初钉死
                         列清单之外的最小增量
6. created_at / updated_at

安全属性：纯新增一张表，无数据改写，存量行为零变化。
表本身另由 core/migrations.py 启动期的 Base.metadata.create_all 幂等兜底
（与 character_plugin_storage 等新表同款双轨）。
"""
from alembic import op
import sqlalchemy as sa


revision = '0070_add_st_plugin_secrets'
down_revision = '0069_memory_embedding_vector'
branch_labels = None
depends_on = None


def _table_exists(table_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return table_name in inspector.get_table_names()


def upgrade() -> None:
    if not _table_exists("st_plugin_secrets"):
        op.create_table(
            "st_plugin_secrets",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("user_id", sa.Integer(), nullable=False),
            sa.Column("key", sa.String(), nullable=False),
            sa.Column("value_encrypted", sa.Text(), nullable=False),
            sa.Column("label", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=True),
            sa.Column("updated_at", sa.DateTime(), nullable=True),
            sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
            sa.UniqueConstraint("user_id", "key", name="uq_st_plugin_secrets_user_key"),
        )
        op.create_index(
            "ix_st_plugin_secrets_user_id",
            "st_plugin_secrets",
            ["user_id"],
        )


def downgrade() -> None:
    if _table_exists("st_plugin_secrets"):
        op.drop_index("ix_st_plugin_secrets_user_id", table_name="st_plugin_secrets")
        op.drop_table("st_plugin_secrets")
