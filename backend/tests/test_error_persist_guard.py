# -*- coding: utf-8 -*-
"""【报错提示 1.6】错误占位文本不落库 / 不拼进真回复正文的守卫契约。

背景（docs/PROMPT_报错提示系统重写_2026-09-30.md §1.5 / §4 1.6）：
- WS 轨早有 `startswith("Error:")` 守卫；SSE 轨的 persist_snapshot 只守 has_content，
  而错误分支是「先 full_content = "Error: ..." 再 persist(force=True)」——赋值动作
  自己就让 has_content 为真，守卫形同虚设。
- 「真实输出 + 错误后缀」不满足 is_error_only，曾被 `+=` 拼进正文一起落库并回喂模型。
"""

import pytest


def _make_result():
    from app.services.stream_builder import StreamResult

    return StreamResult()


class TestErrorOnlyPredicate:
    def test_error_prefix_is_error_only(self):
        r = _make_result()
        r.full_content = "Error: 请求已中断，未收到模型回复。"
        assert r.is_error_only() is True

    def test_error_prefix_with_whitespace_is_error_only(self):
        """WS 轨旧守卫带 .strip()，谓词必须保持同一行为（带前导空白也算）。"""
        r = _make_result()
        r.full_content = "\n\n Error: 网关无响应"
        assert r.is_error_only() is True

    def test_real_output_with_error_suffix_is_not_error_only(self):
        """这正是 1.6(b) 修掉的坑：后缀拼接让错误躲过所有守卫。"""
        r = _make_result()
        r.full_content = "这是一段真实的模型回答。\n\n[推理中断: 推理过程中发生错误]"
        assert r.is_error_only() is False

    def test_empty_content_is_not_error_only(self):
        r = _make_result()
        assert r.is_error_only() is False


class TestHasContentIsNotASafeGuard:
    def test_has_content_is_true_for_error_placeholder(self):
        """守卫必须用 is_error_only() 而不是 has_content。

        has_content 对纯错误占位同样返回 True —— SSE 轨旧守卫因此失效。
        本用例锁死这个事实，防止有人把守卫改回 has_content。
        """
        r = _make_result()
        r.full_content = "Error: 服务暂时不可用"
        assert r.has_content is True
        assert r.is_error_only() is True


class TestStreamErrorSlot:
    def test_stream_error_defaults_to_none(self):
        r = _make_result()
        assert r.stream_error is None

    def test_stream_error_is_settable_and_does_not_affect_content(self):
        """1.6(b)：错误说明改走 extra.stream_error，不再污染 full_content。"""
        r = _make_result()
        r.full_content = "这是已经生成到一半的真实回复。"
        r.stream_error = "服务暂时不可用"
        assert r.stream_error == "服务暂时不可用"
        # 正文未被错误后缀污染
        assert "[服务暂时不可用]" not in r.full_content
        assert "\n\n[" not in r.full_content
        # 且因为正文是真实输出，is_error_only 仍为 False（计费/记忆路径不受影响）
        assert r.is_error_only() is False


class TestWebsocketPredicateParity:
    """WS 轨的手写 startswith 已换成同一谓词，二者必须等价。"""

    @pytest.mark.parametrize(
        "content,expected",
        [
            ("Error: x", True),
            ("  Error: x", True),
            ("正常回复", False),
            ("正常回复\n\n[推理中断: x]", False),
            ("", False),
        ],
    )
    def test_predicate_matches_old_manual_check(self, content, expected):
        r = _make_result()
        r.full_content = content
        old_manual = bool(content.strip().startswith("Error:"))
        assert r.is_error_only() is expected
        assert r.is_error_only() is old_manual
