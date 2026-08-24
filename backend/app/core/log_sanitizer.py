import logging
import re
from typing import List, Tuple

_SENSITIVE_PATTERNS: List[Tuple[str, str]] = [
    (r"eyJ[A-Za-z0-9-_]{20,}", "[REDACTED_JWT]"),
    (r"Bearer\s+\S+", "Bearer [REDACTED]"),
    # N-15: 裸 API 密钥形态（sk-/pk- 前缀 + 16 位以上字母数字），防御性脱敏
    (r"(?<![\w-])(?:sk|pk)-[A-Za-z0-9]{16,}(?![\w-])", "[REDACTED_API_KEY]"),
    (r'(?i)(password|pwd|secret|api_key|apikey|access_token|refresh_token|private_key)\s*[:=]\s*\S+', r'\1=[REDACTED]'),
    (r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}", lambda m: m.group(0)[:2] + "***@" + m.group(0).split("@")[1][:3] + "***"),
    (r"(?<!\d)1[3-9]\d{9}(?!\d)", lambda m: m.group(0)[:3] + "****" + m.group(0)[-4:]),
    (r"(?<!\d)\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)", "[REDACTED_ID]"),
    (r"(?<!\d)\d{16,19}(?!\d)", lambda m: m.group(0)[:4] + "****" + m.group(0)[-4:]),
]

_COMPILED_PATTERNS: List[Tuple[re.Pattern, str]] = [
    (re.compile(pattern), replacement) for pattern, replacement in _SENSITIVE_PATTERNS
]


def sanitize_message(message: str) -> str:
    if not message:
        return message
    result = message
    for pattern, replacement in _COMPILED_PATTERNS:
        result = pattern.sub(replacement, result)
    return result


class SanitizingFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        original = super().format(record)
        return sanitize_message(original)


def setup_sanitized_logging(level: int = logging.INFO, fmt: str | None = None) -> None:
    root_logger = logging.getLogger()
    root_logger.setLevel(level)

    handler = logging.StreamHandler()
    formatter = SanitizingFormatter(fmt or "%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    handler.setFormatter(formatter)

    root_logger.handlers.clear()
    root_logger.addHandler(handler)
