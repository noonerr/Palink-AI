"""add world_book_stages.role/use_group_scoring/automation_id for ST 1.18.0 parity

Revision ID: 0053_add_worldbook_role_scoring_automation
Revises: 0052_add_worldbook_ignore_budget
Create Date: 2026-07-20

New columns (ST 1.18.0 entry fields previously dropped on round-trip):
- world_book_stages.role (Integer, default 0)
  @Depth injection role: 0=system, 1=user, 2=assistant.
  Reference: world-info.js newWorldInfoEntryDefinition:4037, convertCharacterBook:5537
  (extensions.role, default extension_prompt_roles.SYSTEM=0).
- world_book_stages.use_group_scoring (Boolean, nullable)
  null = inherit global; per-entry override otherwise.
  Reference: world-info.js:4035, convertCharacterBook:5535 (extensions.use_group_scoring).
- world_book_stages.automation_id (String, nullable)
  STscript automation id. Reference: world-info.js:4036, convertCharacterBook:5536
  (extensions.automation_id, default '').
"""
from alembic import op
import sqlalchemy as sa


revision = '0053_add_worldbook_role_scoring_automation'
down_revision = '0052_add_worldbook_ignore_budget'
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table_name not in inspector.get_table_names():
        return False
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    if not _column_exists("world_book_stages", "role"):
        op.add_column(
            "world_book_stages",
            sa.Column("role", sa.Integer(), server_default=sa.text("0"), nullable=True),
        )
    if not _column_exists("world_book_stages", "use_group_scoring"):
        op.add_column(
            "world_book_stages",
            sa.Column("use_group_scoring", sa.Boolean(), nullable=True),
        )
    if not _column_exists("world_book_stages", "automation_id"):
        op.add_column(
            "world_book_stages",
            sa.Column("automation_id", sa.String(), nullable=True),
        )


def downgrade() -> None:
    for column_name in ("automation_id", "use_group_scoring", "role"):
        if _column_exists("world_book_stages", column_name):
            op.drop_column("world_book_stages", column_name)
