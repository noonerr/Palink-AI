"""Single Engine Rotator"""
import logging
import random
from typing import Optional, List, Dict, Tuple
import httpx

logger = logging.getLogger(__name__)


class SingleEngineRotator:
    def __init__(self):
        self.current_index = 0
        self.strategy = "round_robin"

    async def search_searxng_single(self, query: str, num_results: int, engine: str) -> List[Dict]:
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                params = {"q": query, "format": "json", "engines": engine}
                resp = await client.get("http://104.208.99.17:8888/search", params=params)
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
