import asyncio
import functools
import hashlib
import threading
import time
from collections import OrderedDict
from typing import Any, Callable

_SENTINEL = object()


class TTLCache:
    def __init__(self, max_size: int = 500):
        self._store: OrderedDict[str, tuple[float, Any]] = OrderedDict()
        self._lock = threading.Lock()
        self._max_size = max_size
        # 失效代次：每次 invalidate/clear 递增。用于防止"失效前发起、
        # 失效后才返回"的 in-flight 请求用陈旧数据重填缓存（stale set race）。
        self._generation = 0

    def generation(self) -> int:
        with self._lock:
            return self._generation

    def get(self, key: str) -> Any:
        with self._lock:
            if key not in self._store:
                return _SENTINEL
            expires_at, value = self._store[key]
            if time.monotonic() >= expires_at:
                del self._store[key]
                return _SENTINEL
            self._store.move_to_end(key)
            return value

    def set(self, key: str, value: Any, ttl_seconds: float, expected_generation: int | None = None) -> None:
        with self._lock:
            # 若调用方在读取时捕获的代次已过期（期间发生过 invalidate/clear），
            # 说明这份数据可能已陈旧，拒绝写入，避免脏缓存重填。
            if expected_generation is not None and expected_generation != self._generation:
                return
            expires_at = time.monotonic() + ttl_seconds
            if key in self._store:
                self._store.move_to_end(key)
                self._store[key] = (expires_at, value)
            else:
                self._evict_locked()
                self._store[key] = (expires_at, value)

    def _evict_locked(self) -> None:
        now = time.monotonic()
        expired = [k for k, (exp, _) in self._store.items() if exp <= now]
        for k in expired:
            del self._store[k]
        while len(self._store) >= self._max_size:
            self._store.popitem(last=False)

    def invalidate(self, key_prefix: str, key_suffix: str = "") -> int:
        """清除以 key_prefix 开头且以 key_suffix 结尾的所有缓存项。

        key_suffix 为空字符串时退化为纯 prefix 失效（原行为）。
        key_suffix 非空时用于用户级隔离: 由于 _build_key 按 kwargs 键名
        字典序排序，user 段通常位于末尾，所以 suffix=":user=<id>" 能
        精确匹配该用户的所有缓存变种（不同 page / page_size / fields 组合）。
        """
        with self._lock:
            # 递增代次：使所有"失效前发起、尚未 set"的 in-flight 请求丧失写缓存资格。
            self._generation += 1
            if key_suffix:
                keys_to_remove = [
                    k for k in self._store
                    if k.startswith(key_prefix) and k.endswith(key_suffix)
                ]
            else:
                keys_to_remove = [k for k in self._store if k.startswith(key_prefix)]
            for k in keys_to_remove:
                del self._store[k]
            return len(keys_to_remove)

    def clear(self) -> None:
        with self._lock:
            self._generation += 1
            self._store.clear()

    def size(self) -> int:
        with self._lock:
            return len(self._store)


_cache = TTLCache()


def _build_key(prefix: str, func: Callable, args: tuple, kwargs: dict) -> str:
    parts = [prefix or func.__name__]
    for arg in args:
        if isinstance(arg, str):
            parts.append(hashlib.sha256(arg.encode()).hexdigest()[:16])
        elif isinstance(arg, (int, float, bool)):
            parts.append(str(arg))
        elif hasattr(arg, "id") and not isinstance(arg, type):
            parts.append(str(arg.id))
    for k, v in sorted(kwargs.items()):
        if isinstance(v, str):
            parts.append(f"{k}={hashlib.sha256(v.encode()).hexdigest()[:16]}")
        elif isinstance(v, (int, float, bool)):
            parts.append(f"{k}={v}")
        elif hasattr(v, "id") and not isinstance(v, type):
            parts.append(f"{k}={v.id}")
    return ":".join(parts)


def cached(ttl_seconds: float, key_prefix: str = ""):
    def decorator(func: Callable) -> Callable:
        @functools.wraps(func)
        async def async_wrapper(*args, **kwargs):
            cache_key = _build_key(key_prefix, func, args, kwargs)
            result = _cache.get(cache_key)
            if result is not _SENTINEL:
                return result
            # 在执行 func 前捕获代次；若 func 执行期间发生 invalidate，
            # set 会因代次不匹配而跳过，避免用陈旧数据重填缓存。
            gen = _cache.generation()
            result = await func(*args, **kwargs)
            _cache.set(cache_key, result, ttl_seconds, expected_generation=gen)
            return result

        @functools.wraps(func)
        def sync_wrapper(*args, **kwargs):
            cache_key = _build_key(key_prefix, func, args, kwargs)
            result = _cache.get(cache_key)
            if result is not _SENTINEL:
                return result
            gen = _cache.generation()
            result = func(*args, **kwargs)
            _cache.set(cache_key, result, ttl_seconds, expected_generation=gen)
            return result

        if asyncio.iscoroutinefunction(func):
            return async_wrapper
        return sync_wrapper

    return decorator


def invalidate_cache(key_prefix: str) -> int:
    return _cache.invalidate(key_prefix)


def invalidate_user_cache(key_prefix: str, user_id: int) -> int:
    """用户级缓存失效辅助函数。

    与 _build_key 生成的 key 格式对齐: kwargs 路径下 user 参数会以
    f"user={user_id}" 形式追加到 key 中（cache.py:81）。由于 _build_key
    按 kwargs 键名字典序排序，user 段通常位于 key 末尾，使用
    suffix=":user=<user_id>" 精确匹配该用户的所有缓存变种
    （不同 page / page_size / fields 组合），避免误伤其他用户。

    使用场景:
    - 用户级列表缓存（character_list / worldbook_list / models 等）
    - 用户设置变化导致仅影响该用户的缓存

    保留全局失效场景使用 invalidate_cache(key_prefix):
    - admin 全局操作（如 unified_model_config 更新影响所有用户）
    """
    return _cache.invalidate(key_prefix, key_suffix=f":user={user_id}")
