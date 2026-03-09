from typing import List
from pydantic import BaseModel

class ModelItem(BaseModel):
    id: str
    name: str
    provider: str
    context_length: int
    icon: str
    description: str

class ProviderConfig(BaseModel):
    id: str
    name: str
    base_url: str
    api_key: str
    models: List[ModelItem]

class TestProviderRequest(BaseModel):
    provider_id: str
    base_url: str
    api_key: str
