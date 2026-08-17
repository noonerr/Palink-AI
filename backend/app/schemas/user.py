from typing import Literal, Optional
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
    # ST 1.18.0 author note position (single Integer field):
    #   0 = in story, 1 = after post-history, 2 = last in chat, 3 = inactive.
    author_note_position: Optional[int] = None
    author_note_frequency: Optional[int] = None
    # ST 1.18.0 depth insertion depth when position == 0 (in story).
    author_note_depth: Optional[int] = None
    custom_chat_prompt_zh: Optional[str] = None
    custom_chat_prompt_en: Optional[str] = None
    custom_character_prompt_zh: Optional[str] = None
    custom_character_prompt_en: Optional[str] = None
    use_custom_prompts: Optional[bool] = None
    show_character_status: Optional[bool] = None
    auto_generate_chat_images: Optional[bool] = None
    silly_tavern_mode: Optional[Literal["compat", "st-compat", "st-native", "palink-native", "iframe", "native"]] = None
    silly_tavern_theme: Optional[str] = None
    # Active persona id (references Persona.id). NULL clears the active persona.
    active_persona_id: Optional[str] = None
    # ST 1.18.0 power_user persistence (JSON string of full power_user object).
    power_user: Optional[str] = None

class PasswordReset(BaseModel):
    new_password: str
