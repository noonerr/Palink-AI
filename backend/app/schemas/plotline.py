from pydantic import BaseModel, field_validator
from typing import Optional
from datetime import datetime

from ..core.input_validation import sanitize_name, sanitize_text


# ── PlotStage ────────────────────────────────────────────────────────────────

class PlotStageResponse(BaseModel):
    id: str
    plot_line_id: str
    stage_index: int
    title: Optional[str] = None
    content: str
    summary: Optional[str] = None
    transition_hint: Optional[str] = None
    priority: int = 5
    token_count: int = 0
    created_at: datetime

    class Config:
        from_attributes = True


class PlotStageUpdate(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    summary: Optional[str] = None
    transition_hint: Optional[str] = None
    priority: Optional[int] = None


# ── PlotLine ─────────────────────────────────────────────────────────────────

class PlotLineResponse(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    is_parsed: bool = False
    stage_count: int = 0
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class PlotLineDetail(PlotLineResponse):
    stages: list[PlotStageResponse] = []
    raw_content: Optional[str] = None


class PlotLineCreate(BaseModel):
    name: str
    description: Optional[str] = None
    raw_content: Optional[str] = None

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        return sanitize_name(v, max_length=200)

    @field_validator("description")
    @classmethod
    def validate_description(cls, v: Optional[str]) -> Optional[str]:
        return sanitize_text(v, max_length=5000)

    @field_validator("raw_content")
    @classmethod
    def validate_raw_content(cls, v: Optional[str]) -> Optional[str]:
        return sanitize_text(v, max_length=500000)


class PlotLineUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    raw_content: Optional[str] = None

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        return sanitize_name(v, max_length=200)

    @field_validator("description")
    @classmethod
    def validate_description(cls, v: Optional[str]) -> Optional[str]:
        return sanitize_text(v, max_length=5000)

    @field_validator("raw_content")
    @classmethod
    def validate_raw_content(cls, v: Optional[str]) -> Optional[str]:
        return sanitize_text(v, max_length=500000)


# ── Session ──────────────────────────────────────────────────────────────────

class SessionPlotLineCreate(BaseModel):
    plot_line_id: str
    stage_transition_mode: str = "manual"


class SessionPlotLineResponse(BaseModel):
    id: str
    session_id: str
    plot_line_id: str
    current_stage_index: int
    stage_transition_mode: str
    created_at: datetime

    class Config:
        from_attributes = True


# ── Status ───────────────────────────────────────────────────────────────────

class PlotStageOverviewItem(BaseModel):
    id: str
    stage_index: int
    title: Optional[str] = None
    summary: Optional[str] = None


class PlotLineStatus(BaseModel):
    active: bool
    plot_line_id: Optional[str] = None
    plot_line_name: Optional[str] = None
    current_stage_index: int = 0
    total_stages: int = 0
    stage_transition_mode: str = "manual"
    stages_overview: list[PlotStageOverviewItem] = []


# ── Stage transition ──────────────────────────────────────────────────────────

class StageTransitionRequest(BaseModel):
    session_id: str
    direction: str = "next"    # "next" | "prev"
    target_index: Optional[int] = None


class StageTransitionResponse(BaseModel):
    success: bool
    new_stage_index: int
    stage_title: Optional[str] = None
    message: str = ""
