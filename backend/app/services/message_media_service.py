"""[P1.1] 消息媒体（`extra.media`）契约与读写。

设计依据 SPEC `docs/SPEC_图像生成与语音播放接线_2026-09-23.md`：

- D1：图片是消息的**侧挂数组**，正文 `content` 不再被改写。改写正文有四个必然故障
  （编辑消息丢标记、重复生成堆多份、无法一消息多图、删图要改文本）。
- §6 三条硬约束：
  1. `url` 只存本地路径，绝不存上游 URL（国内服务商链接 24 小时过期）；
  2. `id` 由我方生成，pending 期即存在，用于事件收敛定位；
  3. 字段名与 ST 对齐（`media` / `media_index` / `media_display`），使插件与第一方共用一条写入路径。
- D3：占位用「乐观插入 + 事件收敛」。`pending` 在页面刷新/断线后会悬挂，
  故渲染期需按 `created_at + pending_timeout` 判定为 `failed` —— 只判定、不写库。
"""

from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy.orm import Session

MEDIA_STATUS_PENDING = "pending"
MEDIA_STATUS_READY = "ready"
MEDIA_STATUS_FAILED = "failed"
MEDIA_STATUSES: tuple[str, ...] = (
    MEDIA_STATUS_PENDING,
    MEDIA_STATUS_READY,
    MEDIA_STATUS_FAILED,
)

MEDIA_DISPLAY_INLINE = "inline"
MEDIA_DISPLAY_GALLERY = "gallery"
MEDIA_DISPLAYS: tuple[str, ...] = (MEDIA_DISPLAY_INLINE, MEDIA_DISPLAY_GALLERY)

#: D3 —— `pending` 超过该秒数即视为 `failed`（仅渲染期判定）
PENDING_TIMEOUT_SECONDS = 120

#: 上游未回传尺寸时的兜底比例（避免骨架完成后版面跳动）
DEFAULT_MEDIA_WIDTH = 1024
DEFAULT_MEDIA_HEIGHT = 1024

#: 前端乐观占位生成的 id 形态（`new_media_id` 同款，12 位十六进制）。
#: 采纳客户端 id 是为了「客户端与服务端认同一个 id」——见 normalize_media_id。
_MEDIA_ID_PATTERN = re.compile(r"^m_[0-9a-fA-F]{6,32}$")


def new_media_id() -> str:
    """生成我方自有的媒体 id（pending 期即可用于事件收敛定位）。"""
    return f"m_{uuid.uuid4().hex[:12]}"


def normalize_media_id(raw: Any) -> Optional[str]:
    """采纳调用方（前端）生成的 media id，不合法返回 None。

    为什么允许外部 id：出图是「前端先插占位 → 后端收敛」的两段式，若两边各
    生成一个 id，前端拿不到服务端 id 就只能靠位置/内容猜——失败重试会再插一项，
    数组里堆出永久 failed 的残骸。采纳同一个 id 后，重试即**原位复位**，
    本地占位与落库项天然同源，刷新前后也一致。

    只接受严格形态（`m_` + 6~32 位十六进制），避免任意字符串进入 `extra`。
    """
    if not isinstance(raw, str):
        return None
    candidate = raw.strip()
    return candidate if _MEDIA_ID_PATTERN.match(candidate) else None


def _load_extra(raw: Any) -> dict:
    if isinstance(raw, dict):
        return dict(raw)
    if raw is None or raw == "":
        return {}
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError, ValueError):
        return {}
    return dict(parsed) if isinstance(parsed, dict) else {}


def _dump_extra(extra: dict) -> str:
    return json.dumps(extra, ensure_ascii=False)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _utcnow_iso() -> str:
    return _utcnow().isoformat()


def get_message_extra(message: Any) -> dict:
    """读取消息的 `extra`（始终返回 dict，坏数据降级为空 dict）。"""
    return _load_extra(getattr(message, "extra", None))


def _coerce_dimension(value: Any) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return 0
    return parsed if parsed > 0 else 0


def build_media_item(
    *,
    prompt: str = "",
    width: Any = None,
    height: Any = None,
    provider_id: Optional[str] = None,
    seed: Any = -1,
    media_id: Optional[str] = None,
    status: str = MEDIA_STATUS_PENDING,
) -> dict:
    """构造一条符合 §6 契约的 media 项。

    宽高在 pending 期即写入，骨架据此预留比例，避免完成后 CLS。
    """
    if status not in MEDIA_STATUSES:
        raise ValueError(f"unknown media status: {status}")
    return {
        "id": media_id or new_media_id(),
        "status": status,
        "url": None,
        "width": _coerce_dimension(width) or DEFAULT_MEDIA_WIDTH,
        "height": _coerce_dimension(height) or DEFAULT_MEDIA_HEIGHT,
        "prompt": prompt or "",
        "seed": seed if isinstance(seed, int) else -1,
        "provider_id": provider_id,
        "error": None,
        "created_at": _utcnow_iso(),
    }


def get_message_media(message: Any) -> list[dict]:
    """读取消息的 media 列表（过滤坏项，始终返回 list[dict]）。"""
    extra = get_message_extra(message)
    media = extra.get("media")
    if not isinstance(media, list):
        return []
    return [item for item in media if isinstance(item, dict)]


def attach_message_media(db: Session, message: Any, item: dict) -> dict:
    """把一条 media 追加进 `message.extra.media` 并落库。

    返回写入后的完整 extra，便于调用方直接构造事件载荷。
    """
    extra = get_message_extra(message)
    media = extra.get("media")
    media = [entry for entry in media if isinstance(entry, dict)] if isinstance(media, list) else []
    media.append(item)
    extra["media"] = media
    extra.setdefault("media_index", 0)
    extra.setdefault("media_display", MEDIA_DISPLAY_INLINE)
    message.extra = _dump_extra(extra)
    db.add(message)
    db.commit()
    db.refresh(message)
    return extra


def update_media_status(
    db: Session,
    message: Any,
    media_id: str,
    status: str,
    *,
    url: Optional[str] = None,
    error: Optional[str] = None,
    seed: Optional[int] = None,
    prompt: Optional[str] = None,
    provider_id: Optional[str] = None,
    commit: bool = True,
) -> bool:
    """按 `media_id` 收敛某条 media 的状态。

    返回是否命中（未命中说明该 media 已不在，调用方据此决定是否降级）。
    """
    if status not in MEDIA_STATUSES:
        raise ValueError(f"unknown media status: {status}")
    extra = get_message_extra(message)
    media = extra.get("media")
    if not isinstance(media, list):
        return False

    hit = False
    for entry in media:
        if not isinstance(entry, dict) or entry.get("id") != media_id:
            continue
        entry["status"] = status
        if url is not None:
            entry["url"] = url
        if error is not None:
            entry["error"] = error
        if seed is not None:
            entry["seed"] = seed
        if prompt is not None:
            entry["prompt"] = prompt
        if provider_id is not None:
            entry["provider_id"] = provider_id
        entry["updated_at"] = _utcnow_iso()
        hit = True
        break

    if not hit:
        return False

    extra["media"] = media
    message.extra = _dump_extra(extra)
    db.add(message)
    if commit:
        db.commit()
        db.refresh(message)
    return True


def reset_media_for_retry(
    db: Session,
    message: Any,
    media_id: str,
    *,
    prompt: Optional[str] = None,
    width: Any = None,
    height: Any = None,
    provider_id: Optional[str] = None,
    commit: bool = True,
) -> bool:
    """把一条已存在的 media 复位为 `pending`，供**原位重试**。

    与 `attach_message_media` 的区别：不新增数组项，只把旧项（通常是 `failed`）
    翻回等待态。重试用它、首轮用 attach，数组里就不会堆永久失败的残骸。

    必须刷新 `created_at`：D3 的超时收敛以它为基准，沿用旧值会让重试中的项被
    立刻判成 `failed`（骨架一闪就变失败）。`url` / `error` 一并清空，
    避免上一轮的结果跟到新一轮。返回是否命中。
    """
    extra = get_message_extra(message)
    media = extra.get("media")
    if not isinstance(media, list):
        return False

    hit = False
    for entry in media:
        if not isinstance(entry, dict) or entry.get("id") != media_id:
            continue
        entry["status"] = MEDIA_STATUS_PENDING
        entry["url"] = None
        entry["error"] = None
        if prompt is not None:
            entry["prompt"] = prompt
        if _coerce_dimension(width):
            entry["width"] = _coerce_dimension(width)
        if _coerce_dimension(height):
            entry["height"] = _coerce_dimension(height)
        if provider_id is not None:
            entry["provider_id"] = provider_id
        now = _utcnow_iso()
        entry["created_at"] = now
        entry["updated_at"] = now
        hit = True
        break

    if not hit:
        return False

    extra["media"] = media
    message.extra = _dump_extra(extra)
    db.add(message)
    if commit:
        db.commit()
        db.refresh(message)
    return True


def effective_media_status(
    item: Optional[dict],
    *,
    now: Optional[datetime] = None,
    timeout_seconds: int = PENDING_TIMEOUT_SECONDS,
) -> Optional[str]:
    """渲染期超时收敛：`pending` 且 `created_at` 已超时 → `failed`。

    依据 D3 —— 刷新/断线导致的悬挂由前端渲染时判定，**不写库**。
    """
    if not isinstance(item, dict):
        return None
    status = item.get("status")
    if status != MEDIA_STATUS_PENDING:
        return status
    created_at = item.get("created_at")
    if not created_at:
        return status
    try:
        parsed = datetime.fromisoformat(str(created_at).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return status
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    reference = now or _utcnow()
    if reference - parsed > timedelta(seconds=timeout_seconds):
        return MEDIA_STATUS_FAILED
    return status


def media_for_api(message: Any, *, apply_timeout: bool = True) -> dict:
    """给 API 响应与推送事件用的媒体载荷。

    结构与 `extra` 的三字段保持一致，前端可直接合并进本地消息。
    """
    media = get_message_media(message)
    if apply_timeout:
        media = [
            {**item, "status": effective_media_status(item)}
            for item in media
        ]

    extra = get_message_extra(message)
    index = extra.get("media_index")
    if not isinstance(index, int) or isinstance(index, bool) or not (0 <= index < len(media)):
        index = 0
    display = extra.get("media_display")
    if display not in MEDIA_DISPLAYS:
        display = MEDIA_DISPLAY_INLINE
    return {"media": media, "media_index": index, "media_display": display}


def remove_message_media(db: Session, message: Any, media_id: str) -> bool:
    """移除某条 media（供后续画廊/删除交互使用），返回是否命中。"""
    extra = get_message_extra(message)
    media = extra.get("media")
    if not isinstance(media, list):
        return False
    remaining = [
        entry for entry in media
        if not (isinstance(entry, dict) and entry.get("id") == media_id)
    ]
    if len(remaining) == len(media):
        return False
    extra["media"] = remaining
    index = extra.get("media_index")
    if not isinstance(index, int) or not (0 <= index < len(remaining)):
        extra["media_index"] = 0
    message.extra = _dump_extra(extra)
    db.add(message)
    db.commit()
    db.refresh(message)
    return True
