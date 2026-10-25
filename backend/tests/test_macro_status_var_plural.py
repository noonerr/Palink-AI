"""护栏标签单复数回归锁（2026-10-25）。

macro_service 的【当前变量状态】护栏重写（严禁把变量快照抄进正文）此前只匹配
单数 <status_current_variable>，MVU 卡实际在场的是复数 <status_current_variables>
（如露缇雅 c28061bb），护栏对这类卡从不生效。现正则容 variable(s)?，单复数均触发。

走真实入口 evaluate_macros（与生产调用点同链：roleplay_prompt_assembly
对全部消息 evaluate_macros_in_messages → evaluate_macros）。

运行: cd backend && py -3 -m pytest tests/test_macro_status_var_plural.py -q
"""

import os
import sys
from unittest.mock import MagicMock

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.services.macro_service import MacroEnv, evaluate_macros  # noqa: E402

# 扁平 JSON（无连续 }}，不会撞 MACRO_PATTERN 的 {{...}} 宏形态）
VAR_BODY = '{"爱意": 5, "魔力值": 60}'


def _eval(text):
    return evaluate_macros(text, MacroEnv(db=MagicMock()))


class TestStatusCurrentVarPlural:
    def test_plural_tag_triggers_guard_rewrite(self):
        """复数标签（MVU 卡在场形态）触发【当前变量状态】护栏重写。"""
        out = _eval(f"<status_current_variables>\n{VAR_BODY}\n</status_current_variables>")
        assert "【当前变量状态】" in out, "复数标签未触发护栏重写（单复数失配）"
        assert "严格禁止" in out, "护栏语必须随重写带上"
        assert VAR_BODY in out, "快照 body 保留作参考"
        assert "<status_current_variables>" not in out and "</status_current_variables>" not in out

    def test_singular_tag_still_triggers_guard_rewrite(self):
        """单数标签回归：重写行为与改前一致。"""
        out = _eval(f"<status_current_variable>{VAR_BODY}</status_current_variable>")
        assert "【当前变量状态】" in out
        assert VAR_BODY in out
        assert "<status_current_variable>" not in out and "</status_current_variable>" not in out

    def test_empty_body_rewrites_to_empty(self):
        """空 body → 整段替换为空（_format_status_current_variable_ref 既有行为）。"""
        assert _eval("<status_current_variables></status_current_variables>") == ""

    def test_plain_text_untouched(self):
        """无标签文本零改动（护栏不误伤正文）。"""
        text = "【当前变量状态】（正文里出现这几个字不算标签，应原样保留）"
        assert _eval(text) == text
