"""开发期留痕端点（包AG · 批次D）—— 只追加，不是产品功能。

背景（用户 2026-10-20 裁决 5 原文）："可以在前端不报错，后端日志记录（我们处于
开发状态，允许后台记录报错自动保存，方便以后查验）。"

因此本模块是**开发期取证管道**，不是面向用户的功能面：
  - 落文件（JSONL 追加），不落库：留痕量小、按天切分后可直接 grep / 直接看；
  - 只追加：**不提供任何删除/覆盖/轮转删除**接口，也绝不在超限时删旧文件
    （`backend/data` 是红线保护区，本端点只新建 `diagnostics/` 子目录）；
  - 单文件有体积上限、单日有行数上限：到顶就**停写**并如实回 `capped=true`，
    让调用方知道"这段没记上"，而不是悄悄丢或悄悄删。

三条硬约束（前端同样实现一遍，这里是服务端的第二道闸）：

1. 鉴权 + CSRF：走既有 `get_current_user`（Bearer 或 `palink_session` Cookie）
   与 `csrf_guard`（纯 Cookie 写请求必须带 `X-CSRF-Token`）。
   ⚠️ 站点注册开关仍开着且公网可达（`docs/OPEN_ISSUES.md` 第 19 条）
   ⇒ 只靠前端闸门不够，所以本模块自己再上**限流 + 体积 + 条数**上限。
2. 只存结构化字段：白名单之外的键一律丢弃。`detail` / `stack` 是**正文可能外溢**
   的字段（用户明令不看自己的卡内容）⇒ 即使客户端发了，也只落 `detailLength`
   与不可逆摘要 `detailHash`，**原文一个字节都不写盘**。
3. 失败必须安静：本端点任何异常都不得让前端弹出错误。前端的实现是"失败静默、
   只试一次"；服务端这边只保证返回结构化状态码/JSON，不抛 500 长栈。

幂等：客户端每批带 `batchId`。同一 `batchId` 重复上传**不重复计数**
（内存里保留最近 N 个已见 batchId；进程重启后去重窗口清空——这是有意的，
开发期留痕不需要跨重启强幂等，重复行本身也可读）。
"""

from __future__ import annotations

import hashlib
import json
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse

from ..core import settings
from ..core.csrf_guard import csrf_guard
from ..models import User
from .dependencies import get_current_user

router = APIRouter(
    prefix="/api/diagnostics",
    tags=["diagnostics"],
    dependencies=[Depends(csrf_guard)],
)

# ── 上限（全部是"防灌盘"而不是"产品配额"）────────────────────────────────
DIAG_MAX_BODY_BYTES = 64 * 1024          # 单请求体上限：一批 100 条结构化记录远小于此
DIAG_MAX_RECORDS_PER_BATCH = 100         # 单请求最多接受条数
DIAG_MAX_FILE_BYTES = 4 * 1024 * 1024    # 单日文件体积上限，到顶停写
DIAG_MAX_LINES_PER_DAY = 20000           # 单日行数上限，到顶停写
DIAG_RATE_LIMIT_REQUESTS = 30            # 每用户每窗口允许的请求数
DIAG_RATE_LIMIT_WINDOW_SECONDS = 60
DIAG_DEDUPE_BATCHES = 512                # 内存里去重窗口大小（最近 N 个 batchId）

# 只允许落盘的结构化字段（顺序即写入顺序，便于人肉 diff）。
# ⛔ 白名单外的键一律丢弃；detail / stack 走长度+摘要通道（见 _sanitize_record）。
DIAG_UPLOAD_FIELDS = (
    "owner",
    "kind",
    "name",
    "count",
    "filename",
    "lineno",
    "colno",
    "missingStSubsystem",
    "frameId",
    "cardId",
    "textLength",
)

# 文本类字段的截断上限（防止单个字段撑爆一行）。
_FIELD_MAX_LEN = {
    "owner": 64,
    "kind": 64,
    "name": 200,
    "filename": 200,
    "missingStSubsystem": 64,
    "frameId": 100,
    "cardId": 100,
}

# 正文可能外溢的字段：只留长度与不可逆摘要，不落原文。
_TEXT_ONLY_FIELDS = ("detail", "stack")

_write_lock = threading.Lock()
_seen_batches: "Dict[str, float]" = {}
_rate_buckets: "Dict[str, List[float]]" = {}
_line_counts: "Dict[str, int]" = {}


def _reset_state_for_test() -> None:
    """测试用：清空内存态（去重窗口 / 限流桶 / 行数缓存）。不碰磁盘。"""
    with _write_lock:
        _seen_batches.clear()
        _rate_buckets.clear()
        _line_counts.clear()


def _records_dir() -> Path:
    """当天留痕目录。每次调用现取 settings.DATA_DIR（测试可 monkeypatch）。"""
    return Path(getattr(settings, "DATA_DIR", "./data")) / "diagnostics"


def _today_name(now: Optional[datetime] = None) -> str:
    day = (now or datetime.now(timezone.utc)).astimezone(timezone.utc).strftime("%Y-%m-%d")
    return f"records-{day}.jsonl"


def _text_digest(text: str) -> Tuple[int, str]:
    """正文的（长度, 不可逆摘要）。摘要用 sha256 前 16 位十六进制，够比对不够还原。"""
    raw = text.encode("utf-8", "replace")
    return len(raw), hashlib.sha256(raw).hexdigest()[:16]


def _sanitize_record(raw: Any) -> Optional[Dict[str, Any]]:
    """把一条客户端记录压成白名单形状；形状不对返回 None（丢弃，不报错）。"""
    if not isinstance(raw, dict):
        return None
    owner = raw.get("owner")
    kind = raw.get("kind")
    if not isinstance(owner, str) or not isinstance(kind, str):
        return None
    if not owner or not kind:
        return None

    out: Dict[str, Any] = {}
    for field in DIAG_UPLOAD_FIELDS:
        value = raw.get(field)
        if field in _FIELD_MAX_LEN:
            out[field] = str(value if value is not None else "")[:_FIELD_MAX_LEN[field]]
            continue
        if field in ("count", "lineno", "colno", "textLength"):
            try:
                num = int(value)
            except (TypeError, ValueError):
                num = -1 if field != "count" else 1
            out[field] = num
            continue
        out[field] = str(value if value is not None else "")

    # ⛔ 正文面：绝不落原文，只落长度 + 摘要（客户端本就不该发，这里是第二道闸）。
    for field in _TEXT_ONLY_FIELDS:
        value = raw.get(field)
        if isinstance(value, str) and value:
            length, digest = _text_digest(value)
            out[f"{field}Length"] = length
            out[f"{field}Hash"] = digest
    return out


def _rate_limited(user_key: str, now: float) -> bool:
    """滑动窗口限流。返回 True = 超限。"""
    window_start = now - DIAG_RATE_LIMIT_WINDOW_SECONDS
    bucket = [ts for ts in _rate_buckets.get(user_key, []) if ts > window_start]
    if len(bucket) >= DIAG_RATE_LIMIT_REQUESTS:
        _rate_buckets[user_key] = bucket
        return True
    bucket.append(now)
    _rate_buckets[user_key] = bucket
    # 桶数有界：太多不同用户时丢掉最老的一半（开发期够用，不追求精确）。
    if len(_rate_buckets) > 2048:
        for key in list(_rate_buckets.keys())[:1024]:
            _rate_buckets.pop(key, None)
    return False


def _count_lines(path: Path) -> int:
    """只在本进程第一次碰这个文件时数一次行数（用于单日行数上限）。"""
    key = str(path)
    cached = _line_counts.get(key)
    if cached is not None:
        return cached
    total = 0
    try:
        with path.open("rb") as handle:
            for _ in handle:
                total += 1
    except FileNotFoundError:
        total = 0
    _line_counts[key] = total
    return total


def _append_lines(lines: List[str], now: Optional[datetime] = None) -> Dict[str, Any]:
    """追加写。返回 {written, file, capped, reason}。超限**停写不删**。"""
    directory = _records_dir()
    name = _today_name(now)
    path = directory / name
    with _write_lock:
        try:
            directory.mkdir(parents=True, exist_ok=True)
        except OSError as exc:  # 目录建不出来：如实回 capped，不抛 500
            return {"written": 0, "file": name, "capped": True, "reason": f"mkdir_failed:{exc.__class__.__name__}"}

        size = path.stat().st_size if path.exists() else 0
        if size >= DIAG_MAX_FILE_BYTES:
            return {"written": 0, "file": name, "capped": True, "reason": "file_size_cap"}
        if _count_lines(path) >= DIAG_MAX_LINES_PER_DAY:
            return {"written": 0, "file": name, "capped": True, "reason": "daily_line_cap"}

        lines_before = _count_lines(path)
        written = 0
        capped_reason = ""
        try:
            with path.open("a", encoding="utf-8") as handle:
                for line in lines:
                    payload = line.encode("utf-8")
                    if size + len(payload) + 1 > DIAG_MAX_FILE_BYTES:
                        capped_reason = "file_size_cap"
                        break
                    handle.write(line + "\n")
                    size += len(payload) + 1
                    written += 1
        except OSError as exc:
            _line_counts[str(path)] = lines_before + written
            return {"written": written, "file": name, "capped": True, "reason": f"write_failed:{exc.__class__.__name__}"}

        _line_counts[str(path)] = lines_before + written
        return {"written": written, "file": name, "capped": bool(capped_reason), "reason": capped_reason}


async def _read_json_body(request: Request) -> Any:
    """读请求体并解析 JSON；非 JSON / 超大 / 形状不对各自给明确状态码。"""
    content_type = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    if content_type != "application/json":
        raise HTTPException(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail="Content-Type must be application/json")

    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            if int(declared) > DIAG_MAX_BODY_BYTES:
                raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="payload too large")
        except ValueError:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="invalid Content-Length")

    body = await request.body()
    if len(body) > DIAG_MAX_BODY_BYTES:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="payload too large")
    if not body:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="empty body")
    try:
        return json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="body is not valid JSON")


@router.post("/records")
async def append_diag_records(request: Request, user: User = Depends(get_current_user)) -> JSONResponse:
    """只追加地写一批留痕记录。开发期取证用，不是产品功能。

    请求体：`{"batchId": "<客户端生成的批号>", "records": [{...白名单字段...}]}`
    返回：`{ok, accepted, written, duplicate, capped, reason, file}`
    """
    now_ts = time.time()
    user_key = str(getattr(user, "id", "") or getattr(user, "username", "") or "anonymous")
    if _rate_limited(user_key, now_ts):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="too many diagnostic uploads")

    payload = await _read_json_body(request)
    if not isinstance(payload, dict):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="payload must be an object")

    raw_records = payload.get("records")
    if not isinstance(raw_records, list):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="records must be a list")
    if len(raw_records) > DIAG_MAX_RECORDS_PER_BATCH:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"too many records in one batch (max {DIAG_MAX_RECORDS_PER_BATCH})",
        )

    batch_id = str(payload.get("batchId") or "").strip()[:128]
    if batch_id:
        with _write_lock:
            if batch_id in _seen_batches:
                return JSONResponse(
                    status_code=status.HTTP_200_OK,
                    content={
                        "ok": True,
                        "accepted": 0,
                        "written": 0,
                        "duplicate": True,
                        "capped": False,
                        "reason": "duplicate_batch",
                        "file": _today_name(),
                    },
                )
            _seen_batches[batch_id] = now_ts
            if len(_seen_batches) > DIAG_DEDUPE_BATCHES:
                for key in list(_seen_batches.keys())[: len(_seen_batches) - DIAG_DEDUPE_BATCHES]:
                    _seen_batches.pop(key, None)

    sanitized: List[Dict[str, Any]] = []
    for item in raw_records:
        clean = _sanitize_record(item)
        if clean is not None:
            sanitized.append(clean)

    if not sanitized:
        return JSONResponse(
            status_code=status.HTTP_200_OK,
            content={"ok": True, "accepted": 0, "written": 0, "duplicate": False, "capped": False, "reason": "no_valid_records", "file": _today_name()},
        )

    stamp = datetime.now(timezone.utc).isoformat()
    lines = [
        json.dumps({"receivedAt": stamp, "userId": user_key, "record": rec}, ensure_ascii=False, separators=(",", ":"))
        for rec in sanitized
    ]
    result = _append_lines(lines)
    return JSONResponse(
        status_code=status.HTTP_200_OK,
        content={
            "ok": True,
            "accepted": len(sanitized),
            "written": result["written"],
            "duplicate": False,
            "capped": result["capped"],
            "reason": result["reason"],
            "file": result["file"],
        },
    )
