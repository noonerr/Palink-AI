import base64
import hashlib
import json
import logging
import secrets
import uuid
from datetime import datetime, timezone, timedelta
from typing import Optional
from urllib.parse import urlencode

import httpx
import jwt
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.backends import default_backend
from sqlalchemy.orm import Session

from ..core.config import settings
from ..models import SystemSetting, User
from ..models.oauth import OAuthAccount

logger = logging.getLogger(__name__)

PROVIDER_PRESETS = {
    "github": {
        "authorize_url": "https://github.com/login/oauth/authorize",
        "token_url": "https://github.com/login/oauth/access_token",
        "userinfo_url": "https://api.github.com/user",
        "scopes": "user:email",
    },
    "google": {
        "authorize_url": "https://accounts.google.com/o/oauth2/v2/auth",
        "token_url": "https://oauth2.googleapis.com/token",
        "userinfo_url": "https://www.googleapis.com/oauth2/v2/userinfo",
        "scopes": "openid email profile",
    },
    "discord": {
        "authorize_url": "https://discord.com/api/oauth2/authorize",
        "token_url": "https://discord.com/api/oauth2/token",
        "userinfo_url": "https://discord.com/api/users/@me",
        "scopes": "identify email",
    },
}


def _derive_aes_key() -> bytes:
    raw = settings.SECRET_KEY.encode("utf-8")
    return hashlib.sha256(raw).digest()


def encrypt_secret(plaintext: str) -> str:
    if not plaintext:
        return ""
    key = _derive_aes_key()
    iv = secrets.token_bytes(16)
    padder = b"\x00" * (16 - len(plaintext.encode("utf-8")) % 16) if len(plaintext.encode("utf-8")) % 16 != 0 else b""
    data = plaintext.encode("utf-8") + padder
    cipher = Cipher(algorithms.AES(key), modes.CBC(iv), backend=default_backend())
    encryptor = cipher.encryptor()
    ct = encryptor.update(data) + encryptor.finalize()
    return base64.b64encode(iv + ct).decode("utf-8")


def decrypt_secret(ciphertext: str) -> str:
    if not ciphertext:
        return ""
    try:
        raw = base64.b64decode(ciphertext)
        iv = raw[:16]
        ct = raw[16:]
        key = _derive_aes_key()
        cipher = Cipher(algorithms.AES(key), modes.CBC(iv), backend=default_backend())
        decryptor = cipher.decryptor()
        pt = decryptor.update(ct) + decryptor.finalize()
        return pt.rstrip(b"\x00").decode("utf-8")
    except Exception:
        logger.warning("Failed to decrypt secret, returning raw value")
        return ciphertext


def get_oauth_providers_config(db: Session) -> list:
    setting = db.query(SystemSetting).filter(SystemSetting.key == "oauth_providers").first()
    if setting:
        try:
            providers = json.loads(setting.value)
            if isinstance(providers, list):
                return providers
        except (json.JSONDecodeError, TypeError):
            logger.warning("Corrupted oauth_providers in database")
    return []


def save_oauth_providers_config(db: Session, providers: list) -> None:
    for p in providers:
        if p.get("client_secret"):
            existing = get_oauth_providers_config(db)
            for e in existing:
                if e.get("name") == p.get("name") and e.get("client_secret") == p.get("client_secret"):
                    p["client_secret"] = e["client_secret"]
                    break
            else:
                p["client_secret"] = encrypt_secret(p["client_secret"])
    value = json.dumps(providers, ensure_ascii=False)
    setting = db.query(SystemSetting).filter(SystemSetting.key == "oauth_providers").first()
    if setting:
        setting.value = value
    else:
        db.add(SystemSetting(key="oauth_providers", value=value))
    db.commit()


def get_oauth_provider_config(provider: str, db: Session) -> Optional[dict]:
    providers = get_oauth_providers_config(db)
    for p in providers:
        if p.get("name") == provider and p.get("enabled", False):
            config = dict(p)
            if config.get("client_secret"):
                config["client_secret"] = decrypt_secret(config["client_secret"])
            preset = PROVIDER_PRESETS.get(provider, {})
            config.setdefault("authorize_url", preset.get("authorize_url", ""))
            config.setdefault("token_url", preset.get("token_url", ""))
            config.setdefault("userinfo_url", preset.get("userinfo_url", ""))
            config.setdefault("scopes", preset.get("scopes", ""))
            return config
    return None


def build_authorize_url(provider: str, redirect_uri: str, db: Session) -> tuple:
    config = get_oauth_provider_config(provider, db)
    if not config:
        raise ValueError(f"OAuth provider '{provider}' is not configured or not enabled")

    state = uuid.uuid4().hex
    state_token = jwt.encode(
        {
            "state": state,
            "provider": provider,
            "redirect_uri": redirect_uri,
            "exp": datetime.now(timezone.utc) + timedelta(minutes=10),
        },
        settings.SECRET_KEY,
        algorithm="HS256",
    )

    params = {
        "client_id": config["client_id"],
        "redirect_uri": redirect_uri,
        "scope": config.get("scopes", ""),
        "response_type": "code",
        "state": state_token,
    }

    authorize_url = config.get("authorize_url", "")
    separator = "&" if "?" in authorize_url else "?"
    url = f"{authorize_url}{separator}{urlencode(params)}"

    return url, state_token


async def exchange_code_for_token(provider: str, code: str, redirect_uri: str, db: Session) -> dict:
    config = get_oauth_provider_config(provider, db)
    if not config:
        raise ValueError(f"OAuth provider '{provider}' is not configured")

    token_url = config.get("token_url", "")
    data = {
        "client_id": config["client_id"],
        "client_secret": config["client_secret"],
        "code": code,
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code",
    }

    headers = {"Accept": "application/json"}
    if provider == "github":
        headers["Accept"] = "application/json"

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(token_url, data=data, headers=headers)
        if resp.status_code != 200:
            raise ValueError(f"Token exchange failed: {resp.status_code} {resp.text}")
        token_data = resp.json()

    if "error" in token_data:
        raise ValueError(f"Token exchange error: {token_data.get('error_description', token_data['error'])}")

    return token_data


async def fetch_user_info(provider: str, access_token: str, db: Session) -> dict:
    config = get_oauth_provider_config(provider, db)
    if not config:
        raise ValueError(f"OAuth provider '{provider}' is not configured")

    userinfo_url = config.get("userinfo_url", "")
    headers = {"Authorization": f"Bearer {access_token}"}
    if provider == "github":
        headers["Accept"] = "application/json"

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(userinfo_url, headers=headers)
        if resp.status_code != 200:
            raise ValueError(f"Fetch user info failed: {resp.status_code} {resp.text}")
        return resp.json()


def _extract_provider_user_info(provider: str, user_info: dict) -> dict:
    if provider == "github":
        return {
            "provider_user_id": str(user_info.get("id", "")),
            "provider_username": user_info.get("login", ""),
            "provider_avatar": user_info.get("avatar_url", ""),
            "email": user_info.get("email", ""),
            "display_name": user_info.get("name") or user_info.get("login", ""),
        }
    elif provider == "google":
        return {
            "provider_user_id": str(user_info.get("id", "")),
            "provider_username": user_info.get("email", "").split("@")[0] if user_info.get("email") else "",
            "provider_avatar": user_info.get("picture", ""),
            "email": user_info.get("email", ""),
            "display_name": user_info.get("name", ""),
        }
    elif provider == "discord":
        return {
            "provider_user_id": str(user_info.get("id", "")),
            "provider_username": user_info.get("username", ""),
            "provider_avatar": (
                f"https://cdn.discordapp.com/avatars/{user_info['id']}/{user_info['avatar']}.png"
                if user_info.get("id") and user_info.get("avatar")
                else ""
            ),
            "email": user_info.get("email", ""),
            "display_name": user_info.get("global_name") or user_info.get("username", ""),
        }
    else:
        provider_user_id = str(user_info.get("id") or user_info.get("sub") or user_info.get("user_id", ""))
        provider_username = user_info.get("login") or user_info.get("username") or user_info.get("name", "")
        provider_avatar = user_info.get("avatar_url") or user_info.get("picture") or user_info.get("avatar", "")
        return {
            "provider_user_id": provider_user_id,
            "provider_username": provider_username,
            "provider_avatar": provider_avatar,
            "email": user_info.get("email", ""),
            "display_name": user_info.get("name") or provider_username,
        }


def sync_oauth_user(db: Session, provider: str, oauth_user_info: dict, token_data: Optional[dict] = None) -> User:
    info = _extract_provider_user_info(provider, oauth_user_info)
    provider_user_id = info["provider_user_id"]
    if not provider_user_id:
        raise ValueError("Cannot extract provider user ID from OAuth response")

    oauth_account = (
        db.query(OAuthAccount)
        .filter(OAuthAccount.provider == provider, OAuthAccount.provider_user_id == provider_user_id)
        .first()
    )

    if oauth_account:
        user = db.query(User).filter(User.id == oauth_account.user_id).first()
        if not user:
            db.delete(oauth_account)
            db.flush()
            oauth_account = None
        else:
            oauth_account.provider_username = info["provider_username"]
            oauth_account.provider_avatar = info["provider_avatar"]
            if token_data:
                oauth_account.access_token = token_data.get("access_token")
                oauth_account.refresh_token = token_data.get("refresh_token")
                expires_in = token_data.get("expires_in")
                if expires_in:
                    oauth_account.token_expires_at = datetime.now(timezone.utc) + timedelta(seconds=expires_in)
            if not user.avatar and info["provider_avatar"]:
                user.avatar = info["provider_avatar"]
            db.commit()
            db.refresh(user)
            return user

    username = info["provider_username"] or info.get("display_name", "") or f"{provider}_{provider_user_id}"
    base_username = username
    counter = 1
    while db.query(User).filter(User.username == username).first():
        username = f"{base_username}_{counter}"
        counter += 1

    avatar = info["provider_avatar"] or None
    user = User(username=username, avatar=avatar)
    db.add(user)
    db.flush()

    access_token_val = token_data.get("access_token") if token_data else None
    refresh_token_val = token_data.get("refresh_token") if token_data else None
    expires_at = None
    if token_data and token_data.get("expires_in"):
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=token_data["expires_in"])

    new_oauth = OAuthAccount(
        user_id=user.id,
        provider=provider,
        provider_user_id=provider_user_id,
        provider_username=info["provider_username"],
        provider_avatar=info["provider_avatar"],
        access_token=access_token_val,
        refresh_token=refresh_token_val,
        token_expires_at=expires_at,
    )
    db.add(new_oauth)
    db.commit()
    db.refresh(user)
    return user


def verify_state(state_token: str) -> dict:
    try:
        payload = jwt.decode(state_token, settings.SECRET_KEY, algorithms=["HS256"])
        return payload
    except jwt.PyJWTError:
        raise ValueError("Invalid or expired OAuth state")
