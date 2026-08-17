import json
import logging

import jwt
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session
from pydantic import BaseModel, field_validator
from typing import Optional
import re

from ..core import (
    get_db,
    settings,
    verify_password,
    get_password_hash,
    create_access_token,
    validate_password_policy,
)
from ..core.token_blacklist import add_to_blacklist
from ..core.rate_limit import enforce_rate_limit
from ..core.auth_config import get_auth_config, get_public_auth_config
from ..core.ws_ticket import create_ticket
from ..api.dependencies import get_current_user
from ..models import User
from ..services.oauth_service import (
    build_authorize_url,
    exchange_code_for_token,
    fetch_user_info,
    sync_oauth_user,
    verify_state,
    get_oauth_provider_config,
)

router = APIRouter(prefix="/api", tags=["auth"])
logger = logging.getLogger(__name__)


def _resolve_allowed_frontend_origin(url_or_referer: str) -> str:
    """校验 url/referer 的 origin 是否在 CORS_ORIGINS 白名单内，返回匹配的 origin；否则返回空串。

    S-3 修复：OAuth 回调的跳转目标 origin 只能取白名单内的值，
    防止开放重定向把 JWT 泄露到攻击者域。开发模式 CORS_ORIGINS=* 时放行。
    """
    from urllib.parse import urlparse

    raw = str(url_or_referer or "").strip()
    if not raw:
        return ""
    parsed = urlparse(raw)
    if not parsed.scheme or not parsed.netloc:
        return ""
    origin = f"{parsed.scheme}://{parsed.netloc}"
    allowed = settings.cors_origins_list
    if "*" in allowed:
        return origin
    for item in allowed:
        if item.strip().rstrip("/").lower() == origin.lower():
            return origin
    return ""


class RegisterRequest(BaseModel):
    username: str
    password: str

    @field_validator("username")
    @classmethod
    def validate_username(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Username is required")
        if len(v) > 64:
            raise ValueError("Username must be 64 characters or less")
        if not re.match(r"^[a-zA-Z0-9_\-\u4e00-\u9fff]+$", v):
            raise ValueError("Username can only contain letters, numbers, underscores, hyphens, and Chinese characters")
        return v


class UserUpdate(BaseModel):
    avatar: Optional[str] = None
    username: Optional[str] = None

    @field_validator("username")
    @classmethod
    def validate_username(cls, v: str) -> str:
        if v is None:
            return v
        v = v.strip()
        if not v:
            raise ValueError("Username cannot be empty")
        if len(v) > 64:
            raise ValueError("Username must be 64 characters or less")
        if not re.match(r"^[a-zA-Z0-9_\-\u4e00-\u9fff]+$", v):
            raise ValueError("Username can only contain letters, numbers, underscores, hyphens, and Chinese characters")
        return v


class ChangePassword(BaseModel):
    old_password: str
    new_password: str


@router.get("/auth/config")
async def get_auth_config_public(db: Session = Depends(get_db)):
    return get_public_auth_config(db)


@router.post("/token")
async def login(
    request: Request,
    form_data: OAuth2PasswordRequestForm = Depends(),
    db: Session = Depends(get_db),
):
    config = get_auth_config(db)
    if not config.get("local_login_enabled", True):
        raise HTTPException(status_code=403, detail="Local login is disabled.")

    if not form_data.username or not form_data.username.strip():
        raise HTTPException(status_code=400, detail="Username is required")
    if not form_data.password:
        raise HTTPException(status_code=400, detail="Password is required")
    if len(form_data.username.strip()) > 64:
        raise HTTPException(status_code=400, detail="Username must be 64 characters or less")

    enforce_rate_limit(
        request,
        "auth:login",
        settings.LOGIN_RATE_LIMIT_REQUESTS,
        settings.LOGIN_RATE_LIMIT_WINDOW_SECONDS,
    )
    user = db.query(User).filter(User.username == form_data.username).first()
    if not user or not user.hashed_password:
        raise HTTPException(status_code=400, detail="Incorrect username or password")
    if not verify_password(form_data.password, user.hashed_password):
        raise HTTPException(status_code=400, detail="Incorrect username or password")
    if not user.is_active:
        raise HTTPException(status_code=400, detail="Inactive user")
    token = create_access_token({"sub": user.username, "role": user.role})
    return {"access_token": token, "token_type": "bearer"}


@router.post("/register")
async def register(
    req: RegisterRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    config = get_auth_config(db)
    if not config.get("local_register_enabled", True):
        raise HTTPException(status_code=403, detail="Local registration is disabled.")

    enforce_rate_limit(
        request,
        "auth:register",
        settings.REGISTER_RATE_LIMIT_REQUESTS,
        settings.REGISTER_RATE_LIMIT_WINDOW_SECONDS,
    )
    if not req.username or not req.username.strip():
        raise HTTPException(status_code=400, detail="Username is required")
    if len(req.username.strip()) > 64:
        raise HTTPException(status_code=400, detail="Username must be 64 characters or less")
    if len(req.password) < settings.PASSWORD_MIN_LENGTH:
        raise HTTPException(status_code=400, detail=f"Password must be at least {settings.PASSWORD_MIN_LENGTH} characters")
    if db.query(User).filter(User.username == req.username).first():
        raise HTTPException(status_code=400, detail="Username already exists")

    pw_error = validate_password_policy(req.password)
    if pw_error:
        raise HTTPException(status_code=400, detail=pw_error)

    user = User(username=req.username, hashed_password=get_password_hash(req.password))
    db.add(user)
    db.commit()
    return {"status": "ok"}


@router.post("/ws/ticket")
async def get_ws_ticket(user: User = Depends(get_current_user)):
    ticket = create_ticket(user.id)
    return {"ticket": ticket}


@router.get("/users/me")
async def get_my_profile(user: User = Depends(get_current_user)):
    return {
        "id": user.id,
        "username": user.username,
        "role": user.role,
        "avatar": user.avatar,
        "storage_used": user.storage_used or 0
    }


@router.put("/users/me")
async def update_my_profile(req: UserUpdate, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if req.avatar is not None:
        user.avatar = req.avatar
    if req.username is not None:
        existing = db.query(User).filter(User.username == req.username, User.id != user.id).first()
        if existing:
            raise HTTPException(status_code=400, detail="Username already taken")
        user.username = req.username
    db.commit()
    return {"status": "ok"}


@router.post("/users/me/password")
async def change_my_password(req: ChangePassword, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if not req.old_password or not req.new_password:
        raise HTTPException(status_code=400, detail="Both old and new passwords are required")
    if not verify_password(req.old_password, user.hashed_password):
        raise HTTPException(status_code=400, detail="Wrong old password")

    if req.new_password == req.old_password:
        raise HTTPException(status_code=400, detail="New password must be different from old password")

    pw_error = validate_password_policy(req.new_password, field_name="New password")
    if pw_error:
        raise HTTPException(status_code=400, detail=pw_error)

    user.hashed_password = get_password_hash(req.new_password)
    db.commit()
    return {"status": "ok"}


@router.post("/auth/logout")
async def logout(request: Request, user: User = Depends(get_current_user)):
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        token = auth_header[7:]
        try:
            payload = jwt.decode(token, settings.SECRET_KEY, algorithms=["HS256"])
            jti = payload.get("jti")
            exp = payload.get("exp")
            if jti and exp:
                add_to_blacklist(jti, exp)
        except Exception:
            pass
    return {"status": "ok"}


@router.get("/auth/oauth/{provider}/login-url")
async def oauth_login_url(provider: str, request: Request, db: Session = Depends(get_db)):
    config = get_oauth_provider_config(provider, db)
    if not config:
        raise HTTPException(status_code=404, detail=f"OAuth provider '{provider}' not found or not enabled")

    redirect_uri = str(request.url.replace(query_params={}))
    redirect_uri = redirect_uri.rstrip("/") + "/callback"

    frontend_url = request.headers.get("referer") or request.query_params.get("redirect_uri")
    if frontend_url:
        allowed_origin = _resolve_allowed_frontend_origin(frontend_url)
        if allowed_origin:
            redirect_uri = f"{allowed_origin}/api/auth/oauth/{provider}/callback"
        # origin 不在白名单时忽略 referer，回退到后端自身的 redirect_uri（安全）

    try:
        url, state_token = build_authorize_url(provider, redirect_uri, db)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    response = Response(
        content=json.dumps({"login_url": url}),
        media_type="application/json",
    )
    response.set_cookie(
        key="oauth_state",
        value=state_token,
        httponly=True,
        max_age=600,
        samesite="lax",
    )
    return response


@router.get("/auth/oauth/{provider}/callback")
async def oauth_callback(
    provider: str,
    code: Optional[str] = None,
    state: Optional[str] = None,
    error: Optional[str] = None,
    request: Request = None,
    db: Session = Depends(get_db),
):
    if error:
        from fastapi.responses import RedirectResponse
        frontend_url = str(request.base_url).rstrip("/") if request else ""
        return RedirectResponse(url=f"{frontend_url}#oauth_error={error}")

    if not code or not state:
        raise HTTPException(status_code=400, detail="Missing code or state parameter")

    cookie_state = request.cookies.get("oauth_state") if request else None
    if cookie_state and cookie_state != state:
        raise HTTPException(status_code=400, detail="State mismatch")

    try:
        state_data = verify_state(state)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    if state_data.get("provider") != provider:
        raise HTTPException(status_code=400, detail="Provider mismatch in state")

    redirect_uri = state_data.get("redirect_uri", "")

    try:
        token_data = await exchange_code_for_token(provider, code, redirect_uri, db)
        access_token = token_data.get("access_token")
        if not access_token:
            raise ValueError("No access_token in token response")

        user_info = await fetch_user_info(provider, access_token, db)
        user = sync_oauth_user(db, provider, user_info, token_data)

        if not user.is_active:
            raise HTTPException(status_code=400, detail="Inactive user")

        jwt_token = create_access_token({"sub": user.username, "role": user.role})

        from fastapi.responses import RedirectResponse
        frontend_url = str(request.base_url).rstrip("/") if request else ""
        referer = request.headers.get("referer", "") if request else ""
        if referer:
            allowed_origin = _resolve_allowed_frontend_origin(referer)
            if allowed_origin:
                frontend_url = allowed_origin

        redirect_url = f"{frontend_url}#access_token={jwt_token}"
        response = RedirectResponse(url=redirect_url)
        response.delete_cookie(key="oauth_state")
        return response

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"OAuth callback error: {e}")
        raise HTTPException(status_code=500, detail="OAuth authentication failed")
