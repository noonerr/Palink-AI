"""D-5b 三槽拆分回归锁（2026-10-25）。

施工图：docs/_active/prompt/PROMPT_对话包_D5b三槽拆分与审计尾巴批_2026-10-24.md §2
形状判据：REPORT_VER1_装配同构差异首版_2026-10-24.md §3.1（应然顺序表）+ §7.2（裁定表 D-5）

锁四件事：
1. 三段各自成独立 system 消息，落位 = worldInfoAfter 之后、相对扩展提示之前
   （ST openai.js:1203-1209）；
2. **main 无残留**——拆分后 main 文本不得再含三段正文（本文件即反证靶心：
   把合并点还原回"三段内嵌"，第 3/8/11/16 条必红）；
3. 空段跳过（ST 语义：字段为空则不产生该消息）；
4. 逐字节对账：legacy − main = 三段之和 + 被移走的行间分隔符（无重复无丢失）。

附带锁两条容易被忽略的连带风险：
5. 三段拆出后必须继承 main 的裁剪地位（否则超预算时它们最先被裁 = 拆分丢内容）；
6. 分槽通道在场时 P1-1 的角色卡字段代理消息不得再抽一遍（否则同一份内容两份）。

运行: cd backend && py -3 -m pytest tests/test_d5b_slots.py -q
"""

import asyncio
import os
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.core.default_prompts import (  # noqa: E402
    CharacterPromptSlots,
    build_default_character_prompt,
    build_default_character_prompt_slots,
)
from app.models import UserSetting  # noqa: E402

try:
    from app.services.roleplay_prompt_assembly import (
        PromptAssemblyDeps,
        PromptAssemblyRequest,
        _collect_prompt_sources,
        assemble_roleplay_prompt,
    )
    from app.services.roleplay_prompt_assembly import (
        PROMPT_ID_CHAR_DESCRIPTION,
        PROMPT_ID_CHAR_PERSONALITY,
        PROMPT_ID_SCENARIO,
        PROMPT_ID_SYSTEM_PROMPT,
        PROMPT_ID_WORLD_INFO_AFTER,
        PROMPT_ID_WORLD_INFO_BEFORE,
    )
    _ASSEMBLY_IMPORT_OK = True
    _ASSEMBLY_IMPORT_ERROR = None
except Exception as _exc:  # pragma: no cover
    _ASSEMBLY_IMPORT_OK = False
    _ASSEMBLY_IMPORT_ERROR = _exc

pytestmark_assembly = pytest.mark.skipif(
    not _ASSEMBLY_IMPORT_OK, reason=f"装配层依赖缺失: {_ASSEMBLY_IMPORT_ERROR}"
)

# ── 测试用文本：刻意互不相同且都够长，保证"残留"断言不会因偶然子串误判 ──
DESC_TEXT = "DESCRIPTION-ANCHOR-露缇雅侧卧在宽大的床褥之间-0123456789"
PERS_TEXT = "PERSONALITY-ANCHOR-遇到身体异变时先羞后迎-abcdefghij"
SCEN_TEXT = "SCENARIO-ANCHOR-2026年7月8日深夜的岚川市-klmnopqrst"
BG_TEXT = "BACKGROUND-ANCHOR-这是一张卡独有的背景字段-stuvwxyz"
SYS_OVER = "SYSTEMPROMPT-OVERRIDE-ANCHOR-角色自己的总纲"

_LABEL_DESC = "描述："
_LABEL_PERS = "性格："
_LABEL_SCEN = "场景："
_LABEL_BG = "背景："


def _mk_char(**over):
    base = dict(
        id="char-d5b",
        name="D5bChar",
        description=DESC_TEXT,
        personality=PERS_TEXT,
        scenario=SCEN_TEXT,
        background=BG_TEXT,
        system_prompt="",
        mes_example=None,
        post_history_instructions=None,
        creator_notes="",
        extensions=None,
        preset_data=None,
        jailbreak=None,
        first_mes=None,
    )
    base.update(over)
    return SimpleNamespace(**base)


def _slots(**over):
    base = dict(
        char_name="D5bChar",
        user_nickname="Tester",
        lang="zh",
        personality=PERS_TEXT,
        background=BG_TEXT,
        scenario=SCEN_TEXT,
        description=DESC_TEXT,
    )
    base.update(over)
    return build_default_character_prompt_slots(**base)


# ---------------------------------------------------------------------------
# 1) core 层分槽产出
# ---------------------------------------------------------------------------
class TestSlotProduction:
    def test_three_slots_carry_their_own_text(self):
        s = _slots()
        assert s.char_description == _LABEL_DESC + DESC_TEXT
        assert s.char_personality == _LABEL_PERS + PERS_TEXT
        assert s.scenario == _LABEL_SCEN + SCEN_TEXT

    def test_main_has_no_residue_of_the_three_sections(self):
        """反证靶心：三段重新内嵌进 main 时，本条必红。"""
        s = _slots()
        for anchor in (DESC_TEXT, PERS_TEXT, SCEN_TEXT):
            assert anchor not in s.main, "main 不得再残留三段正文（拆分后只该有一份）"

    def test_background_stays_in_main(self):
        """ST 卡模型没有 background 字段 ⇒ 无对应槽，该字段留在 main 里。"""
        s = _slots()
        assert _LABEL_BG + BG_TEXT in s.main

    def test_card_block_absent_from_main_when_background_empty(self):
        """background 为空且三段已移出 ⇒ 【角色卡】字段块整体从 main 缺席。"""
        s = _slots(background="")
        assert "【角色卡】" not in s.main
        assert _LABEL_BG not in s.main

    @pytest.mark.parametrize("field,value", [
        ("description", ""),
        ("personality", ""),
        ("scenario", ""),
    ])
    def test_empty_field_yields_empty_slot(self, field, value):
        """空段跳过的前置条件：空字段的槽文本必须是 ""（装配层据此不发消息）。"""
        s = _slots(**{field: value})
        slot_attr = {"description": "char_description",
                     "personality": "char_personality",
                     "scenario": "scenario"}[field]
        assert getattr(s, slot_attr) == ""

    def test_whitespace_only_field_keeps_its_slot(self):
        """与拆分前的守卫逐字一致：只有"空串"才整段缺席，纯空格字段仍产出槽
        （旧实现用 `if personality:` 判真值，纯空格为真）。"""
        s = _slots(personality="   ")
        assert s.char_personality == _LABEL_PERS + "   "


# ---------------------------------------------------------------------------
# 2) 逐字节对账（验收判据②）
# ---------------------------------------------------------------------------
class TestByteAccounting:
    def test_legacy_wrapper_is_byte_identical_to_pre_split(self):
        """legacy_merged 必须等于 D-5b 之前 build_default_character_prompt 的返回。

        旧函数现在只是包装，两条实现同出一源 ⇒ 这里用旧函数钉住旧形态，
        保证 test_b4_main_slot_override / test_batch_a_st_compat_debt
        钉的那份防回退守卫没被本批改判。
        """
        base = dict(
            char_name="D5bChar", user_nickname="Tester", lang="zh",
            personality=PERS_TEXT, background=BG_TEXT, scenario=SCEN_TEXT,
            description=DESC_TEXT,
        )
        variants = [
            {},
            {"custom_prompt": SYS_OVER},
            {"background": ""},
            {"description": "", "personality": "", "scenario": "", "background": ""},
            {"description": "", "personality": PERS_TEXT},
            {"lang": "en"},
            {"lang": "en", "background": "", "scenario": ""},
        ]
        for override in variants:
            params = {**base, **override}
            merged = build_default_character_prompt(**params)
            s = build_default_character_prompt_slots(**params)
            assert s.legacy_merged == merged, f"legacy 形态漂移: {override}"
            assert str(s) == merged, "str(slots) 必须给出旧合并全文（向后兼容通道）"
            assert s.text == merged

    def test_main_shrinks_by_slots_plus_absorbed_separators(self):
        """main 减少的字节数 = 三段之和 + 被移走的字段块内部分隔符（无重复无丢失）。

        字段块内 4 行靠 3 个 \\n 相连；三段移出后只剩 background 一行 ⇒
        3 个分隔符随之消失，这是"消息边界变化"的固有成本，不是内容丢失。
        """
        s = _slots()
        delta = len(s.legacy_merged) - len(s.main)
        slots_sum = len(s.char_description) + len(s.char_personality) + len(s.scenario)
        assert delta == slots_sum + 3, (
            f"对账不平：main-{delta} vs 三段之和-{slots_sum}（分隔符吸收应为 3）"
        )

    def test_no_slots_when_card_fields_all_empty(self):
        """全空卡（实测猫娘卡即此形态）：三段皆空、main 与 legacy 同形。"""
        s = _slots(description="", personality="", scenario="", background="")
        assert (s.char_description, s.char_personality, s.scenario) == ("", "", "")
        assert s.main == s.legacy_merged


# ---------------------------------------------------------------------------
# 3) api 层合并点（生产分槽来源）
# ---------------------------------------------------------------------------
class TestApiMergePoint:
    def _build(self, char=None, user_setting=None):
        from app.api.character_ext import _build_char_system_prompt
        return _build_char_system_prompt(
            char if char is not None else _mk_char(),
            "Tester", "zh", user_setting,
        )

    def test_production_builder_returns_slots(self):
        got = self._build()
        assert isinstance(got, CharacterPromptSlots)
        assert DESC_TEXT in got.char_description
        assert DESC_TEXT not in got.main
        assert BG_TEXT in got.main

    def test_str_of_result_is_the_legacy_merged_prompt(self):
        """仍按 str 消费的调用方（探针脚本）拿到的文本与拆分前一致。"""
        got = self._build()
        assert str(got) == got.legacy_merged
        assert DESC_TEXT in str(got)

    def test_en_labels_follow_prompt_lang(self):
        """英文档下三段用英文标签，且仍各自成槽、main 无残留。"""
        s = _slots(lang="en")
        assert s.char_description == "Description: " + DESC_TEXT
        assert s.char_personality == "Personality: " + PERS_TEXT
        assert s.scenario == "Scenario: " + SCEN_TEXT
        assert DESC_TEXT not in s.main and BG_TEXT in s.main

    def test_custom_prompt_path_does_not_split(self):
        """自定义提示词路径不拆槽：字段由用户自己定点放置，再拆就是两份内容。"""
        us = SimpleNamespace(
            use_custom_prompts=True,
            custom_character_prompt_zh="MY-CUSTOM {{description}} END",
            custom_character_prompt_en="",
            power_user=None,
            show_character_status=False,
            prompt_language="zh",
        )
        got = self._build(user_setting=us)
        assert isinstance(got, CharacterPromptSlots)
        assert got.char_description == "" and got.char_personality == "" and got.scenario == ""
        assert got.main == got.legacy_merged
        assert DESC_TEXT in got.main  # 宏展开后仍在 main 内（用户自己的排版）

    def test_custom_prompt_without_card_variable_not_double_split(self):
        """自定义提示词未引用卡变量时 Palink 自动追加字段块——本批保持原样，
        三槽仍为空（该路径全库 use_custom_prompts=False，生产不可达）。"""
        us = SimpleNamespace(
            use_custom_prompts=True,
            custom_character_prompt_zh="MY-CUSTOM-NO-VARIABLE",
            custom_character_prompt_en="",
            power_user=None,
            show_character_status=False,
            prompt_language="zh",
        )
        got = self._build(user_setting=us)
        assert got.char_description == ""
        assert DESC_TEXT in got.main
        assert got.main.count(DESC_TEXT) == 1, "同一段正文在该路径只允许出现一次"


# ---------------------------------------------------------------------------
# 4) 装配层落位（走真实 assemble_roleplay_prompt）
# ---------------------------------------------------------------------------
def _make_user_setting():
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


def _make_mock_db(user_setting):
    db = MagicMock()

    def _query(model):
        q = MagicMock()
        if model is UserSetting:
            q.filter.return_value.first.return_value = user_setting
        else:
            q.filter.return_value.first.return_value = None
        return q

    db.query.side_effect = _query
    return db


def _make_request(db, char):
    return PromptAssemblyRequest(
        db=db,
        user=SimpleNamespace(id=1, username="Tester"),
        char=char,
        session_id="sess-d5b",
        branch_id="branch-d5b",
        message="hello",
        images=[],
        model="deepseek-v4-flash",  # 必传：不传会得出另一份装配（ASM-2/T-1 教训）
        user_nickname="Tester",
        include_prompt_regex=False,
        include_title_instruction=False,
        include_user_message=True,
        is_init=False,
        is_continue=False,
        smart_card_trigger=False,
        group_id=None,
    )


def _history_one():
    return [SimpleNamespace(
        id="h1", role="user", content="OLD-HISTORY-MSG", name=None,
        extra=None, is_hidden=False,
    )]


def _run_assembly(char, build_system_prompt):
    """真实装配入口 + 隔离外部依赖（世界书按关键字回填拆桶，其余 no-op）。"""
    user_setting = _make_user_setting()
    db = _make_mock_db(user_setting)
    req = _make_request(db, char)
    deps = PromptAssemblyDeps(
        build_system_prompt=build_system_prompt,
        replace_placeholders=lambda text, *a, **kw: text,
        get_full_branch_history=lambda *a, **kw: _history_one(),
        get_ancestor_branch_ids=lambda *a, **kw: [],
        contains_chinese=lambda text: True,
        apply_plugin_regex_scripts=lambda text, *a, **kw: text,
        apply_regex_scripts=lambda text, *a, **kw: text,
        apply_prompt_regex_to_messages=lambda messages, *a, **kw: messages,
    )

    def _wb_spy(*args, **kwargs):
        # 世界书拆桶是"输出参数"语义：往里塞就能得到 worldInfoBefore/After 两条
        kwargs.get("wi_before_parts", []).append("WI-BEFORE-TEXT")
        kwargs.get("wi_after_parts", []).append("WI-AFTER-TEXT")

    with patch(
        "app.services.roleplay_prompt_assembly._append_worldbook_context",
        side_effect=_wb_spy,
    ), patch(
        "app.services.roleplay_prompt_assembly._append_plotline_context",
        new=MagicMock(),
    ), patch(
        "app.services.roleplay_prompt_assembly._append_memory_context",
        new=AsyncMock(),
    ), patch(
        "app.services.roleplay_prompt_assembly._load_context_template",
        return_value=None,
    ), patch(
        "app.services.roleplay_prompt_assembly._load_instruct_template",
        return_value=None,
    ), patch(
        "app.services.roleplay_prompt_assembly.evaluate_macros_in_messages",
        side_effect=lambda messages, env: messages,
    ), patch(
        "app.services.roleplay_prompt_assembly.evaluate_macros",
        side_effect=lambda text, env: text,
    ), patch(
        "app.services.status_bar_detector.build_status_instruction", return_value="",
    ):
        return asyncio.run(assemble_roleplay_prompt(req, deps))


def _texts(result):
    out = []
    for m in result.messages:
        c = m.get("content")
        out.append(c if isinstance(c, str) else " ".join(
            p.get("text", "") for p in c if isinstance(p, dict)))
    return out


def _slots_dep(char):
    """生产分槽通道：api 层 → 装配层。"""
    from app.api.character_ext import _build_char_system_prompt
    return lambda char=None, **kw: _build_char_system_prompt(
        char, kw.get("user_nickname", "Tester"), kw.get("prompt_lang", "zh"),
        kw.get("user_setting"),
    )


@pytest.mark.skipif(not _ASSEMBLY_IMPORT_OK, reason="装配层依赖缺失")
class TestAssemblyPlacement:
    def test_order_matches_st_1203_1209(self):
        """worldInfoBefore → main → worldInfoAfter → charDescription →
        charPersonality → scenario（三段落在 worldInfoAfter 之后）。"""
        res = _run_assembly(_mk_char(), _slots_dep(_mk_char()))
        texts = _texts(res)
        i_before = texts.index("WI-BEFORE-TEXT")
        i_after = texts.index("WI-AFTER-TEXT")
        i_desc = texts.index(_LABEL_DESC + DESC_TEXT)
        i_pers = texts.index(_LABEL_PERS + PERS_TEXT)
        i_scen = texts.index(_LABEL_SCEN + SCEN_TEXT)
        assert i_before < i_after < i_desc < i_pers < i_scen
        # main 夹在 before 与 after 之间
        assert i_before < i_after
        main_idx = next(
            i for i, m in enumerate(res.messages)
            if "next reply in a fictional" in texts[i]
        )
        assert i_before < main_idx < i_after

    def test_each_section_appears_exactly_once_in_main(self):
        """反重复（D-5b 本批口径）：main 里不得再有三段正文的任何一份。"""
        res = _run_assembly(_mk_char(), _slots_dep(_mk_char()))
        texts = _texts(res)
        main_text = next(t for t in texts if "next reply in a fictional" in t)
        for anchor in (DESC_TEXT, PERS_TEXT, SCEN_TEXT):
            assert anchor not in main_text, f"main 仍内嵌 {anchor!r}（拆分未生效）"

    def test_no_new_duplicate_beyond_known_calibration_double_anchor(self):
        """全数组计数：描述/场景各 1 份；性格 2 份——第 2 份在【角色校准】里，
        那是 D-4/P-DEC-5 已裁定的既有双锚（保留内容只改消息边界），**不是**本批
        造成的重复。写死这个数字，是为了让"拆分顺手多插一份"立刻可见。
        """
        res = _run_assembly(_mk_char(), _slots_dep(_mk_char()))
        blob = "\n".join(_texts(res))
        assert blob.count(DESC_TEXT) == 1, "描述出现两份 = 拆分与内嵌同时生效"
        assert blob.count(SCEN_TEXT) == 1, "场景出现两份 = 拆分与内嵌同时生效"
        assert blob.count(PERS_TEXT) == 2, (
            f"性格计数漂到 {blob.count(PERS_TEXT)}（预期 2：charPersonality 槽 "
            f"+ 【角色校准】摘要，后者属 P-DEC-5 既定保留）"
        )
        calib = [t for t in _texts(res) if t.startswith("【角色校准】")]
        assert len(calib) == 1 and PERS_TEXT in calib[0]
        slot = [t for t in _texts(res) if t == _LABEL_PERS + PERS_TEXT]
        assert len(slot) == 1, "charPersonality 槽必须独立成条且只有一条"

    def test_three_slots_are_independent_messages(self):
        res = _run_assembly(_mk_char(), _slots_dep(_mk_char()))
        texts = _texts(res)
        for expected in (_LABEL_DESC + DESC_TEXT, _LABEL_PERS + PERS_TEXT,
                         _LABEL_SCEN + SCEN_TEXT):
            assert expected in texts

    def test_empty_fields_produce_no_message(self):
        """空段跳过（ST 语义）：只留非空那一段。"""
        char = _mk_char(description=DESC_TEXT, personality="", scenario="")
        res = _run_assembly(char, _slots_dep(char))
        texts = _texts(res)
        assert (_LABEL_DESC + DESC_TEXT) in texts
        assert not any(_LABEL_PERS in t for t in texts)
        assert not any(_LABEL_SCEN in t for t in texts)
        assert PERS_TEXT not in "\n".join(texts)
        assert SCEN_TEXT not in "\n".join(texts)

    def test_report_items_present_with_status(self):
        res = _run_assembly(_mk_char(), _slots_dep(_mk_char()))
        by_key = {i.key: i for i in res.report}
        for key in (PROMPT_ID_CHAR_DESCRIPTION, PROMPT_ID_CHAR_PERSONALITY, PROMPT_ID_SCENARIO):
            assert key in by_key, f"report 缺 {key} 项（验收要读数）"
            assert by_key[key].status == "included"
            assert by_key[key].tokens_estimate > 0
        empty_char = _mk_char(personality="")
        res2 = _run_assembly(empty_char, _slots_dep(empty_char))
        by_key2 = {i.key: i for i in res2.report}
        assert by_key2[PROMPT_ID_CHAR_PERSONALITY].status == "skipped"

    def test_legacy_str_dep_still_keeps_fields_in_main_and_adds_no_message(self):
        """返回 str 的旧 dep（测试替身/归档探针）走兼容分支：不拆槽、也不误加消息。"""
        merged = build_default_character_prompt(
            char_name="D5bChar", user_nickname="Tester", lang="zh",
            personality=PERS_TEXT, background=BG_TEXT, scenario=SCEN_TEXT,
            description=DESC_TEXT,
        )
        res = _run_assembly(_mk_char(), lambda *a, **kw: merged)
        texts = _texts(res)
        assert any(DESC_TEXT in t and PERS_TEXT in t and SCEN_TEXT in t for t in texts), (
            "旧形态下三段仍应在 main 内（不得静默丢内容）"
        )
        assert not any(t.startswith(_LABEL_DESC) and t == _LABEL_DESC + DESC_TEXT for t in texts)
        by_key = {i.key for i in res.report}
        assert PROMPT_ID_CHAR_DESCRIPTION not in by_key


@pytest.mark.skipif(not _ASSEMBLY_IMPORT_OK, reason="装配层依赖缺失")
class TestTrimPriority:
    """拆出后三段的裁剪地位必须与拆分前（在 main 内）一致，否则超预算最先被裁。"""

    def test_slots_are_system_priority_and_not_trimmable(self):
        msgs = [
            {"role": "system", "content": "MAIN", "_palink_prompt_id": PROMPT_ID_SYSTEM_PROMPT},
            {"role": "system", "content": _LABEL_DESC + DESC_TEXT,
             "_palink_prompt_id": PROMPT_ID_CHAR_DESCRIPTION},
            {"role": "system", "content": _LABEL_PERS + PERS_TEXT,
             "_palink_prompt_id": PROMPT_ID_CHAR_PERSONALITY},
            {"role": "system", "content": _LABEL_SCEN + SCEN_TEXT,
             "_palink_prompt_id": PROMPT_ID_SCENARIO},
        ]
        sources = _collect_prompt_sources(msgs, _mk_char())
        for src in sources:
            assert src.priority == 100, f"{src.identifier} 优先级漂到 {src.priority}"
            assert src.trimmable is False, f"{src.identifier} 变成可裁剪 = 拆分丢内容风险"

    def test_p1_proxy_messages_keep_their_old_low_priority(self):
        """兼容分支不受本批影响：旧代理消息仍是低优先级可裁（避免与 main 双份占预算）。"""
        msgs = [
            {"role": "system", "content": "MAIN", "_palink_prompt_id": PROMPT_ID_SYSTEM_PROMPT},
            {"role": "system", "content": _LABEL_DESC + DESC_TEXT,
             "_palink_prompt_id": PROMPT_ID_CHAR_DESCRIPTION,
             "_palink_char_field_proxy": True},
        ]
        sources = _collect_prompt_sources(msgs, _mk_char())
        proxy = [s for s in sources if s.identifier == PROMPT_ID_CHAR_DESCRIPTION][0]
        assert proxy.trimmable is True
