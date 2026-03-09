from typing import List, Optional, Dict, Any
from pydantic import BaseModel

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
    is_processing: Optional[bool] = None

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
