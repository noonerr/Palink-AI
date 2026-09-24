from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator

# 服务层 `_validate_provider` / `image_generation_service.py` 本来就支持这三种类型
# （见 _generate_sd_webui / _generate_comfyui），此前只有这里的 Literal 卡死了
# 另外两种，导致自建 SD WebUI / ComfyUI 的配置根本存不进去。
ImageGenerationProviderType = Literal["openai_compatible", "sd_webui", "comfyui"]


class ImageGenerationProvider(BaseModel):
    id: str = "openai_compatible"
    name: str = "OpenAI Compatible"
    type: ImageGenerationProviderType = "openai_compatible"
    enabled: bool = True
    base_url: str = ""
    api_key: str = ""
    model: str = ""
    size: str = "1024x1024"
    quality: Optional[str] = None
    style: Optional[str] = None
    response_format: Optional[str] = "auto"
    timeout_seconds: int = Field(default=120, ge=5, le=600)


class ImageGenerationDefaults(BaseModel):
    prompt_template: str
    include_recent_context_count: int = Field(default=4, ge=0, le=20)


class ImageGenerationConfigRequest(BaseModel):
    enabled: bool = False
    active_provider_id: str = "openai_compatible"
    providers: list[ImageGenerationProvider] = Field(default_factory=list)
    defaults: Optional[ImageGenerationDefaults] = None


class ImageGenerationTestRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=8000)

    @field_validator("prompt")
    @classmethod
    def validate_prompt(cls, value: str) -> str:
        return value.strip()


class ImageGenerationResult(BaseModel):
    image_url: str
    provider_id: str
    model: Optional[str] = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    prompt: Optional[str] = None
    revised_prompt: Optional[str] = None


class ImageGenerationMessageResponse(BaseModel):
    status: str = "ok"
    image: ImageGenerationResult
    updated_message: dict[str, Any]
