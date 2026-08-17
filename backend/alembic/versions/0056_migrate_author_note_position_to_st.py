"""migrate author_note_position values to ST 1.18.0 semantics

Revision ID: 0056_migrate_author_note_position_to_st
Revises: 0055_add_group_chat_st1180_fields
Create Date: 2026-07-24

Aligns Palink's ``author_note_position`` integer values with SillyTavern
1.18.0's ``extension_prompt_types`` enum (``script.js``):

    ST 1.18.0 (target):                Palink (old, pre-migration):
      -1 = NONE  (skip injection)        0 = in story (depth insertion)
       0 = IN_PROMPT (after post-H)      1 = after post-history
       1 = IN_CHAT (in-chat at depth)    2 = last in chat
       2 = BEFORE_PROMPT (before story)  3 = inactive
                                        4 = top of chat

Note how Palink's 0/1 are SWAPPED relative to ST, and Palink's 2/4 have no
direct ST equivalent. Migration value mapping (old -> new):

    0 -> 1   (in story / depth        -> IN_CHAT,    same depth-insertion behavior)
    1 -> 0   (after post-history      -> IN_PROMPT,  same after-post-history behavior)
    2 -> 0   (last in chat            -> IN_PROMPT,  closest ST "end-of-prompt" equivalent)
    3 -> -1  (inactive                -> NONE,       same skip behavior)
    4 -> 2   (top of chat             -> BEFORE_PROMPT, closest "at-start" equivalent)

The default (NULL -> read as 1) is preserved: ST's DEFAULT_POSITION is 1
(IN_CHAT), so new rows keep ``default=1`` and now mean IN_CHAT — matching ST.
Existing rows with explicit old-1 ("after") migrate to 0 (IN_PROMPT) and
keep their "after post-history" behavior.

Applied to:
    1. ``user_settings.author_note_position`` (Integer column) — primary storage.
    2. ``character_chat_sessions.extensions`` JSON — IF the column exists; per-chat
       overrides set by ``/note-position`` (Phase G). Defensive: skipped if absent.

NOT applied to:
    - ``character_chat_sessions.chat_metadata.note_position`` — ST-imported chats
      already use ST semantics; converting would corrupt them.

Idempotency: relies on alembic's single-execution guarantee. The old value
set {0,1,2,3,4} overlaps with the new set {-1,0,1,2} on {0,1,2}, so a second
manual run would re-map and corrupt; do not re-run manually.
"""
from alembic import op
import sqlalchemy as sa


revision = '0056_migrate_author_note_position_to_st'
down_revision = '0055_add_group_chat_st1180_fields'
branch_labels = None
depends_on = None


# Old Palink value -> new ST-aligned value
_VALUE_MAP = {
    0: 1,    # in story / depth -> IN_CHAT
    1: 0,    # after post-history -> IN_PROMPT
    2: 0,    # last in chat -> IN_PROMPT
    3: -1,   # inactive -> NONE
    4: 2,    # top of chat -> BEFORE_PROMPT
}


def _table_exists(table_name: str) -> bool:
    bind = op.get_bind()
    return table_name in sa.inspect(bind).get_table_names()


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    if table_name not in sa.inspect(bind).get_table_names():
        return False
    return any(c["name"] == column_name for c in sa.inspect(bind).get_columns(table_name))


def _convert_extensions_json(bind, table_name: str, id_col: str, ext_col: str) -> None:
    """Parse ``<ext_col>`` JSON on every row of ``<table_name>`` and remap an
    ``author_note_position`` integer key from Palink semantics to ST semantics.

    Rows whose JSON has no such key, or whose value is not in the old set, are
    left untouched. Uses Python-side iteration so the JSON parse/edit/dump is
    dialect-agnostic (works on both SQLite and Postgres).
    """
    select_sql = sa.text(f"SELECT {id_col}, {ext_col} FROM {table_name}")
    results = bind.execute(select_sql).fetchall()
    if not results:
        return
    update_sql = sa.text(f"UPDATE {table_name} SET {ext_col} = :val WHERE {id_col} = :rid")
    changed = 0
    for row_id, raw in results:
        if not raw:
            continue
        try:
            import json
            data = json.loads(raw) if isinstance(raw, str) else raw
        except (ValueError, TypeError):
            continue
        if not isinstance(data, dict):
            continue
        key = "author_note_position"
        if key not in data:
            continue
        try:
            old_val = int(data[key])
        except (TypeError, ValueError):
            continue
        if old_val not in _VALUE_MAP:
            continue
        data[key] = _VALUE_MAP[old_val]
        try:
            import json
            new_raw = json.dumps(data, ensure_ascii=False)
        except (TypeError, ValueError):
            continue
        bind.execute(update_sql, {"val": new_raw, "rid": row_id})
        changed += 1
    if changed:
        bind.info = dict(getattr(bind, "info", {}) or {})


def upgrade() -> None:
    bind = op.get_bind()

    # 1) user_settings.author_note_position (Integer column) — primary storage.
    if _table_exists("user_settings") and _column_exists("user_settings", "author_note_position"):
        # Single-pass CASE evaluated against the ORIGINAL value, so 0->1 and 1->0
        # do not cascade. NULL is preserved (read-time default of 1 = ST IN_CHAT).
        bind.execute(
            sa.text(
                "UPDATE user_settings "
                "SET author_note_position = CASE "
                "WHEN author_note_position = 0 THEN 1 "
                "WHEN author_note_position = 1 THEN 0 "
                "WHEN author_note_position = 2 THEN 0 "
                "WHEN author_note_position = 3 THEN -1 "
                "WHEN author_note_position = 4 THEN 2 "
                "ELSE author_note_position END "
                "WHERE author_note_position IN (0, 1, 2, 3, 4)"
            )
        )

    # 2) character_chat_sessions.extensions JSON — per-chat overrides set by
    #    /note-position (Phase G). Defensive: skipped if the column is absent.
    if _table_exists("character_chat_sessions") and _column_exists("character_chat_sessions", "extensions"):
        _convert_extensions_json(bind, "character_chat_sessions", "id", "extensions")


def downgrade() -> None:
    """Reverse the mapping. New ST value -> old Palink value.

    Note: 0 (IN_PROMPT) is ambiguous — both old-1 ("after") and old-2 ("last")
    mapped to it. We restore to old-1 ("after"), which was the more common
    intent and matches the column default's original meaning.
    """
    bind = op.get_bind()
    reverse_map = {
        1: 0,    # IN_CHAT -> in story / depth
        0: 1,    # IN_PROMPT -> after post-history (old-1; old-2 is lost)
        -1: 3,   # NONE -> inactive
        2: 4,    # BEFORE_PROMPT -> top of chat
    }

    if _table_exists("user_settings") and _column_exists("user_settings", "author_note_position"):
        bind.execute(
            sa.text(
                "UPDATE user_settings "
                "SET author_note_position = CASE "
                "WHEN author_note_position = 1 THEN 0 "
                "WHEN author_note_position = 0 THEN 1 "
                "WHEN author_note_position = -1 THEN 3 "
                "WHEN author_note_position = 2 THEN 4 "
                "ELSE author_note_position END "
                "WHERE author_note_position IN (-1, 0, 1, 2)"
            )
        )

    if _table_exists("character_chat_sessions") and _column_exists("character_chat_sessions", "extensions"):
        select_sql = sa.text("SELECT id, extensions FROM character_chat_sessions")
        results = bind.execute(select_sql).fetchall()
        update_sql = sa.text("UPDATE character_chat_sessions SET extensions = :val WHERE id = :rid")
        import json
        for row_id, raw in results:
            if not raw:
                continue
            try:
                data = json.loads(raw) if isinstance(raw, str) else raw
            except (ValueError, TypeError):
                continue
            if not isinstance(data, dict) or "author_note_position" not in data:
                continue
            try:
                cur_val = int(data["author_note_position"])
            except (TypeError, ValueError):
                continue
            if cur_val not in reverse_map:
                continue
            data["author_note_position"] = reverse_map[cur_val]
            try:
                new_raw = json.dumps(data, ensure_ascii=False)
            except (TypeError, ValueError):
                continue
            bind.execute(update_sql, {"val": new_raw, "rid": row_id})
