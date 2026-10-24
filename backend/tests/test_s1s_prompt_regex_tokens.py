"""S-1s 回归锁：装配 report 的 prompt_regex 项必须带真实 token 估算（2026-10-25）。

出处 docs/_active/report/REPORT_ASM1_卡内正则与预算双算定性_2026-10-24.md §1/§3：
报告项生成点原本一行 `PromptAssemblyReportItem("prompt_regex", "included")`
**从不传 tokens_estimate** ⇒ 无论应用了多少条正则，这一行恒 tok=0。
审计 S-1 从"0 token"推出"卡内正则在 prompt 侧一条都没生效"——前提根本不成立
（同轮实测：6 条卡内正则里 2 条真实命中、13 条消息 21 处替换、9 条长度变化）。

本锁测的是"这一层到底动了多少"，不是正则语义本身（ASM-1 已证应用链健康，
本批不动 `_apply_prompt_regex_to_messages` 的任何应用逻辑）。

口径（为什么 tokens_estimate 用绝对值）：格式类正则常是**净删**（剥标签），
把负数塞进 tokens_estimate 会让读报表的人以为出异常；净增/净删由 detail
里的 `net_tokens=±N` 带符号说明。0 从此只表示"真的一个字都没动"。

运行: cd backend && py -3 -m pytest tests/test_s1s_prompt_regex_tokens.py -q
"""

import asyncio
import os
import re
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from app.services.roleplay_prompt_assembly import (
        PromptAssemblyDeps,
        PromptAssemblyRequest,
        assemble_roleplay_prompt,
    )
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as _exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = _exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"装配层依赖缺失: {_IMPORT_ERROR}")


def _char():
    return SimpleNamespace(
        id="char-s1s",
        name="S1sChar",
        description="DESC-TEXT",
        personality="PERS-TEXT",
        scenario="SCEN-TEXT",
        background="",
        system_prompt="",
        mes_example=None,
        post_history_instructions=None,
        creator_notes="",
        extensions=None,
        preset_data=None,
        jailbreak=None,
        first_mes=None,
    )


def _user_setting():
    return SimpleNamespace(
        user_id=1,
        author_note="",
        author_note_position=-1,
        author_note_depth=4,
        author_note_frequency=0,
        memory_mode="disabled",
        prompt_language="zh",
        instruct_enabled=False,
        instruct_template_id=None,
        active_persona_id=None,
        use_custom_prompts=False,
        custom_character_prompt_zh=None,
        custom_character_prompt_en=None,
        power_user=None,
        show_character_status=False,
        openai_max_context=None,
    )


def _mock_db(us):
    from app.models import UserSetting

    db = MagicMock()

    def _query(model):
        q = MagicMock()
        if model is UserSetting:
            q.filter.return_value.first.return_value = us
        else:
            q.filter.return_value.first.return_value = None
        return q

    db.query.side_effect = _query
    return db


def _run(regex_transform, *, include_prompt_regex=True):
    """跑一次真实装配；regex_transform 是 deps.apply_prompt_regex_to_messages。"""
    us = _user_setting()
    db = _mock_db(us)
    char = _char()
    req = PromptAssemblyRequest(
        db=db, user=SimpleNamespace(id=1, username="Tester"), char=char,
        session_id="sess-s1s", branch_id="branch-s1s", message="hello", images=[],
        model="deepseek-v4-flash", user_nickname="Tester",
        include_prompt_regex=include_prompt_regex, include_title_instruction=False,
        include_user_message=True, is_init=False, is_continue=False,
        smart_card_trigger=False, group_id=None,
    )
    deps = PromptAssemblyDeps(
        build_system_prompt=lambda *a, **kw: "MAIN-PROMPT",
        replace_placeholders=lambda text, *a, **kw: text,
        get_full_branch_history=lambda *a, **kw: [SimpleNamespace(
            id="h1", role="user", content="OLD-HISTORY", name=None,
            extra=None, is_hidden=False,
        )],
        get_ancestor_branch_ids=lambda *a, **kw: [],
        contains_chinese=lambda text: True,
        apply_plugin_regex_scripts=lambda text, *a, **kw: text,
        apply_regex_scripts=lambda text, *a, **kw: text,
        apply_prompt_regex_to_messages=regex_transform,
    )

    def _wb_spy(*args, **kwargs):
        kwargs.get("wi_before_parts", []).append("WI-BEFORE")
        kwargs.get("wi_after_parts", []).append("WI-AFTER")

    with patch("app.services.roleplay_prompt_assembly._append_worldbook_context",
               side_effect=_wb_spy), \
         patch("app.services.roleplay_prompt_assembly._append_plotline_context", new=MagicMock()), \
         patch("app.services.roleplay_prompt_assembly._append_memory_context", new=AsyncMock()), \
         patch("app.services.roleplay_prompt_assembly._load_context_template", return_value=None), \
         patch("app.services.roleplay_prompt_assembly._load_instruct_template", return_value=None), \
         patch("app.services.roleplay_prompt_assembly.evaluate_macros_in_messages",
               side_effect=lambda messages, env: messages), \
         patch("app.services.roleplay_prompt_assembly.evaluate_macros",
               side_effect=lambda text, env: text), \
         patch("app.services.status_bar_detector.build_status_instruction", return_value=""):
        return asyncio.run(assemble_roleplay_prompt(req, deps))


def _item(result, key="prompt_regex"):
    return next((i for i in result.report if i.key == key), None)


class TestPromptRegexTokenReading:
    def test_no_change_means_zero(self):
        """恒等变换 ⇒ 真的一个字没动 ⇒ tok=0 这一次才有意义。"""
        res = _run(lambda messages, *a, **kw: messages)
        item = _item(res)
        assert item is not None and item.status == "included"
        assert item.tokens_estimate == 0

    def test_added_text_reports_nonzero(self):
        """有命中且净增 ⇒ tokens_estimate 必须 > 0（原本恒 0 就是这条判据失效）。"""
        def add_tag(messages, *a, **kw):
            for m in messages:
                if isinstance(m.get("content"), str):
                    m["content"] = m["content"] + "\n<now_plot>APPENDED-BY-REGEX</now_plot>"
            return messages

        res = _run(add_tag)
        item = _item(res)
        assert item.tokens_estimate > 0, f"正则净增文本却报 0：{item.detail}"
        assert "net_tokens=+" in item.detail, item.detail
        assert re.search(r"chars=\d+->\d+", item.detail), item.detail

    def test_removed_text_reports_absolute_value_with_signed_detail(self):
        """净删（格式类正则的常态）：estimate 取绝对值、detail 带负号。
        这样既不让报表出现"负 token"，也不把删掉的量藏起来。"""
        def strip_tag(messages, *a, **kw):
            for m in messages:
                if isinstance(m.get("content"), str) and len(m["content"]) > 10:
                    m["content"] = m["content"][:5]
            return messages

        res = _run(strip_tag)
        item = _item(res)
        assert item.tokens_estimate > 0, "净删也被报成 0 ⇒ 与'没生效'无法区分"
        assert "net_tokens=-" in item.detail, item.detail

    def test_estimate_is_the_delta_not_the_total(self):
        """口径钉住：estimate 是"这一层改动量"，不是全量 prompt 的 token
        （其它报告行都是各源自己的量，一行顶掉全文就没法读了）。
        同时钉住"改了 1 个字符"这种微量的正确读法：净 token 可以是 0
        （估算器是量化的），但 changed_messages 必须显出命中——
        否则"0"又一次和"没生效"撞车，本批要修的就是这个混淆。"""
        def touch_one_char(messages, *a, **kw):
            for m in messages:
                if isinstance(m.get("content"), str) and m["content"]:
                    m["content"] = m["content"] + "x"
                    break
            return messages

        item = _item(_run(touch_one_char))
        assert item.tokens_estimate < 50, (
            f"只加了一个字符却报 {item.tokens_estimate} ⇒ 口径漂成全文总量"
        )
        assert "changed_messages=1;" in item.detail, item.detail
        m = re.search(r"chars=(\d+)->(\d+)", item.detail)
        assert m and int(m.group(2)) - int(m.group(1)) == 1, (
            f"字符增量应当恰好 +1，detail 却是：{item.detail}"
        )

    def test_zero_tokens_estimate_always_accompanied_by_hit_count(self):
        """不变式：tokens_estimate==0 时，detail 必须能自证"是真的没动"还是"动了但量级为 0"。"""
        res_noop = _run(lambda messages, *a, **kw: messages)
        item = _item(res_noop)
        assert item.tokens_estimate == 0
        assert "changed_messages=0;" in item.detail, item.detail

        def touch_one_char(messages, *a, **kw):
            messages[0]["content"] = (messages[0]["content"] or "") + "x"
            return messages

        item2 = _item(_run(touch_one_char))
        if item2.tokens_estimate == 0:
            assert "changed_messages=1;" in item2.detail, (
                "0 token 却报不出命中 ⇒ 读报表的人仍会误判为未生效"
            )

    def test_skipped_branch_unchanged(self):
        """include_prompt_regex=False ⇒ 仍是 skipped、不带估算值。
        本批只给"included"分支补读数，不许把关掉的情形也报成有量。"""
        called = []

        def _spy(messages, *a, **kw):
            called.append(1)
            return messages

        item = _item(_run(_spy, include_prompt_regex=False))
        assert item is not None, "report 里 prompt_regex 行没了（skipped 分支也该留痕）"
        assert item.status == "skipped", item.status
        assert item.tokens_estimate == 0
        assert not called, "关了开关还执行正则 ⇒ 本批读数的分母就不成立了"
