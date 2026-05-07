from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, Any
import jwt
import bcrypt
from .config import settings

ALGORITHM = "HS256"

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
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, settings.SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt

def decode_access_token(token: str) -> Optional[Dict[str, Any]]:
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[ALGORITHM], options={"verify_signature": True})
        return payload
    except jwt.PyJWTError:
        return None
