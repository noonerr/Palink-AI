"""模型网关瘦身（方案 A）回归测试：unified_model_registry 精简后契约不变。

背景（2026-08-29 用户拍板）：
- 删除多供应商路由策略（priority/round_robin/weighted）、权重、
  RPM/并发/TPM 限流 override —— 上游聚合交给外部网关（OpenRouter 等）。
- 保留：find_model / select_provider_for_model / token 上限清单 /
  reasoning effort 映射 / 展示层覆盖（display_name/icon/context 等）。

本测试锁定三件事：
1. 瘦身后 find_model / select_provider_for_model 的返回契约不变（21 个调用点零改动）；
2. 统一模型列表不再暴露路由字段；
3. token 上限与 reasoning effort 解析行为不变。
"""

import os
import sys
from typing import Any, Dict, List

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from app.core.config import settings as app_settings
    from app.services import provider_registry, unified_model_registry as umr
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")


_FAKE_PROVIDERS: List[Dict[str, Any]] = [
    {
        "id": "prov-1",
        "name": "FakeRouter",
        "base_url": "https://fake.example/api/v1",
        "api_key": "sk-test-123",
        "is_active": True,
        "models": [
            {"id": "fake-model-a", "name": "Model A", "context_length": 4096},
            {"id": "fake-model-b", "name": "Model B"},
        ],
    },
    {
        "id": "prov-2",
        "name": "InactiveRouter",
        "base_url": "https://inactive.example/api/v1",
        "api_key": "sk-inactive",
        "is_active": False,
        "models": [{"id": "fake-model-a"}],
    },
]


@pytest.fixture(autouse=True)
def _isolate(monkeypatch, tmp_path):
    """隔离：假供应商列表 + 独立 DATA_DIR（unified_models.json / model_specs.json）。

    注意必须打补丁到 umr 命名空间——umr 通过 ``from .provider_registry import``
    绑定引用，patch provider_registry 模块属性对 umr 内部调用不生效。
    """
    monkeypatch.setattr(umr, "get_runtime_providers", lambda: [dict(p) for p in _FAKE_PROVIDERS])
    # find_model 内部回退到 provider_registry.find_model（独立模块引用），同样需要隔离
    monkeypatch.setattr(provider_registry, "get_runtime_providers", lambda: [dict(p) for p in _FAKE_PROVIDERS])

    data_dir = tmp_path / "data"
    data_dir.mkdir(exist_ok=True)
    monkeypatch.setattr(app_settings, "DATA_DIR", str(data_dir), raising=False)
    umr.invalidate_registry_cache()
    umr._MODEL_SPECS_CACHE = None
    umr._MODEL_SPECS_MTIME = 0.0
    yield
    umr.invalidate_registry_cache()
    umr._MODEL_SPECS_CACHE = None
    umr._MODEL_SPECS_MTIME = 0.0


class TestFindModelContract:
    def test_find_model_returns_provider_and_model_data(self):
        provider, model_data = umr.find_model("fake-model-a")
        assert provider is not None
        assert provider["id"] == "prov-1"
        assert provider["api_key"] == "sk-test-123"
        assert model_data["id"] == "fake-model-a"

    def test_find_model_skips_inactive_provider(self):
        # 同名模型在 inactive provider 也有 —— 只允许解析到 active 的
        provider, _ = umr.find_model("fake-model-a")
        assert provider["id"] == "prov-1"

    def test_find_model_unknown_returns_none_none(self):
        assert umr.find_model("no-such-model") == (None, None)

    def test_select_provider_normalized_id_match(self):
        sel = umr.select_provider_for_model("  FAKE-MODEL-A ")
        assert sel is not None
        info, model_data = sel
        assert info["provider_type"] == "api"
        assert info["base_url"] == "https://fake.example/api/v1"
        assert model_data["id"] == "fake-model-a"

    def test_select_provider_preferred_provider_id(self):
        info, _ = umr.select_provider_for_model("fake-model-a", preferred_provider_id="prov-1")
        assert info["provider_id"] == "prov-1"

    def test_select_provider_preferred_wrong_id_returns_none(self):
        # preferred 指向不含该模型的 provider → 不允许跨 provider 抢模型
        sel = umr.select_provider_for_model("fake-model-a", preferred_provider_id="prov-2")
        assert sel is None

    def test_select_provider_local_not_configured(self):
        assert umr.select_provider_for_model("no-such-model") is None


class TestUnifiedListShape:
    def test_no_routing_fields(self):
        models = umr.get_unified_model_list()
        assert models, "至少应解析出 fake provider 的模型"
        for m in models:
            assert "routing_strategy" not in m
            assert "failover_enabled" not in m
            for p in m["providers"]:
                for legacy in ("priority", "weight", "max_rpm", "max_tokens_per_min", "max_concurrent"):
                    assert legacy not in p, f"路由字段 {legacy} 应已删除"

    def test_flat_list_keeps_provider_info(self):
        flat = umr.get_flat_model_list()
        ids = {item["id"] for item in flat}
        assert "fake-model-a" in ids
        item = next(i for i in flat if i["id"] == "fake-model-a")
        assert item["provider_id"] == "prov-1"
        assert item["supports_vision"] is False


class TestDisplayOverrideAndTokenLimits:
    def test_save_and_read_display_override(self):
        umr.save_unified_model_config(
            "fake-model-a", display_name="自定义名", context_length=32768
        )
        models = umr.get_unified_model_list()
        m = next(x for x in models if x["unified_id"] == "fake-model-a")
        assert m["display_name"] == "自定义名"
        assert m["context_length"] == 32768

    def test_token_limits_fallback_4096(self):
        ctx, out = umr.get_model_token_limits("fake-model-b")
        # 未知模型：上下文兜底 4096；输出未指定时跟随 min(ctx, 默认 8192)
        assert ctx == 4096
        assert out == 4096

    def test_output_cap_none_for_unknown_model(self):
        assert umr.get_model_output_cap("no-such-model") is None

    def test_output_cap_respects_override(self):
        umr.save_unified_model_config("fake-model-b", max_output_tokens=4096)
        assert umr.get_model_output_cap("fake-model-b") == 4096


class TestReasoningEffort:
    def test_off_and_empty_send_nothing(self):
        assert umr.resolve_reasoning_effort("fake-model-a", None) is None
        assert umr.resolve_reasoning_effort("fake-model-a", "off") is None

    def test_deepseek_uses_dedicated_thinking_field(self):
        assert umr.resolve_reasoning_effort("deepseek-r1", "high") is None

    def test_gpt5_min_maps_to_minimal(self):
        assert umr.resolve_reasoning_effort("gpt-5.2", "min") == "minimal"

    def test_compat_models_clamp(self):
        assert umr.resolve_reasoning_effort("qwen3-max", "min") == "low"
        assert umr.resolve_reasoning_effort("kimi-k2", "max") == "high"
