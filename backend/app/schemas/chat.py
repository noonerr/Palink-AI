from typing import List, Optional
from pydantic import BaseModel

class ChatRequest(BaseModel):
    message: str
    session_id: Optional[str] = None
    model: str
    temperature: float = 0.7
    images: List[str] = []
    files: List[str] = []
    session_type: str = "chat"
    display_content: Optional[str] = None
    web_search: bool = False

class ChatResponse(BaseModel):
    session_id: Optional[str] = None
    content: str
    model_reasoning: Optional[str] = None
    total_tokens: int

class MessageUpdateRequest(BaseModel):
    content: str

class UploadRequest(BaseModel):
    filename: str
    data: str
