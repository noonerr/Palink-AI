import sqlite3, sys
c = sqlite3.connect('backend/data/palink.db')
cur = c.cursor()
cur.execute("SELECT id, name FROM characters LIMIT 20")
print("CHARACTERS:", cur.fetchall())
cur.execute("SELECT id, character_id, title FROM character_chat_sessions ORDER BY updated_at DESC LIMIT 20")
sessions = cur.fetchall()
print("SESSIONS:", sessions)
for sid, _, _ in sessions:
    cur.execute("SELECT id, mesid, role, is_user, substr(content,1,2000) FROM character_chat_messages WHERE session_id=? ORDER BY id", (sid,))
    rows = cur.fetchall()
    print(f"\n=== SESSION {sid} ===")
    for row in rows:
        print("id=", row[0], "mesid=", row[1], "role=", row[2], "is_user=", row[3])
        print("  CONTENT_START:", repr(row[4][:1500]))
        print("  CONTENT_END:", repr(row[4][-300:]))