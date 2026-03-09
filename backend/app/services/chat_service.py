import os
import logging
from typing import List
from sqlalchemy.orm import Session

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
            context_text = self._process_file_references(req.files)
        
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
            self.db.query(ChatSession).filter(
                ChatSession.id == session_id
            ).update({"updated_at": datetime.now(timezone.utc)})
            self.db.commit()
            return session_id, False
    
    def save_user_message(self, session_id: str, message: str, model: str, images: List[str], files: List[str]):
        """保存用户消息到数据库"""
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
    
    def _process_file_references(self, files: List[str]) -> str:
        """处理文件引用"""
        context_text = ""
        for file_ref in files:
            content = ""
            if "/api/workspace/file/" in file_ref:
                fid = file_ref.split("/")[-1]
                f = self.db.query(UserFile).filter(UserFile.id == fid).first()
                if f and os.path.exists(f.file_path):
                    if f.mime_type.startswith('text/') or f.filename.endswith(('.txt', '.md', '.py', '.js', '.json', '.csv')):
                        try:
                            with open(f.file_path, 'r', encoding='utf-8', errors='ignore') as fo:
                                content = fo.read(30000)
                        except:
                            content = "[Binary]"
                    else:
                        content = f"[Binary File: {f.filename}]"
            context_text += f"\nFile Reference: {file_ref}\nExtracted Content:\n{content}\n---\n"
        return context_text
