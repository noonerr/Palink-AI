from pydantic import BaseModel

class DefaultModelConfig(BaseModel):
    default_model: str
    default_temperature: float = 0.7
    default_top_p: float = 0.95

class MemoryCompressRequest(BaseModel):
    session_id: str
    compression_ratio: float = 0.5
