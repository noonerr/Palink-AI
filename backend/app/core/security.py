from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, Any
import hashlib
import hmac
import uuid
import jwt
import bcrypt
from .config import settings

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
