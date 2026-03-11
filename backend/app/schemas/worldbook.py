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
    # Keyword-trigger fields
    keys: Optional[List[str]] = None
    secondary_keys: Optional[List[str]] = None
    scan_depth: int = 4
    position: int = 4
    selective: bool = False
    probability: int = 100
    constant: bool = False

    class Config:
        from_attributes = True


class WorldBookStageUpdate(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    summary: Optional[str] = None
    transition_hint: Optional[str] = None
    priority: Optional[int] = None
    image_prompt: Optional[str] = None
    keys: Optional[List[str]] = None
    secondary_keys: Optional[List[str]] = None
    scan_depth: Optional[int] = None
    position: Optional[int] = None
    selective: Optional[bool] = None
    probability: Optional[int] = None
    constant: Optional[bool] = None


# ── WorldBook Detail (with entries) ──

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


class SessionWorldBookResponse(BaseModel):
    id: str
    session_id: str
    world_book_id: str
    world_book: Optional[WorldBookResponse] = None
    stages: Optional[List[WorldBookStageResponse]] = None
    created_at: str
    updated_at: str

    class Config:
        from_attributes = True


# ── WorldBook Status (keyword-trigger mode) ──

class WorldBookStatus(BaseModel):
    active: bool
    world_book_id: Optional[str] = None
    world_book_name: Optional[str] = None
    active_entries_count: int = 0
    entries_overview: Optional[List[dict]] = None


# ── WorldBook Parse ──

class WorldBookParseRequest(BaseModel):
    model: Optional[str] = None


# ── Parse Request ──

class WorldBookParseRequest(BaseModel):
    model: Optional[str] = None  # If None, uses system default
