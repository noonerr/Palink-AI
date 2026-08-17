from typing import Dict, List, Optional

from pydantic import BaseModel, Field


class TTSRequest(BaseModel):
    text: str
    voice_description: Optional[str] = None
    is_narrator: bool = False
    role: Optional[str] = None
    character_id: Optional[str] = None
    binding_override: Optional[Dict] = None


class TTSResponse(BaseModel):
    success: bool
    text: str
    voice_id: str
    gender: str
    provider_id: str
    engine_type: str = "browser"
    is_dialogue: bool
    is_narrator: bool
    role: str = "character"
    clone_sample_id: Optional[str] = None
    speed: float
    volume: float
    style: Optional[str] = None


class TTSConfigRequest(BaseModel):
    enabled: Optional[bool] = None
    active_provider_id: Optional[str] = None
    default_voice_gender: Optional[str] = None
    default_voice_id: Optional[str] = None
    segmented_playback: Optional[bool] = None
    providers: Optional[List[dict]] = None
    provider_configs: Optional[dict] = None


class CustomProviderRequest(BaseModel):
    id: str
    name: str
    description: Optional[str] = ""
    engine_type: str = "custom_api"
    config_fields: Optional[List[dict]] = None
    config: Optional[dict] = None
    voices: Optional[List[dict]] = None


class SetVoiceRequest(BaseModel):
    voice_id: str
    gender: Optional[str] = "female"


class VoiceBindingPayload(BaseModel):
    role: str = "character"
    provider_id: Optional[str] = None
    voice_id: Optional[str] = None
    gender: Optional[str] = None
    clone_sample_id: Optional[str] = None
    speed: float = Field(default=1.0, ge=0.25, le=4.0)
    volume: float = Field(default=1.0, ge=0.0, le=2.0)
    enabled: bool = True
    inherit: bool = False


class BindingsUpdateRequest(BaseModel):
    bindings: List[VoiceBindingPayload]


class TTSPreviewRequest(BaseModel):
    text: Optional[str] = None
    voice_description: Optional[str] = None
    role: str = "character"
    character_id: Optional[str] = None
    binding_override: Optional[Dict] = None


class TTSPrefetchVoicesRequest(BaseModel):
    preview_text: Optional[str] = None


class CloneSampleCreateResponse(BaseModel):
    id: str
    name: str
    provider_id: str
    source_voice_id: Optional[str] = None
    filename: str
    file_size: int
    mime_type: Optional[str] = None
