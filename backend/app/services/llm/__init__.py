"""Native LLM API adapters.

Each adapter converts OpenAI-format chat messages into a provider's native API
format and performs the HTTP call (non-streaming and streaming). Adapters return
a unified result shape so the inference dispatcher can consume them uniformly:

- complete() -> {"content": str, "reasoning_content": str, "usage": dict}
- stream()   -> async generator yielding {"content"|"reasoning"|"usage": ...}

The default "openai"/"custom" path is NOT handled here — it continues to use the
existing AsyncOpenAI client in inference_dispatcher. select_adapter() returns
None for those sources so the dispatcher falls back to its original behavior.
"""

from __future__ import annotations

import logging
from typing import Any, List, Optional

# NOTE: _extract_text is defined before importing the adapter submodules because
# each adapter does ``from . import _extract_text`` at load time. Defining it
# first avoids a circular-import error during package initialization.
def _extract_text(content: Any) -> str:
    """Flatten an OpenAI message content (str or list of parts) to text."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: List[str] = []
        for part in content:
            if isinstance(part, dict):
                if part.get("type") == "text":
                    parts.append(str(part.get("text", "")))
                elif part.get("type") == "image_url":
                    # Native adapters handle vision separately; keep a placeholder
                    # marker so text context is not silently lost.
                    parts.append("[image]")
                elif "text" in part:
                    parts.append(str(part.get("text", "")))
            elif isinstance(part, str):
                parts.append(part)
        return "".join(parts)
    return str(content)


from .claude_adapter import ClaudeAdapter  # noqa: E402
from .gemini_adapter import GeminiAdapter  # noqa: E402
from .mistral_adapter import MistralAdapter  # noqa: E402

logger = logging.getLogger(__name__)

# Sources that route to a native adapter. "openai"/"custom" keep the existing
# OpenAI-compat client path (select_adapter returns None for them).
_NATIVE_ADAPTER_SOURCES = {
    "claude": ClaudeAdapter,
    "google": GeminiAdapter,
    "mistral": MistralAdapter,
}


def select_adapter(
    chat_completion_source: Optional[str],
    api_key: str,
    base_url: str,
    model_id: str,
    timeout: float = 30.0,
):
    """Return a native adapter instance for the given source, or None.

    Returns None for "openai"/"custom"/unknown so the caller falls back to the
    existing OpenAI-compatible client path (preserving default behavior).
    """
    source = (chat_completion_source or "").strip().lower()
    adapter_cls = _NATIVE_ADAPTER_SOURCES.get(source)
    if adapter_cls is None:
        return None
    return adapter_cls(
        api_key=api_key,
        base_url=base_url,
        model_id=model_id,
        timeout=timeout,
    )
