import copy
import json
import os
import threading
from typing import Any, Dict, Optional


class JsonRegistryMixin:
    _registry_lock = threading.Lock()
    _cached_mtime: Optional[float] = None
    _cached_registry: Optional[Dict[str, Any]] = None

    def _registry_path(self) -> str:
        raise NotImplementedError

    def _default_data(self) -> Dict[str, Any]:
        return {"version": 1}

    def _ensure_dirs(self) -> None:
        path = self._registry_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)

    def _ensure_registry_file(self) -> None:
        self._ensure_dirs()
        path = self._registry_path()
        if not os.path.exists(path):
            with open(path, "w", encoding="utf-8") as f:
                json.dump(self._default_data(), f, ensure_ascii=False, indent=2)

    def _load_registry(self) -> Dict[str, Any]:
        self._ensure_registry_file()
        path = self._registry_path()

        try:
            mtime = os.path.getmtime(path)
        except OSError:
            with self._registry_lock:
                self._cached_mtime = None
                self._cached_registry = None
            return copy.deepcopy(self._default_data())

        with self._registry_lock:
            if self._cached_mtime is not None and self._cached_mtime == mtime and self._cached_registry is not None:
                return copy.deepcopy(self._cached_registry)

            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if not isinstance(data, dict):
                    data = self._default_data()
            except Exception:
                data = self._default_data()

            self._cached_mtime = mtime
            self._cached_registry = data
            return copy.deepcopy(data)

    def _save_registry(self, data: Dict[str, Any]) -> None:
        self._ensure_registry_file()
        path = self._registry_path()
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        with self._registry_lock:
            try:
                self._cached_mtime = os.path.getmtime(path)
            except OSError:
                self._cached_mtime = None
            self._cached_registry = copy.deepcopy(data)

    def invalidate_registry_cache(self) -> None:
        with self._registry_lock:
            self._cached_mtime = None
            self._cached_registry = None
