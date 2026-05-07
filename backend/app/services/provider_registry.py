"""
底层 Provider 管理

职责：
- Provider 的 CRUD 操作（增删改查 providers.json）
- API Key 的解析与验证（环境变量引用、密钥缺失检测）
- 运行时 Provider 信息获取（get_runtime_providers、find_model）
- 模型视觉能力推断（infer_supports_vision）

注意：外部模块如需查找模型，应优先使用 unified_model_registry.find_model，
而非直接调用本模块的 find_model，以获得统一的模型路由和 provider 选择能力。
"""

import copy
import json
import os
import re
import threading
from typing import Any, Dict, List, Optional, Tuple

from ..core import settings


_provider_cache_lock = threading.Lock()
_cached_mtime: Optional[float] = None
_cached_providers: List[Dict[str, Any]] = []


def _providers_path() -> str:
    return os.path.join(settings.DATA_DIR, "providers.json")


def invalidate_provider_cache() -> None:
    global _cached_mtime
    global _cached_providers

    with _provider_cache_lock:
        _cached_mtime = None
        _cached_providers = []


def get_providers() -> List[Dict[str, Any]]:
    global _cached_mtime
    global _cached_providers

    path = _providers_path()

    try:
        mtime = os.path.getmtime(path)
    except OSError:
        with _provider_cache_lock:
            _cached_mtime = None
            _cached_providers = []
        return []

    with _provider_cache_lock:
        if _cached_mtime is not None and _cached_mtime == mtime:
            return copy.deepcopy(_cached_providers)

        try:
            with open(path, "r", encoding="utf-8") as provider_file:
                data = json.load(provider_file)
            if not isinstance(data, list):
                data = []
        except Exception:
            data = []

        _cached_mtime = mtime
        _cached_providers = data
        return copy.deepcopy(_cached_providers)


def resolve_secret_reference(secret: Any) -> str:
    if not isinstance(secret, str):
        return ""

    value = secret.strip()
    if not value:
        return ""

    env_name = None
    if value.startswith("env:"):
        env_name = value[4:].strip()
    elif value.startswith("${") and value.endswith("}"):
        env_name = value[2:-1].strip()

    if env_name:
        return os.getenv(env_name, "")

    return value


def extract_secret_reference(secret: Any) -> Optional[str]:
    if not isinstance(secret, str):
        return None

    value = secret.strip()
    if not value:
        return None

    if value.startswith("env:"):
        env_name = value[4:].strip()
        return env_name or None

    if value.startswith("${") and value.endswith("}"):
        env_name = value[2:-1].strip()
        return env_name or None

    return None


def _to_runtime_provider(provider: Dict[str, Any]) -> Dict[str, Any]:
    runtime_provider = copy.deepcopy(provider)
    runtime_provider["api_key"] = resolve_secret_reference(provider.get("api_key"))
    return runtime_provider


def get_runtime_providers() -> List[Dict[str, Any]]:
    return [_to_runtime_provider(provider) for provider in get_providers()]


def get_missing_provider_secret_refs() -> List[Dict[str, str]]:
    missing: List[Dict[str, str]] = []
    for provider in get_providers():
        ref_name = extract_secret_reference(provider.get("api_key"))
        if not ref_name:
            continue
        if not os.getenv(ref_name, "").strip():
            missing.append({
                "provider_id": str(provider.get("id", "")),
                "provider_name": str(provider.get("name", "")),
                "env": ref_name,
            })
    return missing


def find_model(model_id: str) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
    for provider in get_runtime_providers():
        if provider.get("is_active") is not None and not provider.get("is_active"):
            continue
        for model in provider.get("models", []):
            model_id_value = model["id"] if isinstance(model, dict) else model
            if model_id_value == model_id:
                normalized_model = model if isinstance(model, dict) else {"id": model, "alias": model}
                return provider, normalized_model
    return None, None


_VISION_PATTERNS = [
    re.compile(r"gpt-4o", re.IGNORECASE),
    re.compile(r"gpt-4-turbo", re.IGNORECASE),
    re.compile(r"o[1-4]", re.IGNORECASE),
    re.compile(r"claude-3", re.IGNORECASE),
    re.compile(r"gemini", re.IGNORECASE),
    re.compile(r"qwen.*vl", re.IGNORECASE),
    re.compile(r"qwen.*vision", re.IGNORECASE),
    re.compile(r"qwen2-vl", re.IGNORECASE),
    re.compile(r"qwen2\.5-vl", re.IGNORECASE),
    re.compile(r"internvl", re.IGNORECASE),
    re.compile(r"llava", re.IGNORECASE),
    re.compile(r"vision", re.IGNORECASE),
    re.compile(r"mini-cpm", re.IGNORECASE),
    re.compile(r"glm-4v", re.IGNORECASE),
    re.compile(r"deepseek-vl", re.IGNORECASE),
    re.compile(r"yi-vision", re.IGNORECASE),
    re.compile(r"cogvlm", re.IGNORECASE),
    re.compile(r"idefics", re.IGNORECASE),
    re.compile(r"fuyu", re.IGNORECASE),
    re.compile(r"kosmos", re.IGNORECASE),
    re.compile(r"moondream", re.IGNORECASE),
]


def infer_supports_vision(model_id: str) -> bool:
    if not model_id:
        return False
    for pattern in _VISION_PATTERNS:
        if pattern.search(model_id):
            return True
    return False


def get_model_vision_support(model_id: str, model_data: Optional[Dict[str, Any]] = None) -> bool:
    if model_data and isinstance(model_data, dict):
        explicit = model_data.get("supports_vision")
        if explicit is not None:
            return bool(explicit)
    return infer_supports_vision(model_id)
