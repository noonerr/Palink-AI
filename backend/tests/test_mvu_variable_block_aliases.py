"""包Q —— MVU 变量更新块**标签别名识别面**对齐上游的单测。

规格来源（一手取证，非推测）：
  .tmp_probe/mvu_bundle.js —— 卡侧引用的 MagicalAstrogy/MagVarUpdate@beta/artifact/bundle.js
  （压缩产物、全文仅 3 行，引用格式为「行:列」+ 可 grep 的字面 needle）
  · 展示层剥离正则（函数 Dr，2:462098，needle '/\\n<(update(?:variable)?'）：
      /\\n<(update(?:variable)?|variableupdate)>(?:(?!<\\1>).)*<\\/\\1?>/gis
  · 解析层标签记号（函数 Ut，2:360326，needle 'updatevariable|variableupdate|update|json_?patch'）：
      /^<(\\/?)\\s*(updatevariable|variableupdate|update|json_?patch|think|…)\\b[^>]*>/i
⇒ 上游认三种别名 <update> / <updatevariable> / <variableupdate>（大小写不敏感），
  闭合标签反引用 \\1? 要求同名，块内禁止再出现同名开标签。

验收口径：三种别名各自「解析成功 + 正文剥离 + stat_data 正确变化」，
开闭不同名**不得**误匹配，既有包 JSON 形式零回归。

⚠️ 别名判据必须避开 [BARE-JSONPATCH] 裸数组兜底，否则「解析成功」是假阳性
（兜底对任意正文都可能在扫描到合法 patch 数组时命中）。本文件用两种**只有
块路径**才能通过的写法做判据：
  1. op="add" —— 不在 _JSONPATCH_OPS 白名单内，裸兜底一定不采纳；
  2. 一条消息里两个别名块 —— 裸兜底最多采纳 1 个。
"""

import os
import re
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.services.mvu_engine import (  # noqa: E402
    _UPDATE_VAR_RE,
    MvuEngine,
    extract_update_variable_blocks,
    strip_update_variable_blocks,
)

# 三种别名 + 大小写混写，块体用 op="add"（裸兜底不认，见文件头）
_ADD_PATCH = '[{"op":"add","path":"/桃汐/好感度","value":60}]'
_DELTA_PATCH = '[{"op":"delta","path":"/桃汐/好感度","value":5}]'

ALIAS_CASES = [
    ("update_lower", "<update>", "</update>"),
    ("updatevariable", "<UpdateVariable>", "</UpdateVariable>"),
    ("variableupdate", "<variableupdate>", "</variableupdate>"),
    ("update_upper", "<UPDATE>", "</UPDATE>"),
    ("mixed_case", "<uPdAteVaRiAbLe>", "</updATEvARIABLE>"),
    ("mixed_case_short", "<UpDaTe>", "</UPDATE>"),
]


def _wrap(open_tag: str, close_tag: str, body: str, fence: str = "\n") -> str:
    return f"剧情正文。{fence}{open_tag}{fence}{body}{fence}{close_tag}{fence}后续正文。"


# ===========================================================================
# 1. 三种别名：解析 + 剥离 + stat_data 变化
# ===========================================================================


class TestAliasRecognition:
    @pytest.mark.parametrize("name,open_tag,close_tag", ALIAS_CASES)
    def test_alias_parsed_via_block_path(self, name, open_tag, close_tag):
        """op=add 只能由别名块路径解析（裸兜底不采纳 add）。"""
        text = _wrap(open_tag, close_tag, _ADD_PATCH)
        blocks = extract_update_variable_blocks(text)
        assert len(blocks) == 1, f"{name} 未被识别为变量块"
        assert blocks[0] == [{"op": "add", "path": "/桃汐/好感度", "value": 60}]

    @pytest.mark.parametrize("name,open_tag,close_tag", ALIAS_CASES)
    def test_alias_stripped_from_body(self, name, open_tag, close_tag):
        """剥了就必须解析得到，反之解析得到的标签不能留在正文（同一套正则）。"""
        text = _wrap(open_tag, close_tag, _ADD_PATCH)
        cleaned = strip_update_variable_blocks(text)
        assert re.search(r"<\s*/?\s*update", cleaned, re.I) is None, f"{name} 标签残留"
        assert "剧情正文。" in cleaned and "后续正文。" in cleaned
        assert _ADD_PATCH not in cleaned

    @pytest.mark.parametrize("name,open_tag,close_tag", ALIAS_CASES)
    def test_alias_changes_stat_data(self, name, open_tag, close_tag):
        text = _wrap(open_tag, close_tag, _DELTA_PATCH)
        cur = {"stat_data": {"桃汐": {"好感度": 50}}}
        new_vars, logs, applied = MvuEngine.update_from_reply(cur, text, {})
        assert new_vars["stat_data"]["桃汐"]["好感度"] == 55, f"{name} stat_data 未变"
        assert logs and len(applied) == 1

    def test_two_alias_blocks_are_two_blocks(self):
        """两个块：裸兜底最多给 1 个，故只有别名识别能做到。"""
        text = (
            "<update>"
            '[{"op":"delta","path":"/a","value":1}]'
            "</update>中间"
            "<variableupdate>"
            '[{"op":"delta","path":"/b","value":2}]'
            "</variableupdate>"
        )
        blocks = extract_update_variable_blocks(text)
        assert len(blocks) == 2
        assert blocks[0][0]["path"] == "/a"
        assert blocks[1][0]["path"] == "/b"
        cleaned = strip_update_variable_blocks(text)
        assert "中间" in cleaned
        assert re.search(r"<\s*/?\s*(update|variableupdate)", cleaned, re.I) is None

    def test_alias_block_with_inner_jsonpatch(self):
        """别名块内包 <JSONPatch>（上游 Do 规范化产物就是这一形状）。"""
        text = (
            "正文\n<update>\n<Analysis>想想</Analysis>\n<JSONPatch>\n"
            '[{"op":"add","path":"/桃汐/好感度","value":61}]\n</JSONPatch>\n</update>\n后续'
        )
        blocks = extract_update_variable_blocks(text)
        assert len(blocks) == 1
        assert blocks[0][0]["value"] == 61
        assert "想想" not in strip_update_variable_blocks(text)

    def test_alias_inline_without_leading_newline(self):
        """上游展示正则要求块前有 \\n；Palink 有意不要求（内联块必须仍可剥离）。"""
        text = f"前文<update>{_ADD_PATCH}</update>后文"
        assert len(extract_update_variable_blocks(text)) == 1
        cleaned = strip_update_variable_blocks(text)
        assert cleaned == "前文后文"

    def test_bare_close_tag_matches_upstream_backref(self):
        """上游 <\\/\\1?> 的 \\1? 允许裸闭合标签 </>。"""
        text = _wrap("<update>", "</>", _ADD_PATCH)
        assert len(extract_update_variable_blocks(text)) == 1
        assert "<update>" not in strip_update_variable_blocks(text)


# ===========================================================================
# 2. 反引用语义：不同名 / 未闭合 不得误匹配
# ===========================================================================


class TestBackreferenceStrictness:
    @pytest.mark.parametrize(
        "open_tag,close_tag",
        [
            ("<update>", "</UpdateVariable>"),
            ("<UpdateVariable>", "</update>"),
            ("<variableupdate>", "</update>"),
            ("<update>", "</variableupdate>"),
        ],
    )
    def test_mismatched_names_not_matched(self, open_tag, close_tag):
        text = _wrap(open_tag, close_tag, _ADD_PATCH)
        assert _UPDATE_VAR_RE.search(text) is None
        # op=add 不在裸兜底白名单内 ⇒ 别名路径不命中就彻底解析不到
        assert extract_update_variable_blocks(text) == []
        # 严格语义的代价与上游一致：展示层不剥（上游 Dr 同样要求同名）
        assert strip_update_variable_blocks(text) == text.strip()

    def test_unclosed_block_not_matched(self):
        text = f"正文\n<update>\n{_ADD_PATCH}"
        assert _UPDATE_VAR_RE.search(text) is None
        assert extract_update_variable_blocks(text) == []

    def test_attribute_style_still_unsupported(self):
        """上游展示正则不认属性式 —— 保持不支持，勿顺手扩大识别面。"""
        text = '正文 <update name="好感度" value="5" op="delta"/> 结束。'
        assert _UPDATE_VAR_RE.search(text) is None
        assert extract_update_variable_blocks(text) == []

    def test_self_closing_still_unsupported(self):
        """自闭合式（<update […] />）同样不在上游识别面内。"""
        text = f"正文 <update {_ADD_PATCH} /> 结束。"
        assert _UPDATE_VAR_RE.search(text) is None
        assert extract_update_variable_blocks(text) == []

    def test_no_nesting_same_name(self):
        """(?!<\\1>) 禁跨同名开标签：外层不成立，只采纳内层。"""
        text = (
            "<update>前缀<update>"
            '[{"op":"add","path":"/x","value":1}]'
            "</update>后缀</update>"
        )
        m = _UPDATE_VAR_RE.search(text)
        assert m is not None
        assert m.group(1).lower() == "update"
        assert "/x" in m.group(2) and "前缀" not in m.group(2)


# ===========================================================================
# 3. 零回归：既有包 JSON 形式与落库形状
# ===========================================================================


class TestNoRegression:
    def test_wrapped_updatevariable_jsonpatch_unchanged(self):
        text = (
            "一些回复\n<UpdateVariable>\n<Analysis>分析</Analysis>\n<JSONPatch>\n"
            '[{"op":"replace","path":"/桃汐/好感度","value":60}]\n</JSONPatch>\n</UpdateVariable>'
        )
        blocks = extract_update_variable_blocks(text)
        assert blocks == [[{"op": "replace", "path": "/桃汐/好感度", "value": 60}]]
        assert strip_update_variable_blocks(text) == "一些回复"

    def test_wrapped_bare_array_unchanged(self):
        text = (
            '<UpdateVariable>\n<Analysis>分析</Analysis>\n[\n  {"op": "replace", "path": "/x", "value": 1}\n]\n</UpdateVariable>'
        )
        assert extract_update_variable_blocks(text) == [
            [{"op": "replace", "path": "/x", "value": 1}]
        ]

    def test_bare_array_fallback_unchanged(self):
        """[BARE-JSONPATCH] 兜底（消息 2160 病灶）不得因本次改动消失。"""
        text = f"正文。\n{_DELTA_PATCH}\n后续。"
        assert len(extract_update_variable_blocks(text)) == 1
        assert "<" not in strip_update_variable_blocks(text)

    def test_extra_shape_matches_db_baseline(self):
        """落库形状基准（只读取自消息 id=2849）：
        extra["variables"] = {"stat_data": {...}}，
        extra["mvu_patch"] = [{"op","path","value"}, ...]。
        """
        cur = {"stat_data": {"桃汐": {"好感度": 50}}}
        reply = _wrap("<update>", "</update>", _DELTA_PATCH)
        new_vars, _logs, applied = MvuEngine.update_from_reply(cur, reply, {})
        assert list(new_vars.keys()) == ["stat_data"]
        assert isinstance(new_vars["stat_data"], dict)
        assert isinstance(applied, list) and len(applied) == 1
        assert set(applied[0].keys()) == {"op", "path", "value"}

    def test_unrelated_text_untouched(self):
        text = "他更新了自己，写了 <b>粗体</b> 与 [1] 脚注。"
        assert extract_update_variable_blocks(text) == []
        assert strip_update_variable_blocks(text) == text
