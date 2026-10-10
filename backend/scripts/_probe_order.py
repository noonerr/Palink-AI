"""探针 v14：验证 ST 排序下的预算裁剪顺序。
关键问题：order=200 的最大条目是否第一条就把预算吃光，导致 order 更低的 <cg> 规范被裁。
只读。
"""
import os
import sys

sys.path.insert(0, "/app")
os.environ.setdefault("DATABASE_URL", "postgresql+psycopg://ai_user:ai_pass@db:5432/ai_hub")

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models.character import Character, CharacterChatSession
from app.models.user import User
from app.models.worldbook import WorldBookStage
from app.services.worldbook_service import _estimate_tokens

CHAR = "c44f2ae6-5922-454d-8069-06ba48dc4408"
SES = "40d9b7cc-fd8c-49dc-91de-3f4ed640c4ff"
BOOK = "0d10b4a2-113e-41fc-84a0-8679839a5dac"

eng = create_engine(os.environ["DATABASE_URL"])
S = sessionmaker(bind=eng)
db = S()
char = db.query(Character).filter(Character.id == CHAR).first()
sess = db.query(CharacterChatSession).filter(CharacterChatSession.id == SES).first()
user = db.query(User).filter(User.id == sess.user_id).first()

entries = (
    db.query(WorldBookStage)
    .filter(WorldBookStage.world_book_id == BOOK)
    .filter(WorldBookStage.enabled == True)  # noqa: E712
    .all()
)
# 只看 position=4 (atDepth) 且 constant 的（该卡这些才是常驻注入的）
cand = [e for e in entries if (e.position or 4) == 4 and e.constant]

# ST sortFn: b.order - a.order 降序
cand.sort(key=lambda e: -(e.order or 0))

print("ST 排序后（order 降序）逐条预算消耗模拟：")
print("  预算 = 4096 * 25% = 1024 token")
print()
used = 0
budget = 1024
overflow = False
for e in cand:
    est = _estimate_tokens(e.content or "")
    mark = ""
    if e.ignore_budget:
        mark = " [ignore_budget → 永远保留]"
    elif overflow:
        mark = " ← 被裁(预算已溢出)"
    elif used + est > budget:
        overflow = True
        mark = f" ← 被裁(装不下: used={used} + est={est} > {budget})"
    else:
        used += est
    cg = " ★<cg>规范" if "<cg" in (e.content or "") else ""
    print(f"  order={e.order:<7} tok={est:<5} used_before={used if '被裁' in mark else used - (0 if '被裁' in mark else est):<5} "
          f"{str(e.title)[:24]:<26}{cg}{mark}")

print()
print("结论：")
print(f"  能装下的条目数 = {sum(1 for e in cand if not e.ignore_budget and used >= 0 and _estimate_tokens(e.content or '') <= budget)}")
print(f"  <cg> 规范(order=110) 在 ST 排序中排第 "
      f"{[e.order for e in cand].index(110) + 1 if 110 in [e.order for e in cand] else '?'} 位")
db.close()