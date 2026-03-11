from typing import Optional
from pydantic import BaseModel

class DefaultModelConfig(BaseModel):
    default_chat_model: Optional[str] = ""
    default_workspace_model: Optional[str] = ""
    default_outline_model: Optional[str] = ""
    daily_topic_model: Optional[str] = ""

class MemoryCompressRequest(BaseModel):
    session_id: str
    compression_ratio: float = 0.5
