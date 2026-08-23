# -*- coding: utf-8 -*-
"""模拟同一 db 会话连续两次 worldbook build（复现 UniqueViolation）"""
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
        print('=== 第 1 次 build ===')
        try:
            r1 = build_worldbook_context(db=db, session_id=SESSION_ID, user_id=s.user_id,
                recent_messages=[{'role': 'user', 'content': '开始'}], character=char)
            print('OK len:', len(r1.text) if r1.text else 0)
            db.commit()
            print('commit OK')
        except Exception as e:
            print('EXC1:', type(e).__name__, str(e)[:200])
            traceback.print_exc()
            db.rollback()

        print('=== 第 2 次 build（同一 db 会话）===')
        try:
            r2 = build_worldbook_context(db=db, session_id=SESSION_ID, user_id=s.user_id,
                recent_messages=[{'role': 'user', 'content': '666'}], character=char)
            print('OK len:', len(r2.text) if r2.text else 0)
            db.commit()
            print('commit OK')
        except Exception as e:
            print('EXC2:', type(e).__name__, str(e)[:200])
            traceback.print_exc()
    finally:
        db.close()

main()
