import asyncio
import logging
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from ..schemas.chat import ChatRequest
from ..services.chat_service import ChatService
from ..core import get_db
from ..api.dependencies import get_current_user
from ..models import User

router = APIRouter(prefix="/api/chat", tags=["chat"])
logger = logging.getLogger(__name__)

@router.post("")
async def chat_stream(
    req: ChatRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """处理聊天请求，返回流式响应"""
    chat_service = ChatService(db)
    
    context = await chat_service.prepare_chat_context(req, user.id)
    
    session_id, is_new_session = chat_service.ensure_session(
        req.session_id,
        user.id,
        req.message,
        req.session_type
    )
    
    chat_service.save_user_message(
        session_id,
        req.message,
        req.model,
        req.images,
        req.files
    )
    
    messages = [{"role": "system", "content": "You are a helpful assistant."}]
    messages.append(context['user_message'])
    
    async def event_generator():
        response_text = f"I received your message: {req.message}"
        total_tokens = 0
        
        try:
            if is_new_session:
                yield f"data: {{'session_id': '{session_id}'}}\n\n"
            
            for char in response_text:
                await asyncio.sleep(0.05)
                yield f"data: {{'content': '{char}'}}\n\n"
            
            total_tokens = len(response_text) // 2
            yield f"data: {{'type': 'usage', 'total_tokens': {total_tokens}}}\n\n"
            yield "data: [DONE]\n\n"
            
        except Exception as e:
            logger.error(f"Stream error: {e}")
            yield f"data: {{'content': 'Error: {str(e)}'}}\n\n"
        
        try:
            chat_service.save_assistant_message(session_id, response_text, req.model, total_tokens)
        except Exception as e:
            logger.error(f"Failed to save assistant message: {e}")
    
    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no"
        }
    )
