import sys, json
sys.path.insert(0, "/app")
import app.services.unified_model_registry as U
from app.services.unified_model_registry import get_flat_model_list, select_provider_for_model
from app.services.provider_registry import get_runtime_providers

# ---- 模拟两个 provider 都提供同名 deepseek-v4-flash ----
fake_runtime = [
    {
        "id": "prov-A", "name": "ProviderA", "base_url": "https://a.example/v1",
        "api_key": "sk-a", "is_active": True,
        "models": [{"id": "deepseek-v4-flash", "name": "DS Flash"}],
    },
    {
        "id": "prov-B", "name": "ProviderB", "base_url": "https://b.example/v1",
        "api_key": "sk-b", "is_active": True,
        "models": [{"id": "deepseek-v4-flash", "name": "DS Flash"}],
    },
]
fake_unified = [{
    "unified_id": "deepseek-v4-flash",
    "display_name": "DeepSeek V4 Flash",
    "providers": [
        {"provider_id": "prov-A", "provider_name": "ProviderA", "provider_type": "api", "model_id": "deepseek-v4-flash", "enabled": True},
        {"provider_id": "prov-B", "provider_name": "ProviderB", "provider_type": "api", "model_id": "deepseek-v4-flash", "enabled": True},
    ],
}]

orig_rt = U.get_runtime_providers
orig_um = U.get_unified_model_list
U.get_runtime_providers = lambda: fake_runtime
U.get_unified_model_list = lambda: fake_unified
try:
    print("FAKE 2-PROVIDER SAME-MODEL TEST:")
    sA = select_provider_for_model("deepseek-v4-flash", preferred_provider_id="prov-A")
    sB = select_provider_for_model("deepseek-v4-flash", preferred_provider_id="prov-B")
    sNone = select_provider_for_model("deepseek-v4-flash")
    print("  pick A      ->", (sA[0].get("provider_name"), sA[0].get("base_url")) if sA else None)
    print("  pick B      ->", (sB[0].get("provider_name"), sB[0].get("base_url")) if sB else None)
    print("  no pref     ->", (sNone[0].get("provider_name")) if sNone else None, "(priority -> first enabled = A)")
    # 禁用 B 后，无偏好应落到 A；指定 B 应失败回退到 A
    fake_unified[0]["providers"][1]["enabled"] = False
    sBoff = select_provider_for_model("deepseek-v4-flash", preferred_provider_id="prov-B")
    sNoPrefBoff = select_provider_for_model("deepseek-v4-flash")
    print("  B disabled, pick B ->", (sBoff[0].get("provider_name")) if sBoff else None, "(回退到 A)")
    print("  B disabled, no pref->", (sNoPrefBoff[0].get("provider_name")) if sNoPrefBoff else None, "(应 = A)")
finally:
    U.get_runtime_providers = orig_rt
    U.get_unified_model_list = orig_um
