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
    # silly_tavern_mode/silly_tavern_theme 已于 2026-09-04 A1 删除（alembic 0062）；
    # PUT 请求体携带这两个键时被 pydantic 忽略，不再落库。
    # Active persona id (references Persona.id). NULL clears the active persona.
    active_persona_id: Optional[str] = None
    # ST 1.18.0 power_user persistence (JSON string of full power_user object).
    power_user: Optional[str] = None
    # MVU 副 AI 变量更新（2026-08-19）：副模型 ID（空=不启用）+ 开关。
    mvu_secondary_model: Optional[str] = None
    mvu_secondary_enabled: Optional[bool] = None
    # 分层记忆 Phase 1：记忆区注入预算档位（0-3，None=不改）。
    memory_budget_level: Optional[int] = None

class PasswordReset(BaseModel):
    new_password: str
