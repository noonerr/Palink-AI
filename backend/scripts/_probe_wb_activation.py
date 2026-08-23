# -*- coding: utf-8 -*-
"""探针：统计 build_worldbook_context 内 record_activation 的 insert/update"""
import sys
sys.stdout.reconfigure(encoding='utf-8')
import traceback

import app.services.worldbook_service as wb
from app.core.database import SessionLocal
from app.models import CharacterChatSession, Character

SESSION_ID = '389cae42-d42b-4215-94c7-d671aa9c5cfd'

# 记录原始方法
_orig_record = wb.TimedEffectsManager.record_activation
stats = {'insert': [], 'update': [], 'total': 0}

def patched_record(self, entry, message_index):
    stats['total'] += 1
    state = self.get_state(entry.id)
    branch = 'update' if state else 'insert'
    stats[branch].append((entry.id, entry.title or ''))
    # 直接调用原始逻辑，但临时开启 autoflush 修复？不，保持原逻辑观察
    _orig_record(self, entry, message_index)

wb.TimedEffectsManager.record_activation = patched_record

def main():
    db = SessionLocal()
    try:
        s = db.query(CharacterChatSession).filter(CharacterChatSession.id == SESSION_ID).first()
        char = db.query(Character).filter(Character.id == s.character_id).first()
        from app.services.worldbook_service import build_worldbook_context
        try:
            r = build_worldbook_context(db=db, session_id=SESSION_ID, user_id=s.user_id,
                recent_messages=[{'role': 'user', 'content': '666'}], character=char)
            print('build OK len:', len(r.text) if r.text else 0)
        except Exception as e:
            print('build EXC:', type(e).__name__, str(e)[:150])
            traceback.print_exc()
        print('=== record_activation 统计 ===')
        print('total:', stats['total'])
        print('insert count:', len(stats['insert']))
        print('update count:', len(stats['update']))
        from collections import Counter
        insert_ids = Counter(e[0] for e in stats['insert'])
        dup = {k: v for k, v in insert_ids.items() if v > 1}
        print('重复 insert 的 entry:', dup)
        for eid, title in stats['insert'][:10]:
            print(f'  INSERT {eid[:8]} {title[:20]}')
        # 检查 DB 是否已有这些 insert 的 id
        from app.models.worldbook import SessionWorldBookEntryState
        db_rows = {r.entry_id for r in db.query(SessionWorldBookEntryState).filter(
            SessionWorldBookEntryState.session_id == SESSION_ID).all()}
        hit = [eid for eid, _ in stats['insert'] if eid in db_rows]
        print('insert 中已在 DB 的:', len(hit), hit[:5])
        db.rollback()
    finally:
        db.close()

main()
