"""add plugins tables

Revision ID: 0027_add_plugins
Revises: 0026_add_prompts_data_and_group
Create Date: 2026-06-05

"""
from alembic import op
import sqlalchemy as sa


revision = '0027_add_plugins'
down_revision = '0026_add_prompts_data_and_group'
branch_labels = None
depends_on = None


def upgrade():
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing = inspector.get_table_names()

    if 'plugins' not in existing:
        op.create_table('plugins',
            sa.Column('id', sa.String(), primary_key=True),
            sa.Column('name', sa.String(), nullable=False),
            sa.Column('plugin_type', sa.String(), nullable=False),
            sa.Column('description', sa.Text(), nullable=True),
            sa.Column('version', sa.String(), nullable=True),
            sa.Column('author', sa.String(), nullable=True),
            sa.Column('enabled', sa.Boolean(), server_default='true'),
            sa.Column('source_type', sa.String(), nullable=True),
            sa.Column('source_data', sa.Text(), nullable=True),
            sa.Column('config', sa.Text(), nullable=True),
            sa.Column('created_at', sa.DateTime(), nullable=True),
            sa.Column('updated_at', sa.DateTime(), nullable=True),
        )

    if 'plugin_scripts' not in existing:
        op.create_table('plugin_scripts',
            sa.Column('id', sa.String(), primary_key=True),
            sa.Column('plugin_id', sa.String(), sa.ForeignKey('plugins.id', ondelete='CASCADE'), nullable=False),
            sa.Column('script_name', sa.String(), nullable=False),
            sa.Column('script_type', sa.String(), nullable=False),
            sa.Column('enabled', sa.Boolean(), server_default='true'),
            sa.Column('content', sa.Text(), nullable=True),
            sa.Column('find_regex', sa.Text(), nullable=True),
            sa.Column('replace_string', sa.Text(), nullable=True),
            sa.Column('trim_strings', sa.Text(), nullable=True),
            sa.Column('placement', sa.Text(), nullable=True),
            sa.Column('markdown_only', sa.Boolean(), server_default='false'),
            sa.Column('prompt_only', sa.Boolean(), server_default='false'),
            sa.Column('run_on_edit', sa.Boolean(), server_default='false'),
            sa.Column('substitute_regex', sa.Integer(), server_default='0'),
            sa.Column('min_depth', sa.Integer(), nullable=True),
            sa.Column('max_depth', sa.Integer(), nullable=True),
            sa.Column('order_no', sa.Integer(), server_default='0'),
            sa.Column('created_at', sa.DateTime(), nullable=True),
        )


def downgrade():
    op.drop_table('plugin_scripts')
    op.drop_table('plugins')
