import asyncio
import hashlib
import threading
from collections import OrderedDict
from typing import Dict, Optional, Tuple

from openai import AsyncOpenAI


def _api_key_hash(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()[:16]


_client_lock = threading.Lock()
_client_cache: OrderedDict[Tuple[str, str, float], AsyncOpenAI] = OrderedDict()
_MAX_CLIENT_CACHE_SIZE = 50


def get_async_openai_client(api_key: str, base_url: Optional[str] = None, timeout: float = 30.0) -> AsyncOpenAI:
    """Reuse AsyncOpenAI clients by endpoint/key/timeout to reduce repeated connection setup."""
    key = (_api_key_hash(api_key) if api_key else None, base_url or "", float(timeout))

    with _client_lock:
        cached = _client_cache.get(key)
        if cached is not None:
            _client_cache.move_to_end(key)
            return cached

        client = AsyncOpenAI(
            api_key=api_key,
            base_url=base_url,
            timeout=timeout,
        )
        _client_cache[key] = client
        _client_cache.move_to_end(key)

        if len(_client_cache) > _MAX_CLIENT_CACHE_SIZE:
            _, old_client = _client_cache.popitem(last=False)
            try:
                loop = asyncio.get_running_loop()
                loop.create_task(old_client.close())
            except RuntimeError:
                try:
                    old_client.close()
                except Exception:
                    pass

        return client
