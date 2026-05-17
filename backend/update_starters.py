import psycopg2
import json
import os

# Use environment variables for database credentials
conn = psycopg2.connect(
    host=os.getenv("DB_HOST", "db"),
    port=int(os.getenv("DB_PORT", "5432")),
    database=os.getenv("DB_NAME", "ai_hub"),
    user=os.getenv("DB_USER", "ai_user"),
    password=os.getenv("DB_PASSWORD")
)

if not os.getenv("DB_PASSWORD"):
    raise ValueError("DB_PASSWORD environment variable is required")

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
