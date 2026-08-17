"""
上层模型路由与发现

职责：
- 统一模型列表构建（build_unified_models、get_unified_model_list）
- 模型发现与查找（find_model、select_provider_for_model）
- Provider 选择策略（优先级、轮询、加权随机）
- 模型路由配置管理（save_unified_model_config）
- 扁平化模型列表（get_flat_model_list，用于前端展示）

本模块是外部模块查找模型的统一入口，应优先使用本模块的 find_model
而非直接调用 provider_registry.find_model，以获得统一的模型路由能力。
"""

import copy
import json
import logging
import os
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

from .registry_base import JsonRegistryMixin
from .provider_registry import get_providers, get_runtime_providers, get_model_vision_support, resolve_secret_reference, find_model as _provider_find_model
from .local_model_registry import (
    list_local_models,
    list_enabled_chat_models,
    get_local_model_for_inference,
    is_local_model_id,
)

logger = logging.getLogger(__name__)


class _UnifiedRegistry(JsonRegistryMixin):
    def _registry_path(self) -> str:
        from ..core import settings
        return os.path.join(settings.DATA_DIR, "unified_models.json")

    def _default_data(self) -> Dict[str, Any]:
        return {"version": 1, "models": {}}


_registry = _UnifiedRegistry()


# ---- 模型规格清单：按模型 ID 自动补全上下文窗口 / 最大输出 token ----
_MODEL_SPECS_CACHE: Optional[Dict[str, Any]] = None
_MODEL_SPECS_MTIME: float = 0.0
_DEFAULT_FALLBACK_CONTEXT = 4096
_DEFAULT_MAX_OUTPUT = 8192


def _load_model_specs() -> Dict[str, Any]:
    """读取 model_specs.json（已知模型的默认上下文/输出上限），带 mtime 缓存。"""
    global _MODEL_SPECS_CACHE, _MODEL_SPECS_MTIME
    from ..core import settings
    data_dir = getattr(settings, "DATA_DIR", None) or os.path.join(os.path.dirname(__file__), "..", "data")
    path = os.path.join(data_dir, "model_specs.json")
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return {}
    if _MODEL_SPECS_CACHE is not None and _MODEL_SPECS_MTIME == mtime:
        return _MODEL_SPECS_CACHE
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        specs = data.get("models", {})
    except Exception:
        specs = {}
    _MODEL_SPECS_CACHE = specs
    _MODEL_SPECS_MTIME = mtime
    return specs


def get_model_spec(model_id: str) -> Optional[Dict[str, Any]]:
    specs = _load_model_specs()
    return specs.get(_normalize_model_id(model_id))


def resolve_model_token_limits(
    model_id: str,
    stored_context: Optional[int],
    stored_output: Optional[int],
    override_context: Optional[int] = None,
    override_output: Optional[int] = None,
) -> Tuple[int, int]:
    """
    解析模型的最终上下文上限与最大输出 token。

    优先级：手动覆盖 > provider 中填写的真实值(非默认 4096) > 清单 > 兜底 4096。
    """
    # 上下文上限
    if override_context:
        ctx = override_context
    elif stored_context and stored_context != _DEFAULT_FALLBACK_CONTEXT:
        ctx = stored_context
    else:
        spec = get_model_spec(model_id)
        ctx = (spec or {}).get("context_length") or stored_context or _DEFAULT_FALLBACK_CONTEXT

    # 最大输出 token
    if override_output:
        out = override_output
    elif stored_output:
        out = stored_output
    else:
        spec = get_model_spec(model_id)
        out = (spec or {}).get("max_output_tokens") or min(ctx, _DEFAULT_MAX_OUTPUT)

    return int(ctx), int(out)


def get_model_token_limits(model_id: str) -> Tuple[int, int]:
    """
    便捷封装：按模型 ID 直接返回 (context_length, max_output_tokens)。
    自动读取 unified_models.json 中的手动覆盖 + model_specs.json 清单。
    """
    registry = _registry._load_registry()
    ov = registry.get("models", {}).get(model_id, {})
    stored_ctx = ov.get("context_length")
    stored_out = ov.get("max_output_tokens")
    return resolve_model_token_limits(model_id, stored_ctx, stored_out)


def get_model_output_cap(model_id: str) -> Optional[int]:
    """
    返回模型的最大输出硬上限（清单 model_specs 或用户手动覆盖）。
    若两者均无明确设定（即未知模型），返回 None —— 表示不施加封顶，保持原行为。
    """
    registry = _registry._load_registry()
    ov = registry.get("models", {}).get(model_id, {})
    if ov.get("max_output_tokens"):
        return int(ov["max_output_tokens"])
    spec = get_model_spec(model_id)
    if spec and spec.get("max_output_tokens"):
        return int(spec["max_output_tokens"])
    return None


def _map_effort_for_model(model_id: str, effort: str) -> Optional[str]:
    """
    ST 风格：按模型家族把统一挡位(off/auto/low/medium/high/min/max)映射成
    该模型 API 实际接受的 reasoning_effort 取值。
    返回 None 表示该模型走专用思考字段（thinking / max_completion_tokens），不发送 reasoning_effort。
    """
    mid = (model_id or "").lower()
    # 这些模型使用各自的思考开关字段，不发送 reasoning_effort 参数
    if "deepseek" in mid or "gemini" in mid or "gemma" in mid:
        return None
    # OpenAI / GPT-5 / o 系列：对齐 OpenAI 规范挡位
    if "gpt-5" in mid or mid.startswith("o1") or mid.startswith("o3") or mid.startswith("o4") or "openai" in mid:
        return {"low": "low", "medium": "medium", "high": "high", "min": "minimal", "max": "high"}.get(effort, effort)
    # 其余 openai-compat 混合模型（qwen3/kimi/glm/minimax/mimo/grok 等）：对齐到 low/medium/high
    return {"low": "low", "medium": "medium", "high": "high", "min": "low", "max": "high"}.get(effort, effort)


def resolve_reasoning_effort(model_id: str, requested: Optional[str]) -> Optional[str]:
    """
    ST 风格：结合模型能力白名单(supported_reasoning_efforts)与家族映射，解析最终要发送的
    reasoning_effort 取值。

    返回 None 表示「不发送 reasoning_effort 参数」：
      * 用户选 off / 未指定 → 交给 dispatcher 的 thinking/max_completion_tokens 分支或原生默认；
      * 该挡位不在模型白名单（事前能力探测）→ 优雅跳过，避免网关报 unknown parameter；
      * 原生默认就思考的模型（如 gpt-5，白名单不含 auto）→ auto 不发送、由厂商默认自适应。

    其余情况发送映射后的取值（含 auto 对混合模型显式请求自适应推理）。
    """
    if not requested or requested == "off":
        return None
    spec = get_model_spec(model_id) or {}
    mapped = _map_effort_for_model(model_id, requested)
    if mapped is None:
        return None
    supported = spec.get("supported_reasoning_efforts")
    if isinstance(supported, list) and supported and mapped not in supported:
        # 事前能力探测：该取值不被支持，优雅跳过（不发送），而非等网关报错再兜底
        return None
    return mapped


def invalidate_registry_cache() -> None:
    _registry.invalidate_registry_cache()


def _normalize_model_id(raw_id: str) -> str:
    return (raw_id or "").strip().lower()


def build_unified_models() -> List[Dict[str, Any]]:
    unified: Dict[str, Dict[str, Any]] = {}

    for p in get_runtime_providers():
        if p.get("is_active") is not None and not p.get("is_active"):
            continue
        for m in p.get("models", []):
            if isinstance(m, dict):
                model_id = m.get("id", "")
                display_name = m.get("name") or m.get("alias") or model_id
            else:
                model_id = str(m)
                display_name = str(m)
                m = {"id": model_id, "alias": model_id}

            if not model_id:
                continue

            norm_id = _normalize_model_id(model_id)

            provider_entry = {
                "provider_id": p.get("id", ""),
                "provider_name": p.get("name", ""),
                "provider_type": "api",
                "model_id": model_id,
                "base_url": p.get("base_url", ""),
                "api_key_resolved": bool(resolve_secret_reference(p.get("api_key"))),
                "supports_vision": get_model_vision_support(model_id, m if isinstance(m, dict) else None),
                "context_length": m.get("context_length", 4096) if isinstance(m, dict) else 4096,
                "max_output_tokens": m.get("max_output_tokens") if isinstance(m, dict) else None,
                "priority": 0,
                "weight": 1,
                "enabled": True,
                "max_rpm": 0,
                "max_concurrent": 0,
                "max_tokens_per_min": 0,
            }

            if norm_id not in unified:
                unified[norm_id] = {
                    "unified_id": norm_id,
                    "display_name": display_name,
                    "icon": m.get("icon", "🤖") if isinstance(m, dict) else "🤖",
                    "description": m.get("description", "") if isinstance(m, dict) else "",
                    "model_type": "api",
                    "providers": [],
                }
            unified[norm_id]["providers"].append(provider_entry)

    for lm in list_local_models():
        model_id = lm.get("id", "")
        if not model_id:
            continue
        norm_id = _normalize_model_id(model_id.replace("local:", ""))

        provider_entry = {
            "provider_id": "local",
            "provider_name": "Local (llama.cpp)",
            "provider_type": "local",
            "model_id": model_id,
            "base_url": "",
            "api_key_resolved": False,
            "supports_vision": bool(lm.get("mmproj_enabled") and lm.get("mmproj_path")),
            "context_length": lm.get("context_length", 4096),
            "priority": 0,
            "weight": 1,
            "enabled": lm.get("enabled", False),
            "max_rpm": 0,
            "max_concurrent": lm.get("max_concurrent", 1),
            "max_tokens_per_min": 0,
        }

        if norm_id not in unified:
            unified[norm_id] = {
                "unified_id": norm_id,
                "display_name": lm.get("name", model_id),
                "icon": "🦙",
                "description": "Local GGUF model via llama.cpp",
                "model_type": "local",
                "providers": [],
            }
        unified[norm_id]["providers"].append(provider_entry)

    return list(unified.values())


def get_unified_model_list() -> List[Dict[str, Any]]:
    registry = _registry._load_registry()
    overrides = registry.get("models", {})
    raw_models = build_unified_models()

    result = []
    for model in raw_models:
        uid = model["unified_id"]
        ov_context = None
        ov_output = None
        if uid in overrides:
            ov = overrides[uid]
            if ov.get("display_name"):
                model["display_name"] = ov["display_name"]
            if ov.get("icon"):
                model["icon"] = ov["icon"]
            if ov.get("description"):
                model["description"] = ov["description"]
            if ov.get("routing_strategy"):
                model["routing_strategy"] = ov["routing_strategy"]
            if ov.get("failover_enabled") is not None:
                model["failover_enabled"] = ov["failover_enabled"]
            if ov.get("context_length") is not None:
                ov_context = ov["context_length"]
            if ov.get("max_output_tokens") is not None:
                ov_output = ov["max_output_tokens"]

            provider_overrides = ov.get("provider_overrides", {})
            for pe in model["providers"]:
                pid = pe.get("provider_id", "")
                if pid in provider_overrides:
                    po = provider_overrides[pid]
                    if po.get("priority") is not None:
                        pe["priority"] = po["priority"]
                    if po.get("weight") is not None:
                        pe["weight"] = po["weight"]
                    if po.get("enabled") is not None:
                        pe["enabled"] = po["enabled"]
                    if po.get("max_rpm") is not None:
                        pe["max_rpm"] = po["max_rpm"]
                    if po.get("max_concurrent") is not None:
                        pe["max_concurrent"] = po["max_concurrent"]
                    if po.get("max_tokens_per_min") is not None:
                        pe["max_tokens_per_min"] = po["max_tokens_per_min"]

        model.setdefault("routing_strategy", "priority")
        model.setdefault("failover_enabled", True)

        for pe in model["providers"]:
            pe.setdefault("priority", 0)
            pe.setdefault("weight", 1)
            pe.setdefault("enabled", True)
            pe.setdefault("max_rpm", 0)
            pe.setdefault("max_concurrent", 0)
            pe.setdefault("max_tokens_per_min", 0)

        model["providers"].sort(key=lambda p: (-p["priority"], p["provider_name"]))

        # 解析上下文上限 / 最大输出 token：手动覆盖 > provider 真实值 > 清单 > 兜底
        primary = model["providers"][0] if model["providers"] else {}
        stored_ctx = primary.get("context_length", _DEFAULT_FALLBACK_CONTEXT)
        stored_out = primary.get("max_output_tokens")
        ctx, out = resolve_model_token_limits(
            uid, stored_ctx, stored_out, ov_context, ov_output
        )
        model["context_length"] = ctx
        model["max_output_tokens"] = out

        result.append(model)

    result.sort(key=lambda m: m.get("display_name", ""))
    return result


def get_flat_model_list() -> List[Dict[str, Any]]:
    unified_models = get_unified_model_list()
    result = []
    seen_ids = set()

    for um in unified_models:
        enabled_providers = [p for p in um["providers"] if p.get("enabled", True)]
        if not enabled_providers:
            continue

        primary = enabled_providers[0]
        model_id = primary.get("model_id", um["unified_id"])

        if model_id in seen_ids:
            continue
        seen_ids.add(model_id)

        item = {
            "id": model_id,
            "name": um["display_name"],
            "alias": um["display_name"],
            "icon": um.get("icon", "🤖"),
            "description": um.get("description", ""),
            "context_length": um.get("context_length", primary.get("context_length", 4096)),
            "max_output_tokens": um.get("max_output_tokens", _DEFAULT_MAX_OUTPUT),
            "avatar": "",
            "provider": primary.get("provider_name", ""),
            "provider_id": primary.get("provider_id", ""),
            "supports_vision": primary.get("supports_vision", False),
            "unified_id": um["unified_id"],
            "provider_count": len(enabled_providers),
            # 暴露所有「已启用」的 provider，供前端在模型选择器里单独指定用哪一个
            "providers": [
                {
                    "provider_id": p.get("provider_id", ""),
                    "provider_name": p.get("provider_name", ""),
                    "model_id": p.get("model_id", model_id),
                }
                for p in enabled_providers
            ],
        }
        result.append(item)

    return result


def select_provider_for_model(model_id: str, preferred_provider_id: Optional[str] = None) -> Optional[Tuple[Dict[str, Any], Dict[str, Any]]]:
    local_model = get_local_model_for_inference(model_id)
    if local_model:
        return {
            "provider_type": "local",
            "model_key": local_model["key"],
            "model_path": local_model["path"],
            "local_model": local_model,
        }, None

    unified_models = get_unified_model_list()
    norm_id = _normalize_model_id(model_id)

    target_um = None
    for um in unified_models:
        for p in um["providers"]:
            if p.get("model_id") == model_id:
                target_um = um
                break
            if um["unified_id"] == norm_id:
                target_um = um
        if target_um:
            break

    if not target_um:
        find_model = _provider_find_model
        provider, model_data = find_model(model_id)
        if provider and model_data:
            return {
                "provider_type": "api",
                "provider_id": provider.get("id", ""),
                "provider_name": provider.get("name", ""),
                "base_url": provider.get("base_url", ""),
                "api_key": provider.get("api_key", ""),
            }, model_data
        return None

    enabled_providers = [p for p in target_um["providers"] if p.get("enabled", True) and p.get("provider_type") == "api"]
    if not enabled_providers:
        local_providers = [p for p in target_um["providers"] if p.get("enabled", True) and p.get("provider_type") == "local"]
        if local_providers:
            lp = local_providers[0]
            lm = get_local_model_for_inference(lp["model_id"])
            if lm:
                return {
                    "provider_type": "local",
                    "model_key": lm["key"],
                    "model_path": lm["path"],
                    "local_model": lm,
                }, None
        return None

    # 用户/前端明确指定了某个 provider（同名模型跨 provider 时单独选择）
    if preferred_provider_id:
        pref = next(
            (p for p in target_um["providers"]
             if p.get("provider_id") == preferred_provider_id
             and p.get("enabled", True)
             and p.get("provider_type") == "api"),
            None,
        )
        if pref:
            # 必须按 provider_id 在真实 providers 中精准定位，绝不能再用
            # find_model(model_id) 按模型名回查——否则同名模型会被其它 provider 抢走
            for rp in get_runtime_providers():
                if rp.get("id") != pref.get("provider_id"):
                    continue
                for m in rp.get("models", []):
                    mid = m.get("id") if isinstance(m, dict) else m
                    if mid == pref.get("model_id"):
                        return {
                            "provider_type": "api",
                            "provider_id": rp.get("id", ""),
                            "provider_name": rp.get("name", ""),
                            "base_url": rp.get("base_url", ""),
                            "api_key": rp.get("api_key", ""),
                        }, (m if isinstance(m, dict) else {"id": m})
            # 该 provider 在 providers.json 中找不到 / 不含该模型时，回退到下面的策略选择

    strategy = target_um.get("routing_strategy", "priority")

    if strategy == "round_robin":
        selected = _round_robin_select(target_um["unified_id"], enabled_providers)
    elif strategy == "weighted":
        selected = _weighted_select(enabled_providers)
    else:
        selected = enabled_providers[0]

    find_model = _provider_find_model
    provider, model_data = find_model(selected["model_id"])
    if not provider:
        for ep in enabled_providers:
            if ep != selected:
                provider, model_data = find_model(ep["model_id"])
                if provider:
                    selected = ep
                    break

    if not provider:
        return None

    return {
        "provider_type": "api",
        "provider_id": provider.get("id", ""),
        "provider_name": provider.get("name", ""),
        "base_url": provider.get("base_url", ""),
        "api_key": provider.get("api_key", ""),
    }, model_data


_rr_counters: Dict[str, int] = {}
_rr_counter_lock = threading.Lock()


def _round_robin_select(unified_id: str, providers: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not providers:
        return {}
    with _rr_counter_lock:
        idx = _rr_counters.get(unified_id, 0)
        idx = idx % len(providers)
        _rr_counters[unified_id] = idx + 1
    return providers[idx]


def _weighted_select(providers: List[Dict[str, Any]]) -> Dict[str, Any]:
    import random
    weights = [p.get("weight", 1) for p in providers]
    total = sum(weights)
    if total <= 0:
        return providers[0] if providers else {}
    r = random.uniform(0, total)
    cumulative = 0
    for p, w in zip(providers, weights):
        cumulative += w
        if r <= cumulative:
            return p
    return providers[-1]


def save_unified_model_config(
    unified_id: str,
    display_name: Optional[str] = None,
    icon: Optional[str] = None,
    description: Optional[str] = None,
    routing_strategy: Optional[str] = None,
    failover_enabled: Optional[bool] = None,
    context_length: Optional[int] = None,
    max_output_tokens: Optional[int] = None,
    provider_overrides: Optional[Dict[str, Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    registry = _registry._load_registry()
    models = registry.setdefault("models", {})

    if unified_id not in models:
        models[unified_id] = {}

    entry = models[unified_id]

    if display_name is not None:
        entry["display_name"] = display_name
    if icon is not None:
        entry["icon"] = icon
    if description is not None:
        entry["description"] = description
    if routing_strategy is not None:
        entry["routing_strategy"] = routing_strategy
    if failover_enabled is not None:
        entry["failover_enabled"] = failover_enabled
    if context_length is not None:
        entry["context_length"] = context_length
    if max_output_tokens is not None:
        entry["max_output_tokens"] = max_output_tokens

    if provider_overrides is not None:
        existing_po = entry.setdefault("provider_overrides", {})
        for pid, po in provider_overrides.items():
            if pid not in existing_po:
                existing_po[pid] = {}
            existing_po[pid].update(po)

    _registry._save_registry(registry)
    _registry.invalidate_registry_cache()

    return {"status": "ok", "unified_id": unified_id}


def get_routing_strategies() -> List[Dict[str, str]]:
    return [
        {"id": "priority", "name": "优先级", "description": "按优先级从高到低选择提供商，高优先级不可用时自动降级"},
        {"id": "round_robin", "name": "轮询", "description": "在所有可用提供商之间均匀轮询分配请求"},
        {"id": "weighted", "name": "加权随机", "description": "按权重随机选择提供商，权重越高被选中概率越大"},
    ]


def find_model(model_id: str) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
    """
    统一的模型查找入口

    优先通过统一模型注册表查找，回退到 provider_registry.find_model。
    外部模块应使用此函数而非直接调用 provider_registry.find_model。

    Args:
        model_id: 模型ID

    Returns:
        (provider, model_data) 元组
    """
    selection = select_provider_for_model(model_id)
    if selection:
        provider_info, model_data = selection
        if provider_info.get("provider_type") == "api":
            provider, _ = _provider_find_model(model_id)
            if provider:
                return provider, model_data
        return provider_info, model_data
    return _provider_find_model(model_id)
