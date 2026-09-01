"""token_counter_service：按型号精确 token 计数的解析与降级链测试。

解析层（型号 → tokenizer spec）不依赖 tiktoken/tokenizers 库，宿主可测；
计数层依赖库安装与词表下载，缺库环境自动 skip（容器内全量运行）。
"""

import os
import sys

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from app.core.config import settings as app_settings
    from app.services import token_counter_service as tcs
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")


@pytest.fixture(autouse=True)
def _isolate(monkeypatch, tmp_path):
    """隔离 DATA_DIR（tokenizers.json 覆盖文件）+ 清空实例缓存与负缓存。"""
    data_dir = tmp_path / "data"
    data_dir.mkdir(exist_ok=True)
    monkeypatch.setattr(app_settings, "DATA_DIR", str(data_dir), raising=False)
    tcs.invalidate_registry_cache()
    with tcs._TOKENIZER_INSTANCES_LOCK:
        tcs._tokenizer_instances.clear()
    tcs._failed_specs.clear()
    yield
    tcs.invalidate_registry_cache()
    with tcs._TOKENIZER_INSTANCES_LOCK:
        tcs._tokenizer_instances.clear()
    tcs._failed_specs.clear()


class TestFamilyResolution:
    """内置家族正则：覆盖用户点名的 deepseek/qwen/claude/openai/gemini/grok 全系。"""

    def test_deepseek_family(self):
        assert tcs.resolve_tokenizer_spec("deepseek-v4-pro") == "hf:deepseek-ai/DeepSeek-V3"
        assert tcs.resolve_tokenizer_spec("deepseek-r1-distill") == "hf:deepseek-ai/DeepSeek-V3"

    def test_qwen_family(self):
        assert tcs.resolve_tokenizer_spec("qwen3-max") == "hf:Qwen/Qwen3-32B"
        assert tcs.resolve_tokenizer_spec("qwq-32b") == "hf:Qwen/Qwen3-32B"

    def test_openai_family(self):
        assert tcs.resolve_tokenizer_spec("gpt-4o-2024") == "tiktoken:o200k_base"
        assert tcs.resolve_tokenizer_spec("gpt-5.2") == "tiktoken:o200k_base"
        assert tcs.resolve_tokenizer_spec("gpt-4-turbo") == "tiktoken:cl100k_base"
        assert tcs.resolve_tokenizer_spec("gpt-3.5-turbo") == "tiktoken:cl100k_base"

    def test_open_public_vocabulary_families(self):
        assert tcs.resolve_tokenizer_spec("glm-5") == "hf:THUDM/glm-4-9b-chat"
        assert tcs.resolve_tokenizer_spec("kimi-k2") == "hf:moonshotai/Kimi-K2"
        assert tcs.resolve_tokenizer_spec("mistral-small") == "hf:mistralai/Mistral-7B-Instruct-v0.3"
        assert tcs.resolve_tokenizer_spec("llama-4") == "hf:meta-llama/Meta-Llama-3-8B"

    def test_grok_approximates_with_o200k(self):
        # xAI 未公开 API 词表：本地用 o200k 近似，真实消耗以其 usage 为准
        assert tcs.resolve_tokenizer_spec("grok-4") == "tiktoken:o200k_base"

    def test_claude_gemini_have_no_offline_vocabulary(self):
        # 两家未公开离线词表 → 显式 None（不猜），精确计数依赖 API usage
        assert tcs.resolve_tokenizer_spec("claude-sonnet-4") is None
        assert tcs.resolve_tokenizer_spec("gemini-2.5-pro") is None

    def test_unknown_model_returns_none(self):
        assert tcs.resolve_tokenizer_spec("totally-unknown-model") is None
        assert tcs.resolve_tokenizer_spec("") is None


class TestUpgradeableMapping:
    """tokenizers.json：随时升级（显式型号映射 + 家族正则覆盖），无需改代码。"""

    def test_explicit_model_override(self, monkeypatch):
        import json
        path = os.path.join(app_settings.DATA_DIR, "tokenizers.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"models": {"deepseek-v4-pro": "hf:my-org/my-fork"}}, f)
        tcs.invalidate_registry_cache()
        assert tcs.resolve_tokenizer_spec("deepseek-v4-pro") == "hf:my-org/my-fork"
        # 其他 deepseek 型号不受影响
        assert tcs.resolve_tokenizer_spec("deepseek-v4-flash") == "hf:deepseek-ai/DeepSeek-V3"

    def test_family_regex_override_and_new_family(self, monkeypatch):
        import json
        path = os.path.join(app_settings.DATA_DIR, "tokenizers.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({
                "families": {
                    "nova-.*": "hf:org/nova-tokenizer",   # 新厂商
                    "^claude": "tiktoken:cl100k_base",     # 纠偏（默认 None）
                }
            }, f)
        tcs.invalidate_registry_cache()
        assert tcs.resolve_tokenizer_spec("nova-1") == "hf:org/nova-tokenizer"
        assert tcs.resolve_tokenizer_spec("claude-3-haiku") == "tiktoken:cl100k_base"

    def test_malformed_registry_is_tolerated(self, monkeypatch):
        path = os.path.join(app_settings.DATA_DIR, "tokenizers.json")
        with open(path, "w", encoding="utf-8") as f:
            f.write("{not valid json")
        tcs.invalidate_registry_cache()
        # 坏文件 → 回落内置家族
        assert tcs.resolve_tokenizer_spec("deepseek-v4-pro") == "hf:deepseek-ai/DeepSeek-V3"


class TestCounting:
    """计数层：宿主 venv 可能缺 tiktoken/tokenizers → skipif；容器内全量运行。"""

    def _lib_available(self) -> bool:
        try:
            import tiktoken  # noqa: F401
            import tokenizers  # noqa: F401
            return True
        except ImportError:
            return False

    def test_tiktoken_openai_counting(self):
        if not self._lib_available():
            pytest.skip("宿主缺 tiktoken/tokenizers（容器内运行）")
        n = tcs.count_text_tokens("gpt-4o", "hello world")
        assert n is not None and n > 0
        # 精确性锚点：tiktoken o200k 对该文本的计数与官方一致
        import tiktoken
        assert n == len(tiktoken.get_encoding("o200k_base").encode("hello world"))

    def test_messages_counting_and_empty(self):
        if not self._lib_available():
            pytest.skip("宿主缺 tiktoken/tokenizers（容器内运行）")
        msgs = [{"role": "user", "content": "hello"},
                {"role": "assistant", "content": [{"type": "text", "text": "hi there"}]}]
        n = tcs.count_messages_tokens("gpt-4o", msgs)
        assert n is not None and n > 0
        assert tcs.count_messages_tokens("gpt-4o", []) == 0
        assert tcs.count_text_tokens("gpt-4o", "") == 0

    def test_unloadable_spec_returns_none(self):
        # claude 家族 → spec None
        assert tcs.count_text_tokens("claude-sonnet-4", "hello") is None

    def test_failed_download_negative_cached(self, monkeypatch):
        """词表下载失败 → 负缓存，同 spec 不再重试，返回 None 走降级。"""
        if not self._lib_available():
            pytest.skip("宿主缺 tiktoken/tokenizers（容器内运行）")
        called = {"n": 0}

        class _Boom:
            @staticmethod
            def from_pretrained(*a, **kw):
                called["n"] += 1
                raise RuntimeError("network down")

        import tokenizers as _tok
        monkeypatch.setattr(_tok.Tokenizer, "from_pretrained", _Boom.from_pretrained)
        assert tcs.count_text_tokens("deepseek-v4-pro", "hi") is None
        assert tcs.count_text_tokens("deepseek-v4-pro", "hi again") is None
        assert called["n"] == 1  # 负缓存生效
