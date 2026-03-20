from typing import Optional
from pydantic import BaseModel

class DefaultModelConfig(BaseModel):
    default_chat_model: Optional[str] = ""
    default_workspace_model: Optional[str] = ""
    default_outline_model: Optional[str] = ""
    daily_topic_model: Optional[str] = ""
    default_character_parse_model: Optional[str] = ""
    default_character_translate_model: Optional[str] = ""
    default_character_chat_model: Optional[str] = ""
    default_summarization_model: Optional[str] = ""
    default_oc_analysis_model: Optional[str] = ""
    allow_oc_analysis: Optional[bool] = True

class MemoryCompressRequest(BaseModel):
    session_id: str
    compression_ratio: float = 0.5
