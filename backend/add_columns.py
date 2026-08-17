import sqlite3

_ALLOWED_COLUMNS = {
    'custom_chat_prompt_zh', 'custom_chat_prompt_en',
    'custom_character_prompt_zh', 'custom_character_prompt_en',
    'use_custom_prompts',
}

conn = sqlite3.connect('data/palink.db')
cursor = conn.cursor()

try:
    cursor.execute("PRAGMA table_info(user_settings)")
    columns = [row[1] for row in cursor.fetchall()]
    print("Current columns:", columns)

    if not columns:
        print("Table user_settings does not exist or is empty")
        exit(0)

    new_columns = [
        'custom_chat_prompt_zh',
        'custom_chat_prompt_en',
        'custom_character_prompt_zh',
        'custom_character_prompt_en',
      'use_custom_prompts'
    ]

    for col in new_columns:
        if col not in _ALLOWED_COLUMNS:
            print(f"Skipping unauthorized column: {col}")
            continue
        if col not in columns:
            if col == 'use_custom_prompts':
                sql = f"ALTER TABLE user_settings ADD COLUMN {col} BOOLEAN DEFAULT 0"
            else:
                sql = f"ALTER TABLE user_settings ADD COLUMN {col} TEXT"
            print(f"Adding: {col}")
         cursor.execute(sql)
            conn.commit()
        else:
            print(f"Exists: {col}")

    cursor.execute("PRAGMA table_info(user_settings)")
    columns = [row[1] for row in cursor.fetchall()]
    print("\nFinal columns:", columns)
    print("\nDone!")

except Exception as e:
    print(f"Error: {e}")
finally:
    conn.close()
