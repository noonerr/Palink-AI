"""Generation helpers: logit_bias + ban_sequences construction (spec Task 11).

This module is the single source of truth for translating a ``GenerationPreset``'s
``ban_sequences`` and ``logit_bias`` fields into the ``{token_id: bias}`` dict
expected by OpenAI-compatible chat completion endpoints (OpenAI, Anthropic via
OpenAI-compat, KoboldCpp via OpenAI-compat).

Behavioural guarantees (per spec):
- Never raises — ban_sequence tokenization failures are logged and skipped.
- Backends without a tokenizer silently skip ``ban_sequences`` (logit_bias dict
  is still applied since it already contains token IDs).
- ``logit_bias`` values are clamped to ``[-100, 100]``.
- Banned token IDs receive ``bias = -100`` (hard ban).
"""
import json
import logging
from typing import Any, Dict

from .tokenizer_service import encode_tokens, tokenizer_available

logger = logging.getLogger(__name__)

# ST 1.18.0 logit_bias range — OpenAI spec allows ±100; -100 == effective ban.
_BAN_BIAS_VALUE = -100
_BIAS_MIN = -100
_BIAS_MAX = 100


def _build_logit_bias(preset: Any) -> Dict[str, int]:
    """Build a merged ``{token_id: bias}`` dict from a preset.

    Sources (merged in order, later entries win):
    1. ``preset.ban_sequences`` — JSON array of strings; each string is
       tokenized via :func:`encode_tokens` and every resulting token ID
       receives ``bias = -100``.
    2. ``preset.logit_bias`` — JSON object ``{token_id: bias_value}``;
       values clamped to ``[-100, 100]``.

    Args:
        preset: A ``GenerationPreset`` ORM instance (or any object exposing
            ``ban_sequences`` / ``logit_bias`` attributes). ``None`` is tolerated
            and returns ``{}``.

    Returns:
        ``{token_id_str: bias_int}``. Empty when preset is ``None``, fields
        are empty, or tokenization is unavailable for ban_sequences.
    """
    if preset is None:
        return {}

    result: Dict[str, int] = {}

    # 1. ban_sequences → token IDs with bias -100
    ban_raw = getattr(preset, "ban_sequences", None)
    if ban_raw:
        try:
            ban_list = json.loads(ban_raw) if isinstance(ban_raw, str) else ban_raw
        except (json.JSONDecodeError, TypeError):
            logger.warning("Invalid ban_sequences JSON on preset; skipping ban step")
            ban_list = []
        if isinstance(ban_list, list) and ban_list:
            if not tokenizer_available():
                # Backend without token conversion — silently skip per spec.
                logger.info(
                    "Tokenizer unavailable; skipping ban_sequences tokenization "
                    "(preset has %d entries)", len(ban_list)
                )
            else:
                for seq in ban_list:
                    if not isinstance(seq, str) or not seq:
                        continue
                    try:
                        token_ids = encode_tokens(seq)
                    except Exception as e:  # pragma: no cover - defensive
                        logger.warning(
                            "ban_sequence tokenize failed (seq=%r): %s",
                            seq[:50], e,
                        )
                        continue
                    for tid in token_ids:
                        result[str(tid)] = _BAN_BIAS_VALUE

    # 2. logit_bias dict (already token IDs) — clamp values to [-100, 100]
    lb_raw = getattr(preset, "logit_bias", None)
    if lb_raw:
        try:
            lb_dict = json.loads(lb_raw) if isinstance(lb_raw, str) else lb_raw
        except (json.JSONDecodeError, TypeError):
            logger.warning("Invalid logit_bias JSON on preset; skipping bias step")
            lb_dict = {}
        if isinstance(lb_dict, dict):
            for k, v in lb_dict.items():
                try:
                    bias = int(v)
                except (TypeError, ValueError):
                    continue
                if bias < _BIAS_MIN:
                    bias = _BIAS_MIN
                elif bias > _BIAS_MAX:
                    bias = _BIAS_MAX
                result[str(k)] = bias

    return result
