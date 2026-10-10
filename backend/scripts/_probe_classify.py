"""探针 v16：系统审计所有"会丢世界书内容"的裁剪路径。
重点验证 depth 注入的规范条目在 _collect_prompt_sources 里被识别成什么
identifier / priority / trimmable —— 它是 role=system 且不在任何特例分支里。
只读。
"""
import os
import sys

sys.path.insert(0, "/app")
os.environ.setdefault("DATABASE_URL", "postgresql+psycopg://ai_user:ai_pass@db:5432/ai_hub")

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models.character import Character
from app.models.worldbook import WorldBookStage
from app.services import roleplay_prompt_assembly as R

BOOK = "0d10b4a2-113e-41fc-84a0-8679839a5dac"

eng = create_engine(os.environ["DATABASE_URL"])
S = sessionmaker(bind=eng)
db = S()
char = db.query(Character).filter(Character.name == "露缇雅1.2").first()

# 构造一条"depth 注入"的典型消息：role=system，内容是 MVU 变量更新规则
real = (
    db.query(WorldBookStage)
    .filter(WorldBookStage.world_book_id == BOOK)
    .filter(WorldBookStage.title.like("%变量输出格式%"))
    .first()
)
content = real.content if real else "变量输出格式 rule: ..."
cg = (
    db.query(WorldBookStage)
    .filter(WorldBookStage.world_book_id == BOOK)
    .filter(WorldBookStage.title.like("%插图%"))
    .first()
)
print("取到真实条目:", real.title if real else None, "| 插图条目:", cg.title if cg else None)
print()

# 模拟装配结果：system 主提示词 + 若干历史 + depth 注入的规范
msgs = [
    {"role": "system", "content": "主提示词 Write next reply ..."},
    {"role": "user", "content": "消息1"},
    {"role": "assistant", "content": "回复1"},
    {"role": "system", "content": content, "_palink_in_chat_injection": True},
]
if cg:
    msgs.append({"role": "system", "content": cg.content, "_palink_in_chat_injection": True})

print("逐条分类结果：")
for i, m in enumerate(msgs):
    ident = R._classify_message_identifier(m, i, len(msgs), char)
    print(f"  [{i}] role={m['role']:<9} identifier={ident:<22} "
          f"len={len(m['content']):<5} head={m['content'][:44]!r}")

print()
srcs = R._collect_prompt_sources(msgs, char)
print("_collect_prompt_sources 优先级：")
for s in srcs:
    print(f"  idx={s.message_index} id={s.identifier:<22} prio={s.priority:<4} "
          f"trim={str(s.trimmable):<5} tok={s.token_count}")
db.close()