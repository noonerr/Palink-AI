import threading
import time
from collections import defaultdict, deque
from typing import Deque, Dict

from fastapi import HTTPException, Request, status
from .config import settings


_request_history: Dict[str, Deque[float]] = defaultdict(deque)
_request_lock = threading.Lock()


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

    now = time.monotonic()
    key = f"{scope}:{_client_identifier(request)}"

    with _request_lock:
        window_start = now - window_seconds
        entries = _request_history[key]

        while entries and entries[0] <= window_start:
            entries.popleft()

        if len(entries) >= max_requests:
            retry_after = window_seconds
            if entries:
                retry_after = max(1, int(window_seconds - (now - entries[0])))
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many requests, please try again later.",
                headers={"Retry-After": str(retry_after)},
            )

        entries.append(now)
