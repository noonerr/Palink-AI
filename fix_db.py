import sqlite3
import os

DB_PATH = os.path.join(os.path.dirname(__file__), 'backend', 'data', 'palink.db')

conn = sqlite3.connect(DB_PATH)
cursor = conn.cursor()

cursor.execute("PRAGMA table_info(character_chat_session_branches)")
existing_columns = {row[1] for row in cursor.fetchall()}
print(f"Existing columns: {existing_columns}")

columns = [
    ("is_frozen", "BOOLEAN DEFAULT 0"),
    ("is_favorited", "BOOLEAN DEFAULT 0"),
    ("last_message_at", "DATETIME"),
]

for col_name, col_def in columns:
    if col_name not in existing_columns:
    cursor.execute(f"ALTER TABLE character_chat_session_branches ADD COLUMN {col_name} {col_def}")
      print(f"Added: {col_name}")
    else:
        print(f"Exists: {col_name}")

cursor.execute("UPDATE character_chat_session_branches SET last_message_at = created_at WHERE last_message_at IS NULL")

conn.commit()
conn.close()
print("Done!")
