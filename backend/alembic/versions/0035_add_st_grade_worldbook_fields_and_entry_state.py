"""add st grade worldbook fields and entry state

Revision ID: 0035_add_st_grade_worldbook_fields_and_entry_state
Revises: 0034_add_silly_tavern_settings_json
Create Date: 2026-06-15
"""
from alembic import op
import sqlalchemy as sa


revision = '0035_add_st_grade_worldbook_fields_and_entry_state'
down_revision = '0034_add_silly_tavern_settings_json'
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table_name not in inspector.get_table_names():
        return False
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def _table_exists(table_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return table_name in inspector.get_table_names()


def upgrade() -> None:
    table = "world_book_stages"
    new_columns = [
        ("enabled", sa.Boolean(), True),
        ("case_sensitive", sa.Boolean(), False),
        ("match_whole_words", sa.Boolean(), False),
        ("selective_logic", sa.Integer(), 0),
        ("sticky", sa.Integer(), 0),
        ("cooldown", sa.Integer(), 0),
        ("delay", sa.Integer(), 0),
        ("depth", sa.Integer(), 4),
        ("order", sa.Integer(), 0),
        ("exclude_recursion", sa.Boolean(), False),
        ("prevent_recursion", sa.Boolean(), False),
        ("match_persona_description", sa.Boolean(), False),
        ("match_character_description", sa.Boolean(), False),
        ("match_character_personality", sa.Boolean(), False),
        ("match_character_depth_prompt", sa.Boolean(), False),
        ("match_scenario", sa.Boolean(), False),
        ("match_creator_notes", sa.Boolean(), False),
        ("vectorized", sa.Boolean(), False),
        ("group_override", sa.Boolean(), False),
        ("group_weight", sa.Integer(), 0),
        ("add_memo", sa.Boolean(), False),
        ("decorators", sa.Text(), None),
    ]
    for col_name, col_type, default in new_columns:
        if not _column_exists(table, col_name):
            kwargs = {"nullable": True}
            if default is not None:
                kwargs["server_default"] = sa.text(str(default))
            op.add_column(table, sa.Column(col_name, col_type, **kwargs))

    if not _table_exists("session_worldbook_entry_states"):
        op.create_table(
            "session_worldbook_entry_states",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("session_id", sa.String(), nullable=False),
            sa.Column("entry_id", sa.String(), nullable=False),
            sa.Column("sticky_remaining", sa.Integer(), server_default=sa.text("0"), nullable=True),
            sa.Column("cooldown_remaining", sa.Integer(), server_default=sa.text("0"), nullable=True),
            sa.Column("delay_remaining", sa.Integer(), server_default=sa.text("0"), nullable=True),
            sa.Column("last_activated_message_index", sa.Integer(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=True),
            sa.Column("updated_at", sa.DateTime(), nullable=True),
            sa.ForeignKeyConstraint(["entry_id"], ["world_book_stages.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["session_id"], ["character_chat_sessions.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("session_id", "entry_id", name="uq_session_entry_state"),
        )


def downgrade() -> None:
    table = "world_book_stages"
    columns_to_drop = [
        "enabled", "case_sensitive", "match_whole_words", "selective_logic",
        "sticky", "cooldown", "delay", "depth", "order",
        "exclude_recursion", "prevent_recursion",
        "match_persona_description", "match_character_description",
        "match_character_personality", "match_character_depth_prompt",
        "match_scenario", "match_creator_notes",
        "vectorized", "group_override", "group_weight", "add_memo", "decorators",
    ]
    for col_name in columns_to_drop:
        if _column_exists(table, col_name):
            op.drop_column(table, col_name)

    if _table_exists("session_worldbook_entry_states"):
        op.drop_table("session_worldbook_entry_states")
