from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, Any
from jose import JWTError, jwt
from passlib.context import CryptContext
from .config import settings

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
ALGORITHM = "HS256"

def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)

def get_password_hash(password: str) -> str:
    return pwd_context.hash(password)


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
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[ALGORITHM])
        return payload
    except JWTError:
        return None
