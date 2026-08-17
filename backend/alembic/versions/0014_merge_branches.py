"""merge branches: short_title and frozen_favorite

Revision ID: 0014_merge_branches
Revises: 0008_add_branch_frozen_favorite, 0013_add_branch_indexes
Create Date: 2026-05-10

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '0014_merge_branches'
down_revision = ('0008_add_branch_frozen_favorite', '0013_add_branch_indexes')
branch_labels = None
depends_on = None


def upgrade():
    # This is a merge migration, no operations needed
    pass

def downgrade():
    # This is a merge migration, no operations needed
    pass
