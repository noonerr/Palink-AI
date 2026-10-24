"""补 0071：character_chat_messages.role 写侧硬不变量（[P2-23/NF-1] 2026-10-24）

Revision ID: 0071_ccm_role_not_null_check
Revises: 0070_add_st_plugin_secrets
Create Date: 2026-10-24

背景：全池普查（REPORT_VER1b）+ 取证（REPORT_NF1_role空值消息取证_2026-10-24.md）
发现存量库存在 role=NULL 的孤立消息行（id=1297，2026-06-23 已消失的早期写入路径
遗留；当前 15 个构造点 + 2 个更新点均不可能再写 NULL）。装配层已修（884b542，
NULL 归一 assistant + 留痕），本迁移把"写侧永不 NULL"升级为数据库硬不变量：

1. role 加 NOT NULL（原本 `Column(String)` 无 nullable 声明，即真可空）；
2. 加 CHECK 约束 `ck_character_chat_messages_role`：role IN ('user','assistant','system')。

⚠️ SQL 语义注意：CHECK 的 `role IN (...)` 对 NULL 求值为 UNKNOWN、**不拒绝 NULL**
（标准 SQL 三值逻辑，sqlite/postgres 同）；拒 NULL 靠 NOT NULL，拒非法值靠 CHECK，
两者缺一不可。

授权与数据修复：用户已拍板（SPEC_ST三面一致对齐施工计划_2026-10-24.md §0.1 P2-23
"存量一行 UPDATE + role CHECK 约束，已授权（备份先行）"）。生产 id=1297 的单行
UPDATE 由施工批先行执行；本迁移在 upgrade 里再兜一道同样的归一化
（UPDATE ... SET role='assistant' WHERE role IS NULL，静态 SQL、无外部输入），
保证"先跑迁移、后补数据"的顺序颠倒也不会让 SET NOT NULL 半路炸掉——
两步语义一致，先跑谁都是同一结果。

幂等惯例（照 0070）：inspector 先查列 nullability 与 CHECK 是否已在场，
已满足则整段 no-op；fresh 库（main.py 先 create_all 后 stamp head）天然带
新模型形态，迁移不会重复执行。downgrade 全量可逆：卸 CHECK、role 还原可空，
已归一化的数据不回改（历史 NULL 行归 assistant 是数据修复，不是 schema 状态）。

前置条件（实测于本地迁移用例 tests/test_nf1_role_migration.py）：本迁移的
兜底 UPDATE 只处理 NULL（取证 §3.2：全库 role 分布 assistant=133 / user=114 /
NULL=1，无白名单外值）。若某库存在白名单外值（如 'tool'），sqlite 的 batch
重建在"建临时表（已带新 CHECK）→ 拷数据"时、postgres 的 ADD CONSTRAINT
校验存量行时都会**响亮失败**并点名违规行——这是有意的：未知 role 无安全映射，
不许静默改写。

sqlite 兼容：batch_alter_table（env.py 全局 render_as_batch 配合，0001/0029/0042
同款先例）；postgres（生产）为直通 ALTER TABLE。
"""
from alembic import op
import sqlalchemy as sa


revision = '0071_ccm_role_not_null_check'
down_revision = '0070_add_st_plugin_secrets'
branch_labels = None
depends_on = None

_TABLE = "character_chat_messages"
_CHECK_NAME = "ck_character_chat_messages_role"
# 白名单与现行代码口径一致：character_ext.py:3196-3206 / :3447-3459 两处更新
# 路径、_st_message_role/_st_msg_role 兜底、装配层归一化，全部收口为这三值。
_CHECK_CONDITION = "role IN ('user', 'assistant', 'system')"


def _table_exists(table_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return table_name in inspector.get_table_names()


def _role_state() -> dict:
    """返回 {'nullable': bool, 'has_check': bool}（列在场的快照）。"""
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {c["name"]: c for c in inspector.get_columns(_TABLE)}
    checks = {c["name"] for c in inspector.get_check_constraints(_TABLE)}
    return {
        "column_present": "role" in columns,
        "nullable": bool(columns.get("role", {}).get("nullable", True)),
        "has_check": _CHECK_NAME in checks,
    }


def upgrade() -> None:
    if not _table_exists(_TABLE):
        return

    # ① 数据兜底：存量 NULL 归一 assistant（与装配层 884b542 同语义、同授权）。
    #    必须先于 SET NOT NULL，否则带 NULL 行的库升级即炸。
    #    全静态 SQL：无外部输入、无拼接面，故不做参数绑定。
    op.execute(
        sa.text(
            "UPDATE character_chat_messages SET role = 'assistant' WHERE role IS NULL"
        )
    )

    state = _role_state()
    need_not_null = state["column_present"] and state["nullable"]
    need_check = state["column_present"] and not state["has_check"]
    if not (need_not_null or need_check):
        return

    with op.batch_alter_table(_TABLE) as batch_op:
        if need_not_null:
            batch_op.alter_column("role", existing_type=sa.String(), nullable=False)
        if need_check:
            batch_op.create_check_constraint(_CHECK_NAME, _CHECK_CONDITION)


def downgrade() -> None:
    if not _table_exists(_TABLE):
        return

    state = _role_state()
    drop_check = state["column_present"] and state["has_check"]
    relax_null = state["column_present"] and not state["nullable"]
    if not (drop_check or relax_null):
        return

    with op.batch_alter_table(_TABLE) as batch_op:
        if drop_check:
            batch_op.drop_constraint(_CHECK_NAME, type_="check")
        if relax_null:
            batch_op.alter_column("role", existing_type=sa.String(), nullable=True)
