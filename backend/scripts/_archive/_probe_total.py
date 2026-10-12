"""探针 v15：算清两件事
(a) 该书全部常驻条目（at-depth constant）的 token 总量 vs 模型窗口 4096
(b) 100% 预算下实际能装下哪几条
只读。
"""
import os
import sys

sys.path.insert(0, "/app")
os.environ.setdefault("DATABASE_URL", "postgresql+psycopg://ai_user:ai_pass@db:5432/ai_hub")

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models.worldbook import WorldBookStage
from app.services.worldbook_service import _estimate_tokens

BOOK = "0d10b4a2-113e-41fc-84a0-8679839a5dac"
CTX = 4096

eng = create_engine(os.environ["DATABASE_URL"])
S = sessionmaker(bind=eng)
db = S()

all_e = db.query(WorldBookStage).filter(WorldBookStage.world_book_id == BOOK).all()
depth_const = [e for e in all_e if (e.position or 4) == 4 and e.constant and e.enabled]
depth_const.sort(key=lambda e: -(e.order or 0))

tot = sum(_estimate_tokens(e.content or "") for e in depth_const)
print(f"(a) at-depth 常驻条目 {len(depth_const)} 条，合计 {tot} token")
print(f"    模型窗口 {CTX} → 全量装入需要窗口 ≥ {tot}，当前是窗口的 {tot / CTX:.1f} 倍")
print()

for pct in (25, 40, 60, 80, 100):
    budget = int(CTX * pct / 100)
    used = 0
    kept, dropped = [], []
    for e in depth_const:
        est = _estimate_tokens(e.content or "")
        if used + est > budget:
            dropped.append((e, est))
        else:
            used += est
            kept.append((e, est))
    cg_kept = any("<cg" in (e.content or "") for e, _ in kept)
    print(f"预算{pct:>3}% = {budget:>5}  装下 {len(kept):>2}/{len(depth_const)} 条  "
          f"实耗 {used:>5}  <cg>规范={'在' if cg_kept else '被裁'}  "
          f"丢:{[str(e.title)[:12] for e, _ in dropped]}")

print()
print("(b) 100% 预算也装不下的部分 =", tot - used, "token")
db.close()