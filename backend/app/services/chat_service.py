import os
import logging
from typing import List, Optional
from urllib.parse import unquote
from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..core import settings
from ..models import ChatSession, ChatMessage, UserSetting, UserFile

logger = logging.getLogger(__name__)

class ChatService:
    """聊天服务 - 处理聊天相关的业务逻辑"""
    
    def __init__(self, db: Session):
        self.db = db
    
    async def prepare_chat_context(self, req, user_id: int):
        """准备聊天的上下文信息"""
        user_setting = self.db.query(UserSetting).filter(
            UserSetting.user_id == user_id
        ).first()
        memory_mode = user_setting.memory_mode if user_setting else "rule"
        
        context_text = ""
        if req.files:
            context_text = self._process_file_references(req.files, user_id)
        
        final_user_content = req.message + "\n\n" + context_text
        user_message = {"role": "user", "content": final_user_content}
        
        return {
            "user_message": user_message,
            "memory_mode": memory_mode
        }
    
    def ensure_session(self, session_id, user_id: int, message: str, session_type: str):
        """确保会话存在"""
        if not session_id:
            import uuid
            session_id = str(uuid.uuid4())
            title = message[:30] if message else "New Chat"
            self.db.add(ChatSession(
                id=session_id,
                user_id=user_id,
                title=title,
                type=session_type
            ))
            self.db.commit()
            return session_id, True
        else:
            from datetime import datetime, timezone
            existing_session = self.db.query(ChatSession).filter(
                ChatSession.id == session_id,
                ChatSession.user_id == user_id,
            ).first()
            if not existing_session:
                raise HTTPException(status_code=404, detail="Session not found")

            existing_session.updated_at = datetime.now(timezone.utc)
            self.db.commit()
            return session_id, False
    
    def save_user_message(self, session_id: str, message: str, model: str, images: List[str], files: List[str], display_content: Optional[str] = None):
        """保存用户消息到数据库"""
        if display_content:
            db_content = display_content
        else:
            db_content = message
            if images: 
                db_content += f" [Attached {len(images)} Images]"
            if files: 
                db_content += f" [Attached {len(files)} Files]"
        
        self.db.add(ChatMessage(
            session_id=session_id,
            role="user",
            content=db_content,
            model=model
        ))
        self.db.commit()
    
    def save_assistant_message(self, session_id: str, content: str, model: str, tokens: int):
        """保存助手消息到数据库"""
        self.db.add(ChatMessage(
            session_id=session_id,
            role="assistant",
            content=content,
            model=model,
            tokens=tokens
        ))
        self.db.commit()
    
    def _process_file_references(self, files: List[str], user_id: int) -> str:
        """处理文件引用"""
        text_exts = ('.txt', '.md', '.py', '.js', '.ts', '.json', '.csv', '.html', '.css', '.yaml', '.yml')

        def _append_text_or_binary(path: str, display_name: str) -> str:
            ext = os.path.splitext(display_name)[1].lower()
            try:
                if ext in text_exts:
                    with open(path, 'r', encoding='utf-8', errors='ignore') as fo:
                        return fo.read(30000)
            except Exception:
                return '[Unreadable text content]'

            return f"[Binary File: {display_name}]"

        def _resolve_upload_path(file_ref: str) -> str | None:
            upload_prefix = '/api/uploads/' if '/api/uploads/' in file_ref else '/uploads/' if '/uploads/' in file_ref else None
            if not upload_prefix:
                return None

            relative = file_ref.split(upload_prefix, 1)[1]
            relative = relative.split('?', 1)[0].split('#', 1)[0]
            relative = unquote(relative).replace('\\', '/').lstrip('/')
            if not relative:
                return None

            normalized = os.path.normpath(relative).replace('\\', '/')
            if normalized.startswith('../'):
                return None

            parts = [p for p in normalized.split('/') if p]
            if not parts:
                return None

            # Strict user isolation for new upload layout: /api/uploads/{user_id}/{filename}
            if len(parts) >= 2 and parts[0].isdigit() and int(parts[0]) != int(user_id):
                return None

            upload_root = os.path.abspath(settings.UPLOAD_DIR)
            abs_path = os.path.abspath(os.path.join(upload_root, normalized))
            if os.path.commonpath([upload_root, abs_path]) != upload_root:
                return None

            if not os.path.exists(abs_path):
                return None

            return abs_path

        context_chunks: List[str] = []
        for file_ref in files:
            upload_path = _resolve_upload_path(file_ref)
            if upload_path:
                display_name = os.path.basename(upload_path)
                content = _append_text_or_binary(upload_path, display_name)
                context_chunks.append(
                    f"\nFile Reference: {file_ref}\nExtracted Content:\n{content}\n---\n"
                )
                continue

            if "/api/workspace/file/" in file_ref:
                fid = file_ref.split("/api/workspace/file/", 1)[1]
                fid = fid.split("?", 1)[0].split("#", 1)[0].strip("/")
                if not fid:
                    continue

                f = self.db.query(UserFile).filter(
                    UserFile.id == fid,
                    UserFile.user_id == user_id,
                ).first()
                if not f or not os.path.exists(f.file_path):
                    continue

                content = ""
                mime_type = f.mime_type or ""
                if mime_type.startswith('text/') or f.filename.endswith(text_exts):
                    try:
                        with open(f.file_path, 'r', encoding='utf-8', errors='ignore') as fo:
                            content = fo.read(30000)
                    except Exception:
                        content = "[Unreadable text content]"
                else:
                    content = f"[Binary File: {f.filename}]"

                context_chunks.append(
                    f"\nFile Reference: {file_ref}\nExtracted Content:\n{content}\n---\n"
                )

        return "".join(context_chunks)
