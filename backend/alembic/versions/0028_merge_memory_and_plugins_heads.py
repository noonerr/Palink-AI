"""merge memory and plugins heads

Revision ID: 0028_merge_memory_and_plugins_heads
Revises: add_memory_tables, 0029_plugin_substitute_regex_integer
Create Date: 2026-06-08
"""
from typing import Sequence, Union


revision: str = "0028_merge_memory_and_plugins_heads"
down_revision: Union[str, Sequence[str], None] = ("add_memory_tables", "0029_plugin_substitute_regex_integer")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
