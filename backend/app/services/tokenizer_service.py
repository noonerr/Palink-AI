"""Tokenizer service for token-level operations (logit_bias, ban_sequences).

Provides token ID encoding used by ``generation_service._build_logit_bias`` to
convert ``ban_sequences`` strings into token IDs. Falls back gracefully when
``tiktoken`` is unavailable — callers should treat an empty token list as a
signal that tokenization is unsupported and skip silently (per spec).
"""
import logging
from typing import List

logger = logging.getLogger(__name__)

_tiktoken_enc = None
try:  # pragma: no cover - depends on environment
    import tiktoken  # type: ignore

    try:
        _tiktoken_enc = tiktoken.get_encoding("cl100k_base")
    except Exception:  # pragma: no cover
        _tiktoken_enc = None
except ImportError:  # pragma: no cover
    _tiktoken_enc = None


def tokenizer_available() -> bool:
    """Return True iff a real tokenizer backend is loaded."""
    return _tiktoken_enc is not None


def encode_tokens(text: str) -> List[int]:
    """Encode ``text`` to a list of token IDs.

    Returns an empty list when the tokenizer is unavailable or encoding fails,
    so callers can ``continue`` without raising (per spec: silent skip).
    """
    if not text or _tiktoken_enc is None:
        return []
    try:
        return _tiktoken_enc.encode(text)
    except Exception as e:  # pragma: no cover - defensive
        logger.warning("Tokenize failed for text (len=%d): %s", len(text), e)
        return []
