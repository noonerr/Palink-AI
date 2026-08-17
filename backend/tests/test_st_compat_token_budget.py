"""ST-Compat token 预算裁剪测试 (D4 + D6 修复).

直接测试 _apply_st_compat_history_trim 函数，验证 ST 1.18.0
TokenBudgetExceededError + reserveBudget 语义：

覆盖 spec 中 4 个 Scenario:
    1. 历史超预算 → 从中间裁剪（保留开头 [Start a new Chat] + 末尾若干条）
    2. pin_examples=true → 示例保留，历史被裁剪
    3. pin_examples=false → 示例先被裁掉，历史保留
    4. 强制项不被裁剪（mandatory 超预算时跳过历史裁剪）
"""

import os
import sys

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from app.services.roleplay_prompt_assembly import (  # noqa: E402
        _apply_st_compat_history_trim,
        _estimate_tokens,
        PromptAssemblyReportItem,
    )
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")


def _total_tokens(messages):
    """计算 messages 总 token 数（使用与生产一致的 _estimate_tokens）。"""
    return sum(_estimate_tokens(str(m.get("content", ""))) for m in messages)


def _sys(content):
    return {"role": "system", "content": content}


def _user(content):
    return {"role": "user", "content": content}


def _asst(content):
    return {"role": "assistant", "content": content}


def _long_text(words=100):
    """生成约 words 个英文单词的文本（token 估算 ≈ 词数）。"""
    return " ".join(f"word{i}" for i in range(words))


def _build_over_budget_messages(num_history=20, with_examples=False):
    """构造超预算的 messages：强制项 + [Start a new Chat] + 长历史 + jailbreak。"""
    messages = [
        _sys("main prompt " + _long_text(20)),          # 强制项 main
        _sys("world info before " + _long_text(20)),    # 强制项 WIBefore
    ]
    if with_examples:
        messages.append(_sys("[Example Chat]\n" + _long_text(50)))  # 示例块
    messages.append(_sys("[Start a new Chat]"))         # 历史起点
    for i in range(num_history):
        if i % 2 == 0:
            messages.append(_user(f"user msg {i} " + _long_text(30)))
        else:
            messages.append(_asst(f"asst msg {i} " + _long_text(30)))
    messages.append(_sys("jailbreak content " + _long_text(10)))  # 末尾强制项 jailbreak
    return messages


def _find_marker_idx(messages, marker="[Start a new Chat]"):
    for i, m in enumerate(messages):
        if marker in str(m.get("content", "")):
            return i
    return -1


def test_under_budget_no_trim():
    """预算充足时不裁剪。"""
    messages = [_sys("main"), _sys("[Start a new Chat]"), _user("hi"), _asst("hello")]
    report = []
    result = _apply_st_compat_history_trim(messages, token_budget=100000, report=report)
    assert len(result) == len(messages)
    assert not any(r.key == "st_compat_trim" for r in report)


def test_over_budget_trims_history_keeps_ends():
    """Scenario 1: 超预算时裁剪历史中段，保留 [Start a new Chat] 开头 + 末尾消息。"""
    messages = _build_over_budget_messages(num_history=30)
    original_len = len(messages)
    report = []
    # 动态预算 = 总 token 的 50%，确保超预算但强制项不超 budget*0.7
    budget = int(_total_tokens(messages) * 0.5)
    result = _apply_st_compat_history_trim(messages, token_budget=budget, report=report, pin_examples=True)

    assert len(result) < original_len, "应裁剪掉部分历史消息"
    # [Start a new Chat] 标记保留
    assert _find_marker_idx(result) >= 0, "[Start a new Chat] 标记应保留"
    # 末尾 jailbreak 强制项保留
    assert any("jailbreak content" in str(m.get("content", "")) for m in result), "jailbreak 强制项应保留"
    # 开头 main 强制项保留
    assert "main prompt" in str(result[0].get("content", "")), "main 强制项应保留"
    # report 记录裁剪
    assert any(r.key == "st_compat_trim" and r.status == "trimmed" for r in report)


def test_pin_examples_false_drops_examples_first():
    """Scenario 3: pin_examples=false 时示例块先被裁掉。"""
    messages = _build_over_budget_messages(num_history=30, with_examples=True)
    report = []
    # 动态预算：裁掉示例后仍略超预算，确保示例被裁
    budget = int(_total_tokens(messages) * 0.6)
    result = _apply_st_compat_history_trim(messages, token_budget=budget, report=report, pin_examples=False)

    # 示例块应被裁掉
    assert not any("[Example Chat]" in str(m.get("content", "")) for m in result), \
        "pin_examples=false 时示例块应被裁掉"
    assert any("pin_examples=false" in (r.detail or "") for r in report)


def test_pin_examples_true_preserves_examples():
    """Scenario 2: pin_examples=true 时示例保留，历史被裁剪。"""
    messages = _build_over_budget_messages(num_history=30, with_examples=True)
    report = []
    # 动态预算 = 总 token 的 50%
    budget = int(_total_tokens(messages) * 0.5)
    result = _apply_st_compat_history_trim(messages, token_budget=budget, report=report, pin_examples=True)

    # 示例块应保留（pin_examples=true）
    assert any("[Example Chat]" in str(m.get("content", "")) for m in result), \
        "pin_examples=true 时示例块应保留"
    # 历史被裁剪
    assert len(result) < len(messages)


def test_mandatory_exceeds_budget_skips_trim():
    """Scenario 4: 强制项已超预算时不裁剪历史（与 ST TokenBudgetExceededError 一致）。"""
    # 构造：强制项极大，历史极小，预算极小 → history_budget <= 0
    messages = [
        _sys("main " + _long_text(500)),               # 巨大强制项
        _sys("[Start a new Chat]"),
        _user("hi"),
        _asst("hello"),
        _user("bye"),
        _asst("goodbye"),
        _sys("jailbreak " + _long_text(500)),          # 巨大强制项
    ]
    report = []
    result = _apply_st_compat_history_trim(messages, token_budget=50, report=report, pin_examples=True)

    # 强制项超预算 → 跳过裁剪，消息数不变
    assert len(result) == len(messages), "强制项超预算时不应裁剪历史"
    assert any(r.key == "st_compat_trim" and r.status == "skipped" for r in report)


def test_jailbreak_and_trailing_system_not_trimmed():
    """末尾多条强制 system 消息（jailbreak + AN + nudge）均不被裁剪。"""
    messages = _build_over_budget_messages(num_history=30)
    # 追加多条末尾强制 system 消息（模拟 author's note pos1 + group nudge）
    messages.append(_sys("author note pos1 " + _long_text(10)))
    messages.append(_sys("group nudge " + _long_text(10)))
    report = []
    # 动态预算 = 总 token 的 50%，确保触发历史裁剪
    budget = int(_total_tokens(messages) * 0.5)
    result = _apply_st_compat_history_trim(messages, token_budget=budget, report=report, pin_examples=True)

    # 所有末尾强制 system 消息保留
    contents = " ".join(str(m.get("content", "")) for m in result)
    assert "jailbreak content" in contents
    assert "author note pos1" in contents
    assert "group nudge" in contents
