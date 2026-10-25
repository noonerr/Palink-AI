"""[p224 2026-10-25] build_memory_context 读侧碎渣过滤（兜存量，只影响渲染）。

写侧守卫（见 test_p224_memory_write_guards.py）只关未来水源；semantic 时代
（2026-10-05~10-07）的存量碎渣行仍在 conversation_memories 里，注入时按形状清理：

① 行首 1-2 个孤立 * / ” 前缀剥离（完整 *…* 包裹的斜体行不误伤）；
② marker/【声音】/裸关键词微型行（剥掉符号后正文 <10 字且无句末标点）整行丢弃；
不做半句尾删除（会破坏「记忆=消息镜像」不变式）。
"""

import os
import sys
from types import SimpleNamespace

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.utils import build_memory_context  # noqa: E402


def _mem(content: str, role: str = "assistant"):
    return SimpleNamespace(content=content, topics=["#chunk"], role=role)


def _ctx(*memories):
    return SimpleNamespace(user_profile=None, memories=list(memories))


def _render(content: str) -> str:
    return build_memory_context(_ctx(_mem(content)), max_tokens=None)


def _body_lines(output: str) -> list:
    """取注入文本中 '- Assistant: ' 后的正文行。"""
    return [
        ln[len("- Assistant: "):]
        for ln in output.split("\n")
        if ln.startswith("- Assistant: ")
    ]


class TestOrphanMarkerPrefixStripped:
    def test_lone_star_line_dropped_content_kept(self):
        """存量 id=1417 形态：'*' 独占一行 + 正文行 → 星号行消失，正文保留。"""
        out = _render("*\n她抱着抱枕的手指攥得发白，指节泛白的样子被哥哥尽收眼底。")
        assert out is not None
        body = _body_lines(out)
        assert len(body) == 1
        assert body[0] == "她抱着抱枕的手指攥得发白，指节泛白的样子被哥哥尽收眼底。"

    def test_unclosed_star_prefix_stripped(self):
        """存量碎块尾形 '*什么操作啊！'（斜体对被旧切点截断）→ 剥掉孤立星号。"""
        out = _render("前一句剧情内容足够长，可以撑住这一块的记忆文本。\n*什么操作啊！")
        assert "什么操作啊！" in out
        assert "*什么操作啊！" not in out, "孤立星号前缀未被剥离"

    def test_curly_quote_closer_prefix_stripped(self):
        """存量 12 行孤立右引号头：'”……你说句话呀。”' → 剥掉行首闭引号。"""
        out = _render("”……你说句话呀。”她的手指还在发抖，等一个迟迟不来的回答。")
        body = _body_lines(out)
        assert body[0].startswith("……你说句话呀。”")

    def test_double_star_prefix_stripped(self):
        out = _render("**这一行开头挂着两个孤立星号，后面是足够的正文内容撑住它。")
        body = _body_lines(out)
        assert body[0].startswith("这一行开头挂着两个孤立星号")


class TestFullyWrappedItalicUntouched:
    def test_complete_italic_line_kept(self):
        """完整 *…* 斜体行不误伤。"""
        out = _render("*操作什么？*")
        assert "*操作什么？*" in _body_lines(out)[0]

    def test_complete_italic_long_line_kept(self):
        out = _render("*……看他……操作？*")
        assert "*……看他……操作？*" in _body_lines(out)[0]

    def test_inline_italic_not_mangled(self):
        """行首星号在行内有配对闭符（行内强调）时不动，防误删开符。"""
        line = "*强调*这一行是斜体开头后面还有足够的正文内容。"
        out = _render(line)
        assert line in _body_lines(out)[0]


class TestMicroLineDropped:
    def test_bare_keyword_line_dropped(self):
        """存量裸插图关键词行（<cg> 拆标签留文字时代的产物）。"""
        out = _render(
            "她把脸埋进他颈窝，攥着他的衣角不放，指节都捏得发白了。\n害羞\n露出魔纹"
        )
        body = _body_lines(out)
        assert len(body) == 1
        assert "害羞" not in body[0] or "攥着他的衣角" in body[0]
        assert all(ln.strip() not in ("害羞", "露出魔纹") for ln in body)

    def test_voice_marker_line_dropped(self):
        """存量 id=1734 形态：纯【声音】行整行丢弃。"""
        out = _render(
            "真实剧情一句话，足够长，不会被误伤掉。\n【声音：软糯委屈、带着哭腔余韵的娇软少女音】"
        )
        body = _body_lines(out)
        assert len(body) == 1
        assert "【声音" not in body[0]
        assert "真实剧情一句话" in body[0]

    def test_quote_marker_mashup_line_dropped(self):
        """存量 id=1500 形态：'”|【声音…】|害羞|露出魔纹' 整行丢弃。"""
        out = _render(
            "真实剧情一句话，足够长，不会被误伤掉。\n”|【声音：软糯】|害羞|露出魔纹"
        )
        body = _body_lines(out)
        assert len(body) == 1
        assert "露出魔纹" not in body[0]

    def test_short_line_with_sentence_punct_kept(self):
        """句末标点救行：短句不丢。"""
        out = _render("空气静了两秒。\n真实剧情一句话，足够长，不会被误伤掉。")
        body = _body_lines(out)
        assert body[0] == "空气静了两秒。"

    def test_pure_marker_memory_skipped_entirely(self):
        """整条记忆都是 marker → 无可注入，条目整体跳过。"""
        out = build_memory_context(
            _ctx(_mem("【声音：软糯委屈、带着哭腔余韵的娇软少女音】")), max_tokens=None
        )
        assert out == ""

    def test_whitespace_only_residue_memory_skipped(self):
        """碎渣行删完只剩空白行的条目（如 "*\\n\\n"）也跳过（p224 上线导出实测
        "- Assistant: " 空条目残余——裸 not text 拦不住纯空白串）。"""
        out = build_memory_context(_ctx(_mem("*\n\n")), max_tokens=None)
        assert out == ""

    def test_leading_blank_after_debris_stripped(self):
        """碎渣行是首行时，删完后剩余正文的首行空行要清掉——不许渲染成
        "- Assistant: " 空前缀行后另起正文（p224 上线导出实测 6 行这种形态）。"""
        out = build_memory_context(
            _ctx(_mem("*\n她终于憋出一句，声音又小又闷。")), max_tokens=None
        )
        assert out == "[Relevant Memories]\n- Assistant: 她终于憋出一句，声音又小又闷。"

    def test_normal_line_untouched(self):
        """正常行（≥10 字正文或带句末标点）一字不动。"""
        line = '露缇雅 | 依恋 | “……你说句话呀。”'
        out = _render(line)
        assert line in _body_lines(out)[0]


class TestMirrorInvariantPreserved:
    def test_no_half_sentence_tail_deletion(self):
        """半句尾不删（镜像不变式）：'露缇雅 | 依恋 | “……' 这类被切开的引号头保留。"""
        out = _render("前文剧情足够长，不会被过滤。下一行是被旧切点截断的残尾。")
        body = _body_lines(out)
        assert body[0].endswith("残尾。")

    def test_user_role_prefix_unchanged(self):
        out = build_memory_context(_ctx(_mem("用户说过的一句足够长的话。", role="user")), max_tokens=None)
        assert out == "[Relevant Memories]\n- User: 用户说过的一句足够长的话。"
