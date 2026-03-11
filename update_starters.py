import psycopg2
import json

conn = psycopg2.connect(
    host="localhost",
    port=5432,
    database="ai_hub",
    user="ai_user",
    password="ai_password"
)

cur = conn.cursor()

# 查询是否存在
cur.execute("SELECT key FROM system_settings WHERE key = 'starter_questions'")
result = cur.fetchone()

new_questions = [
    "如果你能瞬间掌握一项冷门技能，你会选择什么？为什么？",
    "你希望亲眼见证哪个历史事件？",
    "如果动物能说话，你觉得哪个物种会最没礼貌？",
    "你听过什么有趣的理论希望它是真的？"
]

if result:
    cur.execute(
        "UPDATE system_settings SET value = %s WHERE key = 'starter_questions'",
        (json.dumps(new_questions, ensure_ascii=False),)
    )
else:
    cur.execute(
        "INSERT INTO system_settings (key, value) VALUES ('starter_questions', %s)",
        (json.dumps(new_questions, ensure_ascii=False),)
    )

conn.commit()
print("Updated successfully!")

# 验证
cur.execute("SELECT value FROM system_settings WHERE key = 'starter_questions'")
print(cur.fetchone())

cur.close()
conn.close()
