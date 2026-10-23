from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, Any, Tuple
import hashlib
import hmac
import time
import uuid
import jwt
import bcrypt
from .config import settings
from .token_blacklist import is_blacklisted

ALGORITHM = "HS256"

# [N-6] service_key 分支的 X-Palink-User-Id 头签名消息格式
SERVICE_USER_MSG_PREFIX = "palink-user:"
# [N-7] 上传短时效令牌有效期（秒）
UPLOAD_TOKEN_TTL_SECONDS = 300

def verify_password(plain_password: str, hashed_password: str) -> bool:
    if not plain_password or not hashed_password:
        return False
    if isinstance(hashed_password, str):
        hashed_password = hashed_password.encode("utf-8")
    if isinstance(plain_password, str):
        plain_password = plain_password.encode("utf-8")
    try:
        return bcrypt.checkpw(plain_password, hashed_password)
    except (ValueError, TypeError):
        return False

def get_password_hash(password: str) -> str:
    if not password:
        raise ValueError("Password cannot be empty")
    if isinstance(password, str):
        password = password.encode("utf-8")
    return bcrypt.hashpw(password, bcrypt.gensalt()).decode("utf-8")


def validate_password_policy(password: str, field_name: str = "Password") -> Optional[str]:
    if len(password) < settings.PASSWORD_MIN_LENGTH:
        return f"{field_name} must be at least {settings.PASSWORD_MIN_LENGTH} characters"

    if any(ch.isspace() for ch in password):
        return f"{field_name} cannot contain whitespace"

    if settings.REQUIRE_PASSWORD_MIXED_CASE:
        has_lower = any(ch.islower() for ch in password)
        has_upper = any(ch.isupper() for ch in password)
        if not (has_lower and has_upper):
            return f"{field_name} must include both lowercase and uppercase letters"

    if settings.REQUIRE_PASSWORD_DIGIT and not any(ch.isdigit() for ch in password):
        return f"{field_name} must include at least one digit"

    return None

def create_access_token(data: Dict[str, Any]) -> str:
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire, "jti": uuid.uuid4().hex})
    encoded_jwt = jwt.encode(to_encode, settings.SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt

def decode_access_token(token: str) -> Optional[Dict[str, Any]]:
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[ALGORITHM], options={"verify_signature": True})
        return payload
    except jwt.PyJWTError:
        return None


# ── [L2-2 2026-10-23] 认证内核收口 ────────────────────────────────────────
# 此前 api/dependencies.py::get_current_user 与 api/silly_tavern.py::
# _user_from_request_token 各自手写一遍「JWT 解码 + jti 黑名单 + sub→User +
# is_active」，且 ST 面那一份漏了滑动续期。现在逻辑只此一份，各调用方只保留
# 自己的错误文案（ST 面与原生面的历史 401/400 措辞不同，客户端可能依赖）。

def resolve_user_from_payload(payload: Optional[Dict[str, Any]], db) -> Tuple[Optional[Any], str]:
    """把 JWT payload 解析成 User。

    Returns:
        ``(user, reason)``。reason 取值：
        ``ok`` / ``no_username`` / ``revoked`` / ``no_user`` / ``inactive``。
        user 仅在 ``ok`` 时非 None。

    刻意**不抛** HTTPException：两套调用方的错误文案不同，由它们各自翻译。
    """
    from ..models import User  # 延迟导入：models 不依赖 core，避免启动期环

    if not payload:
        return None, "no_username"
    username = payload.get("sub")
    if not username:
        return None, "no_username"
    jti = payload.get("jti")
    if jti and is_blacklisted(jti):
        return None, "revoked"
    user = db.query(User).filter(User.username == username).first()
    if user is None:
        return None, "no_user"
    if not user.is_active:
        return None, "inactive"
    return user, "ok"


def maybe_refresh_token(
    request,
    token: str,
    payload: Dict[str, Any],
    *,
    from_cookie: bool = False,
) -> None:
    """[N8-a] 滑动续期：满足条件时把新 token 挂到 ``request.state.token_refresh``。

    由 ``main.py::token_refresh_header_middleware`` 统一读取，写
    ``X-Palink-Token-Refresh`` 响应头并重设 ``palink_session`` Cookie。

    条件与历史 ``get_current_user`` 完全一致：
      - 只对显式 Bearer 通道生效（Cookie 通道跳过）；
      - 带 ``scope`` 的 upload 短时效令牌绝不续期；
      - 剩余寿命 < ``ACCESS_TOKEN_EXPIRE_MINUTES/3`` 才续。

    永不抛异常（续期是优化，不能影响鉴权结果）。
    """
    if request is None or from_cookie or payload.get("scope"):
        return
    exp = payload.get("exp")
    remaining = None
    if isinstance(exp, (int, float)):
        remaining = float(exp) - time.time()
    threshold_seconds = settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60 / 3.0
    if remaining is not None and remaining < threshold_seconds:
        request.state.token_refresh = create_access_token({"sub": payload.get("sub")})


def sign_service_user_id(uid: int) -> str:
    """[N-6] 计算 X-Palink-User-Sig 签名头。

    hex(hmac_sha256(key=ST_NATIVE_SERVICE_KEY, msg=f"palink-user:{uid}"))。
    供 ST sidecar / 代理注入侧与 openai_compat 校验侧共用同一格式，
    防止 SERVICE_KEY 持有者经未签名头冒充任意用户。
    """
    msg = f"{SERVICE_USER_MSG_PREFIX}{uid}".encode("utf-8")
    key = (settings.ST_NATIVE_SERVICE_KEY or "").encode("utf-8")
    return hmac.new(key, msg, hashlib.sha256).hexdigest()


def verify_service_user_id(uid: int, sig: Optional[str]) -> bool:
    """[N-6] 校验 X-Palink-User-Sig 签名头（compare_digest 防时序侧信道）。"""
    if not sig:
        return False
    expected = sign_service_user_id(uid)
    return hmac.compare_digest(expected, str(sig).strip())


def create_upload_token(username: str) -> str:
    """[N-7] 签发附件专用 upload-scope 短时效令牌。

    claims 仅含 {sub, scope:"upload", exp:now+300}——不放长效 exp、不放
    jti（5 分钟自然过期，无需黑名单）。主 JWT 无 scope claim，二者不可互换。
    """
    expire = datetime.now(timezone.utc) + timedelta(seconds=UPLOAD_TOKEN_TTL_SECONDS)
    payload = {
        "sub": username,
        "scope": "upload",
        "exp": expire,
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=ALGORITHM)
