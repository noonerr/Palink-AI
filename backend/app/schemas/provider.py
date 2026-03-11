from typing import List, Optional
from pydantic import BaseModel

class ModelItem(BaseModel):
    id: str
    name: str
    provider: str
    context_length: int
    icon: str
    description: str

class ProviderModel(BaseModel):
    id: str
    alias: str = ""
    name: str = ""
    icon: Optional[str] = "🤖"
    description: Optional[str] = ""
    context_length: Optional[int] = 4096
    avatar: Optional[str] = ""

class ProviderConfig(BaseModel):
    id: str
    name: str
    base_url: str
    api_key: str
    models: List[ProviderModel] = []
    is_active: bool = True

class TestProviderRequest(BaseModel):
    provider_id: str
    base_url: str
    api_key: str
