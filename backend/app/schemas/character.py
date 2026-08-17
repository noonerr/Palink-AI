from typing import List, Optional, Dict, Any
from pydantic import BaseModel, field_validator
import json

from ..core.input_validation import sanitize_name, sanitize_text, sanitize_tags


def character_to_dict(character, has_character_book: bool = False) -> Dict[str, Any]:
    result = {
        "id": character.id,
        "name": character.name,
        "description": character.description,
        "background": character.background,
        "personality": character.personality,
        "avatar": character.avatar,
        "scenario": character.scenario,
        "first_mes": character.first_mes,
        "mes_example": character.mes_example,
        "system_prompt": character.system_prompt,
        "creator": character.creator,
        "character_version": character.character_version,
        "user_nickname": character.user_nickname,
        "is_processing": character.is_processing or False,
        "processing_status": character.processing_status or "",
        "created_at": character.created_at,
        "updated_at": character.updated_at,
        "has_character_book": has_character_book,
    }
    try:
        result["tags"] = json.loads(character.tags) if character.tags else []
        result["extensions"] = json.loads(character.extensions) if character.extensions else {}
    except (json.JSONDecodeError, TypeError, ValueError):
        result["tags"] = []
        result["extensions"] = {}
    try:
        result["preset_data"] = json.loads(character.preset_data) if character.preset_data else None
    except (json.JSONDecodeError, TypeError, ValueError):
        result["preset_data"] = None
    try:
        result["alternate_greetings"] = json.loads(character.alternate_greetings) if character.alternate_greetings else []
    except (json.JSONDecodeError, TypeError, ValueError):
        result["alternate_greetings"] = []
    try:
        result["ui_config"] = json.loads(character.ui_config) if character.ui_config else None
    except (json.JSONDecodeError, TypeError, ValueError):
        result["ui_config"] = None
    try:
        result["assets"] = json.loads(character.assets) if character.assets else None
    except (json.JSONDecodeError, TypeError, ValueError):
        result["assets"] = None
    try:
        result["group_only_greetings"] = json.loads(character.group_only_greetings) if character.group_only_greetings else []
    except (json.JSONDecodeError, TypeError, ValueError):
        result["group_only_greetings"] = []
    result["creator_notes"] = character.creator_notes
    result["post_history_instructions"] = character.post_history_instructions
    result["talkativeness"] = character.talkativeness if character.talkativeness is not None else "0.5"
    result["nickname"] = character.nickname
    return result

class CharacterCreate(BaseModel):
    name: str
    description: Optional[str] = None
    background: Optional[str] = None
    personality: Optional[str] = None
    avatar: Optional[str] = None
    scenario: Optional[str] = None
    first_mes: Optional[str] = None
    mes_example: Optional[str] = None
    system_prompt: Optional[str] = None
    tags: Optional[List[str]] = None
    creator: Optional[str] = None
    character_version: Optional[str] = None
    extensions: Optional[Dict[str, Any]] = None
    user_nickname: Optional[str] = None
    alternate_greetings: Optional[List[str]] = None
    creator_notes: Optional[str] = None
    post_history_instructions: Optional[str] = None
    ui_config: Optional[Dict[str, Any]] = None
    talkativeness: Optional[str] = None
    nickname: Optional[str] = None
    group_only_greetings: Optional[List[str]] = None

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        return sanitize_name(v, max_length=200)

    @field_validator("description", "background", "personality", "scenario", "first_mes", "mes_example", "system_prompt", "creator_notes", "post_history_instructions")
    @classmethod
    def validate_text_fields(cls, v: Optional[str]) -> Optional[str]:
        return sanitize_text(v, max_length=50000)

    @field_validator("tags", "alternate_greetings", "group_only_greetings")
    @classmethod
    def validate_tags(cls, v: Optional[List[str]]) -> Optional[List[str]]:
        return sanitize_tags(v)

    @field_validator("creator", "character_version", "user_nickname", "nickname")
    @classmethod
    def validate_short_text(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        return sanitize_name(v, max_length=200)

    @field_validator("talkativeness")
    @classmethod
    def validate_talkativeness(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        # ST 1.18.0 stores talkativeness as a string ("0" - "1" range typical).
        # Keep as string but trim whitespace; allow any short string for compat.
        return sanitize_name(v, max_length=32)

class CharacterUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    background: Optional[str] = None
    personality: Optional[str] = None
    avatar: Optional[str] = None
    scenario: Optional[str] = None
    first_mes: Optional[str] = None
    mes_example: Optional[str] = None
    system_prompt: Optional[str] = None
    tags: Optional[List[str]] = None
    creator: Optional[str] = None
    character_version: Optional[str] = None
    extensions: Optional[Dict[str, Any]] = None
    user_nickname: Optional[str] = None
    preset_data: Optional[Dict[str, Any]] = None
    alternate_greetings: Optional[List[str]] = None
    creator_notes: Optional[str] = None
    post_history_instructions: Optional[str] = None
    ui_config: Optional[Dict[str, Any]] = None
    talkativeness: Optional[str] = None
    nickname: Optional[str] = None
    group_only_greetings: Optional[List[str]] = None

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        return sanitize_name(v, max_length=200)

    @field_validator("description", "background", "personality", "scenario", "first_mes", "mes_example", "system_prompt", "creator_notes", "post_history_instructions")
    @classmethod
    def validate_text_fields(cls, v: Optional[str]) -> Optional[str]:
        return sanitize_text(v, max_length=50000)

    @field_validator("tags", "alternate_greetings", "group_only_greetings")
    @classmethod
    def validate_tags(cls, v: Optional[List[str]]) -> Optional[List[str]]:
        return sanitize_tags(v)

    @field_validator("creator", "character_version", "user_nickname", "nickname")
    @classmethod
    def validate_short_text(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        return sanitize_name(v, max_length=200)

    @field_validator("talkativeness")
    @classmethod
    def validate_talkativeness(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        return sanitize_name(v, max_length=32)

class CharacterChatRequest(BaseModel):
    message: str
    session_id: Optional[str] = None
    character_id: str
    model: str
    temperature: float = 0.7
    top_p: float = 0.9
    max_tokens: int = 2048
    frequency_penalty: float = 0.0
    presence_penalty: float = 0.0
    dialogue_mode: str = "first_person"
    branch_id: Optional[str] = None
    user_nickname: Optional[str] = None
    images: List[str] = []
    files: List[str] = []
    response_length: Optional[str] = None

class BranchCreateRequest(BaseModel):
    session_id: str
    branch_name: str
    parent_message_id: Optional[int] = None

class BranchSwitchRequest(BaseModel):
    session_id: str
    branch_id: str

class CharacterParseRequest(BaseModel):
    image_url: str

class CharacterTranslateRequest(BaseModel):
    character_id: str
    target_language: str
