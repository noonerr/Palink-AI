# -*- coding: utf-8 -*-
"""容器内模拟 MVU user tail 注入逻辑"""
import sys
sys.stdout.reconfigure(encoding='utf-8')
import asyncio

from app.core.database import SessionLocal
from app.models import CharacterChatSession, Character
from app.services.status_bar_detector import _card_has_mvu_scripts

SESSION_ID = 'c0c2adae-8d41-4601-a1c3-dcf4f62caf1a'

async def main():
    db = SessionLocal()
    try:
        s = db.query(CharacterChatSession).filter(CharacterChatSession.id == SESSION_ID).first()
        char = db.query(Character).filter(Character.id == s.character_id).first()
        is_mvu = _card_has_mvu_scripts(char)
        print('is_mvu:', is_mvu)
        messages = [{'role': 'user', 'content': '开始'}]
        if is_mvu:
            instr = '\n\n【变量更新指令 - 强制，不可省略】...<UpdateVariable>...'
            for _m in reversed(messages):
                if _m.get('role') == 'user':
                    if isinstance(_m.get('content'), str):
                        _m['content'] = _m['content'].rstrip() + instr
                    break
        print('after:', messages[0]['content'][:60])
        print('has 变量更新指令:', '变量更新指令' in messages[0]['content'])
    finally:
        db.close()

asyncio.run(main())
