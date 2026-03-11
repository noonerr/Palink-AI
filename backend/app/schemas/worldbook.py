from typing import List, Optional
from pydantic import BaseModel


# ── WorldBook ──

class WorldBookCreate(BaseModel):
    name: str
    description: Optional[str] = None
    source_type: str = "online_edit"  # "upload" / "online_edit"
    raw_content: Optional[str] = None
    format: str = "custom"  # "silly_tavern_v2" / "custom"
    tags: Optional[List[str]] = None


class WorldBookUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    raw_content: Optional[str] = None
    tags: Optional[List[str]] = None


class WorldBookResponse(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    source_type: str
    format: str
    tags: Optional[List[str]] = None
    is_parsed: bool
    stage_count: int = 0
    created_at: str
    updated_at: str

    class Config:
        from_attributes = True


# ── WorldBookStage ──

class WorldBookStageResponse(BaseModel):
    id: str
    world_book_id: str
    stage_index: int
    title: Optional[str] = None
    content: str
    summary: Optional[str] = None
    transition_hint: Optional[str] = None
    priority: int
    token_count: int
    image_prompt: Optional[str] = None

    class Config:
        from_attributes = True


class WorldBookStageUpdate(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    summary: Optional[str] = None
    transition_hint: Optional[str] = None
    priority: Optional[int] = None
    image_prompt: Optional[str] = None


# ── WorldBook Detail (with stages) ──

class WorldBookDetailResponse(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    source_type: str
    raw_content: Optional[str] = None
    format: str
    tags: Optional[List[str]] = None
    is_parsed: bool
    stages: List[WorldBookStageResponse] = []
    created_at: str
    updated_at: str

    class Config:
        from_attributes = True


# ── Session WorldBook ──

class SessionWorldBookCreate(BaseModel):
    world_book_id: str
    stage_transition_mode: str = "auto"  # "auto" / "manual"


class SessionWorldBookResponse(BaseModel):
    id: str
    session_id: str
    world_book_id: str
    current_stage_index: int
    stage_transition_mode: str
    world_book: Optional[WorldBookResponse] = None
    stages: Optional[List[WorldBookStageResponse]] = None
    created_at: str
    updated_at: str

    class Config:
        from_attributes = True


# ── Stage Transition ──

class StageTransitionRequest(BaseModel):
    action: str  # "next" / "prev" / "jump"
    target_stage_index: Optional[int] = None  # Required when action == "jump"


class StageTransitionResponse(BaseModel):
    previous_stage_index: int
    current_stage_index: int
    stage_title: Optional[str] = None
    total_stages: int


# ── Parse Request ──

class WorldBookParseRequest(BaseModel):
    model: Optional[str] = None  # If None, uses system default
