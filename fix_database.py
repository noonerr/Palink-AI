import sqlite3
import os

DB_PATH = os.path.join(os.path.dirname(__file__), 'backend', 'data', 'palink.db')

def add_missing_columns():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='character_chat_session_branches'")

    if not cursor.fetchone():
        print("Table not found")
        conn.close()
        return

    cursor.execute("PRAGMA table_info(character_chat_session_branches)")
    existing_columns = {row[1] for row in cursor.fetchall()}
    print(f"Existing columns: {existing_columns}")

    columns_to_add = [
        ("is_frozen", "BOOLEAN DEFAULT 0"),
        ("is_favorited", "BOOLEAN DEFAULT 0"),
        ("last_message_at", "DATETIME"),
    ]

    added = []
    for col_name, col_def in columns_to_add:
        if col_name not in existing_columns:
            try:
                cursor.execute(f"ALTER TABLE character_chat_session_branches ADD COLUMN {col_name} {col_def}")
            print(f"Added column: {col_name}")
              added.append(col_name)
            except Exception as e:
                print(f"Failed to add {col_name}: {e}")
        else:
          print(f"Column {col_name} already exists")

    if "last_message_at" in added:
        try:
            cursor.execute("UPDATE character_chat_session_branches SET last_message_at = created_at WHERE last_message_at IS NULL")
         print("Set default last_message_at values")
        except Exception as e:
            print(f"Failed to set defaults: {e}")

    conn.commit()
    conn.close()

    if added:
        print(f"\nSuccessfully added {len(added)} columns")
    else:
        print("\nAll columns already exist")

if __name__ == "__main__":
    print("Fixing database...")
    print(f"Database path: {DB_PATH}")

    if not os.path.exists(DB_PATH):
        print(f"Database file not found: {DB_PATH}")
    else:
        add_missing_columns()
        print("\nDone! Please restart the backend service.")
