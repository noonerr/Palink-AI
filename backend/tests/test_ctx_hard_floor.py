"""闸 3 —— 上下文窗口的引擎硬底（2026-10-04）。

背景（复核时发现的真问题，不是防御性假设）：
    `roleplay_prompt_assembly._get_openai_max_context_override` 此前**原样采信**
    UserSetting.silly_tavern_settings.oai_settings.openai_max_context，且它压过模型
    注册表的真实窗口。含义：谁（用户手滑、或将来接线给插件的 L2 参数）把该值设成
    2,000,000，单次请求的提示词预算就被顶到 200 万 token —— 直接冲击成本与超时，
    而 Palink 是多用户服务端。

    本文件钉住硬底：**用户设的值与模型真实窗口取小的那个**，且
    ① 注册表不认识的模型不夹（否则未收录的新模型被误夹到 8K 是功能回退，不是保护）
    ② 没设值时行为与改动前完全一致（返回 None，调用方回退注册表）
    ③ bool 不被当数字放行（True 是 int 子类，会被读成 1）
"""
from __future__ import annotations

import json

import pytest

from app.services import roleplay_prompt_assembly as asm


def _make_user_setting(payload):
    class _US:
        pass
    us = _US()
    us.silly_tavern_settings = json.dumps(payload) if payload is not None else None
    return us


@pytest.fixture
def fake_windows(monkeypatch):
    """把「模型真实窗口」查表换成可控字典，避免依赖注册表/网络/库内数据。"""
    table = {"gpt-x": 32768, "small-m": 4096}

    def _strict(model_id):
        return table.get(model_id)

    monkeypatch.setattr(asm, "_get_model_context_window_strict", _strict, raising=False)
    return table


def test_override_is_clamped_to_model_window(fake_windows):
    """设 200 万、模型真实 32768 → 只能拿到 32768。"""
    us = _make_user_setting({"oai_settings": {"openai_max_context": 2_000_000}})
    assert asm._get_openai_max_context_override(us, "gpt-x") == 32768


def test_reasonable_value_passes_through(fake_windows):
    """设的值不超过真实窗口 → 原样尊重（对齐 ST 语义，不能一律压低）。"""
    us = _make_user_setting({"oai_settings": {"openai_max_context": 16384}})
    assert asm._get_openai_max_context_override(us, "gpt-x") == 16384


def test_unknown_model_is_NOT_clamped(fake_windows):
    """注册表不认识的模型：不夹。拿 8192 默认值当底会把未收录模型误夹，那是回退。"""
    us = _make_user_setting({"oai_settings": {"openai_max_context": 200_000}})
    assert asm._get_openai_max_context_override(us, "brand-new-model") == 200_000


def test_string_value_also_clamped(fake_windows):
    """字符串数字同样要夹（ST 前端可能传字符串）。"""
    us = _make_user_setting({"oai_settings": {"openai_max_context": "999999"}})
    assert asm._get_openai_max_context_override(us, "small-m") == 4096


def test_bool_is_not_accepted_as_number():
    """True 是 int 子类 —— 不排除会被当成 1 生效。"""
    us = _make_user_setting({"oai_settings": {"openai_max_context": True}})
    assert asm._get_openai_max_context_override(us, "gpt-x") is None


def test_no_model_id_keeps_legacy_behaviour(fake_windows):
    """不传 model_id（旧调用方）：不夹，行为与改动前一致。"""
    us = _make_user_setting({"oai_settings": {"openai_max_context": 2_000_000}})
    assert asm._get_openai_max_context_override(us) == 2_000_000


def test_unset_returns_none_and_budget_path_unchanged(fake_windows):
    """没设过 → None，且预算公式仍按模型注册表口径（本测试锁的是"没回归"）。"""
    us = _make_user_setting({"oai_settings": {}})
    assert asm._get_openai_max_context_override(us, "gpt-x") is None
    # 无覆盖时 _compute_prompt_token_budget 仍会走注册表查询，不抛错
    budget = asm._compute_prompt_token_budget("no-such-model-xyz", 1024)
    assert budget > 0


def test_clamped_value_flows_into_token_budget(fake_windows, monkeypatch):
    """端到端一段：夹过的窗口要真的进到 token 预算，而不是只夹了读取口。"""
    us = _make_user_setting({"oai_settings": {"openai_max_context": 2_000_000}})
    override = asm._get_openai_max_context_override(us, "small-m")
    budget = asm._compute_prompt_token_budget(
        "small-m", 1024, context_window_override=override
    )
    # small-m 真实窗口 4096 - max_tokens 1024 - reserve 512 = 2560
    assert budget == 2560, f"预算仍按 200 万算出来的话说明硬底没接到预算口：{budget}"


def test_strict_lookup_returns_none_for_unknown(monkeypatch):
    """strict 版查不到必须给 None（不能回落成 8192 —— 那会被当成真实窗口去夹人）。"""
    def _boom(model_id):
        raise RuntimeError("registry down")
    monkeypatch.setattr("app.services.unified_model_registry.find_model", _boom, raising=True)
    assert asm._get_model_context_window_strict("whatever") is None
    assert asm._get_model_context_window_strict(None) is None
