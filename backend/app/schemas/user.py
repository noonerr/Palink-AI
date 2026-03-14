from typing import Optional
from pydantic import BaseModel

class UserUpdate(BaseModel):
    avatar: Optional[str] = None
    username: Optional[str] = None

class ChangePassword(BaseModel):
    old_password: str
    new_password: str

class UserSettingUpdate(BaseModel):
    show_model_reasoning: Optional[bool] = None
    memory_mode: Optional[str] = None
    memory_model: Optional[str] = None
    prompt_language: Optional[str] = None

class PasswordReset(BaseModel):
    new_password: str
