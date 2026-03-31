from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import List, Optional
import uuid

from ..core import get_db
from ..api.dependencies import get_current_user
from ..models import User, ChatSession, ChatMessage

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


class BatchDeleteRequest(BaseModel):
    session_ids: List[str]


class MessageUpdate(BaseModel):
    content: str


class CreateSessionRequest(BaseModel):
    type: str = "chat"
    title: str = "New Chat"


class CreateMessageRequest(BaseModel):
    role: str
    content: str
    model: Optional[str] = None


@router.get("")
async def get_sessions(
    type: str = "chat",
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    sessions = (
        db.query(ChatSession)
        .filter(ChatSession.user_id == user.id, ChatSession.type == type)
        .order_by(ChatSession.updated_at.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    return [
        {
            "id": s.id,
            "title": s.title,
            "type": s.type,
            "updated_at": s.updated_at,
        }
        for s in sessions
    ]


@router.get("/{sid}/messages")
async def get_session_messages(
    sid: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    session = db.query(ChatSession).filter(ChatSession.id == sid, ChatSession.user_id == user.id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    messages = (
        db.query(ChatMessage)
        .filter(ChatMessage.session_id == sid)
        .order_by(ChatMessage.created_at)
        .all()
    )
    return [
        {
            "id": m.id,
            "role": m.role,
            "content": m.content,
            "model": m.model,
            "created_at": m.created_at,
            "tokens": m.tokens,
        }
        for m in messages
    ]


@router.delete("/batch")
async def batch_delete_sessions(
    req: BatchDeleteRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    sessions = (
        db.query(ChatSession)
        .filter(ChatSession.id.in_(req.session_ids), ChatSession.user_id == user.id)
        .all()
    )
    for s in sessions:
        db.delete(s)
    db.commit()
    return {"status": "ok", "deleted": len(sessions)}


@router.delete("/{sid}")
async def delete_session(
    sid: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    session = db.query(ChatSession).filter(ChatSession.id == sid, ChatSession.user_id == user.id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    db.delete(session)
    db.commit()
    return {"status": "ok"}


@router.delete("/{sid}/messages/{mid}")
async def delete_message(
    sid: str,
    mid: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    session = db.query(ChatSession).filter(ChatSession.id == sid, ChatSession.user_id == user.id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    message = db.query(ChatMessage).filter(ChatMessage.id == mid, ChatMessage.session_id == sid).first()
    if not message:
        raise HTTPException(status_code=404, detail="Message not found")
    db.delete(message)
    db.commit()
    return {"status": "ok"}


@router.post("")
async def create_session(
    req: CreateSessionRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    session_id = str(uuid.uuid4())
    new_session = ChatSession(
        id=session_id,
        user_id=user.id,
        title=req.title,
        type=req.type
    )
    db.add(new_session)
    db.commit()
    db.refresh(new_session)
    return {
        "id": new_session.id,
        "title": new_session.title,
        "type": new_session.type,
        "updated_at": new_session.updated_at
    }


@router.post("/{sid}/messages")
async def create_message(
    sid: str,
    req: CreateMessageRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    session = db.query(ChatSession).filter(ChatSession.id == sid, ChatSession.user_id == user.id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    
    new_message = ChatMessage(
        session_id=sid,
        role=req.role,
        content=req.content,
        model=req.model
    )
    db.add(new_message)
    db.commit()
    db.refresh(new_message)
    
    return {
        "id": new_message.id,
        "role": new_message.role,
        "content": new_message.content,
        "model": new_message.model,
        "created_at": new_message.created_at
    }


@router.put("/{sid}/messages/{mid}")
async def update_message(
    sid: str,
    mid: int,
    req: MessageUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    session = db.query(ChatSession).filter(ChatSession.id == sid, ChatSession.user_id == user.id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    message = db.query(ChatMessage).filter(ChatMessage.id == mid, ChatMessage.session_id == sid).first()
    if not message:
        raise HTTPException(status_code=404, detail="Message not found")
    message.content = req.content
    db.commit()
    return {"status": "ok"}
