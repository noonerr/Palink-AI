from typing import List, Optional, Dict, Any
from pydantic import BaseModel, field_validator
import json

from ..core.input_validation import sanitize_name, sanitize_text, sanitize_tags


def character_to_dict(character) -> Dict[str, Any]:
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
    }
    try:
        result["tags"] = json.loads(character.tags) if character.tags else []
        result["extensions"] = json.loads(character.extensions) if character.extensions else {}
    except (json.JSONDecodeError, TypeError, ValueError):
        result["tags"] = []
        result["extensions"] = {}
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

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        return sanitize_name(v, max_length=200)

    @field_validator("description", "background", "personality", "scenario", "first_mes", "mes_example", "system_prompt")
    @classmethod
    def validate_text_fields(cls, v: Optional[str]) -> Optional[str]:
        return sanitize_text(v, max_length=50000)

    @field_validator("tags")
    @classmethod
    def validate_tags(cls, v: Optional[List[str]]) -> Optional[List[str]]:
        return sanitize_tags(v)

    @field_validator("creator", "character_version", "user_nickname")
    @classmethod
    def validate_short_text(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        return sanitize_name(v, max_length=200)

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

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        return sanitize_name(v, max_length=200)

    @field_validator("description", "background", "personality", "scenario", "first_mes", "mes_example", "system_prompt")
    @classmethod
    def validate_text_fields(cls, v: Optional[str]) -> Optional[str]:
        return sanitize_text(v, max_length=50000)

    @field_validator("tags")
    @classmethod
    def validate_tags(cls, v: Optional[List[str]]) -> Optional[List[str]]:
        return sanitize_tags(v)

    @field_validator("creator", "character_version", "user_nickname")
    @classmethod
    def validate_short_text(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        return sanitize_name(v, max_length=200)

class CharacterChatRequest(BaseModel):
    message: str
    session_id: Optional[str] = None
    character_id: str
    model: str
    temperature: float = 0.7
    images: List[str] = []
    files: List[str] = []

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
