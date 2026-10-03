"""[B2-AUTO-THINK 2026-10-03] auto 档思考预算回归守卫。

缺陷：``calculate_reasoning_budget`` 对 ``auto`` 返回 **0**，而下游
``reasoning_on`` 只判「effort 非 None 且非 off」→ ``auto`` 照样进推理分支，
于是 deepseek 下发 ``max_completion_tokens = body_budget + 0``，
**思考额度被压到 0**。而 ``provider_registry.get_providers`` 会给所有未配置模型
补 ``reasoning_effort = "auto"``，于是**所有默认档 deepseek 模型都不思考**。

用户报的是「思考异常长」，结果被修成了「根本不思考」——方向反了。

本文件锁死：
  1. auto 拿到**非零**预算，且与 medium 档恒等（等价近似的定义）。
  2. auto 下发总量 > 正文额度（实测口径：max_tokens=2048 时不再是 2048）。
  3. off 真的返回 0（思考额度归零 ≠ 保留一个小的正数）。
  4. 开关判定与预算归一化不��叉（"OFF"/" Off " 这类人写值必须先判关）。
  5. ``reasoning_on`` 对 off / 空串 / 未指定的原值语义未被归一化顺手改掉。

回归口径（本文件就是 bug 的最小复现，数字别改）：
  修复前 auto@2048 → budget=0，total=2048（思考归零）
"""

import os
import sys

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from app.services.inference_dispatcher import (
        REASONING_BUDGET_AUTO_EFFORT,
        REASONING_BUDGET_MIN,
        calculate_reasoning_budget,
        ensure_body_budget_min,
    )
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")


def _dispatch_total(max_tokens: int, effort, stream: bool) -> int:
    """复刻 dispatcher deepseek 分支的下发总量：body + 思考预算。"""
    body = ensure_body_budget_min(max_tokens)
    return body + calculate_reasoning_budget(body, effort, stream=stream)


# ── 1. auto 必须有思考额度 ────────────────────────────────────────────────

def test_auto_effort_is_not_zero_budget():
    """auto 不得再返回 0（这正是「根本不思考」的根因）。"""
    assert calculate_reasoning_budget(2048, "auto", stream=True) > 0, (
        "auto 档思考预算归零：provider_registry 给未配置模型补 auto，"
        "等于所有默认档 deepseek 都被禁思考（用户报「思考异常长」被修反了）"
    )


def test_auto_effort_equals_medium_ratio_bucket():
    """auto ≡ medium 档（复用比例，不另立常量，日后调档只改一处）。"""
    assert REASONING_BUDGET_AUTO_EFFORT == "medium"
    for body in (1024, 2048, 8192, 32000):
        assert calculate_reasoning_budget(body, "auto", stream=True) == \
            calculate_reasoning_budget(body, "medium", stream=True)


def test_auto_total_exceeds_body_budget():
    """回归口径：max_tokens=2048 时下发总量必须 > 2048（修复前恒等于 2048）。"""
    total = _dispatch_total(2048, "auto", stream=True)
    assert total > 2048, f"auto@2048 下发 total={total}，思考额度仍为 0"
    # 且不应回到修复前的「顶格 8192」——auto 是近似不是无节制
    assert total < 8192, f"auto@2048 下发 total={total}，退回了顶格 8192 的旧行为"


# ── 2. off 必须真的关闭 ──────────────────────────────────────────────────

@pytest.mark.parametrize("stream", [True, False])
def test_off_effort_budget_is_zero(stream):
    assert calculate_reasoning_budget(2048, "off", stream=stream) == 0


def test_off_effort_total_equals_body_only():
    """off 下发的总量就是正文额度，没有附加思考额度。"""
    body = ensure_body_budget_min(2048)
    assert _dispatch_total(2048, "off", stream=True) == body


# ── 3. 归一化：开关判定与预算函数不得分叉 ────────────────────────────────

@pytest.mark.parametrize("raw", ["OFF", "Off", " off ", "\toff\n"])
def test_off_variants_normalize_to_zero(raw):
    """人写的 "OFF"/"Off" 必须与 "off" 同义，否则开关判开而预算归零。"""
    assert calculate_reasoning_budget(2048, raw, stream=True) == 0


@pytest.mark.parametrize("raw", ["AUTO", " Auto "])
def test_auto_variants_normalize_to_medium_bucket(raw):
    assert calculate_reasoning_budget(2048, raw, stream=True) == \
        calculate_reasoning_budget(2048, "auto", stream=True)


@pytest.mark.parametrize("raw", [None, "", "   ", "bogus"])
def test_unset_or_unknown_effort_still_zero(raw):
    """未指定/空串/未知值不分配思考额度（未知值不能被当成 auto 白送额度）。"""
    assert calculate_reasoning_budget(2048, raw, stream=True) == 0


# ── 4. reasoning_on 判定的原值语义未被归一化顺手改掉 ──────────────────────

def _reasoning_on(effort, is_deepseek: bool) -> bool:
    """复刻 dispatcher（流式/非流式同式）的 reasoning_on 判定。

    归一化只能作用在「和 off 比」上；「是否指定」必须仍看原值 is not None，
    否则空串（配了但没填）会从「已指定」悄悄变成「未指定」→ 非 deepseek 模型
    的思考开关整个翻转。
    """
    norm = (effort or "").strip().lower()
    off = norm == "off"
    return (effort is not None and not off) or (is_deepseek and effort is None)


def test_empty_string_counts_as_specified_for_non_deepseek():
    assert _reasoning_on("", is_deepseek=False) is True
    assert _reasoning_on(None, is_deepseek=False) is False


def test_off_never_enters_reasoning_branch_even_for_deepseek():
    for raw in ("off", "OFF", " Off "):
        assert _reasoning_on(raw, is_deepseek=True) is False


def test_deepseek_default_none_still_enters_reasoning_branch():
    assert _reasoning_on(None, is_deepseek=True) is True


def test_auto_enters_reasoning_branch_with_real_budget():
    """进分支 + 拿到非零预算，两条同时成立才算 auto 被真正修好。"""
    assert _reasoning_on("auto", is_deepseek=True) is True
    assert calculate_reasoning_budget(2048, "auto", stream=True) >= REASONING_BUDGET_MIN