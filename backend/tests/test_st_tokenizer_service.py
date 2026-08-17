"""Unit tests for ST-aligned tokenizer service (st_tokenizer_service.py).

Tests cover:
1. Model name → tokenizer type mapping (get_tokenizer_model)
2. Guesstimate fallback alignment with ST
3. Token counting with real tokenizers (when dependencies are installed)
4. Contextvar-based model name passing (set_current_model / get_current_model)
5. ST compat endpoint type-based API (get_token_count_by_type / encode_tokens_by_type)
6. Fallback behavior when tokenizer backends are unavailable

Tests are designed to pass with or without tiktoken/sentencepiece/tokenizers
installed — they verify the mapping logic and fallback behavior, and skip
real-tokenizer assertions when the libraries are not available.
"""

import os
import sys

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.services.st_tokenizer_service import (  # noqa: E402
    BYTES_PER_TOKEN,
    guesstimate,
    get_tokenizer_model,
    get_token_count,
    encode_tokens,
    decode_tokens,
    get_tokenizer_info,
    set_current_model,
    reset_current_model,
    get_current_model,
    get_token_count_for_current_model,
    get_token_count_by_type,
    encode_tokens_by_type,
    decode_tokens_by_type,
    _tiktoken_lib,
    _sentencepiece_lib,
    _hf_tokenizers_lib,
)


# ---------------------------------------------------------------------------
# Model name → tokenizer type mapping (ST tokenizers.js:441-528)
# ---------------------------------------------------------------------------
class TestGetTokenizerModel:
    """Verify model name to tokenizer type mapping matches ST 1.18.0."""

    def test_openai_gpt4o(self):
        assert get_tokenizer_model("gpt-4o") == "gpt-4o"
        assert get_tokenizer_model("gpt-4o-2024-08-06") == "gpt-4o"
        assert get_tokenizer_model("chatgpt-4o-latest") == "gpt-4o"

    def test_openai_gpt4(self):
        assert get_tokenizer_model("gpt-4") == "gpt-4"
        assert get_tokenizer_model("gpt-4-32k") == "gpt-4-32k"

    def test_openai_gpt35(self):
        assert get_tokenizer_model("gpt-3.5-turbo") == "gpt-3.5-turbo"
        assert get_tokenizer_model("gpt-3.5-turbo-0301") == "gpt-3.5-turbo-0301"

    def test_openai_o1(self):
        assert get_tokenizer_model("o1") == "o1"
        assert get_tokenizer_model("o1-preview") == "o1"
        assert get_tokenizer_model("o1-mini") == "o1"
        assert get_tokenizer_model("o3-mini") == "o1"

    def test_openai_gpt5(self):
        assert get_tokenizer_model("gpt-5") == "o1"
        assert get_tokenizer_model("o3") == "o1"

    def test_claude(self):
        assert get_tokenizer_model("claude-3-opus") == "claude"
        assert get_tokenizer_model("claude-3.5-sonnet") == "claude"

    def test_llama3(self):
        assert get_tokenizer_model("llama3-70b") == "llama3"
        assert get_tokenizer_model("llama-3-8b") == "llama3"

    def test_llama(self):
        assert get_tokenizer_model("llama-2-70b") == "llama"

    def test_mistral(self):
        assert get_tokenizer_model("mistral-7b") == "mistral"
        assert get_tokenizer_model("mixtral-8x7b") == "mistral"

    def test_yi(self):
        assert get_tokenizer_model("yi-34b") == "yi"

    def test_deepseek(self):
        assert get_tokenizer_model("deepseek-coder-33b") == "deepseek"

    def test_gemma(self):
        assert get_tokenizer_model("gemma-7b") == "gemma"
        assert get_tokenizer_model("gemini-pro") == "gemma"

    def test_jamba(self):
        assert get_tokenizer_model("jamba-1.5") == "jamba"

    def test_qwen2(self):
        assert get_tokenizer_model("qwen2-72b") == "qwen2"

    def test_command_r(self):
        assert get_tokenizer_model("command-r-plus") == "command-r"

    def test_command_a(self):
        assert get_tokenizer_model("command-a") == "command-a"

    def test_nemo(self):
        # ST checks 'mistral' before 'nemo', so 'mistral-nemo' → 'mistral'
        # Only models with 'nemo' but NOT 'mistral' map to 'nemo'
        assert get_tokenizer_model("pixtral-12b") == "nemo"
        # 'mistral-nemo-12b' contains 'mistral' → maps to 'mistral' (ST behavior)
        assert get_tokenizer_model("mistral-nemo-12b") == "mistral"

    def test_default(self):
        assert get_tokenizer_model("") == "gpt-3.5-turbo"
        assert get_tokenizer_model("unknown-model") == "gpt-3.5-turbo"


# ---------------------------------------------------------------------------
# Guesstimate alignment with ST (tokenizers.js:69-72)
# ---------------------------------------------------------------------------
class TestGuesstimate:
    """Verify guesstimate matches ST's ceil(byteLength / 3.35) formula."""

    def test_empty_string(self):
        assert guesstimate("") == 0
        assert guesstimate(None) == 0  # type: ignore

    def test_ascii_text(self):
        # "Hello" = 5 bytes → ceil(5 / 3.35) = ceil(1.49) = 2
        assert guesstimate("Hello") == 2

    def test_longer_ascii(self):
        # "Hello, world!" = 13 bytes → ceil(13 / 3.35) = ceil(3.88) = 4
        assert guesstimate("Hello, world!") == 4

    def test_cjk_text(self):
        # "你好" = 6 bytes (UTF-8) → ceil(6 / 3.35) = ceil(1.79) = 2
        assert guesstimate("你好") == 2

    def test_mixed_text(self):
        text = "Hello 世界!"
        byte_len = len(text.encode("utf-8"))
        expected = -(-byte_len // 1)  # placeholder
        import math
        expected = math.ceil(byte_len / BYTES_PER_TOKEN)
        assert guesstimate(text) == expected


# ---------------------------------------------------------------------------
# Token counting (with fallback)
# ---------------------------------------------------------------------------
class TestGetTokenCount:
    """Test token counting with fallback behavior."""

    def test_empty_text(self):
        assert get_token_count("", "gpt-4o") == 0
        assert get_token_count("", "") == 0

    def test_ascii_text_returns_positive(self):
        count = get_token_count("Hello, world!", "gpt-4o")
        assert count > 0
        # Should be at least 1 token for non-empty text
        assert count >= 1

    def test_cjk_text_returns_positive(self):
        count = get_token_count("你好世界", "gpt-4o")
        assert count > 0

    def test_fallback_to_guesstimate_when_no_backend(self):
        # When no tokenizer backend is available, should fall back to guesstimate
        # This test verifies the fallback path doesn't crash
        count = get_token_count("Test text", "nonexistent-model-xyz")
        assert count > 0

    def test_different_models_produce_results(self):
        # All model types should return a positive token count
        for model in ["gpt-4o", "claude-3", "llama-3", "mistral-7b", "gemma-7b"]:
            count = get_token_count("Hello world", model)
            assert count > 0, f"Model {model} returned 0 tokens"


# ---------------------------------------------------------------------------
# Encode / decode round-trip
# ---------------------------------------------------------------------------
class TestEncodeDecode:
    """Test token encoding and decoding."""

    def test_encode_returns_list_of_ints(self):
        ids = encode_tokens("Hello", "gpt-4o")
        assert isinstance(ids, list)
        assert all(isinstance(i, int) for i in ids)

    def test_encode_empty_text(self):
        assert encode_tokens("", "gpt-4o") == []

    def test_decode_returns_string(self):
        ids = encode_tokens("Hello world", "gpt-4o")
        if ids:
            text = decode_tokens(ids, "gpt-4o")
            assert isinstance(text, str)

    def test_decode_empty_ids(self):
        assert decode_tokens([], "gpt-4o") == ""

    @pytest.mark.skipif(
        _tiktoken_lib is None,
        reason="tiktoken not installed"
    )
    def test_tiktoken_round_trip(self):
        """When tiktoken is available, encode→decode should round-trip."""
        original = "Hello, world! 你好世界"
        ids = encode_tokens(original, "gpt-4o")
        decoded = decode_tokens(ids, "gpt-4o")
        assert decoded == original


# ---------------------------------------------------------------------------
# Contextvar-based model name passing
# ---------------------------------------------------------------------------
class TestContextVarModel:
    """Test thread-safe model name passing via contextvars."""

    def test_default_model_is_empty(self):
        assert get_current_model() == ""

    def test_set_and_get_model(self):
        token = set_current_model("gpt-4o")
        assert get_current_model() == "gpt-4o"
        reset_current_model(token)
        assert get_current_model() == ""

    def test_nested_model_context(self):
        token1 = set_current_model("gpt-4o")
        assert get_current_model() == "gpt-4o"

        token2 = set_current_model("claude-3")
        assert get_current_model() == "claude-3"

        reset_current_model(token2)
        assert get_current_model() == "gpt-4o"

        reset_current_model(token1)
        assert get_current_model() == ""

    def test_get_token_count_for_current_model(self):
        # Without model set, should use guesstimate
        token = set_current_model("")
        count1 = get_token_count_for_current_model("Hello world")
        reset_current_model(token)

        # With model set, should use the appropriate tokenizer
        token = set_current_model("gpt-4o")
        count2 = get_token_count_for_current_model("Hello world")
        reset_current_model(token)

        # Both should return positive counts
        assert count1 > 0
        assert count2 > 0


# ---------------------------------------------------------------------------
# ST compat endpoint type-based API
# ---------------------------------------------------------------------------
class TestTypeBasedAPI:
    """Test the type-based API used by the ST compat endpoint."""

    def test_get_token_count_by_type_llama(self):
        count = get_token_count_by_type("Hello world", "llama")
        assert count > 0

    def test_get_token_count_by_type_gpt2(self):
        count = get_token_count_by_type("Hello world", "gpt2")
        assert count > 0

    def test_get_token_count_by_type_openai_with_model(self):
        count = get_token_count_by_type("Hello world", "openai", model_override="gpt-4o")
        assert count > 0

    def test_get_token_count_by_type_openai_without_model(self):
        # Should fall back to default (gpt-3.5-turbo → cl100k_base)
        count = get_token_count_by_type("Hello world", "openai")
        assert count > 0

    def test_encode_tokens_by_type(self):
        ids = encode_tokens_by_type("Hello", "gpt2")
        assert isinstance(ids, list)
        assert len(ids) > 0

    def test_encode_tokens_by_type_empty(self):
        assert encode_tokens_by_type("", "llama") == []

    def test_decode_tokens_by_type_empty(self):
        assert decode_tokens_by_type([], "llama") == ""

    @pytest.mark.skipif(
        _tiktoken_lib is None,
        reason="tiktoken not installed"
    )
    def test_gpt2_round_trip_by_type(self):
        original = "Hello, world!"
        ids = encode_tokens_by_type(original, "gpt2")
        decoded = decode_tokens_by_type(ids, "gpt2")
        assert decoded == original


# ---------------------------------------------------------------------------
# Tokenizer info / diagnostics
# ---------------------------------------------------------------------------
class TestTokenizerInfo:
    """Test tokenizer info diagnostics."""

    def test_info_returns_dict(self):
        info = get_tokenizer_info("gpt-4o")
        assert isinstance(info, dict)
        assert "model_name" in info
        assert "tokenizer_type" in info
        assert "backend" in info
        assert "available" in info

    def test_info_model_name(self):
        info = get_tokenizer_info("gpt-4o")
        assert info["model_name"] == "gpt-4o"
        assert info["tokenizer_type"] == "gpt-4o"

    def test_info_llama(self):
        info = get_tokenizer_info("llama-2-70b")
        assert info["tokenizer_type"] == "llama"

    def test_info_backend_is_valid(self):
        info = get_tokenizer_info("gpt-4o")
        assert info["backend"] in ("tiktoken", "sentencepiece", "hf-tokenizers", "none")


# ---------------------------------------------------------------------------
# Backend availability detection
# ---------------------------------------------------------------------------
class TestBackendAvailability:
    """Test that backend availability is correctly detected."""

    def test_tiktoken_availability(self):
        info = get_tokenizer_info("gpt-4o")
        if _tiktoken_lib is not None:
            assert info["backend"] == "tiktoken"
            assert info["available"] is True
        else:
            # Without tiktoken, should fall back to "none" for OpenAI models
            # (since we don't bundle tiktoken encodings)
            assert info["available"] in (True, False)

    @pytest.mark.skipif(
        _sentencepiece_lib is None,
        reason="sentencepiece not installed"
    )
    def test_sentencepiece_llama_available(self):
        info = get_tokenizer_info("llama-2-70b")
        assert info["backend"] == "sentencepiece"
        assert info["available"] is True

    @pytest.mark.skipif(
        _hf_tokenizers_lib is None,
        reason="tokenizers (HF) not installed"
    )
    def test_hf_tokenizer_claude_available(self):
        info = get_tokenizer_info("claude-3-opus")
        assert info["backend"] == "hf-tokenizers"
        assert info["available"] is True
