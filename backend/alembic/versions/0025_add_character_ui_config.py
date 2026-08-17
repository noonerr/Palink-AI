"""add character ui_config

Revision ID: 0025_add_character_ui_config
Revises: 0024_add_oauth_tables
Create Date: 2026-06-05

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '0025_add_character_ui_config'
down_revision = '0024_add_oauth_tables'
branch_labels = None
depends_on = None


def upgrade():
    try:
        op.add_column('characters', sa.Column('ui_config', sa.Text(), nullable=True))
    except Exception:
        pass


def downgrade():
    try:
        op.drop_column('characters', 'ui_config')
    except Exception:
        pass
