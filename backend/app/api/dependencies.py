from typing import Optional

from fastapi import Depends, HTTPException, Request, Response, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from ..core import get_db, settings
from ..core.security import decode_access_token, maybe_refresh_token, resolve_user_from_payload
from ..models import User

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/token", auto_error=False)

# [N8-a] HttpOnly Cookie 双轨鉴权（spec: docs/SPEC_N8_HttpOnly_Cookie_立项_2026-08-25.md §2）
SESSION_COOKIE_NAME = "palink_session"
CSRF_COOKIE_NAME = "palink_csrf"


def set_session_cookie(response: Response, token: str) -> None:
    """以登录同款属性写入 palink_session Cookie（登录与滑动续期共用）。"""
    response.set_cookie(
        SESSION_COOKIE_NAME,
        token,
        max_age=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        httponly=True,
        secure=settings.APP_ENV == "production",
        samesite="lax",
        path="/",
    )

async def get_current_user(
    token: Optional[str] = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
    # 注意: 必须用裸 Request 注解（Optional[Request] 会被 FastAPI 当作
    # Pydantic 字段而报错）；默认 None 保证非路由路径的直接调用兼容。
    request: "Request" = None,
) -> User:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )

    # [N8-a] 双轨提取：Authorization Bearer 头优先 → palink_session Cookie 兜底；
    # 两处皆无 → 401（现状文案不变）。显式携带但无效的 Bearer 不回退 Cookie
    # （凭据语义明确失败，避免通道混用歧义）。
    token_from_cookie = False
    if not token and request is not None:
        token = request.cookies.get(SESSION_COOKIE_NAME)
        token_from_cookie = token is not None
    if not token:
        raise credentials_exception

    # [L2-2 2026-10-23] 解码 + 用户解析 + 续期收口到 core/security（ST 面共用同一份）。
    # 错误码与文案逐字保持不变：下面每个分支对应原来的抛点。
    payload = decode_access_token(token)
    if payload is None:
        raise credentials_exception

    user, reason = resolve_user_from_payload(payload, db)
    if reason == "revoked":
        raise HTTPException(status_code=401, detail="Token has been revoked")
    if reason == "inactive":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Inactive user"
        )
    if user is None:  # no_username / no_user
        raise credentials_exception

    # [S-1 N-8 止血] 滑动续期：鉴权成功且剩余寿命 < ACCESS_TOKEN_EXPIRE_MINUTES/3 时，
    # 以同一身份签发新 token（同 sub、全新 jti/exp，不带 scope），挂在
    # request.state.token_refresh，由 main.py 的轻量中间件统一写入
    # X-Palink-Token-Refresh 响应头并同步重设 palink_session Cookie（N8-a §2.4，
    # Cookie 通道续期无需 JS 参与）。旧 token 不拉黑、自然过期（不误杀多端会话）。
    # [N8-a] 续期仅对 Bearer 通道生效（token 来自 Cookie 时跳过——Cookie 的更新
    # 由续期响应的 Set-Cookie 覆盖完成）；携带 scope 的 upload 短时效令牌绝不续期
    # （通道隔离不变）。request 为 None（直接调用）或无 Request 上下文时跳过。
    maybe_refresh_token(request, token, payload, from_cookie=token_from_cookie)

    return user

async def get_admin(user: User = Depends(get_current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not enough permissions"
        )
    return user
