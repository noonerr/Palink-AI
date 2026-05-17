"""
Manual database migration script
Add custom prompt fields to user_settings table
"""
import sqlite3
import os

# Database path
db_path = os.path.join(os.path.dirname(__file__), 'palink.db')

if not os.path.exists(db_path):
    print(f"Database file not found: {db_path}")
    exit(1)

print(f"Connecting to database: {db_path}")
conn = sqlite3.connect(db_path)
cursor = conn.cursor()

# Get current columns
cursor.execute("PRAGMA table_info(user_settings)")
columns = [row[1] for row in cursor.fetchall()]
print(f"\nCurrent columns: {columns}")

# Add new columns
columns_to_add = [
    ('custom_chat_prompt_zh', 'TEXT'),
    ('custom_chat_prompt_en', 'TEXT'),
    ('custom_character_prompt_zh', 'TEXT'),
    ('custom_character_prompt_en', 'TEXT'),
  ('use_custom_prompts', 'BOOLEAN DEFAULT 0'),
]

for col_name, col_type in columns_to_add:
    if col_name not in columns:
        sql = f"ALTER TABLE user_settings ADD COLUMN {col_name} {col_type}"
     print(f"\nExecuting: {sql}")
        try:
            cursor.execute(sql)
            conn.commit()
            print(f"[OK] Added column: {col_name}")
        except Exception as e:
          print(f"[ERROR] Failed to add column: {col_name}, error: {e}")
    else:
      print(f"[SKIP] Column already exists: {col_name}")

# Verify
cursor.execute("PRAGMA table_info(user_settings)")
columns = [row[1] for row in cursor.fetchall()]
print(f"\nUpdated columns: {columns}")

conn.close()
print("\n[SUCCESS] Migration completed!")
