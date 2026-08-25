import time

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session
import jwt

from ..core import get_db, settings
from ..core.token_blacklist import is_blacklisted
from ..models import User

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/token")

async def get_current_user(
    token: str = Depends(oauth2_scheme),
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

    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=["HS256"], options={"verify_signature": True})
        username: str = payload.get("sub")
        if username is None:
            raise credentials_exception
    except jwt.PyJWTError:
        raise credentials_exception

    jti = payload.get("jti")
    if jti and is_blacklisted(jti):
        raise HTTPException(status_code=401, detail="Token has been revoked")

    user = db.query(User).filter(User.username == username).first()
    if user is None:
        raise credentials_exception
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Inactive user"
        )

    # [S-1 N-8 止血] 滑动续期：鉴权成功且剩余寿命 < ACCESS_TOKEN_EXPIRE_MINUTES/3 时，
    # 以同一身份签发新 token（同 sub、全新 jti/exp，不带 scope），挂在
    # request.state.token_refresh，由 main.py 的轻量中间件统一写入
    # X-Palink-Token-Refresh 响应头。旧 token 不拉黑、自然过期（不误杀多端会话）。
    # 仅 Authorization Bearer 通道参与（oauth2_scheme 只读该头）；携带 scope 的
    # upload 短时效令牌绝不续期（通道隔离不变）。request 为 None（直接调用）
    # 或无 Request 上下文时跳过。
    if request is not None and not payload.get("scope"):
        exp = payload.get("exp")
        remaining: Optional[float] = None
        if isinstance(exp, (int, float)):
            remaining = float(exp) - time.time()
        threshold_seconds = settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60 / 3.0
        if remaining is not None and remaining < threshold_seconds:
            from ..core.security import create_access_token

            request.state.token_refresh = create_access_token({"sub": username})

    return user

async def get_admin(user: User = Depends(get_current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not enough permissions"
        )
    return user
