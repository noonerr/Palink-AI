"""M33 校准段去重回归锁（2026-10-25）。

主脑裁定（P-DEC-5 再裁定＝去重落点）：【角色校准】保留锚定头句（语气/价值观
锚定意图），不再复读 characters.personality 正文——正文唯一消费点是 main 的
charPersonality 槽（M4），逐字双消费消除。非空门控不变（personality 为空则
整条不注入）。

走真实入口 build_character_chat_messages；M4 对照用传入的 system_prompt
模拟槽在场（charPersonality 槽正文直通 main 文本）。
真实装配层的对照（槽计数=1、校准不含正文）由
tests/test_d5b_slots.py::test_no_new_duplicate_calibration_header_only 承载。

运行: cd backend && py -3 -m pytest tests/test_m33_calibration_slim.py -q
"""

import os
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.services.character_message_builder import build_character_chat_messages  # noqa: E402

PERS_BODY = "PERSONALITY-BODY-遇到身体异变时先羞后迎，傲娇但重情"


def _mk_char(personality="", name="Char"):
    # SimpleNamespace 而非 MagicMock：builder 会读 char.jailbreak（MagicMock 的
    # 真值会幻影注入 jailbreak 消息，污染结构断言）。
    return SimpleNamespace(
        name=name,
        mes_example="",
        post_history_instructions="",
        personality=personality,
        description="描述",
        scenario="",
        background="",
        jailbreak=None,
        extensions=None,
    )


def _build(personality, system_prompt="MAIN-PROMPT", prompt_lang="zh"):
    return build_character_chat_messages(
        db=MagicMock(),
        char=_mk_char(personality=personality),
        user_nickname="User",
        session_id="sess-1",
        branch_id="branch-1",
        message="hello",
        images=[],
        system_prompt=system_prompt,
        dynamic_context_parts=[],
        prompt_lang=prompt_lang,
        user_setting=SimpleNamespace(),
        _replace_placeholders=lambda s, u, c: (s or ""),
        _get_full_branch_history=lambda db, sid, bid, limit: [],
        _contains_chinese=lambda s: True,
        normalize_image_url=lambda s: s,
    )


def _calib(msgs):
    return [m for m in msgs if m["role"] == "system" and m["content"].startswith("【角色校准】")]


class TestCalibrationSlim:
    def test_zh_header_without_body(self):
        """校准段＝锚定头句，不含 personality 正文；头句以句号收尾不悬空冒号。"""
        msgs = _build(PERS_BODY, system_prompt="性格：" + PERS_BODY)
        calib = _calib(msgs)
        assert len(calib) == 1
        text = calib[0]["content"]
        assert "语气、价值观和反应方式必须持续贴合角色性格" in text, "锚定头句必须在"
        assert PERS_BODY not in text, "校准段不得复读 personality 正文（M33 去重）"
        assert text.rstrip().endswith("。"), "去掉正文后头句必须以句号收尾，不悬空冒号"
        assert "：。" not in text and not text.rstrip().endswith("：")

    def test_m4_personality_slot_still_carries_body(self):
        """对照 M4：同一次装配里 charPersonality 槽（模拟为 main 文本）仍含正文。"""
        msgs = _build(PERS_BODY, system_prompt="性格：" + PERS_BODY)
        main = next(m for m in msgs if m["role"] == "system" and m["content"].startswith("性格："))
        assert PERS_BODY in main["content"], "M4 性格槽不得被去重误伤"
        calib = _calib(msgs)
        assert len(calib) == 1 and PERS_BODY not in calib[0]["content"]

    def test_en_header_without_body(self):
        msgs = _build(PERS_BODY, prompt_lang="en")
        en = [m for m in msgs if m["role"] == "system" and m["content"].startswith("[Character Calibration]")]
        assert len(en) == 1
        text = en[0]["content"]
        assert "aligned with this personality" in text, "英文锚定头句必须在"
        assert PERS_BODY not in text
        assert text.rstrip().endswith(".")

    def test_no_calibration_when_personality_empty(self):
        """personality 为空 → 整条校准不注入（既有门控行为回归）。"""
        msgs = _build("")
        assert _calib(msgs) == []
        assert not any(
            isinstance(m["content"], str) and "【角色校准】" in m["content"] for m in msgs
        )
