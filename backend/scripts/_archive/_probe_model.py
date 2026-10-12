"""探针 v11：查真实会话用的模型 + 该模型的真实上下文窗口 + 真实世界书预算。只读。
"""
import os
import sys

sys.path.insert(0, "/app")
os.environ.setdefault("DATABASE_URL", "postgresql+psycopg://ai_user:ai_pass@db:5432/ai_hub")

from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from app.services import roleplay_prompt_assembly as R

SES = "40d9b7cc-fd8c-49dc-91de-3f4ed640c4ff"

eng = create_engine(os.environ["DATABASE_URL"])
S = sessionmaker(bind=eng)
db = S()

print("### 最近 AI 消息记录的模型")
rows = db.execute(
    text(
        "SELECT role, model, left(content, 40) AS c, created_at "
        "FROM character_chat_messages WHERE session_id = :s "
        "AND role = 'assistant' ORDER BY created_at DESC LIMIT 6"
    ),
    {"s": SES},
).fetchall()
for r in rows:
    print(f"  model={r.model!r} :: {r.c!r}")

print()
print("### 模型注册表里的 context_length")
try:
    rows2 = db.execute(
        text(
            "SELECT model_name, context_length FROM model_configs "
            "ORDER BY context_length DESC LIMIT 10"
        )
    ).fetchall()
    for r in rows2:
        print(f"  {r.model_name!r} ctx={r.context_length}")
except Exception as e:
    print("  model_configs 查询失败:", e)

print()
models = [r.model for r in rows if r.model]
seen = set()
for m in models:
    if m in seen:
        continue
    seen.add(m)
    w = R._get_model_context_window(m)
    print(f"_get_model_context_window({m!r}) = {w}"
          f"  → 25% 预算 = {None if not w else round(w * 0.25)}")
db.close()