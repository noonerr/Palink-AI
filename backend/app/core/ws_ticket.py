import secrets
import time
import threading
from typing import Optional, Tuple

_TICKET_STORE: dict[str, Tuple[int, int]] = {}  # ticket -> (user_id, expires_at)
_TICKET_LOCK = threading.Lock()
_TICKET_TTL_SECONDS = 30
_TICKET_MAX_STORE = 10000


def create_ticket(user_id: int) -> str:
    ticket = secrets.token_urlsafe(32)
    expires_at = int(time.monotonic()) + _TICKET_TTL_SECONDS
    with _TICKET_LOCK:
        if len(_TICKET_STORE) >= _TICKET_MAX_STORE:
            now = int(time.monotonic())
            expired = [k for k, (_, exp) in _TICKET_STORE.items() if exp <= now]
            for k in expired:
                del _TICKET_STORE[k]
        _TICKET_STORE[ticket] = (user_id, expires_at)
    return ticket


def validate_ticket(ticket: str) -> Optional[int]:
    if not ticket:
        return None
    with _TICKET_LOCK:
        entry = _TICKET_STORE.pop(ticket, None)
    if entry is None:
        return None
    user_id, expires_at = entry
    if int(time.monotonic()) > expires_at:
        return None
    return user_id
