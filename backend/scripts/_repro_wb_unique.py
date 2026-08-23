# -*- coding: utf-8 -*-
"""复现 worldbook UniqueViolation，抓完整堆栈"""
import sys
sys.stdout.reconfigure(encoding='utf-8')
import traceback

from app.core.database import SessionLocal
from app.models import CharacterChatSession, Character
from app.services.worldbook_service import build_worldbook_context

SESSION_ID = '389cae42-d42b-4215-94c7-d671aa9c5cfd'

def main():
    db = SessionLocal()
    try:
        s = db.query(CharacterChatSession).filter(CharacterChatSession.id == SESSION_ID).first()
        char = db.query(Character).filter(Character.id == s.character_id).first()
        print('session:', SESSION_ID, 'char:', char.name)
        try:
            result = build_worldbook_context(
                db=db,
                session_id=SESSION_ID,
                user_id=s.user_id,
                recent_messages=[{'role': 'user', 'content': '666'}],
                character=char,
            )
            print('OK text_len:', len(result.text) if result.text else 0)
        except Exception as e:
            print('EXCEPTION:', type(e).__name__, str(e)[:300])
            traceback.print_exc()
        # 检查状态行
        from app.models.worldbook import SessionWorldBookEntryState
        rows = db.query(SessionWorldBookEntryState).filter(
            SessionWorldBookEntryState.session_id == SESSION_ID).all()
        print('states in DB:', len(rows))
    finally:
        db.close()

main()
