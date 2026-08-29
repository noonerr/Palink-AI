"""ST 兼容端点的 CSRF 校验（MED-4）。

背景：ST 原生前端在写请求中携带 X-CSRF-Token（从 /csrf-token 获取，当前后端返回
固定值 "palink-csrf"）。此前 Palink 只返回 token、从不校验，CSRF 防护形同虚设。

规则（对齐 ST csrf-sync 语义，同时兼容 Palink 的 Bearer 认证与 bridge.js 代理）：
- GET/HEAD/OPTIONS/TRACE 等安全方法不校验；
- 携带 Authorization: Bearer 的请求不校验 —— Bearer 认证天然免疫 CSRF（跨站请求
  无法伪造 Authorization header），Palink 前端与 bridge.js 代理到 Palink-owned
  端点的请求都带 Bearer；
- 其余请求（纯 cookie 认证，即跨站攻击场景）必须携带 X-CSRF-Token: palink-csrf，
  否则返回 403；
- [N8-d 插件兼容兜底] Origin 同源放行（与 main.py 全局 CSRF 中间件 b) 兜底同语义）：
  经典轨插件（如 Galgame 界面插件）裸 fetch 同源 ST 端点时，浏览器必带同源 Origin，
  跨站伪造必带外站 Origin 或不带。兜底只放宽"同源"这一攻击者拿不到的信号，不削弱
  防护——全局中间件对同源请求本就放行，本守卫此前单点拒绝反而把存量无 palink_csrf
  cookie 的长寿命会话（cookie 仅登录时下发、12h 后过期、滑动续期不重发）卡死在 403。
"""
from urllib.parse import urlparse

from fastapi import HTTPException, Request, status

from .config import settings

_PALINK_CSRF_TOKEN = "palink-csrf"
_SAFE_METHODS = {"GET", "HEAD", "OPTIONS", "TRACE"}


def origin_same_site(origin: str, request: Request) -> bool:
    """[N8-d] Origin 与部署站点同源判定（与 main.py 全局 CSRF 中间件同口径）。

    1) Origin host == 请求 Host（同源部署主路径）；
    2) Origin 命中 CORS_ORIGINS 显式白名单（多第一方域名部署）；"*" 不参与。
    """
    parsed = urlparse(origin or "")
    origin_host = (parsed.netloc or "").lower()
    if not origin_host:
        return False
    site_host = (request.headers.get("host") or "").lower()
    if site_host and origin_host == site_host:
        return True
    allowed = settings.cors_origins_list
    if "*" in allowed:
        return False
    origin_norm = f"{parsed.scheme}://{parsed.netloc}".lower()
    for item in allowed:
        if item.strip().rstrip("/").lower() == origin_norm:
            return True
    return False


async def csrf_guard(request: Request) -> None:
    if request.method.upper() in _SAFE_METHODS:
        return
    if request.headers.get("authorization"):
        return
    token = request.headers.get("x-csrf-token", "")
    if token == _PALINK_CSRF_TOKEN:
        return
    # [N8-c 终态适配] Bearer 退役后 Palink 前端为纯 Cookie 认证，X-CSRF-Token
    # 携带的是动态 palink_csrf cookie 值（N8-a 双提交，登录时随 palink_session
    # 下发）。与 cookie 配对即放行——跨站攻击者无法同时伪造该 header 与配对
    # cookie（SameSite=Lax）。静态值分支保留给 ST iframe/bridge 兼容流量。
    if token and token == request.cookies.get("palink_csrf"):
        return
    # [N8-d 插件兼容兜底] 同源 Origin 放行——与全局中间件 b) 兜底同语义，
    # 存量无 palink_csrf cookie 的会话（滑动续期不重发 cookie）不再被本守卫单点卡死。
    origin = request.headers.get("origin")
    if origin and origin_same_site(origin, request):
        return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="CSRF token mismatch",
    )
