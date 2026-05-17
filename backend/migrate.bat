@echo off
chcp 65001 >nul
echo =====================================
echo Palink-AI Database Migration
echo Adding custom prompt fields...
echo ====================
echo.

cd /d "%~dp0"

python -c "import sqlite3; conn = sqlite3.connect('data/palink.db'); c = conn.cursor(); c.execute('PRAGMA table_info(user_settings)'); cols = [r[1] for r in c.fetchall()]; print('Current columns:', len(cols)); [c.execute(f'ALTER TABLE user_settings ADD COLUMN {col} TEXT') if col not in cols else None for col in ['custom_chat_prompt_zh', 'custom_chat_prompt_en', 'custom_character_prompt_zh', 'custom_character_prompt_en']]; c.execute('ALTER TABLE user_settings ADD COLUMN use_custom_prompts BOOLEAN DEFAULT 0') if 'use_custom_prompts' not in cols else None; conn.commit(); c.execute('PRAGMA table_info(user_settings)'); print('Updated columns:', len([r[1] for r in c.fetchall()])); conn.close(); print('Migration completed!')"

echo.
echo ============================
echo Migration completed!
echo Press any key to exit...
echo ========================
pause >nul
