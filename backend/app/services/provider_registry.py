import copy
import json
import os
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
        if not provider.get("is_active"):
            continue
        for model in provider.get("models", []):
            model_id_value = model["id"] if isinstance(model, dict) else model
            if model_id_value == model_id:
                normalized_model = model if isinstance(model, dict) else {"id": model, "alias": model}
                return provider, normalized_model
    return None, None
