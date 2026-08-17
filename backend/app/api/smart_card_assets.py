import asyncio
import hashlib
import ipaddress
import json
import logging
import mimetypes
import os
import re
import socket
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, urljoin, urlparse, urlunparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse
from PIL import Image, ImageOps, UnidentifiedImageError
from PIL.Image import DecompressionBombError
from pydantic import BaseModel, Field

from ..core import settings
from ..api.dependencies import get_current_user
from ..models import User
from ..utils import _is_public_http_url

router = APIRouter(prefix="/api/smart-card-assets", tags=["smart-card-assets"])
logger = logging.getLogger(__name__)

_MAX_ASSET_SIZE = 12 * 1024 * 1024
_MAX_IMAGE_PIXELS = 24_000_000
_MAX_REDIRECTS = 4
_MAX_PREFETCH_URLS = 48
_PREFETCH_CONCURRENCY = 3
_PREFETCH_SOURCE_TTL_SECONDS = 30 * 60
_CACHE_CONTROL = "private, max-age=86400"
_UI_IMAGE_VARIANT = "ui"
_UI_IMAGE_VARIANT_MAX_SIDE = 1280
_UI_IMAGE_VARIANT_QUALITY = 78
_UI_IMAGE_VARIANT_MIN_SOURCE_BYTES = 180 * 1024
_UI_IMAGE_VARIANT_EXT = ".ui.webp"
_REMOTE_URL_PATTERN = re.compile(r"https?://[^\s'\"`<>),]+", re.IGNORECASE)
_CSS_URL_PATTERN = re.compile(r"url\(\s*(['\"]?)([^'\"\)]+)\1\s*\)", re.IGNORECASE)
_CACHEABLE_ASSET_KINDS = {"image", "style", "font", "script"}
_ALLOWED_IMAGE_TYPES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/avif": ".avif",
    "image/bmp": ".bmp",
    "image/svg+xml": ".svg",
    "image/x-icon": ".ico",
    "image/vnd.microsoft.icon": ".ico",
}
_ALLOWED_STYLE_TYPES = {
    "text/css": ".css",
}
_ALLOWED_SCRIPT_TYPES = {
    "application/javascript": ".js",
    "application/ecmascript": ".js",
    "application/x-javascript": ".js",
    "text/javascript": ".js",
    "text/ecmascript": ".js",
}
_ALLOWED_FONT_TYPES = {
    "font/woff": ".woff",
    "font/woff2": ".woff2",
    "font/ttf": ".ttf",
    "font/otf": ".otf",
    "application/font-woff": ".woff",
    "application/font-woff2": ".woff2",
    "application/vnd.ms-fontobject": ".eot",
}
_cache_locks: dict[str, asyncio.Lock] = {}
_cache_locks_guard = asyncio.Lock()
_prefetch_scheduled_urls: set[str] = set()
_prefetch_scheduled_guard = asyncio.Lock()
_prefetch_source_fingerprints: dict[str, float] = {}
Image.MAX_IMAGE_PIXELS = min(
    Image.MAX_IMAGE_PIXELS or _MAX_IMAGE_PIXELS,
    _MAX_IMAGE_PIXELS,
)


class SmartCardAssetPrefetchRequest(BaseModel):
    urls: list[str] = Field(default_factory=list, max_length=192)


def _normalize_discovered_url(raw_url: str) -> str:
    return (
        str(raw_url or "")
        .strip()
        .replace("\\/", "/")
        .replace("&amp;", "&")
        .rstrip("\\]};,.'\"")
    )


def _looks_like_remote_http_url(url: str) -> bool:
    try:
        parsed = urlparse(url)
    except Exception:
        return False
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return False
    lowered_host = parsed.hostname.lower()
    if lowered_host in {"localhost", "127.0.0.1", "0.0.0.0", "::1"} or lowered_host.endswith(".local"):
        return False
    return True


def _is_blocked_ip_address(ip_address: str) -> bool:
    try:
        ip_obj = ipaddress.ip_address(ip_address)
    except ValueError:
        return True

    return (
        ip_obj.is_private
        or ip_obj.is_loopback
        or ip_obj.is_link_local
        or ip_obj.is_multicast
        or ip_obj.is_reserved
        or ip_obj.is_unspecified
        or ip_obj in ipaddress.ip_network("100.64.0.0/10")
    )


async def _resolve_public_addresses(hostname: str, port: int) -> list[str]:
    def resolve() -> list[str]:
        addr_info = socket.getaddrinfo(hostname, port, proto=socket.IPPROTO_TCP)
        addresses: list[str] = []
        seen: set[str] = set()
        for info in addr_info:
            ip_address = info[4][0]
            if _is_blocked_ip_address(ip_address):
                raise ValueError("Host resolves to a private/internal address")
            if ip_address not in seen:
                seen.add(ip_address)
                addresses.append(ip_address)
        return addresses

    try:
        resolved_addresses = await asyncio.to_thread(resolve)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Only public http(s) asset URLs are allowed") from exc

    if not resolved_addresses:
        raise HTTPException(status_code=400, detail="Only public http(s) asset URLs are allowed")
    return resolved_addresses


async def _validate_public_asset_url(url: str) -> tuple[str, str, int, str]:
    normalized_url = str(url or "").strip()
    if not _is_public_http_url(normalized_url):
        raise HTTPException(status_code=400, detail="Only public http(s) asset URLs are allowed")

    parsed = urlparse(normalized_url)
    if not parsed.hostname or parsed.username or parsed.password:
        raise HTTPException(status_code=400, detail="Only public http(s) asset URLs are allowed")

    try:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Only public http(s) asset URLs are allowed") from exc

    resolved_addresses = await _resolve_public_addresses(parsed.hostname, port)
    return normalized_url, parsed.hostname, port, resolved_addresses[0]


def _build_pinned_url(url: str, resolved_ip: str) -> str:
    parsed = urlparse(url)
    netloc = f"[{resolved_ip}]" if ":" in resolved_ip else resolved_ip
    if parsed.port:
        netloc = f"{netloc}:{parsed.port}"
    return urlunparse(parsed._replace(netloc=netloc))


def _host_header_value(hostname: str, port: int, scheme: str) -> str:
    default_port = 443 if scheme == "https" else 80
    host = f"[{hostname}]" if ":" in hostname else hostname
    return host if port == default_port else f"{host}:{port}"


def _redirect_target(response: httpx.Response, current_url: str) -> str | None:
    if response.status_code not in {301, 302, 303, 307, 308}:
        return None
    location = response.headers.get("location")
    if not location:
        raise HTTPException(status_code=502, detail="Remote asset redirect is missing a location")
    return urljoin(current_url, location)


def _safe_content_length(headers: httpx.Headers) -> int | None:
    content_length = headers.get("content-length")
    if not content_length:
        return None
    try:
        parsed_length = int(content_length)
    except ValueError as exc:
        raise HTTPException(status_code=502, detail="Remote asset sent an invalid content length") from exc
    if parsed_length < 0:
        raise HTTPException(status_code=502, detail="Remote asset sent an invalid content length")
    return parsed_length


def _verify_cached_image(path: Path) -> None:
    if path.suffix.lower() == ".svg":
        return
    try:
        with Image.open(path) as image:
            width, height = image.size
            if width <= 0 or height <= 0 or width * height > _MAX_IMAGE_PIXELS:
                raise HTTPException(status_code=413, detail="Remote image is too large")
            image.verify()
    except HTTPException:
        raise
    except DecompressionBombError as exc:
        raise HTTPException(status_code=413, detail="Remote image is too large") from exc
    except (OSError, UnidentifiedImageError) as exc:
        raise HTTPException(status_code=415, detail="Remote image is not a supported image") from exc


def _is_allowed_asset_request_origin(origin: str | None, request: Request) -> bool:
    if not origin:
        return True

    # P1-1: 智能卡沙箱 iframe 为 opaque-origin（sandbox="allow-scripts" 去掉
    # allow-same-origin 后），资源请求（img/style/font）的 Origin 头为字面量
    # "null"。这是 Palink 自身沙箱发出的受控请求（资源 URL 已由
    # _download_smart_card_asset 的 _classify_cacheable_asset_url 白名单校验），
    # 必须放行，否则卡片图片/字体/样式全部 403。
    if origin == "null":
        return True

    try:
        parsed_origin = urlparse(origin)
    except Exception:
        return False

    if parsed_origin.scheme not in {"http", "https"} or not parsed_origin.hostname:
        return False

    request_hostname = urlparse(f"//{request.headers.get('host', '')}").hostname
    if request_hostname and parsed_origin.hostname.lower() == request_hostname.lower():
        return True

    configured_origins = [
        configured_origin.strip().rstrip("/")
        for configured_origin in (settings.CORS_ORIGINS or "").split(",")
        if configured_origin.strip() and configured_origin.strip() != "*"
    ]
    return origin.rstrip("/") in configured_origins


def _looks_like_image_asset_url(url: str) -> bool:
    try:
        parsed = urlparse(url)
    except Exception:
        return False

    path = parsed.path.lower()
    if os.path.splitext(path)[1] in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico"}:
        return True

    host = (parsed.hostname or "").lower()
    return any(
        token in host
        for token in (
            "postimg",
            "imgur",
            "image",
            "cdn.discordapp",
            "media.discordapp",
            "pinimg",
            # 无扩展名占位图/图片服务：返回合法图片但 URL 不带扩展名，
            # 若不放行会被 415 拒绝（如卡片头像占位图）。
            "picsum",
            "placeholder",
            "placehold.co",
            "loremflickr",
            "unsplash",
            "i.pravatar.cc",
            "avatars.githubusercontent.com",
        )
    )


def _classify_cacheable_asset_url(url: str) -> str | None:
    try:
        parsed = urlparse(url)
    except Exception:
        return None

    path = parsed.path.lower()
    host = (parsed.hostname or "").lower()
    extension = os.path.splitext(path)[1]

    if extension in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico", ".svg"}:
        return "image"
    if extension in {".woff", ".woff2", ".ttf", ".otf", ".eot"} or "fonts.gstatic.com" in host:
        return "font"
    if extension == ".css" or "fonts.googleapis.com" in host or "font-awesome" in url.lower():
        return "style"
    if extension in {".js", ".mjs"} or any(token in host for token in ("jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com")):
        return "script"
    if _looks_like_image_asset_url(url):
        return "image"
    return None


def _looks_like_cacheable_asset_url(url: str) -> bool:
    return _classify_cacheable_asset_url(url) in _CACHEABLE_ASSET_KINDS


def extract_smart_card_asset_urls(source: Any, limit: int = _MAX_PREFETCH_URLS) -> list[str]:
    if source is None:
        return []

    if isinstance(source, str):
        text = source
    else:
        try:
            text = json.dumps(source, ensure_ascii=False, default=str)
        except Exception:
            text = str(source)

    urls: list[str] = []
    seen: set[str] = set()
    for match in _REMOTE_URL_PATTERN.finditer(text):
        url = _normalize_discovered_url(match.group(0))
        if (
            not url
            or url in seen
            or not _looks_like_remote_http_url(url)
            or not _looks_like_cacheable_asset_url(url)
        ):
            continue
        seen.add(url)
        urls.append(url)
        if len(urls) >= limit:
            break
    return urls


def extract_smart_card_image_urls(source: Any, limit: int = _MAX_PREFETCH_URLS) -> list[str]:
    return extract_smart_card_asset_urls(source, limit)


def schedule_smart_card_source_prefetch(source_key: str, source: Any) -> bool:
    if source is None:
        return False

    if isinstance(source, str):
        text = source
    else:
        try:
            text = json.dumps(source, ensure_ascii=False, default=str)
        except Exception:
            text = str(source)

    if "http://" not in text and "https://" not in text:
        return False

    now = time.monotonic()
    if len(_prefetch_source_fingerprints) > 512:
        expired_keys = [
            key
            for key, expires_at in _prefetch_source_fingerprints.items()
            if expires_at <= now
        ]
        for key in expired_keys:
            _prefetch_source_fingerprints.pop(key, None)

    fingerprint = hashlib.sha256(text.encode("utf-8", errors="ignore")).hexdigest()[:20]
    cache_key = f"{source_key}:{fingerprint}"
    expires_at = _prefetch_source_fingerprints.get(cache_key)
    if expires_at and expires_at > now:
        return False

    _prefetch_source_fingerprints[cache_key] = now + _PREFETCH_SOURCE_TTL_SECONDS

    async def prefetch_from_source() -> None:
        try:
            urls = extract_smart_card_image_urls(text)
            if urls:
                await schedule_smart_card_asset_prefetch(urls)
        except Exception as exc:
            logger.debug("Smart card source prefetch failed for %s: %s", source_key, exc)

    asyncio.create_task(prefetch_from_source())
    return True


def _asset_cache_dir() -> Path:
    cache_dir = Path(settings.DATA_DIR) / "smart_card_assets"
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir


def _asset_cache_key(url: str) -> str:
    return hashlib.sha256(url.encode("utf-8")).hexdigest()


def _asset_proxy_url(url: str, variant: str | None = None) -> str:
    variant_param = f"&variant={quote(variant, safe='')}" if variant else ""
    return f"/api/smart-card-assets?url={quote(url, safe='')}{variant_param}"


def _content_type_asset_kind(content_type: str) -> str | None:
    normalized_type = content_type.split(";", 1)[0].strip().lower()
    if normalized_type.startswith("image/") or normalized_type in _ALLOWED_IMAGE_TYPES:
        return "image"
    if normalized_type in _ALLOWED_STYLE_TYPES:
        return "style"
    if normalized_type in _ALLOWED_SCRIPT_TYPES:
        return "script"
    if normalized_type.startswith("font/") or normalized_type in _ALLOWED_FONT_TYPES:
        return "font"
    return None


def _extension_from_content_type(content_type: str, asset_kind: str) -> str | None:
    normalized_type = content_type.split(";", 1)[0].strip().lower()
    if asset_kind == "image" and normalized_type in _ALLOWED_IMAGE_TYPES:
        return _ALLOWED_IMAGE_TYPES[normalized_type]
    if asset_kind == "style" and normalized_type in _ALLOWED_STYLE_TYPES:
        return _ALLOWED_STYLE_TYPES[normalized_type]
    if asset_kind == "script" and normalized_type in _ALLOWED_SCRIPT_TYPES:
        return _ALLOWED_SCRIPT_TYPES[normalized_type]
    if asset_kind == "font" and normalized_type in _ALLOWED_FONT_TYPES:
        return _ALLOWED_FONT_TYPES[normalized_type]
    return None


def _guess_asset_extension(url: str, content_type: str, asset_kind: str) -> str:
    from_content_type = _extension_from_content_type(content_type, asset_kind)
    if from_content_type:
        return from_content_type

    path_ext = os.path.splitext(urlparse(url).path)[1].lower()
    if path_ext in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico", ".svg"}:
        return ".jpg" if path_ext == ".jpeg" else path_ext
    if path_ext in {".css", ".js", ".mjs", ".woff", ".woff2", ".ttf", ".otf", ".eot"}:
        return path_ext

    normalized_type = content_type.split(";", 1)[0].strip().lower()
    guessed = mimetypes.guess_extension(normalized_type)
    if guessed in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico", ".svg"}:
        return ".jpg" if guessed == ".jpeg" else guessed
    if guessed in {".css", ".js", ".mjs", ".woff", ".woff2", ".ttf", ".otf", ".eot"}:
        return guessed

    if asset_kind == "style":
        return ".css"
    if asset_kind == "font":
        return ".woff2"
    return ".img"


def _charset_from_content_type(content_type: str) -> str:
    for part in content_type.split(";")[1:]:
        key, _, value = part.strip().partition("=")
        if key.lower() == "charset" and value.strip():
            return value.strip()
    return "utf-8"


def _resolve_css_asset_url(raw_value: str, base_url: str) -> str | None:
    value = (raw_value or "").strip()
    if not value or value.startswith("#") or re.match(r"^(?:data|blob|javascript|about):", value, re.I):
        return None

    absolute_url = urljoin(base_url, value)
    parsed = urlparse(absolute_url)
    if parsed.path.rstrip("/") == "/api/smart-card-assets":
        proxied_url = parse_qs(parsed.query).get("url", [None])[0]
        if proxied_url:
            return proxied_url

    return absolute_url


def _extract_css_asset_urls(css_text: str, base_url: str, limit: int = _MAX_PREFETCH_URLS) -> list[str]:
    urls: list[str] = []
    seen: set[str] = set()

    for match in _CSS_URL_PATTERN.finditer(css_text or ""):
        asset_url = _resolve_css_asset_url(match.group(2) or "", base_url)
        if (
            not asset_url
            or asset_url in seen
            or not _looks_like_remote_http_url(asset_url)
            or not _looks_like_cacheable_asset_url(asset_url)
        ):
            continue

        seen.add(asset_url)
        urls.append(asset_url)
        if len(urls) >= limit:
            break

    return urls


def _schedule_css_dependency_prefetch(css_text: str, base_url: str) -> None:
    urls = _extract_css_asset_urls(css_text, base_url)
    if urls:
        asyncio.create_task(schedule_smart_card_asset_prefetch(urls))


def _rewrite_css_asset_urls(css_text: str, base_url: str) -> str:
    def replace_url(match: re.Match[str]) -> str:
        quote_char = match.group(1) or ""
        asset_url = _resolve_css_asset_url(match.group(2) or "", base_url)
        if not asset_url:
            return match.group(0)

        if not _looks_like_remote_http_url(asset_url) or not _looks_like_cacheable_asset_url(asset_url):
            return match.group(0)

        variant = _UI_IMAGE_VARIANT if _classify_cacheable_asset_url(asset_url) == "image" else None
        return f"url({quote_char}{_asset_proxy_url(asset_url, variant)}{quote_char})"

    return _CSS_URL_PATTERN.sub(replace_url, css_text)


def _find_cached_asset(cache_dir: Path, key: str) -> Path | None:
    for path in cache_dir.glob(f"{key}.*"):
        if path.is_file() and not path.name.endswith(".tmp"):
            return path
    return None


def _variant_cache_dir(cache_dir: Path) -> Path:
    variant_dir = cache_dir / "variants"
    variant_dir.mkdir(parents=True, exist_ok=True)
    return variant_dir


def _ui_image_variant_path(cache_dir: Path, cache_key: str) -> Path:
    return _variant_cache_dir(cache_dir) / f"{cache_key}{_UI_IMAGE_VARIANT_EXT}"


def _can_create_ui_image_variant(path: Path) -> bool:
    return path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".avif", ".bmp"}


def _needs_ui_image_variant(cache_dir: Path, cache_key: str, source_path: Path) -> bool:
    if not _can_create_ui_image_variant(source_path):
        return False
    if _ui_image_variant_path(cache_dir, cache_key).is_file():
        return False
    try:
        return source_path.stat().st_size >= _UI_IMAGE_VARIANT_MIN_SOURCE_BYTES
    except OSError:
        return False


def _write_ui_image_variant(source_path: Path, variant_path: Path) -> Path | None:
    tmp_path = variant_path.with_name(
        f"{variant_path.stem}.{uuid.uuid4().hex}{variant_path.suffix}.tmp"
    )
    try:
        with Image.open(source_path) as image:
            image = ImageOps.exif_transpose(image)
            has_alpha = image.mode in {"RGBA", "LA"} or (
                image.mode == "P" and "transparency" in image.info
            )
            image = image.convert("RGBA" if has_alpha else "RGB")
            image.thumbnail(
                (_UI_IMAGE_VARIANT_MAX_SIDE, _UI_IMAGE_VARIANT_MAX_SIDE),
                Image.Resampling.LANCZOS,
            )
            image.save(
                tmp_path,
                "WEBP",
                quality=_UI_IMAGE_VARIANT_QUALITY,
                method=4,
            )
        os.replace(tmp_path, variant_path)
        return variant_path
    except (DecompressionBombError, OSError, UnidentifiedImageError) as exc:
        logger.debug("Smart card image variant failed for %s: %s", source_path, exc)
        try:
            tmp_path.unlink()
        except OSError:
            pass
        return None


async def _ensure_ui_image_variant(cache_dir: Path, cache_key: str, source_path: Path) -> tuple[Path, str]:
    if not _can_create_ui_image_variant(source_path):
        return source_path, "variant-bypass"

    try:
        if source_path.stat().st_size < _UI_IMAGE_VARIANT_MIN_SOURCE_BYTES:
            return source_path, "variant-bypass"
    except OSError:
        return source_path, "variant-bypass"

    variant_path = _ui_image_variant_path(cache_dir, cache_key)
    if variant_path.is_file():
        return variant_path, "variant-hit"

    lock = await _get_cache_lock(f"{cache_key}:{_UI_IMAGE_VARIANT}")
    async with lock:
        if variant_path.is_file():
            return variant_path, "variant-hit"

        generated_path = await asyncio.to_thread(
            _write_ui_image_variant,
            source_path,
            variant_path,
        )
        if generated_path and generated_path.is_file():
            return generated_path, "variant-miss"

    return source_path, "variant-failed"


def _media_type_for_path(path: Path) -> str:
    media_type, _ = mimetypes.guess_type(path.name)
    return media_type or "image/png"


def _is_font_asset_path(path: Path) -> bool:
    media_type = _media_type_for_path(path)
    if media_type and media_type.startswith("font/"):
        return True
    ext = path.suffix.lower()
    return ext in {".woff", ".woff2", ".ttf", ".otf", ".eot"}


async def _get_cache_lock(cache_key: str) -> asyncio.Lock:
    async with _cache_locks_guard:
        lock = _cache_locks.get(cache_key)
        if lock is None:
            lock = asyncio.Lock()
            _cache_locks[cache_key] = lock
        return lock


async def _download_smart_card_asset(
    url: str,
    client: httpx.AsyncClient | None = None,
) -> tuple[Path, str]:
    normalized_url, _, _, _ = await _validate_public_asset_url(url)

    requested_kind = _classify_cacheable_asset_url(normalized_url)
    if requested_kind not in _CACHEABLE_ASSET_KINDS:
        raise HTTPException(status_code=415, detail="Remote asset type is not supported")

    cache_dir = _asset_cache_dir()
    cache_key = _asset_cache_key(normalized_url)
    cached_path = _find_cached_asset(cache_dir, cache_key)
    if cached_path:
        if cached_path.suffix.lower() == ".css":
            try:
                css_text = cached_path.read_text(encoding="utf-8", errors="replace")
                _schedule_css_dependency_prefetch(css_text, normalized_url)
            except OSError:
                pass
        return cached_path, "hit"

    lock = await _get_cache_lock(cache_key)
    async with lock:
        cached_path = _find_cached_asset(cache_dir, cache_key)
        if cached_path:
            if cached_path.suffix.lower() == ".css":
                try:
                    css_text = cached_path.read_text(encoding="utf-8", errors="replace")
                    _schedule_css_dependency_prefetch(css_text, normalized_url)
                except OSError:
                    pass
            return cached_path, "hit"

        owns_client = client is None
        if client is None:
            timeout = httpx.Timeout(connect=4.0, read=20.0, write=4.0, pool=4.0)
            limits = httpx.Limits(max_connections=10, max_keepalive_connections=0)
            client = httpx.AsyncClient(follow_redirects=False, timeout=timeout, limits=limits)

        headers = {
            "User-Agent": "Palink-AI SmartCardAssetCache/1.0",
            "Accept": (
                "image/avif,image/webp,image/png,image/jpeg,image/gif,image/*,"
                "text/css,font/woff2,font/woff,*/*;q=0.4"
            ),
            "Connection": "close",
        }

        try:
            current_url = normalized_url
            final_path: Path | None = None
            for redirect_count in range(_MAX_REDIRECTS + 1):
                current_url, hostname, port, resolved_ip = await _validate_public_asset_url(current_url)
                parsed_current_url = urlparse(current_url)
                request_headers = {
                    **headers,
                    "Host": _host_header_value(hostname, port, parsed_current_url.scheme),
                }
                request_extensions = {"sni_hostname": hostname} if parsed_current_url.scheme == "https" else {}
                request_url = _build_pinned_url(current_url, resolved_ip)

                async with client.stream(
                    "GET",
                    request_url,
                    headers=request_headers,
                    extensions=request_extensions,
                    follow_redirects=False,
                ) as response:
                    redirect_url = _redirect_target(response, current_url)
                    if redirect_url:
                        if redirect_count >= _MAX_REDIRECTS:
                            raise HTTPException(status_code=508, detail="Remote asset redirected too many times")
                        current_url = redirect_url
                        continue

                    if response.status_code >= 400:
                        raise HTTPException(status_code=502, detail="Remote asset fetch failed")

                    content_length = _safe_content_length(response.headers)
                    if content_length and content_length > _MAX_ASSET_SIZE:
                        raise HTTPException(status_code=413, detail="Remote asset is too large")

                    content_type_header = response.headers.get("content-type", "")
                    content_type = content_type_header.split(";", 1)[0].strip().lower()
                    generic_content_type = {
                        "",
                        "application/octet-stream",
                        "binary/octet-stream",
                        "text/plain",
                    }
                    content_kind = _content_type_asset_kind(content_type)
                    if content_kind is None and content_type not in generic_content_type:
                        raise HTTPException(status_code=415, detail="Remote asset type is not supported")

                    asset_kind = content_kind or requested_kind or "image"
                    extension = _guess_asset_extension(current_url, content_type, asset_kind)
                    final_path = cache_dir / f"{cache_key}{extension}"
                    tmp_path = cache_dir / f"{cache_key}.{uuid.uuid4().hex}{extension}.tmp"
                    bytes_written = 0

                    with tmp_path.open("wb") as file_handle:
                        if asset_kind == "style":
                            chunks: list[bytes] = []
                            async for chunk in response.aiter_bytes():
                                if not chunk:
                                    continue
                                bytes_written += len(chunk)
                                if bytes_written > _MAX_ASSET_SIZE:
                                    raise HTTPException(status_code=413, detail="Remote asset is too large")
                                chunks.append(chunk)
                            if bytes_written == 0:
                                raise HTTPException(status_code=502, detail="Remote asset is empty")
                            charset = _charset_from_content_type(content_type_header)
                            css_text = b"".join(chunks).decode(charset, errors="replace")
                            _schedule_css_dependency_prefetch(css_text, current_url)
                            rewritten_css = _rewrite_css_asset_urls(css_text, current_url)
                            file_handle.write(rewritten_css.encode("utf-8"))
                            os.replace(tmp_path, final_path)
                            return final_path, "miss"

                        async for chunk in response.aiter_bytes():
                            if not chunk:
                                continue
                            bytes_written += len(chunk)
                            if bytes_written > _MAX_ASSET_SIZE:
                                raise HTTPException(status_code=413, detail="Remote asset is too large")
                            file_handle.write(chunk)

                    if bytes_written == 0:
                        raise HTTPException(status_code=502, detail="Remote asset is empty")

                    if asset_kind == "image":
                        _verify_cached_image(tmp_path)

                    os.replace(tmp_path, final_path)
                    break
            else:
                raise HTTPException(status_code=508, detail="Remote asset redirected too many times")
        except HTTPException:
            for tmp_file in cache_dir.glob(f"{cache_key}.*.tmp"):
                try:
                    tmp_file.unlink()
                except OSError:
                    pass
            raise
        except Exception as exc:
            for tmp_file in cache_dir.glob(f"{cache_key}.*.tmp"):
                try:
                    tmp_file.unlink()
                except OSError:
                    pass
            raise HTTPException(status_code=502, detail=f"Failed to cache smart card asset: {exc}") from exc
        finally:
            if owns_client:
                await client.aclose()

    if final_path is None:
        raise HTTPException(status_code=502, detail="Failed to cache smart card asset")
    return final_path, "miss"


async def _prefetch_smart_card_assets(urls: list[str]) -> None:
    unique_urls: list[str] = []
    seen: set[str] = set()
    for raw_url in urls:
        url = str(raw_url or "").strip()
        if not url or url in seen or not _is_public_http_url(url):
            continue
        seen.add(url)
        unique_urls.append(url)
        if len(unique_urls) >= _MAX_PREFETCH_URLS:
            break

    if not unique_urls:
        return

    timeout = httpx.Timeout(connect=4.0, read=20.0, write=4.0, pool=4.0)
    limits = httpx.Limits(max_connections=_PREFETCH_CONCURRENCY, max_keepalive_connections=0)
    semaphore = asyncio.Semaphore(_PREFETCH_CONCURRENCY)

    async with httpx.AsyncClient(follow_redirects=False, timeout=timeout, limits=limits) as client:
        async def prefetch_one(url: str) -> None:
            try:
                async with semaphore:
                    cached_path, _ = await _download_smart_card_asset(url, client)
                    if _classify_cacheable_asset_url(url) == "image":
                        cache_key = _asset_cache_key(url)
                        await _ensure_ui_image_variant(_asset_cache_dir(), cache_key, cached_path)
            except Exception as exc:
                logger.debug("Smart card asset prefetch failed for %s: %s", url, exc)
            finally:
                async with _prefetch_scheduled_guard:
                    _prefetch_scheduled_urls.discard(url)

        await asyncio.gather(*(prefetch_one(url) for url in unique_urls))


async def schedule_smart_card_asset_prefetch(
    urls: list[str],
) -> dict[str, int]:
    accepted_urls: list[str] = []
    skipped = 0
    cache_dir = _asset_cache_dir()

    async with _prefetch_scheduled_guard:
        for raw_url in urls:
            url = _normalize_discovered_url(raw_url)
            if (
                not url
                or not _is_public_http_url(url)
                or not _looks_like_cacheable_asset_url(url)
            ):
                skipped += 1
                continue

            cache_key = _asset_cache_key(url)
            if url in _prefetch_scheduled_urls:
                skipped += 1
                continue

            cached_path = _find_cached_asset(cache_dir, cache_key)
            if cached_path:
                if (
                    _classify_cacheable_asset_url(url) == "image"
                    and _needs_ui_image_variant(cache_dir, cache_key, cached_path)
                ):
                    _prefetch_scheduled_urls.add(url)
                    accepted_urls.append(url)
                    if len(accepted_urls) >= _MAX_PREFETCH_URLS:
                        break
                    continue
                skipped += 1
                continue

            _prefetch_scheduled_urls.add(url)
            accepted_urls.append(url)
            if len(accepted_urls) >= _MAX_PREFETCH_URLS:
                break

    if accepted_urls:
        asyncio.create_task(_prefetch_smart_card_assets(accepted_urls))

    return {
        "accepted": len(accepted_urls),
        "skipped": skipped,
        "limit": _MAX_PREFETCH_URLS,
    }


@router.get("")
async def get_smart_card_asset(
    request: Request,
    url: str = Query(..., min_length=8, max_length=4096),
    variant: str | None = Query(default=None, max_length=16),
):
    if variant not in {None, _UI_IMAGE_VARIANT}:
        raise HTTPException(status_code=400, detail="Unsupported smart card asset variant")
    if not _is_allowed_asset_request_origin(request.headers.get("origin"), request):
        raise HTTPException(status_code=403, detail="Cross-origin smart card asset requests are not allowed")

    cached_path, cache_status = await _download_smart_card_asset(url)
    response_path = cached_path
    variant_status = "none"

    if variant == _UI_IMAGE_VARIANT and _classify_cacheable_asset_url(url) == "image":
        response_path, variant_status = await _ensure_ui_image_variant(
            _asset_cache_dir(),
            _asset_cache_key(url),
            cached_path,
        )

    origin = request.headers.get("origin")
    headers = {
        "Cache-Control": _CACHE_CONTROL,
        "X-Content-Type-Options": "nosniff",
        "X-Palink-Asset-Cache": cache_status,
        "X-Palink-Asset-Variant": variant_status,
        "Cross-Origin-Resource-Policy": "cross-origin",
    }
    # opaque sandbox（sandbox="allow-scripts"，Origin 头为字面量 "null"）下的
    # 字体请求：CORSMiddleware 无法为其返回 ACAO（生产环境 CORS_ORIGINS 为显式
    # 域名列表 + allow_credentials），导致字体 CORS 失败、浏览器不缓存失败结果，
    # 每次 srcDoc 重建都重新请求字体。字体加载不携带凭证，可安全返回 ACAO: *，
    # 使字体请求成功并进入浏览器缓存（private, max-age=86400）。
    if origin == "null" and _is_font_asset_path(response_path):
        headers["Access-Control-Allow-Origin"] = "*"

    return FileResponse(
        response_path,
        media_type=_media_type_for_path(response_path),
        headers=headers,
    )


@router.post("/prefetch")
async def prefetch_smart_card_assets(
    payload: SmartCardAssetPrefetchRequest,
    _user: User = Depends(get_current_user),
):
    return await schedule_smart_card_asset_prefetch(payload.urls)
