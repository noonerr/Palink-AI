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
    developer_mode: Optional[bool] = None
    memory_mode: Optional[str] = None
    memory_model: Optional[str] = None
    prompt_language: Optional[str] = None
    character_display_mode: Optional[str] = None
    author_note: Optional[str] = None
    author_note_position: Optional[str] = None
    author_note_frequency: Optional[int] = None
    custom_chat_prompt_zh: Optional[str] = None
    custom_chat_prompt_en: Optional[str] = None
    custom_character_prompt_zh: Optional[str] = None
    custom_character_prompt_en: Optional[str] = None
    use_custom_prompts: Optional[bool] = None
    show_character_status: Optional[bool] = None

class PasswordReset(BaseModel):
    new_password: str
