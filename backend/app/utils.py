import base64
import ipaddress
import logging
import mimetypes
import os
import re
import socket
import uuid
from typing import Optional

from fastapi import HTTPException

from .core import settings

logger = logging.getLogger(__name__)


def normalize_image_url(img_url: str, check_size: bool = False, user_id: Optional[int] = None) -> str:
    if not isinstance(img_url, str) or not img_url.strip():
        if check_size:
            raise HTTPException(status_code=400, detail="Invalid image URL")
        return img_url

    normalized = img_url.strip()
    if not normalized:
        if check_size:
            raise HTTPException(status_code=400, detail="Invalid image URL")
        return img_url

    if normalized.startswith("data:image"):
        return normalized

    upload_prefix = None
    if normalized.startswith("/api/uploads/"):
        upload_prefix = "/api/uploads/"
    elif normalized.startswith("/uploads/"):
        upload_prefix = "/uploads/"

    if upload_prefix:
        relative_path = normalized.split(upload_prefix, 1)[1]
        relative_path = relative_path.split("?", 1)[0].split("#", 1)[0]
        normalized_relative = os.path.normpath(relative_path).replace("\\", "/").lstrip("/")
        if not normalized_relative or normalized_relative.startswith("../"):
            if check_size:
                raise HTTPException(status_code=400, detail="Invalid uploaded image path")
            return img_url

        upload_root = os.path.abspath(settings.UPLOAD_DIR)
        file_path = os.path.abspath(os.path.join(upload_root, normalized_relative))
        if os.path.commonpath([upload_root, file_path]) != upload_root:
            if check_size:
                raise HTTPException(status_code=400, detail="Invalid uploaded image path")
            return img_url

        if user_id is not None:
            user_dir = os.path.abspath(os.path.join(upload_root, str(user_id)))
            if not (file_path == user_dir or file_path.startswith(user_dir + os.sep)):
                if check_size:
                    raise HTTPException(status_code=403, detail="Image does not belong to current user")
                return img_url

        if not os.path.exists(file_path):
            if check_size:
                raise HTTPException(status_code=404, detail="Uploaded image not found")
            return img_url

        if check_size:
            file_size = os.path.getsize(file_path)
            if file_size > 10 * 1024 * 1024:
                raise HTTPException(status_code=413, detail="Image too large (max 10MB)")

        mime_type, _ = mimetypes.guess_type(file_path)
        if not mime_type or not mime_type.startswith("image/"):
            mime_type = "image/png"

        with open(file_path, "rb") as f:
            encoded = base64.b64encode(f.read()).decode("ascii")

        return f"data:{mime_type};base64,{encoded}"

    if check_size:
        if not _is_public_http_url(normalized):
            raise HTTPException(status_code=400, detail="Only public http(s) image URLs are allowed")

    if normalized.startswith("http://") or normalized.startswith("https://"):
        return normalized

    return img_url


def _is_public_http_url(url: str) -> bool:
    from urllib.parse import urlparse
    try:
        parsed = urlparse(url)
    except Exception:
        return False

    if parsed.scheme not in ("http", "https"):
        return False

    host = parsed.hostname
    if not host:
        return False

    lowered_host = host.lower()
    if lowered_host in {"localhost", "127.0.0.1", "0.0.0.0", "::1", "[::]", "0:0:0:0:0:0:0:1", "0:0:0:0:0:0:0:0"} or lowered_host.endswith(".local"):
        return False

    def _is_private_or_local_ip(ip_str: str) -> bool:
        try:
            ip_obj = ipaddress.ip_address(ip_str)
            return (
                ip_obj.is_private
                or ip_obj.is_loopback
                or ip_obj.is_link_local
                or ip_obj.is_multicast
                or ip_obj.is_reserved
                or ip_obj.is_unspecified
                or _is_carrier_grade_nat(ip_obj)
            )
        except ValueError:
            return False

    def _is_carrier_grade_nat(ip_obj) -> bool:
        try:
            return ip_obj in ipaddress.ip_network("100.64.0.0/10")
        except Exception:
            return False

    if _is_private_or_local_ip(host):
        return False

    try:
        target_port = parsed.port or (443 if parsed.scheme == "https" else 80)
        addr_info = socket.getaddrinfo(host, target_port, proto=socket.IPPROTO_TCP)
    except Exception:
        return False

    for info in addr_info:
        ip_addr = info[4][0]
        if _is_private_or_local_ip(ip_addr):
            return False

    return True


def build_memory_context(memory_ctx) -> str:
    parts = []
    if memory_ctx.user_profile and memory_ctx.user_profile.summary:
        parts.append(f"[User Profile]\n{memory_ctx.user_profile.summary}")
    if memory_ctx.memories:
        mem_lines = []
        for mem in memory_ctx.memories:
            prefix = "User" if mem.role == "user" else "Assistant"
            mem_lines.append(f"- {prefix}: {mem.content[:200]}")
        if mem_lines:
            parts.append("[Relevant Memories]\n" + "\n".join(mem_lines))
    return "\n\n".join(parts)


def normalize_upload_filename(filename: Optional[str]) -> str:
    raw = (filename or "").strip()
    raw = raw.replace("\x00", "")
    raw = raw.replace("../", "").replace("..\\", "")
    base_name = os.path.basename(raw)
    cleaned = re.sub(r"[\x00-\x1f\x7f]", "", base_name)
    cleaned = re.sub(r"[^\w.\- ()\[\]]", "_", cleaned)
    cleaned = cleaned.strip(" .")
    if not cleaned or cleaned in {".", ".."}:
        cleaned = f"upload_{uuid.uuid4().hex}.bin"
    name_part, ext_part = os.path.splitext(cleaned)
    while True:
        inner_ext = os.path.splitext(name_part)[1].lower()
        if inner_ext and inner_ext in _DANGEROUS_EXTENSIONS:
            name_part = os.path.splitext(name_part)[0]
        else:
            break
    cleaned = name_part + ext_part
    max_name_len = 255
    if len(cleaned) > max_name_len:
        name_part, ext_part = os.path.splitext(cleaned)
        name_part = name_part[: max_name_len - len(ext_part)]
        cleaned = name_part + ext_part
    return cleaned


_DANGEROUS_EXTENSIONS = {
    ".php", ".php3", ".php4", ".php5", ".phtml",
    ".jsp", ".jspx", ".asp", ".aspx",
    ".exe", ".dll", ".bat", ".cmd", ".com", ".msi", ".scr",
    ".ps1", ".psm1", ".vbs", ".vbe", ".jse", ".wsf", ".wsh", ".hta",
    ".jar", ".apk", ".cgi", ".pl", ".py", ".rb", ".sh", ".bash",
}

_MAGIC_SIGNATURES = [
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
    (b"%PDF", "application/pdf"),
    (b"PK\x03\x04", "application/zip"),
    (b"Rar!\x1a\x07", "application/vnd.rar"),
    (b"7z\xbc\xaf\x27\x1c", "application/x-7z-compressed"),
    (b"BM", "image/bmp"),
    (b"RIFF", None),
    (b"II*\x00", "image/tiff"),
    (b"MM\x00*", "image/tiff"),
    (b"<?xml", "text/xml"),
]

_COMPATIBLE_MIME_GROUPS = [
    {"image/jpeg", "image/jpg"},
    {"application/zip", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
     "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
     "application/vnd.openxmlformats-officedocument.presentationml.presentation"},
    {"text/plain", "text/csv", "text/html", "text/xml", "application/xml"},
]


def _is_mime_compatible(detected: str, declared: str) -> bool:
    if detected == declared:
        return True
    for group in _COMPATIBLE_MIME_GROUPS:
        if detected in group and declared in group:
            return True
    return False


def get_default_ai_model(db=None) -> str:
    from .services.provider_registry import get_runtime_providers
    from .services.local_model_registry import list_enabled_chat_models
    from fastapi import HTTPException

    providers = get_runtime_providers()
    provider = next((p for p in providers if p.get("is_active") and p.get("models")), None)
    if provider and provider["models"]:
        model_id = provider["models"][0]["id"] if isinstance(provider["models"][0], dict) else provider["models"][0]
        return model_id

    local_models = list_enabled_chat_models()
    if not local_models:
        raise HTTPException(status_code=400, detail="No AI model configured")
    return local_models[0]["id"]
