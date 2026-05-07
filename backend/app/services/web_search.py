import logging
import json
import os
import ipaddress
import socket
import httpx
from typing import Optional
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

_shared_client: Optional[httpx.AsyncClient] = None


async def get_http_client() -> httpx.AsyncClient:
    global _shared_client
    if _shared_client is None or _shared_client.is_closed:
        _shared_client = httpx.AsyncClient(timeout=15.0, follow_redirects=True)
    return _shared_client

SEARXNG_DEFAULT_URL = "http://localhost:8080"
BRAVE_SEARCH_API_URL = "https://api.search.brave.com/res/v1/web/search"
BAIDU_SEARCH_API_URL = "https://www.baidu.com/s"
BAIDU_QIANFAN_SEARCH_URL = "https://qianfan.baidubce.com/v2/ai_search/web_search"


def _is_safe_search_url(url: str) -> bool:
    try:
        parsed = urlparse(url)
    except Exception:
        return False
    if parsed.scheme not in ("http", "https"):
        return False
    host = parsed.hostname
    if not host:
        return False
    lowered = host.lower()
    if lowered in {"localhost", "127.0.0.1", "0.0.0.0", "::1", "[::]", "0:0:0:0:0:0:0:1", "0:0:0:0:0:0:0:0"} or lowered.endswith(".local"):
        return False

    def _is_private_ip(ip_str: str) -> bool:
        try:
            ip_obj = ipaddress.ip_address(ip_str)
            return ip_obj.is_private or ip_obj.is_loopback or ip_obj.is_link_local or ip_obj.is_reserved or ip_obj.is_unspecified
        except ValueError:
            return False

    if _is_private_ip(host):
        return False
    try:
        addr_info = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except Exception:
        return False
    for info in addr_info:
        if _is_private_ip(info[4][0]):
            return False
    return True


def _settings_path() -> str:
    from ..core.config import settings
    return os.path.join(settings.DATA_DIR, "web_search.json")


def _get_raw_config() -> dict:
    path = _settings_path()
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {
        "enabled": False,
        "engine": "searxng",
        "searxng_url": SEARXNG_DEFAULT_URL,
        "brave_api_key": "",
        "baidu_cookie": "",
        "custom_url": "",
        "custom_engine": "searxng",
    }


def get_web_search_config() -> dict:
    return _mask_sensitive_fields(_get_raw_config())


_SENSITIVE_KEYS = {"brave_api_key", "baidu_cookie"}


def _mask_sensitive_fields(data: dict) -> dict:
    result = dict(data)
    for key in _SENSITIVE_KEYS:
        val = result.get(key, "")
        if val:
            if len(val) <= 8:
                result[key] = "********"
            else:
                result[key] = val[:4] + "****" + val[-4:]
    return result


def save_web_search_config(config: dict) -> dict:
    path = _settings_path()
    allowed_keys = {
        "enabled", "engine",
        "searxng_url", "brave_api_key",
        "baidu_cookie", "custom_url", "custom_engine",
    }
    cleaned = {k: v for k, v in config.items() if k in allowed_keys}
    defaults = _get_raw_config()
    for k in allowed_keys:
        if k not in cleaned:
            cleaned[k] = defaults.get(k, "")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cleaned, f, ensure_ascii=False, indent=2)
    return _mask_sensitive_fields(cleaned)


async def search_web(query: str, num_results: int = 5) -> list:
    config = _get_raw_config()
    if not config.get("enabled"):
        return []

    engine = config.get("engine", "searxng")

    try:
        if engine == "searxng":
            return await _search_searxng(query, config.get("searxng_url", SEARXNG_DEFAULT_URL), num_results)
        elif engine == "brave":
            return await _search_brave(query, config.get("brave_api_key", ""), num_results)
        elif engine == "baidu":
            return await _search_baidu(query, config.get("baidu_cookie", ""), num_results)
        elif engine == "custom":
            url = config.get("custom_url", "").strip()
            sub_engine = config.get("custom_engine", "searxng")
            if not url:
                logger.warning("Custom search: no URL configured")
                return []
            if not _is_safe_search_url(url):
                logger.warning("Custom search URL blocked (SSRF protection): %s", url)
                return []
            if sub_engine == "brave":
                return await _search_brave(query, config.get("brave_api_key", ""), num_results, base_url=url)
            else:
                return await _search_searxng(query, url, num_results)
        else:
            logger.warning(f"Unknown search engine: {engine}")
            return []
    except Exception as e:
        logger.error(f"Web search failed: {e}")
        return []


async def _search_searxng(query: str, base_url: str, num_results: int) -> list:
    url = f"{base_url.rstrip('/')}/search"
    params = {
        "q": query,
        "format": "json",
        "categories": "general",
    }
    client = await get_http_client()
    resp = await client.get(url, params=params)
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


async def _search_brave(query: str, api_key: str, num_results: int, base_url: Optional[str] = None) -> list:
    if not api_key:
        return []
    headers = {
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": api_key,
    }
    params = {
        "q": query,
        "count": num_results,
    }
    target_url = base_url or BRAVE_SEARCH_API_URL
    client = await get_http_client()
    resp = await client.get(target_url, headers=headers, params=params)
    resp.raise_for_status()
    data = resp.json()

    results = []
    for item in data.get("web", {}).get("results", []):
        results.append({
            "title": item.get("title", ""),
            "url": item.get("url", ""),
            "snippet": item.get("description", ""),
        })
    return results


async def _search_baidu(query: str, cookie: str, num_results: int) -> list:
    if cookie and cookie.strip().startswith("bce-v3/"):
        return await _search_baidu_qianfan(query, cookie.strip(), num_results)
    return await _search_baidu_web(query, cookie, num_results)


async def _search_baidu_qianfan(query: str, api_key: str, num_results: int) -> list:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "X-Appbuilder-From": "palink-ai",
        "Content-Type": "application/json",
    }
    body = {
        "messages": [
            {"content": query, "role": "user"}
        ],
        "search_source": "baidu_search_v2",
        "resource_type_filter": [{"type": "web", "top_k": min(num_results, 50)}],
        "search_filter": {},
    }
    client = await get_http_client()
    resp = await client.post(BAIDU_QIANFAN_SEARCH_URL, json=body, headers=headers)
    resp.raise_for_status()
    data = resp.json()

    if "code" in data and data.get("code") != 0:
        error_msg = data.get("message", "未知错误")
        logger.error(f"Baidu Qianfan search API error: code={data.get('code')}, message={error_msg}")
        return []

    results = []
    for item in data.get("references", [])[:num_results]:
        results.append({
            "title": item.get("title", "") or item.get("name", ""),
            "url": item.get("url", "") or item.get("link", ""),
            "snippet": item.get("content", "") or item.get("snippet", "") or item.get("abstract", ""),
        })
    return results


async def _search_baidu_web(query: str, cookie: str, num_results: int) -> list:
    params = {
        "wd": query,
        "rn": num_results,
        "ie": "utf-8",
    }
    headers = {}
    if cookie:
        headers["Cookie"] = cookie
    client = await get_http_client()
    resp = await client.get(BAIDU_SEARCH_API_URL, params=params, headers=headers)
    html = resp.text

    results = []
    try:
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(html, "html.parser")
        for item in soup.select(".result")[:num_results]:
            title_el = item.select_one("h3 a")
            snippet_el = item.select_one(".c-abstract")
            results.append({
                "title": title_el.get_text(strip=True) if title_el else "",
                "url": title_el.get("href", "") if title_el else "",
                "snippet": snippet_el.get_text(strip=True) if snippet_el else "",
            })
    except ImportError:
        logger.warning("beautifulsoup4 not installed, Baidu HTML parsing skipped")
    except Exception as e:
        logger.warning(f"Baidu HTML parsing failed: {e}")

    if not results and cookie:
        try:
            params["output"] = "json"
            client = await get_http_client()
            resp = await client.get(
                "https://www.baidu.com/s",
                params=params,
                headers={"Cookie": cookie},
            )
            data = resp.json()
            for item in data.get("results", [])[:num_results]:
                    results.append({
                        "title": item.get("title", ""),
                        "url": item.get("url", ""),
                        "snippet": item.get("desc", "") or item.get("abstract", ""),
                    })
        except Exception as e:
            logger.warning(f"Baidu API fallback failed: {e}")

    return results


def format_search_results(results: list, query: str) -> str:
    if not results:
        return ""
    lines = [f"[Web Search Results for: {query}]", ""]
    for i, r in enumerate(results, 1):
        lines.append(f"{i}. {r['title']}")
        if r["snippet"]:
            lines.append(f"   {r['snippet']}")
        lines.append(f"   Source: {r['url']}")
        lines.append("")
    lines.append("Please use the above search results to help answer the user's question. Cite sources when relevant.")
    return "\n".join(lines)


async def validate_web_search_config(config: dict = None) -> dict:
    """
    轻量级验证 Web Search 配置，不消耗 API 使用次数
    返回格式：{"valid": bool, "message": str, "details": dict}
    """
    if config is None:
        config = _get_raw_config()

    engine = config.get("engine", "searxng")

    try:
        if engine == "searxng":
            return await _validate_searxng(config.get("searxng_url", SEARXNG_DEFAULT_URL))
        elif engine == "brave":
            return await _validate_brave(config.get("brave_api_key", ""))
        elif engine == "baidu":
            return await _validate_baidu(config.get("baidu_cookie", ""))
        elif engine == "custom":
            url = config.get("custom_url", "").strip()
            if not url:
                return {"valid": False, "message": "未配置自定义 URL", "details": {"error": "empty_url"}}
            if not _is_safe_search_url(url):
                return {"valid": False, "message": "自定义 URL 不安全（指向内网或私有地址）", "details": {"error": "ssrf_blocked", "url": url}}
            sub_engine = config.get("custom_engine", "searxng")
            if sub_engine == "brave":
                return await _validate_brave(config.get("brave_api_key", ""), base_url=url)
            else:
                return await _validate_searxng(url)
        else:
            return {"valid": False, "message": f"不支持的搜索引擎: {engine}", "details": {"error": "unknown_engine"}}
    except Exception as e:
        logger.error(f"Web search validation failed: {e}")
        return {"valid": False, "message": f"验证失败: {str(e)}", "details": {"error": str(e)}}


async def _validate_searxng(url: str) -> dict:
    """验证 SearXNG 实例是否可访问（不执行搜索）"""
    base_url = url.rstrip('/')
    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            resp = await client.get(f"{base_url}/", follow_redirects=True)
            if resp.status_code == 200:
                return {
                    "valid": True,
                    "message": f"SearXNG 服务可访问 ({url})",
                    "details": {
                        "status_code": resp.status_code,
                        "url": url,
                        "note": "未执行搜索请求，零消耗"
                    }
                }
            else:
                return {
                    "valid": False,
                    "message": f"SearXNG 返回异常状态码: {resp.status_code}",
                    "details": {"status_code": resp.status_code, "url": url}
                }
        except httpx.ConnectError:
            return {
                "valid": False,
                "message": f"无法连接到 SearXNG 实例 ({url})",
                "details": {"error": "connection_refused", "url": url}
            }
        except httpx.TimeoutException:
            return {
                "valid": False,
                "message": f"SearXNG 连接超时 ({url})",
                "details": {"error": "timeout", "url": url}
            }


async def _validate_brave(api_key: str, base_url: Optional[str] = None) -> dict:
    """验证 Brave API Key 是否有效（使用最小化请求）"""
    if not api_key or not api_key.strip():
        return {
            "valid": False,
            "message": "Brave API Key 未填写",
            "details": {"error": "missing_api_key"}
        }

    target_url = (base_url or BRAVE_SEARCH_API_URL).rstrip('/')

    headers = {
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": api_key,
    }

    params = {
        "q": "test",
        "count": 0,
    }

    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            resp = await client.get(target_url, headers=headers, params=params)

            if resp.status_code == 200:
                data = resp.json()
                web_results = data.get("web", {}).get("results", [])
                total = data.get("web", {}).get("total", len(web_results))

                return {
                    "valid": True,
                    "message": f"Brave API Key 有效 ✓ (count=0 不消耗配额)",
                    "details": {
                        "status_code": resp.status_code,
                        "note": "使用 count=0 参数验证，不计入使用次数",
                        "response_type": data.get("type", "unknown")
                    }
                }

            elif resp.status_code == 401:
                return {
                    "valid": False,
                    "message": "Brave API Key 无效或已过期",
                    "details": {"error": "unauthorized", "status_code": resp.status_code}
                }

            elif resp.status_code == 429:
                return {
                    "valid": False,
                    "message": "Brave API 配额已用尽或限流中",
                    "details": {"error": "rate_limited", "status_code": resp.status_code}
                }

            else:
                error_text = resp.text[:200] if resp.text else "未知错误"
                return {
                    "valid": False,
                    "message": f"Brave API 返回错误 (HTTP {resp.status_code})",
                    "details": {"error": error_text, "status_code": resp.status_code}
                }

        except httpx.TimeoutException:
            return {
                "valid": False,
                "message": "Brave API 连接超时",
                "details": {"error": "timeout"}
            }
        except Exception as e:
            return {
                "valid": False,
                "message": f"Brave API 验证失败: {str(e)}",
                "details": {"error": str(e)}
            }


async def _validate_baidu(cookie: str) -> dict:
    if cookie and cookie.strip().startswith("bce-v3/"):
        return await _validate_baidu_qianfan(cookie.strip())
    return await _validate_baidu_web(cookie)


async def _validate_baidu_qianfan(api_key: str) -> dict:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "X-Appbuilder-From": "palink-ai",
        "Content-Type": "application/json",
    }
    body = {
        "messages": [
            {"content": "test", "role": "user"}
        ],
        "search_source": "baidu_search_v2",
        "resource_type_filter": [{"type": "web", "top_k": 1}],
        "search_filter": {},
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            resp = await client.post(BAIDU_QIANFAN_SEARCH_URL, json=body, headers=headers)
            if resp.status_code == 200:
                data = resp.json()
                if "code" in data and data.get("code") != 0:
                    return {
                        "valid": False,
                        "message": f"百度千帆 API 返回错误: {data.get('message', '未知错误')}",
                        "details": {"error": "api_error", "code": data.get("code")}
                    }
                ref_count = len(data.get("references", []))
                return {
                    "valid": True,
                    "message": f"百度千帆 AI 搜索 API 有效 ✓ (返回 {ref_count} 条结果)",
                    "details": {
                        "status_code": resp.status_code,
                        "note": "使用最小化查询验证"
                    }
                }
            elif resp.status_code == 401 or resp.status_code == 403:
                return {
                    "valid": False,
                    "message": "百度千帆 API Key 无效或已过期",
                    "details": {"error": "unauthorized", "status_code": resp.status_code}
                }
            else:
                error_text = resp.text[:200] if resp.text else "未知错误"
                return {
                    "valid": False,
                    "message": f"百度千帆 API 返回错误 (HTTP {resp.status_code})",
                    "details": {"error": error_text, "status_code": resp.status_code}
                }
        except httpx.TimeoutException:
            return {
                "valid": False,
                "message": "百度千帆 API 连接超时",
                "details": {"error": "timeout"}
            }
        except Exception as e:
            return {
                "valid": False,
                "message": f"百度千帆 API 验证失败: {str(e)}",
                "details": {"error": str(e)}
            }


async def _validate_baidu_web(cookie: str) -> dict:
    """验证百度 Cookie 是否有效（发送轻量级请求）"""
    headers = {}
    if cookie and cookie.strip():
        headers["Cookie"] = cookie

    params = {
        "wd": "",
        "ie": "utf-8",
    }

    async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
        try:
            resp = await client.get(BAIDU_SEARCH_API_URL, params=params, headers=headers)

            if resp.status_code == 200:
                has_cookie = bool(cookie and cookie.strip())
                if has_cookie:
                    if "验证码" in resp.text or "vcode" in resp.text.lower():
                        return {
                            "valid": False,
                            "message": "百度 Cookie 可能无效（触发验证码）",
                            "details": {"warning": "captcha_triggered"}
                        }
                    return {
                        "valid": True,
                        "message": "百度 Cookie 有效 ✓ (空查询不消耗)",
                        "details": {
                            "has_cookie": True,
                            "note": "使用空查询验证，不影响使用次数"
                        }
                    }
                else:
                    return {
                        "valid": True,
                        "message": "百度搜索可用（无 Cookie 模式）",
                        "details": {
                            "has_cookie": False,
                            "warning": "无 Cookie 可能遇到限制"
                        }
                    }

            elif resp.status_code == 302 or resp.status_code == 301:
                return {
                    "valid": False,
                    "message": "百度重定向（可能需要更新 Cookie）",
                    "details": {"redirect": True, "status_code": resp.status_code}
                }

            else:
                return {
                    "valid": False,
                    "message": f"百度返回异常状态: {resp.status_code}",
                    "details": {"status_code": resp.status_code}
                }

        except httpx.TimeoutException:
            return {
                "valid": False,
                "message": "百度连接超时",
                "details": {"error": "timeout"}
            }
        except Exception as e:
            return {
                "valid": False,
                "message": f"百度验证失败: {str(e)}",
                "details": {"error": str(e)}
            }
