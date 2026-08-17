import sqlite3

_ALLOWED_COLUMNS = {
    'custom_chat_prompt_zh', 'custom_chat_prompt_en',
    'custom_character_prompt_zh', 'custom_character_prompt_en',
    'use_custom_prompts',
}

conn = sqlite3.connect('data/palink.db')
c = conn.cursor()

c.execute('PRAGMA table_info(user_settings)')
cols = [r[1] for r in c.fetchall()]
print('Current columns:', cols)

new_cols = ['custom_chat_prompt_zh', 'custom_chat_prompt_en', 'custom_character_prompt_zh', 'custom_character_prompt_en']
for col in new_cols:
    if col not in _ALLOWED_COLUMNS:
        print(f'Skipping unauthorized column: {col}')
        continue
    if col not in cols:
        print(f'Adding {col}...')
        c.execute(f'ALTER TABLE user_settings ADD COLUMN {col} TEXT')

if 'use_custom_prompts' not in _ALLOWED_COLUMNS:
    print('Skipping unauthorized column: use_custom_prompts')
elif 'use_custom_prompts' not in cols:
    print('Adding use_custom_prompts...')
    c.execute('ALTER TABLE user_settings ADD COLUMN use_custom_prompts BOOLEAN DEFAULT 0')

conn.commit()

c.execute('PRAGMA table_info(user_settings)')
final_cols = [r[1] for r in c.fetchall()]
print('Updated columns:', final_cols)
print('Migration completed!')

conn.close()
