"""[标题: ...] 标记提取/剥离共享助手回归（TITLE-MARKER-FIX，2026-09-25）。

背景：character_message_builder 的标题指令让模型在回复末尾输出
「[标题: xxx]」。SSE 路径有内联剥离，WS 主路径漏了 → 标记原样显示在
消息正文末尾（实测消息 2300/2302）。正则现收口到
compact_title_service.extract_response_title，两条路径共用。
"""

import os
import sys

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.services.compact_title_service import extract_response_title  # noqa: E402


class TestExtractResponseTitle:
    def test_marker_at_end_extracted_and_stripped(self):
        # 真实形态（消息 2300）：正文 + 空行 + 末尾标记
        content = "灯室的窗外，雨仍在下。\n\n@bubble:灯塔守夜人|温暖|[晚安。]\n\n[标题: 暴风雨夜共守灯塔光]"
        title, cleaned = extract_response_title(content)
        assert title == "暴风雨夜共守灯塔光"
        assert cleaned.endswith("[晚安。]")
        assert "[标题" not in cleaned

    def test_fullwidth_colon_matched(self):
        title, cleaned = extract_response_title("正文一句。\n\n[标题：火光不灭心即是岸]")
        assert title == "火光不灭心即是岸"
        assert cleaned == "正文一句。"

    def test_no_marker_returns_original_untouched(self):
        content = "普通回复，没有任何标记。"
        title, cleaned = extract_response_title(content)
        assert title is None
        assert cleaned == content

    def test_empty_content(self):
        assert extract_response_title("") == (None, "")
        assert extract_response_title(None) == (None, None)

    def test_marker_mid_text_still_extracts_title(self):
        # 标记行内嵌在散文行里：保守保留（防误伤正文），但标题仍提取
        content = "开头 [标题: 中途标记] 结尾\n"
        title, cleaned = extract_response_title(content)
        assert title == "中途标记"
        assert cleaned == "开头 [标题: 中途标记] 结尾"

    def test_standalone_marker_line_mid_content_removed(self):
        # 实测消息 2304 的形态：标记独立成行、后面还有别的行
        content = "正文结尾。\n</now_plot>\n\n[标题: 雨夜带你看海灯塔守夜人]\n【声音：温柔沉稳的女声】"
        title, cleaned = extract_response_title(content)
        assert title == "雨夜带你看海灯塔守夜人"
        assert "[标题" not in cleaned
        assert cleaned.endswith("【声音：温柔沉稳的女声】")

    def test_standalone_marker_line_between_paragraphs_removed(self):
        content = "第一段。\n\n[标题: 某某标题]\n\n第二段。"
        title, cleaned = extract_response_title(content)
        assert title == "某某标题"
        assert cleaned == "第一段。\n\n第二段。"

    def test_title_longer_than_15_chars_not_matched(self):
        # 正则上限 15 字（与指令「11个字」呼应）：超长不匹配、不剥离
        long_title = "这是一个远远超过十五个字上限的标题所以不该被匹配到才对"
        content = f"正文。\n\n[标题: {long_title}]"
        title, cleaned = extract_response_title(content)
        assert title is None
        assert cleaned == content

    def test_fifteen_char_title_matched(self):
        title_15 = "一二三四五六七八九十一二三四五"
        assert len(title_15) == 15
        title, cleaned = extract_response_title(f"正文。\n\n[标题: {title_15}]")
        assert title == title_15
        assert cleaned == "正文。"

    def test_trailing_whitespace_after_marker_stripped(self):
        title, cleaned = extract_response_title("正文。\n\n[标题: 短标题]  \n\n")
        assert title == "短标题"
        assert cleaned == "正文。"
