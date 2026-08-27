"""ST 兼容端点的 CSRF 校验（MED-4）。

背景：ST 原生前端在写请求中携带 X-CSRF-Token（从 /csrf-token 获取，当前后端返回
固定值 "palink-csrf"）。此前 Palink 只返回 token、从不校验，CSRF 防护形同虚设。

规则（对齐 ST csrf-sync 语义，同时兼容 Palink 的 Bearer 认证与 bridge.js 代理）：
- GET/HEAD/OPTIONS/TRACE 等安全方法不校验；
- 携带 Authorization: Bearer 的请求不校验 —— Bearer 认证天然免疫 CSRF（跨站请求
  无法伪造 Authorization header），Palink 前端与 bridge.js 代理到 Palink-owned
  端点的请求都带 Bearer；
- 其余请求（纯 cookie 认证，即跨站攻击场景）必须携带 X-CSRF-Token: palink-csrf，
  否则返回 403。
"""
from fastapi import HTTPException, Request, status

_PALINK_CSRF_TOKEN = "palink-csrf"
_SAFE_METHODS = {"GET", "HEAD", "OPTIONS", "TRACE"}


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
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="CSRF token mismatch",
    )
