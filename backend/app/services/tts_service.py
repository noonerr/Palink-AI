"""
TTS语音合成服务
支持多TTS服务商：浏览器内置、小米MIMO TTS、自定义TTS API等
配置持久化存储到 data/tts_config.json，用户/角色语音绑定存储到数据库
"""

import base64
import json
import logging
import mimetypes
import os
import re
from typing import Dict, List, Optional, Tuple

import httpx
from sqlalchemy.orm import Session

from ..models import Character, TTSCloneSample, TTSVoiceBinding, User
from ..utils import _is_public_http_url, allow_internal_service_urls

logger = logging.getLogger(__name__)


# ============================================================
# 音频格式识别（AUDIT-2026-09-25）
# ============================================================

def sniff_audio_mime(data: bytes, fallback: str = "audio/mpeg") -> str:
    """按魔数（文件头字节）推断音频 MIME。

    custom_api 分支此前把上游返回的字节硬编码声明成 audio/mpeg：Chrome
    靠内容嗅探大概率能播，Safari / iOS 严格按声明类型解码会直接不出声。
    """
    if not data or len(data) < 12:
        return fallback
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "audio/wav"
    if data[:4] == b"OggS":
        return "audio/ogg"
    if data[:4] == b"fLaC":
        return "audio/flac"
    if data[4:8] == b"ftyp":
        return "audio/mp4"
    if data[:3] == b"ID3" or (data[0] == 0xFF and (data[1] & 0xE0) == 0xE0):
        return "audio/mpeg"
    return fallback


def resolve_audio_mime(upstream_content_type: Optional[str], audio_bytes: bytes, fallback: str = "audio/mpeg") -> str:
    """优先信上游声明的 Content-Type（audio/*），否则按魔数推断。"""
    ct = (upstream_content_type or "").split(";")[0].strip().lower()
    if ct.startswith("audio/"):
        return ct
    return sniff_audio_mime(audio_bytes, fallback)


def audio_mime_ext(mime: str) -> str:
    """Content-Disposition 文件名扩展名要跟真实格式一致（.wav 配 audio/wav）。"""
    return {
        "audio/wav": ".wav",
        "audio/x-wav": ".wav",
        "audio/wave": ".wav",
        "audio/mpeg": ".mp3",
        "audio/mp3": ".mp3",
        "audio/ogg": ".ogg",
        "audio/flac": ".flac",
        "audio/mp4": ".m4a",
        "audio/x-m4a": ".m4a",
        "audio/aac": ".aac",
    }.get((mime or "").split(";")[0].strip().lower(), ".mp3")


# ============================================================
# 内置TTS服务商定义
# ============================================================

BUILTIN_PROVIDERS = [
    {
        "id": "browser",
        "name": "浏览器内置",
        "description": "使用浏览器 Web Speech API，无需配置",
        "engine_type": "browser",
        "is_builtin": True,
        "config_fields": [],
        "voices": [
            {"voice_id": "browser_zh_female", "gender": "female", "description": "中文女声"},
            {"voice_id": "browser_zh_male", "gender": "male", "description": "中文男声"},
        ],
    },
    {
        "id": "xiaomi_mimo",
        "name": "小米 MIMO TTS",
        "description": "小米MiMo语音合成服务，支持风格控制和声音克隆，限时免费",
        "engine_type": "xiaomi_mimo",
        "is_builtin": True,
        "config_fields": [
            {"key": "api_key", "label": "API Key", "type": "password", "required": True, "placeholder": "请输入小米 MIMO API Key"},
            {"key": "model", "label": "模型", "type": "text", "required": False, "placeholder": "mimo-v2.5-tts"},
            {"key": "voiceclone_model", "label": "克隆模型", "type": "text", "required": False, "placeholder": "mimo-v2.5-tts-voiceclone"},
        ],
        "voices": [
            {"voice_id": "冰糖", "gender": "female", "description": "冰糖（中文女声）"},
            {"voice_id": "茉莉", "gender": "female", "description": "茉莉（中文女声）"},
            {"voice_id": "苏打", "gender": "male", "description": "苏打（中文男声）"},
            {"voice_id": "白桦", "gender": "male", "description": "白桦（中文男声）"},
            {"voice_id": "Mia", "gender": "female", "description": "Mia（英文女声）"},
            {"voice_id": "Chloe", "gender": "female", "description": "Chloe（英文女声）"},
            {"voice_id": "Milo", "gender": "male", "description": "Milo（英文男声）"},
            {"voice_id": "Dean", "gender": "male", "description": "Dean（英文男声）"},
        ],
    },
    {
        "id": "custom_api",
        "name": "自定义 TTS API",
        "description": "兼容 OpenAI TTS 接口格式的自定义服务",
        "engine_type": "custom_api",
        "is_builtin": False,
        "config_fields": [
            {"key": "base_url", "label": "API 地址", "type": "text", "required": True, "placeholder": "https://api.example.com/v1/audio/speech"},
            {"key": "api_key", "label": "API Key", "type": "password", "required": True, "placeholder": "请输入 API Key"},
            {"key": "model", "label": "模型名称", "type": "text", "required": False, "placeholder": "tts-1"},
        ],
        "voices": [
            {"voice_id": "alloy", "gender": "female", "description": "Alloy（中性）"},
            {"voice_id": "echo", "gender": "male", "description": "Echo（男声）"},
            {"voice_id": "fable", "gender": "female", "description": "Fable（女声）"},
            {"voice_id": "onyx", "gender": "male", "description": "Onyx（男声）"},
            {"voice_id": "nova", "gender": "female", "description": "Nova（女声）"},
            {"voice_id": "shimmer", "gender": "female", "description": "Shimmer（女声）"},
        ],
    },
    {
        "id": "edge",
        "name": "Edge TTS",
        "description": "微软 Edge 浏览器 TTS，免费，支持多语言高质量语音",
        "engine_type": "edge",
        "is_builtin": True,
        "config_fields": [],
        "voices": [
            {"voice_id": "zh-CN-XiaoxiaoNeural", "gender": "female", "description": "晩晩（中文女声）"},
            {"voice_id": "zh-CN-YunxiNeural", "gender": "male", "description": "云希（中文男声）"},
            {"voice_id": "en-US-AriaNeural", "gender": "female", "description": "Aria（英文女声）"},
            {"voice_id": "en-US-GuyNeural", "gender": "male", "description": "Guy（英文男声）"},
        ],
    },
    {
        "id": "elevenlabs",
        "name": "ElevenLabs TTS",
        "description": "ElevenLabs 高质量 AI 语音合成，支持声音克隆",
        "engine_type": "elevenlabs",
        "is_builtin": True,
        "config_fields": [
            {"key": "api_key", "label": "API Key", "type": "password", "required": True, "placeholder": "请输入 ElevenLabs API Key"},
            {"key": "model", "label": "模型", "type": "text", "required": False, "placeholder": "eleven_multilingual_v2"},
        ],
        "voices": [
            {"voice_id": "21m00Tcm4TlvDq8ikWAM", "gender": "female", "description": "Rachel（女声）"},
            {"voice_id": "AZnzlk1XvdvUeBnXmlld", "gender": "male", "description": "Domi（男声）"},
            {"voice_id": "EXAVITQu4vr4xnSDxMaL", "gender": "female", "description": "Bella（女声）"},
            {"voice_id": "ErXwobaYiN019PkySvjV", "gender": "male", "description": "Antoni（男声）"},
        ],
    },
    {
        "id": "coqui",
        "name": "Coqui TTS",
        "description": "Coqui TTS 开源语音合成服务器",
        "engine_type": "coqui",
        "is_builtin": True,
        "config_fields": [
            {"key": "base_url", "label": "服务器地址", "type": "text", "required": True, "placeholder": "http://localhost:5002"},
            {"key": "speaker_id", "label": "说话人 ID", "type": "text", "required": False, "placeholder": "可选"},
            {"key": "language_id", "label": "语言 ID", "type": "text", "required": False, "placeholder": "XTTS 多语模型必填，如 zh-cn / en（默认 en）"},
        ],
        "voices": [
            {"voice_id": "default", "gender": "female", "description": "默认音色"},
        ],
    },
]


# ============================================================
# TTS语音描述到发音人的映射表（跨服务商通用）
# ============================================================

VOICE_DESCRIPTION_MAPPING = {
    "温柔": {"gender": "female", "tags": ["gentle", "warm"]},
    "温柔女声": {"gender": "female", "tags": ["gentle", "warm"]},
    "甜美": {"gender": "female", "tags": ["sweet", "cute"]},
    "甜美女声": {"gender": "female", "tags": ["sweet", "cute"]},
    "活泼": {"gender": "female", "tags": ["lively", "cheerful"]},
    "活泼女声": {"gender": "female", "tags": ["lively", "cheerful"]},
    "知性": {"gender": "female", "tags": ["intellectual", "calm"]},
    "知性女声": {"gender": "female", "tags": ["intellectual", "calm"]},
    "成熟女声": {"gender": "female", "tags": ["mature", "deep"]},
    "女声": {"gender": "female", "tags": []},
    "女性": {"gender": "female", "tags": []},
    "女": {"gender": "female", "tags": []},
    "成熟": {"gender": "male", "tags": ["mature", "deep"]},
    "成熟男声": {"gender": "male", "tags": ["mature", "deep"]},
    "稳重": {"gender": "male", "tags": ["steady", "deep"]},
    "稳重男声": {"gender": "male", "tags": ["steady", "deep"]},
    "阳光": {"gender": "male", "tags": ["sunny", "bright"]},
    "阳光男声": {"gender": "male", "tags": ["sunny", "bright"]},
    "男声": {"gender": "male", "tags": []},
    "男性": {"gender": "male", "tags": []},
    "男": {"gender": "male", "tags": []},
    "旁白": {"gender": "female", "tags": ["narrator"], "is_narrator": True},
    "叙述": {"gender": "female", "tags": ["narrator"], "is_narrator": True},
}

DEFAULT_VOICE_GENDER = "female"
DEFAULT_PREVIEW_TEXT = "这是一段语音试听。今晚的风很轻，我会用这个声音为你朗读角色对白。"
VALID_ROLES = {"character", "narrator"}
VALID_SCOPES = {"global", "user", "character"}


# ============================================================
# 400 文案白名单（N-13 契约兼容，AUDIT-2026-09-25）
# ============================================================
#
# 审计实锤：api 层曾把写给人看的提示（"请先去模型管理→语音中设置"）统一
# 压成 request_id 脱敏文案，用户无法自助修复。但 N-13 契约（4xx detail
# 禁止直传 str(e)）仍然正确——异常原文可能带上游内容。折中：只有本服务
# 手写的静态文案才原样透出，其余一律脱敏。

_CLIENT_SAFE_EXACT = frozenset({
    "TTS 已禁用",
    "该语音绑定已禁用",
    "Text cannot be empty",
    "No text to synthesize",
    "No text to synthesize after extraction",
    "小米 MIMO TTS API Key 未配置，请在模型管理→语音中设置",
    "自定义 TTS API 地址未配置",
    "自定义 TTS API Key 未配置",
    "ElevenLabs API Key 未配置，请在模型管理→语音中设置",
    "Coqui TTS 服务器地址未配置",
    "Coqui TTS 服务器地址必须是公网 http(s) 地址（本地服务请设 ALLOW_INTERNAL_SERVICE_URLS=true）",
    "edge-tts 未安装，请运行 pip install edge-tts",
    "edge-tts 未返回音频数据",
    "MIMO TTS API returned no choices",
    "MIMO TTS API returned no audio data",
    "Only public http(s) TTS API URLs are allowed",
    "声音克隆样本文件不存在",
    "声音克隆需要登录用户上下文",
    "当前服务商不支持声音克隆",
    "声音克隆样本不存在或无权访问",
    "声音克隆样本路径无效",
})

# 含用户可控但无害的插值（服务商 id / 角色 名）：按前缀放行。
_CLIENT_SAFE_PREFIXES = ("服务商 '", "Invalid TTS role")


def client_safe_tts_detail(exc: Exception, request_id: str = "unknown") -> str:
    """TTS 400 文案策略：白名单内的静态提示透出，其余脱敏。

    api 层不得直传 ``detail=str(e)``（N-13 静态守卫），经此函数中转：
    白名单命中 → 原文；否则 → request_id 脱敏文案。
    """
    text = str(exc)
    if text in _CLIENT_SAFE_EXACT or text.startswith(_CLIENT_SAFE_PREFIXES):
        return text
    return f"语音合成请求无法处理 (request_id: {request_id})"


# ============================================================
# 配置持久化
# ============================================================

_config_cache: Optional[dict] = None
_config_mtime: Optional[float] = None


def _config_path() -> str:
    from ..core.config import settings
    return os.path.join(settings.DATA_DIR, "tts_config.json")


def _get_raw_config() -> dict:
    global _config_cache, _config_mtime
    path = _config_path()
    try:
        mtime = os.path.getmtime(path)
        if _config_mtime == mtime and _config_cache is not None:
            return _config_cache
        with open(path, "r", encoding="utf-8") as f:
            _config_cache = json.load(f)
            _config_mtime = mtime
            return _config_cache
    except Exception:
        pass
    return _config_cache or _default_config()


def _default_config() -> dict:
    return {
        "enabled": True,
        "active_provider_id": "browser",
        "default_voice_gender": "female",
        "default_voice_id": "",
        "segmented_playback": False,
        "providers": [],
        "provider_configs": {},
    }


def get_tts_config() -> dict:
    raw = _get_raw_config()
    return _mask_sensitive(raw)


def save_tts_config(config: dict) -> dict:
    global _config_cache, _config_mtime
    path = _config_path()
    allowed_top = {"enabled", "active_provider_id", "default_voice_gender", "default_voice_id", "segmented_playback", "providers", "provider_configs"}
    cleaned = {k: v for k, v in config.items() if k in allowed_top}
    defaults = _get_raw_config()
    for k in allowed_top:
        if k not in cleaned:
            cleaned[k] = defaults.get(k, "")

    if "provider_configs" in cleaned:
        raw_pc = defaults.get("provider_configs", {})
        new_pc = cleaned["provider_configs"]
        merged_pc = {}
        for pid, pconfig in raw_pc.items():
            merged_pc[pid] = dict(pconfig) if isinstance(pconfig, dict) else pconfig
        for pid, pconfig in new_pc.items():
            if pid in merged_pc and isinstance(merged_pc[pid], dict) and isinstance(pconfig, dict):
                for key, val in pconfig.items():
                    if _is_masked(val):
                        continue
                    merged_pc[pid][key] = val
            else:
                if isinstance(pconfig, dict):
                    pconfig = {k: v for k, v in pconfig.items() if not _is_masked(v)}
                merged_pc[pid] = pconfig
        cleaned["provider_configs"] = merged_pc

    if "provider_configs" in cleaned:
        custom_config = cleaned["provider_configs"].get("custom_api", {})
        if isinstance(custom_config, dict):
            base_url = custom_config.get("base_url", "")
            if base_url and not _is_masked(base_url):
                custom_config["base_url"] = _validate_custom_tts_base_url(base_url)

    if "providers" in cleaned:
        raw_providers = defaults.get("providers", [])
        new_providers = cleaned["providers"]
        merged_providers = []
        for new_p in new_providers:
            pid = new_p.get("id", "")
            existing = next((p for p in raw_providers if p.get("id") == pid), None)
            if existing and "config" in new_p and isinstance(new_p["config"], dict):
                merged_config = dict(existing.get("config", {}))
                for key, val in new_p["config"].items():
                    if _is_masked(val):
                        continue
                    merged_config[key] = val
                new_p = {**new_p, "config": merged_config}
            merged_providers.append(new_p)
        cleaned["providers"] = merged_providers

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cleaned, f, ensure_ascii=False, indent=2)
    _config_cache = None
    _config_mtime = None
    return get_tts_config()


def _is_masked(val: object) -> bool:
    if not isinstance(val, str):
        return False
    return val == "********" or "****" in val


def _validate_custom_tts_base_url(base_url: str) -> str:
    normalized = (base_url or "").strip()
    if not normalized:
        return normalized
    if _is_public_http_url(normalized):
        return normalized
    # 本地 TTS 服务（LM Studio / 自建网关等）此前在开发模式也被拦——
    # 该校验无条件拒绝内网。现在统一走内网放行开关（dev 默认放行，
    # 生产需 ALLOW_INTERNAL_SERVICE_URLS=true）。
    if allow_internal_service_urls():
        return normalized
    raise ValueError("Only public http(s) TTS API URLs are allowed")


_SENSITIVE_KEYS = {"api_key"}


def _mask_sensitive(data: dict) -> dict:
    result = dict(data)
    providers = result.get("providers", [])
    masked_providers = []
    for p in providers:
        mp = dict(p)
        config = mp.get("config", {})
        masked_config = dict(config)
        for key in _SENSITIVE_KEYS:
            val = masked_config.get(key, "")
            if val:
                if len(val) <= 8:
                    masked_config[key] = "********"
                else:
                    masked_config[key] = val[:4] + "****" + val[-4:]
        mp["config"] = masked_config
        masked_providers.append(mp)
    result["providers"] = masked_providers

    provider_configs = result.get("provider_configs", {})
    masked_pc = {}
    for pid, pconfig in provider_configs.items():
        masked_pconfig = dict(pconfig) if isinstance(pconfig, dict) else pconfig
        if isinstance(masked_pconfig, dict):
            for key in _SENSITIVE_KEYS:
                val = masked_pconfig.get(key, "")
                if val:
                    if len(val) <= 8:
                        masked_pconfig[key] = "********"
                    else:
                        masked_pconfig[key] = val[:4] + "****" + val[-4:]
        masked_pc[pid] = masked_pconfig
    result["provider_configs"] = masked_pc

    return result


# ============================================================
# 语音描述解析 / 文本清理
# ============================================================

def parse_voice_description(description: str) -> Dict:
    if not description or not isinstance(description, str):
        return {"gender": DEFAULT_VOICE_GENDER, "tags": []}
    desc = description.lower().strip()
    for key, value in VOICE_DESCRIPTION_MAPPING.items():
        if key in desc:
            return value.copy()
    if "女" in desc or "female" in desc:
        return {"gender": "female", "tags": []}
    if "男" in desc or "male" in desc:
        return {"gender": "male", "tags": []}
    return {"gender": DEFAULT_VOICE_GENDER, "tags": []}


def clean_text_for_tts(text: str) -> str:
    if not text:
        return ""
    clean_text = re.sub(r"【声音[：:]\s*[^】]+】", "", text)
    clean_text = re.sub(r"\[Voice[：:]\s*[^\]]+\]", "", clean_text, flags=re.IGNORECASE)
    clean_text = re.sub(r"<state[\s\S]*?</state>", "", clean_text, flags=re.IGNORECASE)
    clean_text = re.sub(r"\[state\][\s\S]*?\[/state\]", "", clean_text, flags=re.IGNORECASE)
    clean_text = re.sub(r"---[\s\S]*$", "", clean_text).strip()
    clean_text = re.sub(r"\*+", "", clean_text)
    clean_text = re.sub(r"_+", "", clean_text)
    clean_text = re.sub(r"#+", "", clean_text)
    return clean_text.strip()


def extract_dialogue_for_tts(text: str) -> Tuple[str, bool]:
    clean_text = clean_text_for_tts(text)
    if not clean_text:
        return "", False
    dialogue_pattern = r'["“](.*?)["”]'
    matches = re.findall(dialogue_pattern, clean_text)
    if matches:
        dialogue = " ".join([m.strip() for m in matches if m.strip()])
        if dialogue:
            return dialogue, True
    return clean_text, False


# ============================================================
# Provider / Binding helpers
# ============================================================

def _all_providers(raw_config: Optional[dict] = None) -> List[dict]:
    raw = raw_config or _get_raw_config()
    return list(BUILTIN_PROVIDERS) + [p for p in raw.get("providers", []) if isinstance(p, dict)]


def _get_provider(provider_id: str, raw_config: Optional[dict] = None) -> Optional[dict]:
    for provider in _all_providers(raw_config):
        if provider.get("id") == provider_id:
            return provider
    return None


def _provider_config(provider: dict, raw_config: Optional[dict] = None) -> dict:
    raw = raw_config or _get_raw_config()
    provider_id = provider.get("id", "")
    provider_configs = raw.get("provider_configs", {})
    config = {}
    if isinstance(provider.get("config"), dict):
        config.update(provider.get("config", {}))
    if isinstance(provider_configs.get(provider_id), dict):
        config.update(provider_configs.get(provider_id, {}))
    return config


def _resolve_voice_for_provider(provider_id: str, gender: str) -> Optional[str]:
    provider = _get_provider(provider_id)
    if not provider:
        return None
    voices = provider.get("voices", [])
    gender_matches = [v for v in voices if v.get("gender") == gender]
    if gender_matches:
        return gender_matches[0].get("voice_id")
    if voices:
        return voices[0].get("voice_id")
    return None


def _binding_to_dict(binding: Optional[TTSVoiceBinding]) -> Optional[dict]:
    if not binding:
        return None
    return {
        "id": binding.id,
        "scope": binding.scope,
        "user_id": binding.user_id,
        "character_id": binding.character_id,
        "role": binding.role,
        "provider_id": binding.provider_id,
        "voice_id": binding.voice_id,
        "gender": binding.gender,
        "clone_sample_id": binding.clone_sample_id,
        "speed": binding.speed if binding.speed is not None else 1.0,
        "volume": binding.volume if binding.volume is not None else 1.0,
        "enabled": bool(binding.enabled),
    }


def binding_to_public_dict(binding: Optional[TTSVoiceBinding], inherited: bool = False) -> Optional[dict]:
    data = _binding_to_dict(binding)
    if data:
        data["inherited"] = inherited
    return data


def sync_global_bindings_on_provider_switch(db: Session, old_provider_id: str, new_provider_id: str) -> int:
    """管理员切换 active_provider_id 后，把"跟随旧默认"的全局绑定刷到新服务商。

    审计实锤（tts_service resolve 的 ``binding.provider_id or provider_id``）：
    global 绑定首次由 ``ensure_global_defaults`` 落库时冻结当时的
    active_provider_id，此后管理员切换服务商只改配置文件，实际合成仍走冻结
    的旧服务商——UI 显示与真实行为不一致。这里只刷 provider_id 仍等于旧
    激活服务商的绑定；管理员显式指定为其他服务商的绑定保持不动。
    """
    if not old_provider_id or not new_provider_id or new_provider_id == old_provider_id:
        return 0
    config = _get_raw_config()
    bindings = db.query(TTSVoiceBinding).filter(
        TTSVoiceBinding.scope == "global",
        TTSVoiceBinding.provider_id == old_provider_id,
    ).all()
    for binding in bindings:
        binding.provider_id = new_provider_id
        gender = binding.gender or config.get("default_voice_gender", DEFAULT_VOICE_GENDER)
        binding.voice_id = _resolve_voice_for_provider(new_provider_id, gender) or ""
        logger.info("TTS global binding role=%s follows provider switch %s -> %s", binding.role, old_provider_id, new_provider_id)
    db.flush()
    return len(bindings)


# ============================================================
# 实际TTS API调用
# ============================================================

async def _call_xiaomi_mimo_tts(
    text: str,
    voice_id: str,
    api_key: str,
    model: str = "mimo-v2.5-tts",
    style: Optional[str] = None,
) -> bytes:
    content = text
    if style:
        content = f"({style}){text}"

    payload = {
        "model": model,
        "messages": [{"role": "assistant", "content": content}],
        "audio": {"format": "wav", "voice": voice_id},
    }
    headers = {"api-key": api_key, "Content-Type": "application/json"}

    logger.info("MIMO TTS API call: model=%s, voice_id=%s, text_len=%d", model, voice_id, len(text))

    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            "https://api.xiaomimimo.com/v1/chat/completions",
            json=payload,
            headers=headers,
        )
        if response.status_code != 200:
            logger.error("MIMO TTS API error: status=%s", response.status_code)
        response.raise_for_status()
        result = response.json()

    return _decode_mimo_audio(result)


async def _call_xiaomi_mimo_voiceclone_tts(
    text: str,
    sample_path: str,
    api_key: str,
    model: str = "mimo-v2.5-tts-voiceclone",
    mime_type: Optional[str] = None,
    style: Optional[str] = None,
) -> bytes:
    content = text
    if style:
        content = f"({style}){text}"

    if not os.path.exists(sample_path):
        raise ValueError("声音克隆样本文件不存在")

    guessed_mime = mime_type or mimetypes.guess_type(sample_path)[0] or "audio/wav"
    with open(sample_path, "rb") as sample_file:
        sample_b64 = base64.b64encode(sample_file.read()).decode("ascii")

    payload = {
        "model": model,
        "messages": [{"role": "assistant", "content": content}],
        "audio": {
            "format": "wav",
            "voice": f"data:{guessed_mime};base64,{sample_b64}",
        },
    }
    headers = {"api-key": api_key, "Content-Type": "application/json"}

    logger.info("MIMO voice clone TTS API call: model=%s, sample_mime=%s, text_len=%d", model, guessed_mime, len(text))

    async with httpx.AsyncClient(timeout=90.0) as client:
        response = await client.post(
            "https://api.xiaomimimo.com/v1/chat/completions",
            json=payload,
            headers=headers,
        )
        if response.status_code != 200:
            logger.error("MIMO voice clone API error: status=%s", response.status_code)
        response.raise_for_status()
        result = response.json()

    return _decode_mimo_audio(result)


def _decode_mimo_audio(result: dict) -> bytes:
    choices = result.get("choices", [])
    if not choices:
        raise ValueError("MIMO TTS API returned no choices")

    message = choices[0].get("message", {})
    audio_data = message.get("audio", {})
    audio_b64 = audio_data.get("data", "")

    if not audio_b64:
        raise ValueError("MIMO TTS API returned no audio data")

    return base64.b64decode(audio_b64)


async def _call_custom_api_tts(
    text: str,
    voice_id: str,
    base_url: str,
    api_key: str,
    model: str = "tts-1",
) -> Tuple[bytes, Optional[str]]:
    """调用自定义 TTS API，返回 (音频字节, 上游 Content-Type)。

    此前丢弃上游 Content-Type 只回字节，调用方被迫硬编码声明类型——
    上游给 WAV、声明 MP3，Safari/iOS 直接失声。
    """
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload = {"model": model, "input": text, "voice": voice_id}
    safe_base_url = _validate_custom_tts_base_url(base_url)

    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(safe_base_url, json=payload, headers=headers)
        response.raise_for_status()
        return response.content, response.headers.get("content-type")


async def _synthesize_edge(text: str, voice: str = "zh-CN-XiaoxiaoNeural") -> bytes:
    """使用 edge-tts 库生成音频（MP3 格式）。"""
    try:
        import edge_tts
    except ImportError:
        raise ValueError("edge-tts 未安装，请运行 pip install edge-tts")
    communicate = edge_tts.Communicate(text, voice)
    audio_data = b""
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            audio_data += chunk["data"]
    if not audio_data:
        raise ValueError("edge-tts 未返回音频数据")
    return audio_data


async def _synthesize_elevenlabs(text: str, voice: str, api_key: str, model: str = "eleven_multilingual_v2") -> bytes:
    """通过 ElevenLabs API 生成音频。"""
    if not api_key:
        raise ValueError("ElevenLabs API Key 未配置")
    if not voice:
        voice = "21m00Tcm4TlvDq8ikWAM"
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice}"
    headers = {"xi-api-key": api_key, "Content-Type": "application/json"}
    payload = {
        "text": text,
        "model_id": model,
        "voice_settings": {"stability": 0.5, "similarity_boost": 0.5},
    }
    logger.info("ElevenLabs TTS API call: voice=%s, model=%s, text_len=%d", voice, model, len(text))
    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(url, json=payload, headers=headers)
        if response.status_code != 200:
            logger.error("ElevenLabs API error: status=%s, body=%s", response.status_code, response.text[:500])
        response.raise_for_status()
        return response.content


async def _synthesize_coqui(text: str, voice: str, server_url: str, language_id: str = "") -> bytes:
    """通过 Coqui TTS 服务器生成音频。

    审计（2026-09-25）实锤两处必踩坑：① XTTS 多语模型缺 ``language_id``
    直接报错（此前从不传）；② 内置音色 "default" 被原样当 ``speaker_id``
    发送，而真实服务器没有叫 "default" 的说话人——空或 "default" 一律
    不传，让服务器用自身默认说话人。
    """
    if not server_url:
        raise ValueError("Coqui TTS 服务器地址未配置")
    normalized = server_url.rstrip("/")
    if not _is_public_http_url(normalized) and not allow_internal_service_urls():
        raise ValueError("Coqui TTS 服务器地址必须是公网 http(s) 地址（本地服务请设 ALLOW_INTERNAL_SERVICE_URLS=true）")
    url = f"{normalized}/api/tts"
    params = {"text": text}
    speaker = (voice or "").strip()
    if speaker and speaker != "default":
        params["speaker_id"] = speaker
    params["language_id"] = (language_id or "").strip() or "en"
    logger.info("Coqui TTS API call: server=%s, speaker=%s, language=%s, text_len=%d", normalized, speaker or "<server default>", params["language_id"], len(text))
    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.get(url, params=params)
        if response.status_code != 200:
            logger.error("Coqui TTS API error: status=%s", response.status_code)
        response.raise_for_status()
        return response.content


# ============================================================
# TTSService 主类
# ============================================================

class TTSService:
    def __init__(self):
        self.voice_configs = {}

    def get_user_voice_config(self, user_id: int) -> Dict:
        return self.voice_configs.get(user_id, {"gender": DEFAULT_VOICE_GENDER})

    def set_user_voice_config(self, user_id: int, voice_id: str = "", gender: str = "female"):
        self.voice_configs[user_id] = {"voice_id": voice_id, "gender": gender}

    def validate_role(self, role: Optional[str], is_narrator: bool = False) -> str:
        resolved = role or ("narrator" if is_narrator else "character")
        if resolved not in VALID_ROLES:
            raise ValueError(f"Invalid TTS role: {resolved}")
        return resolved

    def get_explicit_binding(
        self,
        db: Session,
        user_id: Optional[int],
        role: str,
        scope: str,
        character_id: Optional[str] = None,
    ) -> Optional[TTSVoiceBinding]:
        query = db.query(TTSVoiceBinding).filter(
            TTSVoiceBinding.scope == scope,
            TTSVoiceBinding.role == role,
        )
        if scope == "global":
            query = query.filter(TTSVoiceBinding.user_id.is_(None), TTSVoiceBinding.character_id.is_(None))
        elif scope == "user":
            query = query.filter(TTSVoiceBinding.user_id == user_id, TTSVoiceBinding.character_id.is_(None))
        elif scope == "character":
            query = query.filter(TTSVoiceBinding.user_id == user_id, TTSVoiceBinding.character_id == character_id)
        else:
            raise ValueError(f"Invalid TTS binding scope: {scope}")
        return query.order_by(TTSVoiceBinding.updated_at.desc()).first()

    def upsert_binding(
        self,
        db: Session,
        role: str,
        scope: str,
        user_id: Optional[int] = None,
        character_id: Optional[str] = None,
        provider_id: Optional[str] = None,
        voice_id: Optional[str] = None,
        gender: Optional[str] = None,
        clone_sample_id: Optional[str] = None,
        speed: float = 1.0,
        volume: float = 1.0,
        enabled: bool = True,
    ) -> TTSVoiceBinding:
        role = self.validate_role(role)
        if scope not in VALID_SCOPES:
            raise ValueError(f"Invalid TTS binding scope: {scope}")
        binding = self.get_explicit_binding(db, user_id, role, scope, character_id)
        if not binding:
            binding = TTSVoiceBinding(scope=scope, user_id=user_id, character_id=character_id, role=role)
            db.add(binding)
        binding.provider_id = provider_id
        binding.voice_id = voice_id
        binding.gender = gender
        binding.clone_sample_id = clone_sample_id
        binding.speed = speed
        binding.volume = volume
        binding.enabled = enabled
        return binding

    def clear_binding(
        self,
        db: Session,
        role: str,
        scope: str,
        user_id: Optional[int] = None,
        character_id: Optional[str] = None,
    ) -> bool:
        binding = self.get_explicit_binding(db, user_id, self.validate_role(role), scope, character_id)
        if not binding:
            return False
        db.delete(binding)
        return True

    def ensure_global_defaults(self, db: Session) -> None:
        config = _get_raw_config()
        for role in ("character", "narrator"):
            existing = self.get_explicit_binding(db, None, role, "global")
            if existing:
                continue
            gender = config.get("default_voice_gender", DEFAULT_VOICE_GENDER)
            provider_id = config.get("active_provider_id", "browser")
            voice_id = config.get("default_voice_id", "") or _resolve_voice_for_provider(provider_id, gender)
            db.add(TTSVoiceBinding(
                scope="global",
                role=role,
                provider_id=provider_id,
                voice_id=voice_id,
                gender=gender,
                enabled=True,
            ))
        db.flush()

    def resolve_voice_binding(
        self,
        db: Optional[Session],
        user: Optional[User],
        role: str = "character",
        character_id: Optional[str] = None,
        voice_description: Optional[str] = None,
        override: Optional[Dict] = None,
        user_voice_config: Optional[Dict] = None,
    ) -> Dict:
        role = self.validate_role(role)
        config = _get_raw_config()
        if config.get("enabled") is False:
            raise ValueError("TTS 已禁用")

        parsed = parse_voice_description(voice_description or "")
        default_gender = parsed.get("gender") if voice_description else config.get("default_voice_gender", DEFAULT_VOICE_GENDER)
        provider_id = config.get("active_provider_id", "browser")
        voice_id = config.get("default_voice_id", "")
        clone_sample_id = None
        speed = 1.0
        volume = 1.0
        source = "legacy"

        if user_voice_config:
            if user_voice_config.get("gender"):
                default_gender = user_voice_config["gender"]
            if user_voice_config.get("voice_id"):
                voice_id = user_voice_config["voice_id"]
                source = "legacy_user"

        binding = None
        if db is not None and user is not None:
            self.ensure_global_defaults(db)
            if character_id:
                character = db.query(Character).filter(Character.id == character_id, Character.user_id == user.id).first()
                if character:
                    binding = self.get_explicit_binding(db, user.id, role, "character", character_id)
            if not binding:
                binding = self.get_explicit_binding(db, user.id, role, "user")
            if not binding:
                binding = self.get_explicit_binding(db, None, role, "global")

        if binding:
            if not binding.enabled:
                raise ValueError("该语音绑定已禁用")
            provider_id = binding.provider_id or provider_id
            voice_id = binding.voice_id or ""
            default_gender = binding.gender or default_gender
            clone_sample_id = binding.clone_sample_id
            speed = binding.speed if binding.speed is not None else 1.0
            volume = binding.volume if binding.volume is not None else 1.0
            source = binding.scope

        if override:
            provider_id = override.get("provider_id") or provider_id
            voice_id = override.get("voice_id") or voice_id
            default_gender = override.get("gender") or default_gender
            clone_sample_id = override.get("clone_sample_id") or clone_sample_id
            speed = float(override["speed"]) if override.get("speed") is not None else speed
            volume = float(override["volume"]) if override.get("volume") is not None else volume
            source = "override"

        if not voice_id and not clone_sample_id:
            voice_id = _resolve_voice_for_provider(provider_id, default_gender) or ""

        provider = _get_provider(provider_id, config) or _get_provider("browser", config) or BUILTIN_PROVIDERS[0]
        if not _get_provider(provider_id, config):
            provider_id = provider.get("id", "browser")

        return {
            "provider_id": provider_id,
            "provider": provider,
            "engine_type": provider.get("engine_type", "browser"),
            "voice_id": voice_id,
            "gender": default_gender,
            "clone_sample_id": clone_sample_id,
            "speed": speed,
            "volume": volume,
            "style": " ".join(parsed.get("tags", [])) if voice_description else None,
            "role": role,
            "source": source,
        }

    def synthesize(
        self,
        text: str,
        voice_description: Optional[str] = None,
        user_voice_config: Optional[Dict] = None,
        is_narrator: bool = False,
        db: Optional[Session] = None,
        user: Optional[User] = None,
        role: Optional[str] = None,
        character_id: Optional[str] = None,
        binding_override: Optional[Dict] = None,
    ) -> Dict:
        if not text:
            raise ValueError("Text cannot be empty")

        resolved_role = self.validate_role(role, is_narrator)
        binding = self.resolve_voice_binding(
            db=db,
            user=user,
            role=resolved_role,
            character_id=character_id,
            voice_description=voice_description,
            override=binding_override,
            user_voice_config=user_voice_config,
        )
        tts_text, is_dialogue = extract_dialogue_for_tts(text)

        return {
            "text": tts_text,
            "voice_id": binding["voice_id"],
            "gender": binding["gender"],
            "provider_id": binding["provider_id"],
            "engine_type": binding["engine_type"],
            "is_dialogue": is_dialogue,
            "is_narrator": resolved_role == "narrator",
            "role": resolved_role,
            "clone_sample_id": binding.get("clone_sample_id"),
            "speed": binding["speed"],
            "volume": binding["volume"],
            "style": binding.get("style"),
        }

    async def synthesize_audio(
        self,
        text: str,
        voice_description: Optional[str] = None,
        user_voice_config: Optional[Dict] = None,
        is_narrator: bool = False,
        db: Optional[Session] = None,
        user: Optional[User] = None,
        role: Optional[str] = None,
        character_id: Optional[str] = None,
        binding_override: Optional[Dict] = None,
    ) -> Tuple[str, bytes]:
        params = self.synthesize(
            text=text,
            voice_description=voice_description,
            user_voice_config=user_voice_config,
            is_narrator=is_narrator,
            db=db,
            user=user,
            role=role,
            character_id=character_id,
            binding_override=binding_override,
        )

        tts_text = params["text"]
        if not tts_text:
            raise ValueError("No text to synthesize after extraction")

        config = _get_raw_config()
        provider = _get_provider(params["provider_id"], config)
        if not provider:
            raise ValueError(f"服务商 '{params['provider_id']}' 不存在")
        engine_type = provider.get("engine_type", "browser")
        pconfig = _provider_config(provider, config)

        if params.get("clone_sample_id"):
            return await self._synthesize_clone_audio(params, pconfig, tts_text, user, db)

        if engine_type == "xiaomi_mimo":
            api_key = pconfig.get("api_key", "")
            model = pconfig.get("model", "mimo-v2.5-tts")
            if not api_key:
                raise ValueError("小米 MIMO TTS API Key 未配置，请在模型管理→语音中设置")
            audio_bytes = await _call_xiaomi_mimo_tts(
                text=tts_text,
                voice_id=params["voice_id"] or "冰糖",
                api_key=api_key,
                model=model,
                style=params.get("style"),
            )
            return "audio/wav", audio_bytes

        if engine_type == "custom_api":
            base_url = pconfig.get("base_url", "")
            api_key = pconfig.get("api_key", "")
            model = pconfig.get("model", "tts-1")
            if not base_url:
                raise ValueError("自定义 TTS API 地址未配置")
            if not api_key:
                raise ValueError("自定义 TTS API Key 未配置")
            audio_bytes, upstream_type = await _call_custom_api_tts(
                text=tts_text,
                voice_id=params["voice_id"] or "alloy",
                base_url=base_url,
                api_key=api_key,
                model=model,
            )
            # 此前恒声明 audio/mpeg：上游回 WAV 时 Safari/iOS 解码失败失声。
            # 现按上游 Content-Type / 魔数声明真实类型。
            return resolve_audio_mime(upstream_type, audio_bytes), audio_bytes

        if engine_type == "edge":
            voice_id = params["voice_id"] or "zh-CN-XiaoxiaoNeural"
            audio_bytes = await _synthesize_edge(text=tts_text, voice=voice_id)
            return "audio/mpeg", audio_bytes

        if engine_type == "elevenlabs":
            api_key = pconfig.get("api_key", "")
            model = pconfig.get("model", "eleven_multilingual_v2")
            if not api_key:
                raise ValueError("ElevenLabs API Key 未配置，请在模型管理→语音中设置")
            voice_id = params["voice_id"] or "21m00Tcm4TlvDq8ikWAM"
            audio_bytes = await _synthesize_elevenlabs(
                text=tts_text,
                voice=voice_id,
                api_key=api_key,
                model=model,
            )
            return "audio/mpeg", audio_bytes

        if engine_type == "coqui":
            server_url = pconfig.get("base_url", "")
            if not server_url:
                raise ValueError("Coqui TTS 服务器地址未配置")
            voice_id = params["voice_id"] or pconfig.get("speaker_id", "")
            audio_bytes = await _synthesize_coqui(
                text=tts_text,
                voice=voice_id,
                server_url=server_url,
                language_id=pconfig.get("language_id", ""),
            )
            return "audio/wav", audio_bytes

        raise ValueError(f"服务商 '{params['provider_id']}' 不支持后端音频生成，请使用浏览器内置播放")

    async def _synthesize_clone_audio(
        self,
        params: Dict,
        pconfig: dict,
        tts_text: str,
        user: Optional[User],
        db: Optional[Session],
    ) -> Tuple[str, bytes]:
        if not user or db is None:
            raise ValueError("声音克隆需要登录用户上下文")
        provider = _get_provider(params["provider_id"])
        if not provider or provider.get("engine_type") != "xiaomi_mimo":
            raise ValueError("当前服务商不支持声音克隆")
        sample = db.query(TTSCloneSample).filter(
            TTSCloneSample.id == params["clone_sample_id"],
            TTSCloneSample.user_id == user.id,
        ).first()
        if not sample:
            raise ValueError("声音克隆样本不存在或无权访问")
        sample_path = os.path.realpath(sample.file_path)
        from ..core.config import settings
        sample_root = os.path.realpath(os.path.join(settings.UPLOAD_DIR, str(user.id), "tts_clones"))
        if not (sample_path == sample_root or sample_path.startswith(sample_root + os.sep)):
            raise ValueError("声音克隆样本路径无效")
        api_key = pconfig.get("api_key", "")
        raw_model = pconfig.get("voiceclone_model") or pconfig.get("clone_model") or ""
        model = raw_model.strip() if isinstance(raw_model, str) else ""
        if not model:
            model = "mimo-v2.5-tts-voiceclone"
        if not api_key:
            raise ValueError("小米 MIMO TTS API Key 未配置，请在模型管理→语音中设置")
        audio_bytes = await _call_xiaomi_mimo_voiceclone_tts(
            text=tts_text,
            sample_path=sample_path,
            api_key=api_key,
            model=model,
            mime_type=sample.mime_type,
            style=params.get("style"),
        )
        return "audio/wav", audio_bytes



tts_service = TTSService()
