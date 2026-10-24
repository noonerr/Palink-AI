"""ASM-4 装配消息结构重排回归锁（2026-10-24）。

施工图：REPORT_VER1_装配同构差异首版_2026-10-24.md §7 主脑裁定表 +
REPORT_VER1b_全卡池装配同构普查_2026-10-24.md 主脑裁定段（NF-3 并入 D-1）。
覆盖：D-2/D-4 尾块拆独立消息、D-1+NF-3 世界书拆桶、D-7 newMainChat（开关）、
D-9 depth 纯历史锚点、D-12 IN_PROMPT 独立消息的前部插槽机制、设置开关读取。

运行: cd backend && py -3 -m pytest tests/test_asm4_message_structure.py -q
"""

import json
import os
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.services.character_message_builder import build_character_chat_messages  # noqa: E402
from app.services import roleplay_prompt_assembly as rpa  # noqa: E402
from app.services.worldbook_service import WorldbookContextResult  # noqa: E402


def _mk_msg(role, content, mid="m1"):
    return SimpleNamespace(
        id=mid, role=role, content=content, name=None, extra=None, is_hidden=False,
    )


def _mk_char(personality="", name="Char"):
    # SimpleNamespace 而非 MagicMock：builder 会读 char.jailbreak（MagicMock 的
    # 真值会经 _apply_context_table 幻影注入一条 jailbreak 消息，污染结构断言）。
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


def _build(history=None, **overrides):
    kwargs = dict(
        db=MagicMock(),
        char=_mk_char(),
        user_nickname="User",
        session_id="sess-1",
        branch_id="branch-1",
        message="hello",
        images=[],
        system_prompt="MAIN-PROMPT",
        dynamic_context_parts=[],
        prompt_lang="zh",
        user_setting=SimpleNamespace(),
        _replace_placeholders=lambda s, u, c: (s or ""),
        _get_full_branch_history=lambda db, sid, bid, limit: (history or []),
        _contains_chinese=lambda s: True,
        normalize_image_url=lambda s: s,
    )
    kwargs.update(overrides)
    return build_character_chat_messages(**kwargs)


# ---------------------------------------------------------------------------
# D-2/D-3/D-4：尾部动态块拆独立消息
# ---------------------------------------------------------------------------
class TestTailSplit:
    def test_dynamic_parts_are_independent_messages(self):
        """多个动态 part 不再 join 成单条——每 part 一条独立 system 消息。"""
        msgs = _build(
            history=[_mk_msg("user", "hi", "m1")],
            dynamic_context_parts=["PART-ONE", "PART-TWO"],
        )
        roles = [(m["role"], m["content"]) for m in msgs]
        assert ("system", "PART-ONE") in roles
        assert ("system", "PART-TWO") in roles
        joined = [m for m in msgs if m["role"] == "system" and "PART-ONE\n\nPART-TWO" in str(m["content"])]
        assert not joined, "动态 part 不得再合并为单条消息（D-2/D-4 消息边界）"

    def test_calibration_is_own_message(self):
        """【角色校准】保留（P-DEC-5）但单独成条，不与动态 part 粘连。"""
        msgs = _build(
            history=[_mk_msg("user", "hi", "m1")],
            dynamic_context_parts=["PART-ONE"],
            char=_mk_char(personality="傲娇、猫耳"),
        )
        calib = [m for m in msgs if m["role"] == "system" and m["content"].startswith("【角色校准】")]
        assert len(calib) == 1
        assert "PART-ONE" not in calib[0]["content"], "校准不得并入动态块"

    def test_relative_order_preserved(self):
        """拆分只改消息边界：动态 part 相对顺序与"part 在校准之前"保持不变。"""
        msgs = _build(
            history=[_mk_msg("user", "hi", "m1")],
            dynamic_context_parts=["AAA", "BBB"],
            char=_mk_char(personality="性格"),
        )
        texts = [m["content"] for m in msgs if m["role"] == "system"]
        assert texts.index("AAA") < texts.index("BBB")
        assert texts.index("BBB") < next(
            i for i, t in enumerate(texts) if t.startswith("【角色校准】")
        )


# ---------------------------------------------------------------------------
# D-5/D-12/D-1 前部插槽：worldInfoBefore / main / worldInfoAfter / 相对扩展提示
# ---------------------------------------------------------------------------
class TestFrontSlots:
    def test_worldinfo_before_straddles_main(self):
        """worldInfoBefore 在 main 之前、worldInfoAfter 紧跟 main 之后（ST 1203-1205）。"""
        msgs = _build(
            history=[_mk_msg("user", "hi", "m1")],
            front_before_main=[{"role": "system", "content": "WI-BEFORE", "_palink_prompt_id": "worldInfoBefore"}],
            front_after_main=[{"role": "system", "content": "WI-AFTER", "_palink_prompt_id": "worldInfoAfter"}],
        )
        ids = [m.get("_palink_prompt_id") for m in msgs]
        assert ids.index("worldInfoBefore") < ids.index("main") < ids.index("worldInfoAfter")

    def test_memory_and_inprompt_after_main_as_own_messages(self):
        """记忆与 IN_PROMPT 扩展各成一条、位于 main 之后（D-2/D-12 落位）。"""
        msgs = _build(
            history=[_mk_msg("user", "hi", "m1")],
            front_after_main=[
                {"role": "system", "content": "MEMORY-CTX", "_palink_prompt_id": "memory"},
                {"role": "system", "content": "EXT-INPROMPT"},
            ],
        )
        ids = [m.get("_palink_prompt_id") for m in msgs]
        assert ids.index("main") < ids.index("memory")
        contents = [m["content"] for m in msgs]
        assert contents.index("MEMORY-CTX") < contents.index("EXT-INPROMPT")
        assert not any(
            isinstance(m["content"], str) and "MEMORY-CTX\n\nEXT-INPROMPT" in m["content"]
            for m in msgs
        ), "IN_PROMPT 条目不得字符串级并入其他消息（D-12）"

    def test_title_instruction_goes_to_main_not_worldinfo(self):
        """标题指令并入 main（T2 语义）；前部插槽在场时不得误并 worldInfoBefore。"""
        msgs = _build(
            history=[_mk_msg("user", "hi", "m1")],
            front_before_main=[{"role": "system", "content": "WI-BEFORE", "_palink_prompt_id": "worldInfoBefore"}],
            include_title_instruction=True,
        )
        wi = next(m for m in msgs if m.get("_palink_prompt_id") == "worldInfoBefore")
        main = next(m for m in msgs if m.get("_palink_prompt_id") == "main")
        assert "[标题:" not in wi["content"]
        assert "[标题:" in main["content"]


# ---------------------------------------------------------------------------
# D-7：newMainChat 历史区头
# ---------------------------------------------------------------------------
class TestNewMainChat:
    def test_header_inserted_before_first_history_message(self):
        msgs = _build(
            history=[_mk_msg("user", "u1", "m1"), _mk_msg("assistant", "a1", "m2")],
            new_main_chat_prompt="[开始新的对话]",
        )
        contents = [m["content"] for m in msgs]
        header_idx = contents.index("[开始新的对话]")
        first_hist_idx = contents.index("u1")
        assert header_idx == first_hist_idx - 1, "区头必须紧贴首条历史消息之前"
        assert msgs[header_idx]["role"] == "system"

    def test_header_absent_without_history(self):
        """无历史（is_init 形态）不插区头——无历史区可标记。"""
        msgs = _build(history=[], new_main_chat_prompt="[开始新的对话]")
        assert "[开始新的对话]" not in [m["content"] for m in msgs]

    def test_header_not_passed_absent(self):
        msgs = _build(history=[_mk_msg("user", "u1", "m1")])
        assert not any(
            isinstance(m.get("content"), str) and m["content"].startswith("[开始新的对话")
            for m in msgs
        )


# ---------------------------------------------------------------------------
# D-9：历史区标记
# ---------------------------------------------------------------------------
class TestHistoryMarkers:
    def test_markers_on_history_region(self):
        msgs = _build(history=[_mk_msg("user", "u1", "m1"), _mk_msg("assistant", "a1", "m2")])
        starts = [i for i, m in enumerate(msgs) if m.get("_palink_history_start")]
        ends = [i for i, m in enumerate(msgs) if m.get("_palink_history_end")]
        assert len(starts) == 1 and len(ends) == 1
        # 首条历史 = u1；末梢 = 当前 user 输入 "hello"
        assert msgs[starts[0]]["content"] == "u1"
        assert msgs[ends[0]]["content"] == "hello"

    def test_end_marker_falls_back_to_last_history_without_user_msg(self):
        """include_user_message=False（continue 形态）：末梢锚点落在最后一条历史。"""
        msgs = _build(
            history=[_mk_msg("user", "u1", "m1"), _mk_msg("assistant", "a1", "m2")],
            include_user_message=False,
        )
        ends = [i for i, m in enumerate(msgs) if m.get("_palink_history_end")]
        assert len(ends) == 1
        assert msgs[ends[0]]["content"] == "a1"


# ---------------------------------------------------------------------------
# D-9：_insert_depth_prompt 纯历史锚点算式
# ---------------------------------------------------------------------------
def _run_depth(messages, entries):
    report = []
    req = SimpleNamespace(char=SimpleNamespace(extensions=None), user_nickname="User")
    deps = SimpleNamespace(replace_placeholders=lambda s, u, c: (s or ""))
    return rpa._insert_depth_prompt(messages, req, deps, entries, report)


class TestDepthAnchorPureHistory:
    def _array(self):
        # 前部 1 条 main + 历史区 3 条（h1/h2/h3）+ 尾部动态块 1 条 + 当前 user
        # 聊天槽（user/assistant）= [h1,h2,h3,user] 共 4 条；TAIL/MAIN 是 system
        # 件，不占聊天槽（ST 注入数组之外，D-9 口径）。
        return [
            {"role": "system", "content": "MAIN", "_palink_prompt_id": "main"},
            {"role": "user", "content": "h1", "_palink_history_start": True},
            {"role": "assistant", "content": "h2"},
            {"role": "user", "content": "h3"},
            {"role": "system", "content": "TAIL-BLOCK"},
            {"role": "user", "content": "hello", "_palink_history_end": True},
        ]

    def test_depth4_ignores_tail_block(self):
        """depth=4 = 聊天槽从末往前 4 条：落在首条聊天消息之前，尾部块不计槽。"""
        out = _run_depth(self._array(), [rpa.DepthInjection(depth=4, content="D4", role=0, source="t")])
        texts = [m["content"] for m in out]
        # 聊天槽 [h1,h2,h3,user]：depth4 → 倒序数组 splice(4) = 首条聊天消息之前
        assert texts.index("D4") == texts.index("h1") - 1
        assert texts.index("D4") > texts.index("MAIN"), "注入不得越过主提示词"

    def test_depth0_after_current_user(self):
        out = _run_depth(self._array(), [rpa.DepthInjection(depth=0, content="D0", role=0, source="t")])
        texts = [m["content"] for m in out]
        assert texts.index("D0") == len(texts) - 1, "depth=0 落数组最末（user 之后）"

    def test_depth1_before_current_user(self):
        out = _run_depth(self._array(), [rpa.DepthInjection(depth=1, content="D1", role=0, source="t")])
        texts = [m["content"] for m in out]
        assert texts.index("D1") == texts.index("hello") - 1

    def test_depth3_lands_relative_to_chat_slots_not_array(self):
        """depth=3 = 从末第 3 条聊天消息（h2）之前——数组含 TAIL 时旧算式会偏 1。"""
        out = _run_depth(self._array(), [rpa.DepthInjection(depth=3, content="D3", role=0, source="t")])
        texts = [m["content"] for m in out]
        assert texts.index("D3") == texts.index("h2") - 1

    def test_multiple_insertions_stay_anchor_correct(self):
        """多条注入按 depth 降序依次落位，逐轮重扫聊天槽，位移不积累偏差。"""
        out = _run_depth(self._array(), [
            rpa.DepthInjection(depth=4, content="D4", role=0, source="t"),
            rpa.DepthInjection(depth=1, content="D1", role=0, source="t"),
            rpa.DepthInjection(depth=0, content="D0", role=0, source="t"),
        ])
        texts = [m["content"] for m in out]
        assert texts.index("D1") == texts.index("hello") - 1
        assert texts.index("D0") == len(texts) - 1
        assert texts.index("D4") == texts.index("h1") - 1

    def test_depth_beyond_history_clamps_to_history_start(self):
        out = _run_depth(self._array(), [rpa.DepthInjection(depth=99, content="D99", role=0, source="t")])
        texts = [m["content"] for m in out]
        assert texts.index("D99") == texts.index("h1") - 1

    def test_legacy_fallback_without_markers(self):
        """标记缺席（直调旧形态）：回退数组总长算式，行为与改前一致。"""
        legacy = [
            {"role": "system", "content": "MAIN"},
            {"role": "user", "content": "h1"},
            {"role": "user", "content": "hello"},
        ]
        out = _run_depth(legacy, [rpa.DepthInjection(depth=1, content="D1", role=0, source="t")])
        texts = [m["content"] for m in out]
        assert texts.index("D1") == texts.index("hello") - 1  # len(3)-1=2


# ---------------------------------------------------------------------------
# D-1+NF-3：_append_worldbook_context 拆桶
# ---------------------------------------------------------------------------
class _PassDeps:
    def apply_plugin_regex_scripts(self, text, *a, **k):
        return text

    def apply_regex_scripts(self, text, *a, **k):
        return text

    def replace_placeholders(self, text, *a, **k):
        return text


def _run_wb_append(canned, split=True):
    parts, depth, report = [], [], []
    out = {}
    kwargs = {}
    if split:
        out = {
            "wi_before_parts": [],
            "wi_after_parts": [],
            "an_before_parts": [],
            "an_after_parts": [],
        }
        kwargs.update(out)
    req = SimpleNamespace(
        db=MagicMock(), user=SimpleNamespace(id=1, username="Tester"),
        char=MagicMock(name="C", extensions=None), session_id="s", branch_id=None,
        is_init=False, message="hello", smart_card_trigger=False, is_continue=False,
        group_id=None, user_nickname="Tester",
    )
    orig = rpa.build_worldbook_context
    rpa.build_worldbook_context = lambda **kw: canned
    try:
        rpa._append_worldbook_context(req, _PassDeps(), parts, depth, report, **kwargs)
    finally:
        rpa.build_worldbook_context = orig
    return parts, out, report


class TestWorldbookSplitBuckets:
    def test_before_after_an_buckets(self):
        canned = WorldbookContextResult(
            text="[World Lore]\nmerged",
            debug_report=[], total_tokens=10, budget_used=0,
            entries_by_position={0: ["BEFORE-ENTRY"], 1: ["AFTER-ENTRY"], 2: ["AN-TOP"], 3: ["AN-BOTTOM"]},
        )
        parts, out, report = _run_wb_append(canned, split=True)
        assert out["wi_before_parts"] == ["BEFORE-ENTRY"]
        assert out["wi_after_parts"] == ["AFTER-ENTRY"]
        assert out["an_before_parts"] == ["AN-TOP"]
        assert out["an_after_parts"] == ["AN-BOTTOM"]
        assert not any("BEFORE-ENTRY" in p for p in parts), "before 条目不得再进尾部块（D-1）"
        assert not any("AN-TOP" in p for p in parts), "ANTop 条目不得压平进尾块（NF-3）"
        wb_item = next(i for i in report if i.key == "worldbook")
        assert "split=" in (wb_item.detail or "")

    def test_legacy_mode_keeps_merged_text(self):
        """拆桶出参缺省（直接调用方）：旧合并行为零变化。"""
        canned = WorldbookContextResult(
            text="[World Lore]\nBEFORE-ENTRY", debug_report=[], total_tokens=5, budget_used=0,
        )
        parts, out, report = _run_wb_append(canned, split=False)
        assert any("BEFORE-ENTRY" in p for p in parts)
        assert out == {}


# ---------------------------------------------------------------------------
# D-7：设置开关读取与文案
# ---------------------------------------------------------------------------
class TestNewMainChatSwitch:
    def test_default_on_without_settings(self):
        assert rpa._read_palink_assembly_flags(None) == {"new_main_chat": True}
        assert rpa._read_palink_assembly_flags(SimpleNamespace(silly_tavern_settings=None)) == {"new_main_chat": True}

    def test_off_via_extension_settings_namespace(self):
        us = SimpleNamespace(silly_tavern_settings=json.dumps({
            "extension_settings": {"palink_assembly": {"new_main_chat": False}},
        }))
        assert rpa._read_palink_assembly_flags(us) == {"new_main_chat": False}

    def test_malformed_json_falls_back_to_default(self):
        us = SimpleNamespace(silly_tavern_settings="not-json{")
        assert rpa._read_palink_assembly_flags(us) == {"new_main_chat": True}

    def test_prompt_text_zh_en_group(self):
        assert rpa._new_main_chat_prompt_text(True, False) == "[开始新的对话]"
        assert rpa._new_main_chat_prompt_text(True, True) == "[开始新的群聊对话]"
        assert rpa._new_main_chat_prompt_text(False, False) == "[Start of a new conversation]"
        assert rpa._new_main_chat_prompt_text(False, True) == "[Start of a new group conversation]"
