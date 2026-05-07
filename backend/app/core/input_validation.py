import re
from typing import Optional, List
from html import escape


_XSS_PATTERN = re.compile(
    r'<\s*/?script|<\s*img[^>]+onerror|<\s*svg[^>]+onload|<\s*iframe|<\s*object|<\s*embed|<\s*link|<\s*meta|<\s*style|javascript\s*:|vbscript\s*:|on\w+\s*=',
    re.IGNORECASE | re.DOTALL,
)

_PATH_TRAVERSAL_PATTERN = re.compile(
    r'\.\./|\.\.\\|%2e%2e%2f|%2e%2e/|..%2f|%2e%2e%5c',
    re.IGNORECASE,
)

_NULL_BYTE_PATTERN = re.compile(r'\x00')


def sanitize_name(value: str, max_length: int = 200) -> str:
    if not value:
        return value
    value = value.strip()
    if not value:
        return value
    if _NULL_BYTE_PATTERN.search(value):
        raise ValueError("Input contains null bytes")
    if _PATH_TRAVERSAL_PATTERN.search(value):
        raise ValueError("Input contains path traversal characters")
    if len(value) > max_length:
        raise ValueError(f"Input exceeds maximum length of {max_length} characters")
    if _XSS_PATTERN.search(value):
        raise ValueError("Input contains potentially dangerous HTML/script content")
    return value


def sanitize_text(value: Optional[str], max_length: int = 50000) -> Optional[str]:
    if value is None:
        return value
    if not isinstance(value, str):
        return value
    if _NULL_BYTE_PATTERN.search(value):
        raise ValueError("Input contains null bytes")
    if len(value) > max_length:
        raise ValueError(f"Input exceeds maximum length of {max_length} characters")
    return value


def sanitize_tags(tags: Optional[List[str]], max_tag_length: int = 100, max_tags: int = 50) -> Optional[List[str]]:
    if tags is None:
        return tags
    if len(tags) > max_tags:
        raise ValueError(f"Too many tags (max {max_tags})")
    result = []
    for tag in tags:
        if not isinstance(tag, str):
            continue
        tag = tag.strip()
        if not tag:
            continue
        if len(tag) > max_tag_length:
            raise ValueError(f"Tag exceeds maximum length of {max_tag_length} characters")
        if _XSS_PATTERN.search(tag):
            raise ValueError("Tag contains potentially dangerous HTML/script content")
        if _PATH_TRAVERSAL_PATTERN.search(tag):
            raise ValueError("Tag contains path traversal characters")
        result.append(tag)
    return result


def sanitize_title(value: str, max_length: int = 500) -> str:
    if not value:
        return value
    value = value.strip()
    if not value:
        return value
    if _NULL_BYTE_PATTERN.search(value):
        raise ValueError("Input contains null bytes")
    if len(value) > max_length:
        raise ValueError(f"Title exceeds maximum length of {max_length} characters")
    return value
