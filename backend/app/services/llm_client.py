import threading
from typing import Dict, Optional, Tuple

from openai import AsyncOpenAI


_client_lock = threading.Lock()
_client_cache: Dict[Tuple[str, str, float], AsyncOpenAI] = {}


def get_async_openai_client(api_key: str, base_url: Optional[str] = None, timeout: float = 30.0) -> AsyncOpenAI:
    """Reuse AsyncOpenAI clients by endpoint/key/timeout to reduce repeated connection setup."""
    key = (api_key or "", base_url or "", float(timeout))

    with _client_lock:
        cached = _client_cache.get(key)
        if cached is not None:
            return cached

        client = AsyncOpenAI(
            api_key=api_key,
            base_url=base_url,
            timeout=timeout,
        )
        _client_cache[key] = client
        return client
