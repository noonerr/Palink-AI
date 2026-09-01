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
    max_output_tokens: Optional[int] = None
    avatar: Optional[str] = ""
    supports_vision: Optional[bool] = None
    enable_thinking: Optional[bool] = None
    reasoning_effort: Optional[str] = None

class ProviderConfig(BaseModel):
    id: str
    name: str
    base_url: str
    api_key: str
    models: List[ProviderModel] = []
    is_active: bool = True
    # 网关管理（可选，P2-3）：base_url 指向 new-api/one-api 系网关时的后台地址与
    # 管理凭据，支持 env:/${} 引用；admin_url 仅在后台与 API 不同源时需要。
    admin_url: Optional[str] = None
    admin_username: Optional[str] = None
    admin_password: Optional[str] = None

class TestProviderRequest(BaseModel):
    provider_id: str
    base_url: str
    api_key: str
