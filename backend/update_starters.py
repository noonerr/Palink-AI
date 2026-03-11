import psycopg2
import json

conn = psycopg2.connect(
    host="db",
    port=5432,
    database="ai_hub",
    user="ai_user",
    password="ai_password"
)

cur = conn.cursor()

new_questions = [
    "如果你能瞬间掌握一项冷门技能，你会选择什么？为什么？",
    "你希望亲眼见证哪个历史事件？",
    "如果动物能说话，你觉得哪个物种会最没礼貌？",
    "你听过什么有趣的理论希望它是真的？"
]

# 更新或插入
cur.execute("SELECT 1 FROM settings WHERE key = 'starter_questions'")
if cur.fetchone():
    cur.execute(
        "UPDATE settings SET value = %s WHERE key = 'starter_questions'",
        (json.dumps(new_questions, ensure_ascii=False),)
    )
else:
    cur.execute(
        "INSERT INTO settings (key, value) VALUES ('starter_questions', %s)",
        (json.dumps(new_questions, ensure_ascii=False),)
    )

conn.commit()
print("Updated successfully!")

cur.close()
conn.close()
