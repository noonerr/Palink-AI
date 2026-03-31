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


def find_model(model_id: str) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
    for provider in get_providers():
        if not provider.get("is_active"):
            continue
        for model in provider.get("models", []):
            model_id_value = model["id"] if isinstance(model, dict) else model
            if model_id_value == model_id:
                normalized_model = model if isinstance(model, dict) else {"id": model, "alias": model}
                return provider, normalized_model
    return None, None
