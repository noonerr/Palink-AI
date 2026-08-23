# -*- coding: utf-8 -*-
"""容器内验证：world book constant entry（变量输出格式）是否被注入提示词"""
import sys, json
sys.stdout.reconfigure(encoding='utf-8')

from app.core.database import SessionLocal
from app.models import CharacterChatSession, Character, User
from app.services.worldbook_service import build_worldbook_context

db = SessionLocal()
try:
    # 用用户最近的真实会话
    session = db.query(CharacterChatSession).filter(
        CharacterChatSession.id == 'afba5c30-40af-4c37-be99-ae50eb914692'
    ).first()
    if not session:
        print('SESSION_NOT_FOUND')
        sys.exit(1)
    char = db.query(Character).filter(Character.id == session.character_id).first()
    user = db.query(User).filter(User.id == session.user_id).first()
    print(f'session={session.id} char={char.name if char else None} user_id={user.id if user else None}')

    result = build_worldbook_context(
        db=db,
        session_id=session.id,
        user_id=user.id if user else 0,
        recent_messages=[],
        character=char,
        character_name=char.name if char else '',
        character_tags=None,
    )
    print('=== ACTIVATED ENTRIES ===')
    for rep in result.debug_report:
        if rep.status == 'activated':
            print(f'  [activated] reason={rep.reason} title={rep.title}')
    print('=== TEXT LENGTH ===')
    print(f'  text len = {len(result.text)}')
    print('=== 是否包含 变量输出格式 ===')
    print(f'  has 变量输出格式: {"变量输出格式" in result.text}')
    print(f'  has UpdateVariable: {"UpdateVariable" in result.text}')
    print(f'  has <status>: {"<status>" in result.text}')
    # 打印含 UpdateVariable 的片段
    idx = result.text.find('变量输出格式')
    if idx >= 0:
        print('=== 片段 ===')
        print(result.text[idx:idx+300])
    else:
        print('=== TEXT HEAD ===')
        print(result.text[:400])
finally:
    db.close()
