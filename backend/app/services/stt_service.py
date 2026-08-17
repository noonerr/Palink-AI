"""
STT 语音识别服务
基于 faster-whisper 实现本地语音转文字，支持 CPU/GPU 推理
模型在首次使用时懒加载（首次会从 HuggingFace 下载模型文件）
"""

import logging
import os
import tempfile
import threading
from typing import List, Optional, Tuple

logger = logging.getLogger(__name__)

# 尝试导入 faster-whisper，未安装时降级处理
try:
    from faster_whisper import WhisperModel  # type: ignore

    _FASTER_WHISPER_AVAILABLE = True
except ImportError:
    WhisperModel = None  # type: ignore
    _FASTER_WHISPER_AVAILABLE = False
    logger.warning(
        "faster-whisper 未安装，STT 服务不可用。"
        "请运行 pip install faster-whisper 安装依赖。"
    )


# ============================================================
# 音频格式探测（基于魔术字节）
# ============================================================

# (签名, 扩展名) 列表，用于为临时文件选择正确的扩展名
_AUDIO_SIGNATURES: List[Tuple[bytes, str]] = [
    (b"RIFF", ".wav"),
    (b"ID3", ".mp3"),
    (b"\xff\xfb", ".mp3"),
    (b"\xff\xf3", ".mp3"),
    (b"\xff\xf2", ".mp3"),
    (b"fLaC", ".flac"),
    (b"OggS", ".ogg"),
    (b"\x1a\x45\xdf\xa3", ".webm"),  # EBML，webm/matroska 容器
]


def _detect_audio_suffix(audio_bytes: bytes) -> str:
    """根据魔术字节推断音频文件扩展名，默认返回 .webm（MediaRecorder 默认输出）"""
    if not audio_bytes:
        return ".webm"
    head = audio_bytes[:16]
    for signature, suffix in _AUDIO_SIGNATURES:
        if head.startswith(signature):
            return suffix
    # m4a/mp4 容器：'ftyp' box 位于偏移 4
    if len(head) >= 12 and head[4:8] == b"ftyp":
        return ".m4a"
    return ".webm"


# ============================================================
# STTService 主类（单例）
# ============================================================

class STTService:
    """语音识别服务，单例模式以避免重复加载模型"""

    _instance: Optional["STTService"] = None
    _lock = threading.Lock()

    def __new__(cls, *args, **kwargs):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self):
        if getattr(self, "_initialized", False):
            return
        self._initialized = True
        self._model: Optional["WhisperModel"] = None
        self._model_lock = threading.Lock()
        # 配置项可由环境变量覆盖
        self.model_size: str = os.environ.get("STT_MODEL_SIZE", "base")
        self.device: str = os.environ.get("STT_DEVICE", "cpu")
        self.compute_type: str = os.environ.get("STT_COMPUTE_TYPE", "int8")
        self._load_error: Optional[str] = None

    def is_available(self) -> bool:
        """STT 服务是否可用（faster-whisper 已安装）"""
        return _FASTER_WHISPER_AVAILABLE

    def _get_model(self) -> "WhisperModel":
        """懒加载 Whisper 模型（线程安全，仅加载一次）"""
        if not _FASTER_WHISPER_AVAILABLE:
            raise RuntimeError(
                "faster-whisper 未安装，STT 服务不可用。请联系管理员安装依赖"
            )
        if self._model is not None:
            return self._model
        with self._model_lock:
            if self._model is not None:
                return self._model
            logger.info(
                "正在加载 Whisper 模型: size=%s, device=%s, compute_type=%s",
                self.model_size, self.device, self.compute_type,
            )
            try:
                self._model = WhisperModel(
                    self.model_size,
                    device=self.device,
                    compute_type=self.compute_type,
                )
                self._load_error = None
                logger.info("Whisper 模型加载完成: %s", self.model_size)
            except Exception as e:
                self._load_error = str(e)
                logger.exception("Whisper 模型加载失败")
                raise
        return self._model

    def transcribe(self, audio_bytes: bytes, language: str = "zh") -> str:
        """
        将音频字节流转写为文本

        参数:
            audio_bytes: 音频二进制数据（支持 webm/wav/mp3/ogg/m4a）
            language: 语言代码，默认 "zh"

        返回:
            转录文本；转录失败返回空字符串

        说明:
            faster-whisper 要求 16kHz 单声道输入。传入文件路径时，
            底层通过 PyAV 自动解码并重采样至 16kHz，因此无需手动转换。
        """
        if not _FASTER_WHISPER_AVAILABLE:
            logger.warning("faster-whisper 未安装，无法转录")
            raise RuntimeError(
                "faster-whisper 未安装，STT 服务不可用。请联系管理员安装依赖"
            )

        if not audio_bytes:
            return ""

        try:
            model = self._get_model()
        except Exception as e:
            # 模型不可用时抛出友好错误，由 API 层捕获转换为 500
            raise RuntimeError(f"语音识别模型加载失败: {e}")

        tmp_path: Optional[str] = None
        try:
            suffix = _detect_audio_suffix(audio_bytes)
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
                tmp.write(audio_bytes)
                tmp_path = tmp.name

            # 传入文件路径，faster-whisper 内部通过 PyAV 解码并重采样至 16kHz 单声道
            segments, _info = model.transcribe(
                tmp_path,
                language=language,
                beam_size=5,
                vad_filter=True,
            )
            text_parts = [segment.text for segment in segments]
            return "".join(text_parts).strip()
        except Exception:
            logger.exception("STT 转录失败")
            return ""
        finally:
            if tmp_path and os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass


stt_service = STTService()
