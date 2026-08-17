"""add prompts_data and group fields

Revision ID: 0026_add_prompts_data_and_group
Revises: 0025_add_character_ui_config
Create Date: 2026-06-05

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '0026_add_prompts_data_and_group'
down_revision = '0025_add_character_ui_config'
branch_labels = None
depends_on = None


def upgrade():
    try:
        op.add_column('generation_presets', sa.Column('prompts_data', sa.Text(), nullable=True))
    except Exception:
        pass
    try:
        op.add_column('world_book_stages', sa.Column('group', sa.String(), nullable=True))
    except Exception:
        pass


def downgrade():
    try:
        op.drop_column('generation_presets', 'prompts_data')
    except Exception:
        pass
    try:
        op.drop_column('world_book_stages', 'group')
    except Exception:
        pass
