"""多进程共享的速率限制（MED-3）。

原实现为进程内存 defaultdict + threading.Lock，多 worker（uvicorn --workers N）
部署时限速各自计数、互相绕过。改为后端共享存储（PostgreSQL/SQLite 通用表
rate_limit_entries，UPSERT + RETURNING 原子计数），多 worker 共享同一计数。
DB 不可用时回退进程内存计数（不阻塞可用性）。

注意：
- key 使用 wall-clock（time.time()）而非 monotonic —— monotonic 在不同进程
  起点不同，跨进程比较窗口会失真。
- TRUST_PROXY_HEADERS=True 时 X-Forwarded-For 由可信代理设置；若客户端可绕过
  代理直连后端，XFF 可被伪造。这是部署者主动开启信任声明的既有权衡，未改变。
"""

import threading
import time
from collections import defaultdict, deque
from typing import Deque, Dict, Tuple

from fastapi import HTTPException, Request, status
from sqlalchemy import text

from .config import settings
from .database import engine

# ---------------- 共享存储（DB） ----------------

_RATE_LIMIT_DDL = """
CREATE TABLE IF NOT EXISTS rate_limit_entries (
    key VARCHAR(256) PRIMARY KEY,
    window_start DOUBLE PRECISION NOT NULL,
    count INTEGER NOT NULL
)
"""

_RATE_LIMIT_UPSERT = """
INSERT INTO rate_limit_entries (key, window_start, count)
VALUES (:key, :now, 1)
ON CONFLICT (key) DO UPDATE SET
    count = CASE
        WHEN rate_limit_entries.window_start <= :expired THEN 1
        ELSE rate_limit_entries.count + 1
    END,
    window_start = CASE
        WHEN rate_limit_entries.window_start <= :expired THEN :now
        ELSE rate_limit_entries.window_start
    END
RETURNING count, window_start
"""

_KEY_TTL_SECONDS = 3600
_LAST_CLEANUP: float = 0.0
_CLEANUP_LOCK = threading.Lock()


def _ensure_table() -> None:
    try:
        with engine.begin() as conn:
            conn.execute(text(_RATE_LIMIT_DDL))
    except Exception:
        # DB 暂不可用时静默，enforce 会回退内存计数
        pass


# 模块导入时确保表存在（业务场景 DB 恒可用；测试环境失败则自动回退内存）
_ensure_table()


def _cleanup_expired(now: float) -> None:
    """每 5 分钟清理一次过期键（多进程重复执行也安全，删除是幂等的）。"""
    global _LAST_CLEANUP
    with _CLEANUP_LOCK:
        if now - _LAST_CLEANUP < 300:
            return
        _LAST_CLEANUP = now
    try:
        with engine.begin() as conn:
            conn.execute(
                text("DELETE FROM rate_limit_entries WHERE window_start < :cutoff"),
                {"cutoff": now - _KEY_TTL_SECONDS},
            )
    except Exception:
        pass


def _db_increment(key: str, now: float, window_seconds: int) -> Tuple[bool, int, float]:
    """DB 原子计数（UPSERT + RETURNING）。返回 (ok, count, window_start)。"""
    try:
        return _db_try_upsert(key, now, window_seconds)
    except Exception:
        # 表缺失或 DB 暂不可用：尝试补建表后重试一次，仍失败则回退内存计数
        _ensure_table()
        try:
            return _db_try_upsert(key, now, window_seconds)
        except Exception:
            return False, 1, now


def _db_try_upsert(key: str, now: float, window_seconds: int) -> Tuple[bool, int, float]:
    expired = now - window_seconds
    with engine.begin() as conn:
        row = conn.execute(
            text(_RATE_LIMIT_UPSERT),
            {"key": key, "now": now, "expired": expired},
        ).fetchone()
    if row is None:
        return False, 1, now
    return True, int(row[0]), float(row[1])


# ---------------- 内存回退（DB 不可用） ----------------

_memory_history: Dict[str, Deque[float]] = defaultdict(deque)
_memory_lock = threading.Lock()
_MEMORY_MAX_KEYS = 10000


def _memory_increment(key: str, now: float, window_seconds: int) -> Tuple[int, float]:
    with _memory_lock:
        if key not in _memory_history and len(_memory_history) >= _MEMORY_MAX_KEYS:
            oldest_key = min(
                _memory_history,
                key=lambda k: _memory_history[k][-1] if _memory_history[k] else float("inf"),
            )
            del _memory_history[oldest_key]
        entries = _memory_history[key]
        while entries and entries[0] <= now - window_seconds:
            entries.popleft()
        entries.append(now)
        return len(entries), entries[0]


# ---------------- 客户端标识 ----------------

def _client_identifier(request: Request) -> str:
    if settings.TRUST_PROXY_HEADERS:
        forwarded_for = request.headers.get("x-forwarded-for")
        if forwarded_for:
            return forwarded_for.split(",", 1)[0].strip()

    if request.client and request.client.host:
        return request.client.host

    return "unknown"


def enforce_rate_limit(
    request: Request,
    scope: str,
    max_requests: int,
    window_seconds: int,
) -> None:
    if max_requests <= 0 or window_seconds <= 0:
        return

    now = time.time()
    key = f"{scope}:{_client_identifier(request)}"[:256]

    ok, count, window_start = _db_increment(key, now, window_seconds)
    if not ok:
        count, window_start = _memory_increment(key, now, window_seconds)
    _cleanup_expired(now)

    if count > max_requests:
        retry_after = max(1, int(window_seconds - (now - window_start)))
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many requests, please try again later.",
            headers={"Retry-After": str(retry_after)},
        )
