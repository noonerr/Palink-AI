from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator

# 服务层 `_validate_provider` / `image_generation_service.py` 本来就支持这三种类型
# （见 _generate_sd_webui / _generate_comfyui），此前只有这里的 Literal 卡死了
# 另外两种，导致自建 SD WebUI / ComfyUI 的配置根本存不进去。
ImageGenerationProviderType = Literal["openai_compatible", "sd_webui", "comfyui"]

# 执行位置：server = Palink 后端直接出站调用（自托管同机）；browser = 任务下发给
# 用户浏览器，由浏览器 fetch 用户本机服务（托管部署下后端够不到用户内网）。
ImageGenerationExecutionMode = Literal["server", "browser"]


class ImageGenerationProvider(BaseModel):
    id: str = "openai_compatible"
    name: str = "OpenAI Compatible"
    type: ImageGenerationProviderType = "openai_compatible"
    enabled: bool = True
    execution: ImageGenerationExecutionMode = "server"
    base_url: str = ""
    api_key: str = ""
    model: str = ""
    size: str = "1024x1024"
    quality: Optional[str] = None
    style: Optional[str] = None
    response_format: Optional[str] = "auto"
    timeout_seconds: int = Field(default=120, ge=5, le=600)
    # [AUDIT-2026-09-25] SD/ComfyUI 出图参数此前全硬编码（steps=20 /
    # Euler a / cfg=7.0 / neg=''），schema 也没有这些字段，填了不生效。
    # 对 openai_compatible 无效（其本有 quality/style）。
    negative_prompt: str = ""
    steps: int = Field(default=20, ge=1, le=150)
    cfg_scale: float = Field(default=7.0, ge=0.0, le=30.0)
    sampler_name: str = "Euler a"
    seed: int = Field(default=-1, ge=-1)  # -1 = 随机（ComfyUI 侧由服务层取随机值）

    # ── 家族适配三件套（SPEC §1，B1-T1）──────────────────────────────
    # 这三个字段与 image_generation_service._validate_provider 的**白名单返回**
    # 必须同步：那里漏一个 = 设置页保存成功但字段被静默丢弃。默认值全部等价于
    # 改动前的行为（自动识别 / 空 checkpoint / 无自定义工作流）。
    family: str = "auto"
    checkpoint_name: str = ""
    workflow_json: str = ""

    @field_validator("family")
    @classmethod
    def validate_family(cls, value: str) -> str:
        allowed = {
            "auto", "nl", "danbooru",
            "qwen_image", "flux", "sdxl", "pony", "illustrious", "noobai",
        }
        text = str(value or "").strip().lower()
        return text if text in allowed else "auto"


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


class ImageGenerationMediaRequest(BaseModel):
    """为消息配图时的可选请求体。

    `media_id` 由前端在插入乐观占位时生成，服务端**采纳**它（见
    `message_media_service.normalize_media_id`）：两边认同一个 id，重试即原位
    复位同一条 media，而不是每次失败都在数组里堆一项。不传则老行为（服务端生成）。
    """

    media_id: Optional[str] = Field(default=None, max_length=64)


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


class LocalImageTaskResultRequest(BaseModel):
    """浏览器执行器回传出图结果。

    `images` 取第一张（与 SD/ComfyUI 服务端路径同语义），元素接受裸 base64 或
    data URL（执行器用 FileReader 产出 dataURL，服务端两种都剥）。
    """

    images: list[str] = Field(..., min_length=1, max_length=4)


class LocalImageTaskFailRequest(BaseModel):
    error: str = Field(..., min_length=1, max_length=500)
