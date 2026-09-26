"""TTS 音频类型识别与自定义 API 校验回归（AUDIT-2026-09-25）。

背景：custom_api 分支把上游返回的 WAV 字节硬编码声明成 audio/mpeg
（实测确证），Chrome 靠嗅探能播，Safari/iOS 严格按声明解码直接失声。
另覆盖 coqui 参数修复与内网放行开关。
"""

import asyncio
import os
import sys

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import httpx  # noqa: E402
import pytest  # noqa: E402

import app.services.tts_service as tts_module  # noqa: E402
from app.services.tts_service import (  # noqa: E402
    _call_custom_api_tts,
    _synthesize_coqui,
    _validate_custom_tts_base_url,
    audio_mime_ext,
    resolve_audio_mime,
    sniff_audio_mime,
)

# 44 字节最小合法 WAV 头（RIFF....WAVE）
WAV_BYTES = b"RIFF$\x00\x00\x00WAVEfmt " + b"\x00" * 20
MP3_BYTES = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\x00" * 10
OGG_BYTES = b"OggS\x00\x02\x00\x00\x00\x00\x00\x00" + b"\x00" * 10
M4A_BYTES = b"\x00\x00\x00\x20ftypM4A " + b"\x00" * 10


class TestSniffAudioMime:
    def test_wav_magic(self):
        assert sniff_audio_mime(WAV_BYTES) == "audio/wav"

    def test_mp3_id3_magic(self):
        assert sniff_audio_mime(MP3_BYTES) == "audio/mpeg"

    def test_mp3_frame_sync_magic(self):
        assert sniff_audio_mime(b"\xff\xfb\x90\x00" + b"\x00" * 20) == "audio/mpeg"

    def test_ogg_magic(self):
        assert sniff_audio_mime(OGG_BYTES) == "audio/ogg"

    def test_m4a_magic(self):
        assert sniff_audio_mime(M4A_BYTES) == "audio/mp4"

    def test_unknown_falls_back(self):
        assert sniff_audio_mime(b"\x00\x01\x02\x03" + b"\x00" * 20) == "audio/mpeg"
        assert sniff_audio_mime(b"\x00\x01\x02\x03" + b"\x00" * 20, "audio/wav") == "audio/wav"

    def test_empty_falls_back(self):
        assert sniff_audio_mime(b"") == "audio/mpeg"


class TestResolveAudioMime:
    def test_upstream_audio_content_type_wins(self):
        assert resolve_audio_mime("audio/wav", MP3_BYTES) == "audio/wav"

    def test_upstream_charset_params_stripped(self):
        assert resolve_audio_mime("audio/wav; charset=binary", WAV_BYTES) == "audio/wav"

    def test_non_audio_content_type_sniffs_bytes(self):
        # 上游误标 application/octet-stream / text/plain 时按魔数兜底
        assert resolve_audio_mime("application/octet-stream", WAV_BYTES) == "audio/wav"
        assert resolve_audio_mime(None, WAV_BYTES) == "audio/wav"


class TestAudioMimeExt:
    @pytest.mark.parametrize("mime,ext", [
        ("audio/wav", ".wav"),
        ("audio/mpeg", ".mp3"),
        ("audio/ogg", ".ogg"),
        ("audio/flac", ".flac"),
        ("audio/mp4", ".m4a"),
        ("audio/weird", ".mp3"),
    ])
    def test_ext_mapping(self, mime, ext):
        assert audio_mime_ext(mime) == ext


class TestCustomTtsBaseUrlGate:
    def test_internal_rejected_when_gate_closed(self, monkeypatch):
        monkeypatch.setattr(tts_module, "allow_internal_service_urls", lambda: False)
        with pytest.raises(ValueError, match="Only public http\\(s\\) TTS API URLs"):
            _validate_custom_tts_base_url("http://127.0.0.1:8000/v1/audio/speech")

    def test_internal_allowed_when_gate_open(self, monkeypatch):
        monkeypatch.setattr(tts_module, "allow_internal_service_urls", lambda: True)
        normalized = _validate_custom_tts_base_url("http://127.0.0.1:8000/v1/audio/speech")
        assert normalized == "http://127.0.0.1:8000/v1/audio/speech"

    def test_public_always_allowed(self):
        assert _validate_custom_tts_base_url("https://api.example.com/v1/audio/speech")

    def test_empty_passthrough(self):
        assert _validate_custom_tts_base_url("") == ""


class TestCustomApiTtsReturnsUpstreamType:
    def test_returns_content_and_content_type(self, monkeypatch):
        """_call_custom_api_tts 不再丢弃上游 Content-Type。"""

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=WAV_BYTES, headers={"Content-Type": "audio/wav"})

        transport = httpx.MockTransport(handler)
        real_async_client = httpx.AsyncClient

        def factory(**kwargs):
            return real_async_client(transport=transport, **kwargs)

        monkeypatch.setattr(tts_module.httpx, "AsyncClient", factory)
        audio, content_type = asyncio.run(
            _call_custom_api_tts(text="你好", voice_id="alloy", base_url="https://api.example.com/tts", api_key="k")
        )
        assert audio == WAV_BYTES
        assert content_type == "audio/wav"


class TestCoquiParams:
    def _run_coqui(self, monkeypatch, voice, language_id=""):
        captured = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["params"] = dict(request.url.params)
            return httpx.Response(200, content=WAV_BYTES)

        transport = httpx.MockTransport(handler)
        real_async_client = httpx.AsyncClient

        def factory(**kwargs):
            return real_async_client(transport=transport, **kwargs)

        monkeypatch.setattr(tts_module.httpx, "AsyncClient", factory)
        monkeypatch.setattr(tts_module, "allow_internal_service_urls", lambda: True)
        asyncio.run(
            _synthesize_coqui(text="你好", voice=voice, server_url="http://127.0.0.1:5002", language_id=language_id)
        )
        return captured["params"]

    def test_placeholder_default_voice_not_sent_as_speaker(self, monkeypatch):
        """内置音色 "default" 此前被原样当 speaker_id 发送，真实服务器没有该说话人。"""
        params = self._run_coqui(monkeypatch, voice="default")
        assert "speaker_id" not in params
        assert params["language_id"] == "en"

    def test_real_voice_sent_and_language_override(self, monkeypatch):
        params = self._run_coqui(monkeypatch, voice="Claribel Dervla", language_id="zh-cn")
        assert params["speaker_id"] == "Claribel Dervla"
        assert params["language_id"] == "zh-cn"

    def test_internal_url_rejected_when_gate_closed(self, monkeypatch):
        monkeypatch.setattr(tts_module, "allow_internal_service_urls", lambda: False)
        with pytest.raises(ValueError, match="公网"):
            asyncio.run(
                _synthesize_coqui(text="hi", voice="default", server_url="http://127.0.0.1:5002")
            )
