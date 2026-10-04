"""L2 生成参数「按卡影子副本」的契约测试（2026-10-04，用户裁定：放，但封顶）。

裁决记录：结构性动作只放「动用户自己数据」那半桶；生成参数放给插件，但必须过闸 3。
本文件锁的就是「放」与「封顶」同时成立：

  1. 优先级：卡影子 > 用户自己的设置 > 模型注册表；
  2. **三层里最上层也要过闸 3** —— 插件把该值设成 200 万，只能拿到模型真实窗口；
  3. 影子是按卡存的：A 卡影子不得影响 B 卡，也不影响不传 character_id 的旧调用；
  4. 影子缺失时行为与改动前一致（回落到用户设置）。

配套前端侧（SillyTavern.chatCompletionSettings 挂活子对象 / custom_include_body 记账）
在 frontend/src/utils/__tests__/plugin-runtime-l1-settings.test.ts 的 L2 段。
"""
from __future__ import annotations

import json

import pytest

from app.services import roleplay_prompt_assembly as asm


def _us(payload: dict):
    class _US:
        pass
    us = _US()
    us.silly_tavern_settings = json.dumps(payload)
    return us


@pytest.fixture
def windows(monkeypatch):
    table = {"gpt-x": 32768}
    monkeypatch.setattr(asm, "_get_model_context_window_strict",
                        lambda mid: table.get(mid), raising=False)
    return table


def _shadow(value):
    return {
        "oai_settings": {"openai_max_context": 8192},
        "plugin_extension_settings_by_character": {
            "card-a": {"chatCompletionSettings": {"openai_max_context": value}},
        },
    }


def test_card_shadow_beats_user_setting(windows):
    """用户自己设 8192、这张卡的影子设 16384 → 取影子（用户裁定「放」）。"""
    us = _us(_shadow(16384))
    assert asm._get_openai_max_context_override(us, "gpt-x", "card-a") == 16384


def test_card_shadow_still_clamped_to_model_window(windows):
    """★ 放但不能越底：影子写 200 万，模型真实 32768 → 只能拿 32768。"""
    us = _us(_shadow(2_000_000))
    assert asm._get_openai_max_context_override(us, "gpt-x", "card-a") == 32768


def test_shadow_is_per_card(windows):
    """B 卡没有影子 → 回落到用户自己的 8192，绝不读到 A 卡的值。"""
    us = _us(_shadow(16384))
    assert asm._get_openai_max_context_override(us, "gpt-x", "card-b") == 8192


def test_no_character_id_keeps_legacy_path(windows):
    """不传 character_id（旧调用方/装配外的使用者）：完全不看影子。"""
    us = _us(_shadow(16384))
    assert asm._get_openai_max_context_override(us, "gpt-x") == 8192


def test_shadow_absent_falls_back_to_user_setting(windows):
    """这张卡从没存过影子 → 与改动前一致。"""
    us = _us({"oai_settings": {"openai_max_context": 4096}})
    assert asm._get_openai_max_context_override(us, "gpt-x", "card-a") == 4096


def test_unknown_model_does_not_clamp_shadow(windows):
    """未收录模型不夹（否则等于把新模型误限到注册表默认值）。"""
    us = _us(_shadow(131072))
    assert asm._get_openai_max_context_override(us, "not-in-registry", "card-a") == 131072


def test_garbage_in_shadow_is_ignored_not_fatal(windows):
    """影子是插件可写内容：坏形状（bool / 字符串非数字 / 非 dict）只能被忽略。"""
    for bad in (True, "abc", None, -5):
        us = _us(_shadow(bad))
        assert asm._get_openai_max_context_override(us, "gpt-x", "card-a") == 8192
    us = _us({"plugin_extension_settings_by_character": {"card-a": {"chatCompletionSettings": "不是对象"}}})
    assert asm._get_openai_max_context_override(us, "gpt-x", "card-a") is None


def test_clamped_shadow_reaches_token_budget(windows):
    """端到端：影子顶格写的值，最后算出来的预算必须是夹过的。"""
    us = _us(_shadow(2_000_000))
    budget = asm._compute_prompt_token_budget(
        "gpt-x", 1024,
        context_window_override=asm._get_openai_max_context_override(us, "gpt-x", "card-a"),
    )
    # 32768 - 1024 - 512 = 31232（若未夹会得到 200 万级别的预算）
    assert budget == 31232
