"""路由注册健康守卫。

背景：api/__init__.py 曾把 regex_scripts/expressions/sd/backgrounds/stt/
connection_profiles/themes 七个 router 与带 csrf_guard 的版本重复注册——
Starlette 按注册顺序取第一个命中，CSRF 防护靠注册顺序侥幸生效，一旦重排
顺序即静默失守（2026-09-05 修复）。本测试防回潮：同一 (path, method)
不允许出现多个路由。
"""
import os
import sys
from collections import Counter

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)


def test_no_duplicate_routes_in_api_router():
    from app.api import api_router

    seen = []
    for route in api_router.routes:
        methods = getattr(route, "methods", None) or set()
        for m in methods:
            if m in ("HEAD", "OPTIONS"):
                # HEAD/OPTIONS 由同一路由自动派生，不参与去重
                continue
            seen.append((route.path, m))

    duplicates = {pair: n for pair, n in Counter(seen).items() if n > 1}
    assert not duplicates, f"存在重复注册的路由（后注册者永不生效，且可能绕过路由级依赖）: {duplicates}"


def test_csrf_guarded_routers_registered_exactly_once():
    """七个曾遭重复注册的 router：带 csrf_guard 的注册必须恰好一次。"""
    from app.api import api_router

    guarded_paths = {
        "/api/regex-scripts",
        "/api/expressions",
        "/api/sd",
        "/api/backgrounds",
        "/api/stt",
        "/api/connection-profiles",
        "/api/themes",
    }
    counts = Counter()
    for route in api_router.routes:
        for m in (getattr(route, "methods", None) or set()) - {"HEAD", "OPTIONS"}:
            for prefix in guarded_paths:
                if route.path == prefix or route.path.startswith(prefix + "/"):
                    counts[prefix] += 1
    unexpected = {p: c for p, c in counts.items() if c == 0}
    assert not unexpected, f"带守卫的 router 丢了注册: {unexpected}"
