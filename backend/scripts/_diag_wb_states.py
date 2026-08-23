# -*- coding: utf-8 -*-
"""诊断 _load_all_states 为何查不到已有状态行"""
import sys
sys.stdout.reconfigure(encoding='utf-8')
import traceback

from app.core.database import SessionLocal
from app.models import CharacterChatSession, Character
from app.services.worldbook_service import TimedEffectsManager, build_worldbook_context
from app.models.worldbook import SessionWorldBookEntryState

SESSION_ID = '389cae42-d42b-4215-94c7-d671aa9c5cfd'

def main():
    db = SessionLocal()
    try:
        s = db.query(CharacterChatSession).filter(CharacterChatSession.id == SESSION_ID).first()
        char = db.query(Character).filter(Character.id == s.character_id).first()
        # 直接查 DB
        rows = db.query(SessionWorldBookEntryState).filter(
            SessionWorldBookEntryState.session_id == SESSION_ID).all()
        print('直接查询 DB rows:', len(rows))
        if rows:
            print('首行 entry_id:', rows[0].entry_id)
        # 通过 TimedEffectsManager 查（同 db 会话）
        mgr = TimedEffectsManager(db=db, session_id=SESSION_ID)
        states = mgr._load_all_states()
        print('mgr._load_all_states():', len(states))
        # 找激活的 entry 检查 get_state
        from app.models.worldbook import WorldBookStage
        entries = db.query(WorldBookStage).join(
            __import__('app.models.worldbook', fromlist=['WorldBook']).WorldBook,
            WorldBookStage.world_book_id == __import__('app.models.worldbook', fromlist=['WorldBook']).WorldBook.id,
        ).filter(
            __import__('app.models.worldbook', fromlist=['WorldBook']).WorldBook.character_id == s.character_id,
            WorldBookStage.enabled.is_(True),
        ).all()
        print('enabled entries:', len(entries))
        miss = [e.id for e in entries[:10] if e.id not in states]
        print('前 10 个 entry 中 get_state 查不到:', len(miss), miss[:3])
        # 检查是否 constant 条目
        for e in entries[:5]:
            print('  entry:', e.id[:8], 'constant=', e.constant, 'title=', (e.title or '')[:20])
    finally:
        db.close()

main()
