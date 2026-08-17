"""migrate extension_prompts.position to ST 1.18.0 semantics

Revision ID: 0057_migrate_extension_prompt_position_to_st
Revises: 0056_migrate_author_note_position_to_st
Create Date: 2026-07-27

Aligns extension_prompts.position with SillyTavern 1.18.0's
extension_prompt_types enum (script.js:491-496):

    ST 1.18.0 (target):             Palink (old, pre-migration):
      -1 = NONE                       0 = NONE
       0 = IN_PROMPT                  1 = IN_PROMPT
       1 = IN_CHAT                    2 = IN_CHAT
       2 = BEFORE_PROMPT              3 = BEFORE_PROMPT

Migration value mapping (old -> new):
     0 -> -1  (NONE          -> NONE)
     1 ->  0  (IN_PROMPT     -> IN_PROMPT)
     2 ->  1  (IN_CHAT       -> IN_CHAT)
     3 ->  2  (BEFORE_PROMPT -> BEFORE_PROMPT)

Idempotency: relies on alembic's single-execution guarantee.
The old set {0,1,2,3} overlaps with the new set {-1,0,1,2} on {0,1,2},
so a second manual run would re-map and corrupt; do not re-run manually.
"""
from alembic import op
import sqlalchemy as sa


revision = '0057_migrate_extension_prompt_position_to_st'
down_revision = '0056_migrate_author_note_position_to_st'
branch_labels = None
depends_on = None


# Old Palink value -> new ST-aligned value
_VALUE_MAP = {
    0: -1,   # NONE -> NONE
    1: 0,    # IN_PROMPT -> IN_PROMPT
    2: 1,    # IN_CHAT -> IN_CHAT
    3: 2,    # BEFORE_PROMPT -> BEFORE_PROMPT
}


def _table_exists(table_name: str) -> bool:
    bind = op.get_bind()
    return table_name in sa.inspect(bind).get_table_names()


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    if table_name not in sa.inspect(bind).get_table_names():
        return False
    return any(c["name"] == column_name for c in sa.inspect(bind).get_columns(table_name))


def upgrade() -> None:
    """Migrate extension_prompts.position from Palink enum to ST 1.18.0 enum.

    Uses raw SQL per (old, new) pair. Safe on empty tables (updates 0 rows).
    Defensive: skipped if extension_prompts table or position column is absent.
    """
    bind = op.get_bind()
    if not (_table_exists("extension_prompts") and _column_exists("extension_prompts", "position")):
        return

    # 用逐值 raw SQL 更新（最安全，避免 CASE 在 SQLite 上的兼容问题）
    # 注意：必须按从大到小的 old_val 顺序更新，避免 0->-1 后又被 1->0 误命中
    # 实际上 WHERE position = :old 用的是原值匹配，每次更新后该值已变，
    # 不会被后续 WHERE 命中，因此顺序无关；这里仍按 old_val 降序排列以求清晰。
    for old_val, new_val in sorted(_VALUE_MAP.items(), key=lambda kv: kv[0], reverse=True):
        bind.execute(
            sa.text(
                "UPDATE extension_prompts SET position = :new WHERE position = :old"
            ),
            {"new": new_val, "old": old_val},
        )


def downgrade() -> None:
    """Reverse the mapping. New ST value -> old Palink value.

    The new set {-1,0,1,2} maps back to {0,1,2,3} cleanly (1:1).
    """
    bind = op.get_bind()
    if not (_table_exists("extension_prompts") and _column_exists("extension_prompts", "position")):
        return

    reverse_map = {v: k for k, v in _VALUE_MAP.items()}
    for new_val, old_val in reverse_map.items():
        bind.execute(
            sa.text(
                "UPDATE extension_prompts SET position = :old WHERE position = :new"
            ),
            {"old": old_val, "new": new_val},
        )
