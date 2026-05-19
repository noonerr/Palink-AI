import logging
import random
from typing import Optional, List, Dict, Tuple
import httpx

logger = logging.getLogger(__name__)

_DEFAULT_ROTATOR_URL = ""


class SingleEngineRotator:
    def __init__(self):
        self.current_index = 0
        self.strategy = "round_robin"
        self._base_url: Optional[str] = None

    def _get_base_url(self) -> Optional[str]:
        if self._base_url:
            return self._base_url
        try:
            from ..core.config import settings
            import os, json
            config_path = os.path.join(settings.DATA_DIR, "web_search.json")
            if os.path.exists(config_path):
                with open(config_path, "r", encoding="utf-8") as f:
                    config = json.load(f)
                url = config.get("rotator_url", "").strip()
                if url:
                    self._base_url = url
                    return url
        except Exception as e:
            logger.error(f"Failed to read rotator URL from config: {e}")
        return None

    async def search_searxng_single(self, query: str, num_results: int, engine: str) -> List[Dict]:
        from .web_search import _is_safe_search_url

        base_url = self._get_base_url()
        if not base_url:
            logger.error("Rotator URL not configured. Set 'rotator_url' in web_search config.")
            return []

        if not _is_safe_search_url(base_url):
            logger.error("Rotator URL blocked by SSRF protection: %s", base_url)
            return []

        if not base_url.startswith("https://"):
            logger.error("Rotator URL must use HTTPS: %s", base_url)
            return []

        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                params = {"q": query, "format": "json", "engines": engine}
                search_url = f"{base_url.rstrip('/')}/search"
                headers = {}
                try:
                    from ..core.config import settings
                    import os, json
                    config_path = os.path.join(settings.DATA_DIR, "web_search.json")
                    if os.path.exists(config_path):
                        with open(config_path, "r", encoding="utf-8") as f:
                            cfg = json.load(f)
                        token = cfg.get("search_token", "").strip()
                        if token:
                            headers["Authorization"] = f"Bearer {token}"
                except Exception:
                    pass
                resp = await client.get(search_url, params=params, headers=headers)
                resp.raise_for_status()
                data = resp.json()
                results = []
                for item in data.get("results", [])[:num_results]:
                    results.append({
                        "title": item.get("title", ""),
                        "url": item.get("url", ""),
                        "snippet": item.get("content", ""),
                    })
                return results
        except Exception as e:
            logger.error(f"Single engine search failed ({engine}): {e}")
            return []

    async def search(self, query: str, num_results: int = 5) -> Tuple[List[Dict], str]:
        engines = ["duckduckgo", "qwant", "brave", "wikipedia"]

        if self.strategy == "round_robin":
            engine = engines[self.current_index % len(engines)]
            self.current_index += 1
        else:
            engine = random.choice(engines)

        max_retries = 3
        for attempt in range(max_retries):
            try:
                logger.info(f"Searching with {engine} (attempt {attempt + 1})")
                results = await self.search_searxng_single(query, num_results, engine)
                if results:
                    logger.info(f"Search successful: {engine} returned {len(results)} results")
                    return results, engine
                else:
                    logger.warning(f"{engine} returned no results, trying next")
                    if self.strategy == "round_robin":
                        engine = engines[self.current_index % len(engines)]
                        self.current_index += 1
                    else:
                        engine = random.choice(engines)
            except Exception as e:
                logger.error(f"Search failed ({engine}): {e}")
                continue

        logger.error("All search attempts failed")
        return [], "none"

    def set_strategy(self, strategy: str):
        if strategy in ["round_robin", "random"]:
            self.strategy = strategy
            logger.info(f"Search strategy set to: {strategy}")


_rotator: Optional[SingleEngineRotator] = None


def get_rotator() -> SingleEngineRotator:
    global _rotator
    if _rotator is None:
        _rotator = SingleEngineRotator()
    return _rotator
