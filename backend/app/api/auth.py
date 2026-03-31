from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional

from ..core import (
    get_db,
    settings,
    verify_password,
    get_password_hash,
    create_access_token,
    validate_password_policy,
)
from ..core.rate_limit import enforce_rate_limit
from ..api.dependencies import get_current_user
from ..models import User

router = APIRouter(prefix="/api", tags=["auth"])


class RegisterRequest(BaseModel):
    username: str
    password: str


class UserUpdate(BaseModel):
    avatar: Optional[str] = None
    username: Optional[str] = None


class ChangePassword(BaseModel):
    old_password: str
    new_password: str


@router.post("/token")
async def login(
    request: Request,
    form_data: OAuth2PasswordRequestForm = Depends(),
    db: Session = Depends(get_db),
):
    enforce_rate_limit(
        request,
        "auth:login",
        settings.LOGIN_RATE_LIMIT_REQUESTS,
        settings.LOGIN_RATE_LIMIT_WINDOW_SECONDS,
    )
    user = db.query(User).filter(User.username == form_data.username).first()
    if not user or not verify_password(form_data.password, user.hashed_password):
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
    enforce_rate_limit(
        request,
        "auth:register",
        settings.REGISTER_RATE_LIMIT_REQUESTS,
        settings.REGISTER_RATE_LIMIT_WINDOW_SECONDS,
    )
    if db.query(User).filter(User.username == req.username).first():
        raise HTTPException(status_code=400, detail="Username already exists")

    pw_error = validate_password_policy(req.password)
    if pw_error:
        raise HTTPException(status_code=400, detail=pw_error)

    user = User(username=req.username, hashed_password=get_password_hash(req.password))
    db.add(user)
    db.commit()
    return {"status": "ok"}


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
