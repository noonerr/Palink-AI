"""add characters.jailbreak and user_settings.jailbreak for ST 1.18.0 parity

Revision ID: 0054_add_jailbreak_fields
Revises: 0053_add_worldbook_role_scoring_automation
Create Date: 2026-07-21

New columns (ST 1.18.0 jailbreak prompt assembly parity):
- characters.jailbreak (Text, nullable)
  V3 card spec: data.extensions.jailbreak or data.jailbreak.
  Separate from post_history_instructions. ST 1.18.0 uses PHI as default
  jailbreak override (script.js:3361), V3 allows independent jailbreak field.
- user_settings.jailbreak (Text, nullable)
  User-global jailbreak (ST main UI Jailbreak box), synced from power_user JSON.
"""
from alembic import op
import sqlalchemy as sa


revision = '0054_add_jailbreak_fields'
down_revision = '0053_add_worldbook_role_scoring_automation'
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = [c['name'] for c in inspector.get_columns(table_name)]
    return column_name in columns


def upgrade():
    if not _column_exists('characters', 'jailbreak'):
        op.add_column('characters', sa.Column('jailbreak', sa.Text(), nullable=True))
    if not _column_exists('user_settings', 'jailbreak'):
        op.add_column('user_settings', sa.Column('jailbreak', sa.Text(), nullable=True))


def downgrade():
    if _column_exists('characters', 'jailbreak'):
        op.drop_column('characters', 'jailbreak')
    if _column_exists('user_settings', 'jailbreak'):
        op.drop_column('user_settings', 'jailbreak')
