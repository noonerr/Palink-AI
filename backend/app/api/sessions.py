from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import text
from pydantic import BaseModel, Field, field_validator
from typing import List, Optional
import uuid
import json
import logging

from ..core.input_validation import sanitize_title, sanitize_text

logger = logging.getLogger(__name__)

from ..core import get_db
from ..api.dependencies import get_current_user
from ..models import User, ChatSession, ChatMessage

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


class BatchDeleteRequest(BaseModel):
    session_ids: List[str] = Field(..., max_length=100)


class MessageUpdate(BaseModel):
    content: str

    @field_validator("content")
    @classmethod
    def validate_content(cls, v: str) -> str:
        return sanitize_text(v, max_length=100000) or ""


class CreateSessionRequest(BaseModel):
    type: str = "chat"
    title: str = "New Chat"

    @field_validator("title")
    @classmethod
    def validate_title(cls, v: str) -> str:
        return sanitize_title(v, max_length=500)

    @field_validator("type")
    @classmethod
    def validate_type(cls, v: str) -> str:
        if v not in ("chat", "character"):
            raise ValueError("Invalid session type")
        return v


class CreateMessageRequest(BaseModel):
    role: str
    content: str
    model: Optional[str] = None

    @field_validator("role")
    @classmethod
    def validate_role(cls, v: str) -> str:
        if v not in ("user", "assistant", "system"):
            raise ValueError("Invalid message role")
        return v

    @field_validator("content")
    @classmethod
    def validate_content(cls, v: str) -> str:
        return sanitize_text(v, max_length=100000) or ""


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
    result = []
    for m in messages:
        entry = {
            "id": m.id,
            "role": m.role,
            "content": m.content,
            "model": m.model,
            "created_at": m.created_at,
            "tokens": m.tokens,
        }
        if m.web_search_results:
            try:
                entry["webSearchResults"] = json.loads(m.web_search_results)
            except (json.JSONDecodeError, TypeError):
                pass
        result.append(entry)
    return result


def delete_session_memories(db: Session, session_ids: List[str], user_id: int):
    """删除指定会话的所有记忆数据"""
    if not session_ids:
        return
    try:
        placeholders = ", ".join([f":session_id_{i}" for i in range(len(session_ids))])
        params = {"user_id": user_id}
        for i, session_id in enumerate(session_ids):
            params[f"session_id_{i}"] = session_id
            
        sql = text(f"""
            DELETE FROM conversation_memories 
            WHERE session_id IN ({placeholders}) AND user_id = :user_id
        """)
        db.execute(sql, params)
        db.commit()
    except Exception as e:
        db.rollback()
        logger.error(f"删除记忆数据时出错: {e}")


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
    
    # 先删除相关的记忆数据
    session_ids_to_delete = [s.id for s in sessions]
    delete_session_memories(db, session_ids_to_delete, user.id)
    
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
    
    # 先删除相关的记忆数据
    delete_session_memories(db, [sid], user.id)
    
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
