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
            "context_length": primary.get("context_length", 4096),
            "avatar": "",
            "provider": primary.get("provider_name", ""),
            "provider_id": primary.get("provider_id", ""),
            "supports_vision": primary.get("supports_vision", False),
            "unified_id": um["unified_id"],
            "provider_count": len(enabled_providers),
        }
        result.append(item)

    return result


def select_provider_for_model(model_id: str) -> Optional[Tuple[Dict[str, Any], Dict[str, Any]]]:
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
