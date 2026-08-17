"""add ST 1.18.0 instruct template fields for Task 3.6 alignment

Revision ID: 0051_add_instruct_template_st1180_fields
Revises: 0050_add_extension_prompt_filter
Create Date: 2026-07-18

New columns on ``instruct_templates`` (all nullable, backward compatible):
- skip_examples (Boolean, default False) — ST 1.18.0: when True, dialogue
  examples are NOT wrapped with instruct sequences.
- names_behavior (String, default 'force') — ST 1.18.0 names_behavior_types
  enum: 'none' / 'force' / 'always'. Replaces the obsolete names /
  names_force_groups pair. 'force' preserves the legacy group-chat name
  injection behavior.
- system_sequence (String, default '') — ST 1.18.0 system message prefix
  sequence (replaces the obsolete system_sequence_prefix).
- system_suffix (String, default '') — ST 1.18.0 system message suffix
  sequence (replaces the obsolete system_sequence_suffix).
- last_system_sequence (String, default '') — ST 1.18.0 sequence used for
  the final system message in a generation.
- first_input_sequence (String, default '') — ST 1.18.0 first user input
  prefix (falls back to input_prefix when empty).
- last_input_sequence (String, default '') — ST 1.18.0 last user input
  prefix (falls back to input_prefix when empty).
- user_alignment_message (String, default '') — ST 1.18.0 user alignment
  message appended after the last output sequence.
- story_string_prefix (String, default '') — ST 1.18.0 story string prefix.
- story_string_suffix (String, default '') — ST 1.18.0 story string suffix.
- macro (Boolean, default False) — ST 1.18.0: when True, instruct sequences
  are run through substituteParams before being applied.
- system_same_as_user (Boolean, default False) — ST 1.18.0: when True,
  narrator/system messages use the user input prefix/suffix instead of the
  dedicated system_sequence/system_suffix.
- sequences_as_stop_strings (Boolean, default True) — ST 1.18.0: when True,
  non-empty instruct sequences are added to the stop strings passed to the
  model endpoint.

These fields bring the Palink InstructTemplate into alignment with
SillyTavern 1.18.0's ``instruct_presets`` schema. Existing rows keep their
current behavior because every new column defaults to the legacy value
(False / '' / 'force') and the prompt assembly reads them via ``getattr``
with the same fallbacks.
"""
from alembic import op
import sqlalchemy as sa


revision = '0051_add_instruct_template_st1180_fields'
down_revision = '0050_add_extension_prompt_filter'
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table_name not in inspector.get_table_names():
        return False
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


# (column_name, sa.Column) — new ST 1.18.0 instruct fields
_NEW_COLUMNS = [
    ("skip_examples", sa.Column("skip_examples", sa.Boolean(), nullable=False, server_default=sa.text("false"))),
    ("names_behavior", sa.Column("names_behavior", sa.String(), nullable=False, server_default="force")),
    ("system_sequence", sa.Column("system_sequence", sa.String(), nullable=False, server_default="")),
    ("system_suffix", sa.Column("system_suffix", sa.String(), nullable=False, server_default="")),
    ("last_system_sequence", sa.Column("last_system_sequence", sa.String(), nullable=False, server_default="")),
    ("first_input_sequence", sa.Column("first_input_sequence", sa.String(), nullable=False, server_default="")),
    ("last_input_sequence", sa.Column("last_input_sequence", sa.String(), nullable=False, server_default="")),
    ("user_alignment_message", sa.Column("user_alignment_message", sa.String(), nullable=False, server_default="")),
    ("story_string_prefix", sa.Column("story_string_prefix", sa.String(), nullable=False, server_default="")),
    ("story_string_suffix", sa.Column("story_string_suffix", sa.String(), nullable=False, server_default="")),
    ("macro", sa.Column("macro", sa.Boolean(), nullable=False, server_default=sa.text("false"))),
    ("system_same_as_user", sa.Column("system_same_as_user", sa.Boolean(), nullable=False, server_default=sa.text("false"))),
    ("sequences_as_stop_strings", sa.Column("sequences_as_stop_strings", sa.Boolean(), nullable=False, server_default=sa.text("true"))),
]


def upgrade() -> None:
    table_name = "instruct_templates"
    for column_name, column in _NEW_COLUMNS:
        if not _column_exists(table_name, column_name):
            op.add_column(table_name, column)


def downgrade() -> None:
    table_name = "instruct_templates"
    for column_name, _ in reversed(_NEW_COLUMNS):
        if _column_exists(table_name, column_name):
            op.drop_column(table_name, column_name)
