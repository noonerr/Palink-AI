"""[IMAGE-PROXY] 被阻断图床的图片代理服务（2026-09-27 用户报障）。

背景：生态卡把头像/CG 图库放在 jsDelivr（GitHub CDN），主域 cdn.jsdelivr.net
在大陆网络被阻断（实测 SSL EOF/超时，testingcf 镜像可用）→ 卡里的 <img> 全部
加载失败只剩占位底图。本服务：校验 URL → 按镜像回退下载 → 落盘缓存 → 回源。

安全约束（生成前安全约束，逐条落实）：
- 仅允许 http/https；发请求前校验 host：拒绝 localhost、环回、私有和保留地址
  （utils._is_public_http_url：含 DNS 解析复检）；
- 仅回传图片内容（魔数/content-type 双重校验）；单文件大小上限；
- 仅认证用户可用（端点层依赖）；缓存目录限定在 DATA_DIR/image-proxy-cache 下。
"""

import hashlib
import json
import logging
import os
import re

import httpx

from ..utils import _is_public_http_url

logger = logging.getLogger(__name__)

_MAX_IMAGE_BYTES = 20 * 1024 * 1024  # 单图 20MB 上限
_DOWNLOAD_TIMEOUT = 20.0
_CACHE_DIRNAME = "image-proxy-cache"

# jsDelivr 镜像回退顺序：卡里写的原始域（境外可用）→ 大陆可达镜像 → 其余镜像
_JSDELIVR_MIRROR_ORDER = [
    "cdn.jsdelivr.net",
    "testingcf.jsdelivr.net",
    "fastly.jsdelivr.net",
    "gcore.jsdelivr.net",
]
_JSDELIVR_HOST_RE = re.compile(r"https://([a-z0-9.-]*\.?jsdelivr\.net)/(.+)$", re.I)

# 图片魔数（content-type 可能缺失/撒谎，双校验）
_IMAGE_MAGIC = (
    b"\x89PNG\r\n\x1a\n",  # PNG
    b"\xff\xd8\xff",       # JPEG
    b"GIF87a",             # GIF87a
    b"GIF89a",             # GIF89a
    b"RIFF",               # WebP（RIFF....WEBP）
)


def _looks_like_image(payload: bytes, content_type: str) -> bool:
    if content_type.split(";")[0].strip().lower().startswith("image/"):
        return True
    return any(payload.startswith(magic) for magic in _IMAGE_MAGIC)


def _mirror_variants(url: str) -> list:
    """同一路径的镜像回退列表：URL 原域优先，失败依次换 jsDelivr 镜像。

    非 jsDelivr URL 原样返回单元素列表（不猜镜像）。
    """
    m = _JSDELIVR_HOST_RE.match(url)
    if not m:
        return [url]
    path = m.group(2)
    variants = [f"https://{host}/{path}" for host in _JSDELIVR_MIRROR_ORDER]
    # 若卡里写的本来就不是列表里第一个域（如 testingcf），把原始域排最前
    original_host = m.group(1).lower()
    variants.sort(key=lambda u: 0 if u.startswith(f"https://{original_host}/") else 1)
    return variants


def _cache_paths(url: str) -> tuple:
    key = hashlib.sha256(url.encode("utf-8")).hexdigest()
    from ..core.config import settings
    cache_dir = os.path.join(settings.DATA_DIR, _CACHE_DIRNAME)
    return cache_dir, os.path.join(cache_dir, key), os.path.join(cache_dir, key + ".meta")


def _read_cache(url: str):
    _, body_path, meta_path = _cache_paths(url)
    if not (os.path.exists(body_path) and os.path.exists(meta_path)):
        return None
    try:
        with open(meta_path, "r", encoding="utf-8") as handle:
            meta = json.load(handle)
        with open(body_path, "rb") as handle:
            return handle.read(), meta.get("content_type", "application/octet-stream")
    except (OSError, json.JSONDecodeError):
        return None


def _write_cache(url: str, payload: bytes, content_type: str) -> None:
    cache_dir, body_path, meta_path = _cache_paths(url)
    try:
        os.makedirs(cache_dir, exist_ok=True)
        tmp = body_path + ".tmp"
        with open(tmp, "wb") as handle:
            handle.write(payload)
        os.replace(tmp, body_path)
        with open(meta_path + ".tmp", "w", encoding="utf-8") as handle:
            json.dump({"content_type": content_type}, handle)
        os.replace(meta_path + ".tmp", meta_path)
    except OSError:
        logger.warning("image-proxy 缓存写入失败（非致命）", exc_info=True)


def _validate_proxy_url(url: str) -> None:
    """安全校验：scheme/host/内网地址。违规抛 ValueError。

    图片代理只服务**外部图库**（jsDelivr 等），内网/环回/保留地址一律拒绝
    ——不受 ALLOW_INTERNAL_SERVICE_URLS 影响（放开内网等于开 SSRF 洞打本地服务）。
    """
    if not url or not isinstance(url, str) or len(url) > 2048:
        raise ValueError("无效的图片地址")
    if not re.match(r"^https?://", url, re.I):
        raise ValueError("仅允许 http(s) 图片地址")
    if not _is_public_http_url(url):
        raise ValueError("仅允许公网 http(s) 图片地址")


async def proxy_image_bytes(url: str) -> tuple:
    """下载并缓存图片，返回 (字节, content_type)。所有镜像均失败抛 ValueError/最后异常。"""
    _validate_proxy_url(url)

    cached = _read_cache(url)
    if cached is not None:
        return cached

    last_error: Exception = ValueError("空 URL")
    for candidate in _mirror_variants(url):
        try:
            async with httpx.AsyncClient(timeout=_DOWNLOAD_TIMEOUT, follow_redirects=True) as client:
                resp = await client.get(candidate)
            if resp.status_code != 200:
                last_error = RuntimeError(f"HTTP {resp.status_code}")
                continue
            payload = resp.content
            if not payload or len(payload) > _MAX_IMAGE_BYTES:
                last_error = RuntimeError("图片超出大小限制")
                continue
            content_type = (resp.headers.get("content-type") or "application/octet-stream").split(";")[0].strip()
            if not _looks_like_image(payload, content_type):
                last_error = RuntimeError("响应不是图片")
                continue
            content_type = content_type if content_type.startswith("image/") else "image/png"
            _write_cache(url, payload, content_type)
            return payload, content_type
        except (httpx.HTTPError, OSError) as exc:
            last_error = exc
            continue
    raise last_error
