import threading
import time


_BLACKLIST: dict[str, float] = {}
_LOCK = threading.Lock()
_CLEANUP_INTERVAL = 300
_LAST_CLEANUP: float = 0.0


def add_to_blacklist(token_jti: str, expires_at_timestamp: float) -> None:
    global _LAST_CLEANUP
    with _LOCK:
        now = time.time()
        if now - _LAST_CLEANUP > _CLEANUP_INTERVAL:
            expired = [k for k, v in _BLACKLIST.items() if v <= now]
            for k in expired:
                del _BLACKLIST[k]
            _LAST_CLEANUP = now
        _BLACKLIST[token_jti] = expires_at_timestamp


def is_blacklisted(token_jti: str) -> bool:
    with _LOCK:
        expires_at = _BLACKLIST.get(token_jti)
        if expires_at is None:
            return False
        if time.time() > expires_at:
            del _BLACKLIST[token_jti]
            return False
        return True
