"""真实卡片数据离线验证 depth=0 路由修复（只读，不落库）。

用法：把本脚本 docker cp 进后端容器后执行，参数为「角色 id」与「会话 id」：
    docker cp backend/scripts/_verify_depth_zero_real_card.py palink-ai-backend-1:/tmp/_v.py
    MSYS_NO_PATHCONV=1 docker exec -e PYTHONPATH=/app palink-ai-backend-1 \
        sh -c 'cd /app && python /tmp/_v.py <character_id> <session_id>'

判定：DEPTHS 全部为 0 且 ANY_FOUR=False。改动前此处为 [4,4,4,4,4]。
"""

import sys

sys.path.insert(0, "/app")
from app.core.database import SessionLocal  # noqa: E402
from app.models.character import Character  # noqa: E402
from app.services.worldbook_service import build_worldbook_context  # noqa: E402

CHAR_ID = sys.argv[1]
SESSION_ID = sys.argv[2]

db = SessionLocal()
char = db.query(Character).filter(Character.id == CHAR_ID).first()
if char is None:
    print("CHAR_NOT_FOUND=" + CHAR_ID)
    sys.exit(1)

result = build_worldbook_context(
    db=db,
    session_id=SESSION_ID,
    user_id=char.user_id,
    recent_messages=[{"role": "user", "content": "探针"}],
    character=char,
    enable_timed_effects=False,
)
depths = [d for d, _c, _r in result.depth_entries]
print("CHAR=", char.name)
print("DEPTH_ENTRIES_COUNT=", len(result.depth_entries))
print("DEPTHS=", depths)
print("ALL_ZERO=", all(d == 0 for d in depths) if depths else "NO_DEPTH_ENTRIES")
print("ANY_FOUR=", 4 in depths)