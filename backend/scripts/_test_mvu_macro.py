# -*- coding: utf-8 -*-
import sys
sys.stdout.reconfigure(encoding='utf-8')
from app.services.macro_service import _format_status_current_variable_ref, _STATUS_CURRENT_VAR_RE

text = '---\n<status_current_variable>\n{"世界信息": {"日期时间": "2026年04月11日"}}\n</status_current_variable>\n---'
r = _STATUS_CURRENT_VAR_RE.sub(_format_status_current_variable_ref, text)
print('RESULT:', r)
assert 'status_current_variable>' not in r
assert '仅供 AI 参考' in r
print('OK - tag converted')

# 测试 evaluate_macros 走宏替换 + 标签转换（用真实会话 stat_data）
import asyncio
from app.core.database import SessionLocal
from app.models import CharacterChatSession
from app.services.macro_service import MacroEnv, evaluate_macros

def main():
    db = SessionLocal()
    try:
        s = db.query(CharacterChatSession).order_by(CharacterChatSession.updated_at.desc()).first()
        env = MacroEnv(db=db, session_id=s.id, user_id=1)
        tpl = '<status_current_variable>\n{{format_message_variable::stat_data}}\n</status_current_variable>'
        out = evaluate_macros(tpl, env)
        print('=== EVAL RESULT (first 400) ===')
        print(out[:400])
        assert 'status_current_variable>' not in out
        assert '桃汐' in out or '世界信息' in out
        print('OK - macro resolved + tag converted')
    finally:
        db.close()

main()
