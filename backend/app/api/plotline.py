"""PlotLine API routes — CRUD, AI parse, session association, stage transitions."""
import json
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..core import get_db
from ..api.dependencies import get_current_user
from ..models import User
from ..models.plotline import PlotLine, PlotStage, SessionPlotLine
from ..schemas.plotline import (
    PlotLineCreate, PlotLineUpdate, PlotLineResponse,
    PlotLineDetail, PlotStageResponse, PlotStageUpdate,
    SessionPlotLineCreate, SessionPlotLineResponse,
    PlotLineStatus, PlotStageOverviewItem,
    StageTransitionRequest, StageTransitionResponse,
)

router = APIRouter(prefix="/api/plotlines", tags=["plotlines"])
router_session_pl = APIRouter(prefix="/api/character-sessions", tags=["session-plotline"])


def _utc_now():
    return datetime.now(timezone.utc)


def _pl_to_response(pl: PlotLine) -> dict:
    stage_count = len(pl.stages) if pl.stages else 0
    return {
        "id": pl.id,
        "name": pl.name,
        "description": pl.description,
        "is_parsed": pl.is_parsed,
        "stage_count": stage_count,
        "created_at": str(pl.created_at) if pl.created_at else "",
        "updated_at": str(pl.updated_at) if pl.updated_at else "",
    }


def _stage_to_response(stage: PlotStage) -> dict:
    return {
        "id": stage.id,
        "plot_line_id": stage.plot_line_id,
        "stage_index": stage.stage_index,
        "title": stage.title,
        "content": stage.content,
        "summary": stage.summary,
        "transition_hint": stage.transition_hint,
        "priority": stage.priority,
        "token_count": stage.token_count,
        "created_at": str(stage.created_at) if stage.created_at else "",
    }


# ── PlotLine CRUD ─────────────────────────────────────────────────────────────

@router.get("")
def list_plot_lines(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    pls = db.query(PlotLine).filter(PlotLine.user_id == current_user.id).all()
    return [_pl_to_response(pl) for pl in pls]


@router.post("")
def create_plot_line(
    req: PlotLineCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    pl = PlotLine(
        id=str(uuid.uuid4()),
        user_id=current_user.id,
        name=req.name,
        description=req.description,
        raw_content=req.raw_content,
    )
    db.add(pl)
    db.commit()
    db.refresh(pl)
    return _pl_to_response(pl)


@router.get("/{plot_line_id}")
def get_plot_line(
    plot_line_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    pl = db.query(PlotLine).filter(PlotLine.id == plot_line_id, PlotLine.user_id == current_user.id).first()
    if not pl:
        raise HTTPException(status_code=404, detail="PlotLine not found")
    resp = _pl_to_response(pl)
    resp["stages"] = [_stage_to_response(s) for s in (pl.stages or [])]
    resp["raw_content"] = pl.raw_content
    return resp


@router.patch("/{plot_line_id}")
def update_plot_line(
    plot_line_id: str,
    req: PlotLineUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    pl = db.query(PlotLine).filter(PlotLine.id == plot_line_id, PlotLine.user_id == current_user.id).first()
    if not pl:
        raise HTTPException(status_code=404, detail="PlotLine not found")
    if req.name is not None:
        pl.name = req.name
    if req.description is not None:
        pl.description = req.description
    if req.raw_content is not None:
        pl.raw_content = req.raw_content
    pl.updated_at = _utc_now()
    db.commit()
    return _pl_to_response(pl)


@router.delete("/{plot_line_id}")
def delete_plot_line(
    plot_line_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    pl = db.query(PlotLine).filter(PlotLine.id == plot_line_id, PlotLine.user_id == current_user.id).first()
    if not pl:
        raise HTTPException(status_code=404, detail="PlotLine not found")
    db.delete(pl)
    db.commit()
    return {"success": True}


# ── AI Parse ─────────────────────────────────────────────────────────────────

@router.post("/{plot_line_id}/parse")
async def parse_plot_line(
    plot_line_id: str,
    body: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Use LLM to parse raw_content into structured stages."""
    from ..services.plotline_service import PARSE_SYSTEM_PROMPT
    from ..api.character_ext import call_openai_compat

    pl = db.query(PlotLine).filter(PlotLine.id == plot_line_id, PlotLine.user_id == current_user.id).first()
    if not pl:
        raise HTTPException(status_code=404, detail="PlotLine not found")
    if not pl.raw_content:
        raise HTTPException(status_code=400, detail="No raw content to parse")

    model = body.get("model")
    if not model:
        raise HTTPException(status_code=400, detail="model is required")

    from ..services.provider_registry import find_model

    provider, _ = find_model(model)
    if not provider:
        raise HTTPException(status_code=400, detail="Model not configured")

    api_base = provider.get("base_url")
    api_key = provider.get("api_key")
    if not api_base or not api_key:
        raise HTTPException(status_code=400, detail="Provider config incomplete")

    try:
        result_text = await call_openai_compat(
            api_base=api_base,
            api_key=api_key,
            model=model,
            messages=[
                {"role": "system", "content": PARSE_SYSTEM_PROMPT},
                {"role": "user", "content": pl.raw_content},
            ],
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"LLM call failed: {e}")

    # Parse JSON response
    try:
        raw = result_text.strip()
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
        stages_data: list = json.loads(raw)
    except (json.JSONDecodeError, IndexError) as e:
        raise HTTPException(status_code=422, detail=f"Failed to parse LLM response: {e}")

    # Delete existing stages and re-create
    db.query(PlotStage).filter(PlotStage.plot_line_id == pl.id).delete()

    for i, s in enumerate(stages_data):
        content = s.get("content", "")
        stage = PlotStage(
            id=str(uuid.uuid4()),
            plot_line_id=pl.id,
            stage_index=i,
            title=s.get("title"),
            content=content,
            summary=s.get("summary"),
            transition_hint=s.get("transition_hint"),
            priority=int(s.get("priority", 5)),
            token_count=len(content) // 4,
        )
        db.add(stage)

    pl.is_parsed = True
    pl.updated_at = _utc_now()
    db.commit()
    db.refresh(pl)

    resp = _pl_to_response(pl)
    resp["stages"] = [_stage_to_response(s) for s in pl.stages]
    return resp


# ── Stage edit ────────────────────────────────────────────────────────────────

@router.patch("/{plot_line_id}/stages/{stage_id}")
def update_stage(
    plot_line_id: str,
    stage_id: str,
    req: PlotStageUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    pl = db.query(PlotLine).filter(PlotLine.id == plot_line_id, PlotLine.user_id == current_user.id).first()
    if not pl:
        raise HTTPException(status_code=404, detail="PlotLine not found")
    stage = db.query(PlotStage).filter(PlotStage.id == stage_id, PlotStage.plot_line_id == plot_line_id).first()
    if not stage:
        raise HTTPException(status_code=404, detail="Stage not found")

    if req.title is not None:
        stage.title = req.title
    if req.content is not None:
        stage.content = req.content
        stage.token_count = len(req.content) // 4
    if req.summary is not None:
        stage.summary = req.summary
    if req.transition_hint is not None:
        stage.transition_hint = req.transition_hint
    if req.priority is not None:
        stage.priority = req.priority

    db.commit()
    return _stage_to_response(stage)


# ── Session association ───────────────────────────────────────────────────────

@router_session_pl.post("/{session_id}/plotline")
def associate_plot_line(
    session_id: str,
    req: SessionPlotLineCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    pl = db.query(PlotLine).filter(PlotLine.id == req.plot_line_id, PlotLine.user_id == current_user.id).first()
    if not pl:
        raise HTTPException(status_code=404, detail="PlotLine not found")

    existing = db.query(SessionPlotLine).filter(SessionPlotLine.session_id == session_id).first()
    if existing:
        existing.plot_line_id = req.plot_line_id
        existing.current_stage_index = 0
        existing.stage_transition_mode = req.stage_transition_mode
        existing.updated_at = _utc_now()
        db.commit()
        return {"success": True, "current_stage_index": 0}

    spl = SessionPlotLine(
        id=str(uuid.uuid4()),
        session_id=session_id,
        plot_line_id=req.plot_line_id,
        current_stage_index=0,
        stage_transition_mode=req.stage_transition_mode,
    )
    db.add(spl)
    db.commit()
    return {"success": True, "current_stage_index": 0}


@router_session_pl.delete("/{session_id}/plotline")
def remove_plot_line(
    session_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    spl = db.query(SessionPlotLine).filter(SessionPlotLine.session_id == session_id).first()
    if spl:
        db.delete(spl)
        db.commit()
    return {"success": True}


@router_session_pl.get("/{session_id}/plotline/status")
def get_plot_line_status(
    session_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    spl = db.query(SessionPlotLine).filter(SessionPlotLine.session_id == session_id).first()
    if not spl:
        return {"active": False}

    pl = db.query(PlotLine).filter(PlotLine.id == spl.plot_line_id).first()
    if not pl:
        return {"active": False}

    stages = db.query(PlotStage).filter(PlotStage.plot_line_id == pl.id).order_by(PlotStage.stage_index).all()
    return {
        "active": True,
        "plot_line_id": pl.id,
        "plot_line_name": pl.name,
        "current_stage_index": spl.current_stage_index,
        "total_stages": len(stages),
        "stage_transition_mode": spl.stage_transition_mode,
        "stages_overview": [
            {
                "id": s.id,
                "stage_index": s.stage_index,
                "title": s.title,
                "summary": s.summary,
            }
            for s in stages
        ],
    }


@router_session_pl.post("/{session_id}/plotline/transition")
def transition_stage(
    session_id: str,
    req: StageTransitionRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    spl = db.query(SessionPlotLine).filter(SessionPlotLine.session_id == session_id).first()
    if not spl:
        raise HTTPException(status_code=404, detail="No plotline for this session")

    total = db.query(PlotStage).filter(PlotStage.plot_line_id == spl.plot_line_id).count()

    if req.target_index is not None:
        new_idx = max(0, min(req.target_index, total - 1))
    elif req.direction == "prev":
        new_idx = max(0, spl.current_stage_index - 1)
    else:
        new_idx = min(total - 1, spl.current_stage_index + 1)

    spl.current_stage_index = new_idx
    spl.updated_at = _utc_now()
    db.commit()

    stage = db.query(PlotStage).filter(
        PlotStage.plot_line_id == spl.plot_line_id,
        PlotStage.stage_index == new_idx,
    ).first()

    return {
        "success": True,
        "new_stage_index": new_idx,
        "stage_title": stage.title if stage else None,
        "message": f"已切换到阶段 {new_idx + 1}",
    }
