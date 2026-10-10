"""探针 v10：确认 8192 是真实模型窗口还是兜底，以及 token_budget 组成。只读。
"""
import os
import sys

sys.path.insert(0, "/app")
os.environ.setdefault("DATABASE_URL", "postgresql+psycopg://ai_user:ai_pass@db:5432/ai_hub")

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models.character import Character, CharacterChatSession
from app.models.user import User
from app.models.system import UserSetting
from app.services import roleplay_prompt_assembly as R

CHAR = "c44f2ae6-5922-454d-8069-06ba48dc4408"
SES = "40d9b7cc-fd8c-49dc-91de-3f4ed640c4ff"

eng = create_engine(os.environ["DATABASE_URL"])
S = sessionmaker(bind=eng)
db = S()
char = db.query(Character).filter(Character.id == CHAR).first()
sess = db.query(CharacterChatSession).filter(CharacterChatSession.id == SES).first()
user = db.query(User).filter(User.id == sess.user_id).first()
us = db.query(UserSetting).filter(UserSetting.user_id == user.id).first()

model = None
print("会话里的模型字段:", getattr(sess, "model", None), "| character.model:",
      getattr(char, "model", None))

print()
print("openai_max_context (用户设置):",
      R._get_openai_max_context_override(us, getattr(sess, "model", None), char.id)
      if hasattr(R, "_get_openai_max_context_override") else "N/A")

for m in [getattr(sess, "model", None), None]:
    if m is None:
        continue
    print(f"model={m!r} -> _get_model_context_window = {R._get_model_context_window(m)}")

print()
print("DEFAULT_MODEL_CONTEXT / 兜底常量:")
for name in dir(R):
    if "CONTEXT" in name.upper() and name.isupper():
        print(f"  {name} = {getattr(R, name)}")

print()
tb = R._compute_prompt_token_budget(getattr(sess, "model", None), 1024)
print("_compute_prompt_token_budget(model, 1024) =", tb)
db.close()