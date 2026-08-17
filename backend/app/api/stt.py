"""
STT 语音识别 API
接受 multipart/form-data 音频 Blob，返回 {text: string}

部署提示：浏览器 getUserMedia（麦克风访问）要求 HTTPS 环境（localhost 除外）。
若通过非 HTTPS 反向代理访问本端点，前端将无法获取麦克风权限。
参见：https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
"""
import logging
import os

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from typing import Optional

from .dependencies import get_current_user
from ..models import User
from ..services.stt_service import stt_service

router = APIRouter(prefix="/api", tags=["speech-to-text"])
logger = logging.getLogger(__name__)

MAX_STT_AUDIO_BYTES = 25 * 1024 * 1024  # 25MB
UPLOAD_READ_CHUNK_BYTES = 1024 * 1024
ALLOWED_STT_EXTENSIONS = {".webm", ".wav", ".mp3", ".ogg", ".m4a"}


async def _read_upload_with_limit(file: UploadFile, max_bytes: int) -> bytes:
    chunks = []
    total = 0
    while True:
        chunk = await file.read(UPLOAD_READ_CHUNK_BYTES)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(status_code=413, detail="音频文件过大（最大 25MB）")
        chunks.append(chunk)
    return b"".join(chunks)


@router.post("/stt")
async def transcribe_audio(
    file: UploadFile = File(...),
    language: Optional[str] = Form("zh"),
    current_user: User = Depends(get_current_user),
):
    """ST 1.18.0 兼容端点：接受 form-encoded 音频 Blob，返回转录文本"""
    if not stt_service.is_available():
        raise HTTPException(
            status_code=503,
            detail="语音识别服务不可用：faster-whisper 未安装",
        )

    original_name = file.filename or "audio.webm"
    extension = os.path.splitext(original_name)[1].lower()
    # 扩展名缺失时（前端 Blob 可能无文件名），放行交由魔术字节探测处理
    if extension and extension not in ALLOWED_STT_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的音频格式: {extension or '[none]'}",
        )

    audio_bytes = await _read_upload_with_limit(file, MAX_STT_AUDIO_BYTES)
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="空音频文件不可转录")

    lang = (language or "zh").strip() or "zh"

    try:
        text = stt_service.transcribe(audio_bytes, language=lang)
    except RuntimeError as e:
        logger.exception("STT 转录失败")
        raise HTTPException(status_code=500, detail=str(e))
    except Exception:
        logger.exception("STT 转录失败")
        raise HTTPException(status_code=500, detail="语音识别失败")

    return {"text": text}
