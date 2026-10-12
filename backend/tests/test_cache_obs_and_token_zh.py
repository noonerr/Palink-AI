# -*- coding: utf-8 -*-
"""[CACHE-OBS / TOK-ZH 2026-10-12] 缓存命中数解析 + 中文 token 计数回归测试。

守两件事：
  1) `extract_cache_tokens` 三家字段名（DeepSeek 专有 / OpenAI-MiMo / Anthropic）
     都必须能读到命中数 —— 此前只认后两种，走 DeepSeek 时恒为 0。
  2) token 计数回退不许把中文按「每字 2 token」或 cl100k 估 ——
     实测真值约 0.64~0.71 token/字，旧的 2.0 高估 212%、cl100k 高估 95%。
"""
import math

import pytest

from app.services.stream_builder import extract_cache_tokens
from app.services.st_tokenizer_service import (
    guesstimate,
    smart_guesstimate,
    zh_aware_guesstimate,
)


# ── 1) 缓存字段解析 ────────────────────────────────────────────────
class TestExtractCacheTokens:
    def test_deepseek_proprietary_fields(self):
        """DeepSeek 用专有字段名，必须能读到（这是本改动修的核心缺口）。"""
        read, creation, miss = extract_cache_tokens({
            "prompt_tokens": 1000,
            "prompt_cache_hit_tokens": 900,
            "prompt_cache_miss_tokens": 100,
        })
        assert read == 900
        assert miss == 100
        assert creation == 0

    def test_openai_mimo_nested_field(self):
        read, creation, miss = extract_cache_tokens({
            "prompt_tokens": 1000,
            "prompt_tokens_details": {"cached_tokens": 800},
        })
        assert read == 800
        # 上游没给未命中数 → 用「总输入 - 命中」推
        assert miss == 200

    def test_anthropic_fields(self):
        read, creation, miss = extract_cache_tokens({
            "prompt_tokens": 1000,
            "cache_read_input_tokens": 700,
            "cache_creation_input_tokens": 50,
        })
        assert read == 700
        assert creation == 50
        assert miss == 300

    def test_missing_fields_are_zero_not_negative(self):
        read, creation, miss = extract_cache_tokens({"prompt_tokens": 1000})
        assert (read, creation, miss) == (0, 0, 0)

    def test_empty_and_none_usage(self):
        assert extract_cache_tokens({}) == (0, 0, 0)
        assert extract_cache_tokens(None) == (0, 0, 0)

    def test_deepseek_miss_not_overwritten_by_derivation(self):
        """上游给了真值 miss 时不许被「总输入-命中」覆盖。"""
        read, _, miss = extract_cache_tokens({
            "prompt_tokens": 1000,
            "prompt_cache_hit_tokens": 900,
            "prompt_cache_miss_tokens": 7,   # 故意与 1000-900 不等
        })
        assert read == 900
        assert miss == 7

    @pytest.mark.parametrize("bad", ["abc", None, [], {}])
    def test_malformed_values_do_not_raise(self, bad):
        read, creation, miss = extract_cache_tokens({
            "prompt_cache_hit_tokens": bad,
            "prompt_cache_miss_tokens": bad,
        })
        assert (read, creation, miss) == (0, 0, 0)


# ── 2) 中文 token 计数 ─────────────────────────────────────────────
class TestChineseAwareTokenCount:
    # 真实 deepseek tokenizer 实测约 0.64~0.71 token/字（中文语料）。
    # 旧的「中文 × 2」是 2.0 —— 高估 212%；cl100k 约 1.25 —— 高估 95%。
    ZE_CEIL_RATE = 0.85   # 上界：任何合理的估算都不该超过 0.85 tok/字

    def test_cjk_never_counted_as_two_tokens(self):
        """回归：旧公式 `chinese_chars * 2`。纯中文估算必须显著小于字数 × 2。"""
        text = "她沿着走廊小跑来到隔壁紧闭的房门前抬起手却又停住了" * 3
        est = smart_guesstimate(text)
        assert est < len(text) * 2 * 0.5, (
            f"中文被按 ≈2 token/字 估算了（est={est}, chars={len(text)}）"
        )

    def test_cjk_rate_within_empirical_band(self):
        """纯中文长文本：每字 token 应落在实测区间内。"""
        text = "露缇雅抿着嘴把睡裙的一角又往下拽了拽露出小腹上那道正在发热微光的粉色纹路" * 4
        rate = smart_guesstimate(text) / len(text)
        assert 0.55 <= rate <= self.ZE_CEIL_RATE, f"实测区间外的估算率 {rate:.2f}"

    def test_pure_ascii_uses_st_guesstimate(self):
        """纯 ASCII 仍走 ST 原公式（cl100k 对英文是准的，不该动）。"""
        text = "The quick brown fox jumps over the lazy dog"
        assert smart_guesstimate(text) == guesstimate(text)

    def test_mixed_text_between_pure_formulas(self):
        text = "她看到了 UpdateVariable 标记 then said OK"
        mixed = smart_guesstimate(text)
        assert 0 < mixed < guesstimate(text) * 3

    def test_empty_inputs(self):
        for fn in (guesstimate, zh_aware_guesstimate, smart_guesstimate):
            assert fn("") == 0
            assert fn(None) == 0  # type: ignore

    def test_never_negative_or_huge(self):
        for text in ("", "a", "你好", "a" * 5000, "字" * 5000):
            est = smart_guesstimate(text)
            assert 0 <= est <= max(1, len(text)) * 2

    def test_zh_aware_beats_cl100k_rate(self):
        """中文感知估算必须显著低于 cl100k 的实测水平。

        ⚠️ 这里**不用** `import tiktoken` 做对比：本仓测试环境不装 tiktoken，
        那条路只会变成一条 `pytest.skip`（本仓明令禁止用 skip 占位）。
        改用实测常数断言之——cl100k 在真实中文语料上是 **1.26 tok/字**
        （132,174 字 → 166,437 tok，2026-10-12 实测），取 1.10 作为下界。
        """
        text = "她沿着走廊小跑，来到隔壁紧闭的房门前。" * 20
        ours = smart_guesstimate(text)
        assert ours < len(text) * 1.10, (
            f"中文感知估算 {ours} 未低于 cl100k 实测水平（{len(text)} 字 × 1.10）"
        )


# ── 3) 装配侧回退链 ───────────────────────────────────────────────
class TestAssemblyFallback:
    def test_local_estimate_uses_zh_aware(self):
        """`_local_estimate_tokens` 不许再用「中文 × 2」。"""
        from app.services.roleplay_prompt_assembly import _local_estimate_tokens

        text = "她沿着走廊小跑来到隔壁紧闭的房门前" * 5
        est = _local_estimate_tokens(text)
        assert est < len(text) * 1.0, (
            f"装配侧回退仍在高估中文：est={est}, chars={len(text)}"
        )
        assert est == smart_guesstimate(text)


# ── 4) 模型列存在（迁移/模型同步） ────────────────────────────────
class TestColumnWiring:
    def test_message_model_has_cache_columns(self):
        from app.models.character import CharacterChatMessage
        cols = CharacterChatMessage.__table__.columns
        assert "cache_read_input_tokens" in cols
        assert "cache_miss_input_tokens" in cols

    def test_runtime_compat_columns_declare_them(self):
        from app.core.migrations import _RUNTIME_COMPAT_COLUMNS
        names = {(t, c) for t, c, _ in _RUNTIME_COMPAT_COLUMNS}
        assert ("character_chat_messages", "cache_read_input_tokens") in names
        assert ("character_chat_messages", "cache_miss_input_tokens") in names

    def test_stream_result_has_cache_miss_slot(self):
        from app.services.stream_builder import StreamResult
        r = StreamResult()
        assert r.cache_miss_input_tokens == 0
        assert math.isclose(r.cache_read_input_tokens, 0)
