"""Claude (Anthropic) native API adapter.

Converts OpenAI-format chat messages to Anthropic's Messages API format and
performs the HTTP call. Key differences from OpenAI:
  - The system prompt is a top-level ``system`` field, not a message.
  - Messages must alternate user/assistant roles (consecutive same-role
    messages are merged).
  - Streaming uses typed SSE events (content_block_delta / message_delta).
  - Optional prompt caching via ``cache_control`` markers.

Reference: https://docs.anthropic.com/en/api/messages
"""

from __future__ import annotations

import json
import logging
from typing import Any, AsyncGenerator, Dict, List, Optional

import httpx

from . import _extract_text

logger = logging.getLogger(__name__)

_ANTHROPIC_VERSION = "2023-06-01"
_DEFAULT_BASE_URL = "https://api.anthropic.com"


class ClaudeAdapter:
    """Native adapter for the Anthropic Messages API."""

    def __init__(
        self,
        api_key: str,
        base_url: str,
        model_id: str,
        timeout: float = 30.0,
    ) -> None:
        self.api_key = api_key
        # Anthropic base URL is the host root (e.g. https://api.anthropic.com);
        # tolerate a trailing /v1 that some OpenAI-compat configs append.
        base = (base_url or "").strip().rstrip("/")
        if base.endswith("/v1"):
            base = base[:-3]
        self.base_url = base or _DEFAULT_BASE_URL
        self.model_id = model_id
        self.timeout = timeout

    # ------------------------------------------------------------------ #
    # Message conversion
    # ------------------------------------------------------------------ #
    @staticmethod
    def _split_system(messages: List[Dict[str, Any]]) -> tuple[str, List[Dict[str, Any]]]:
        """Extract system prompt (top-level field) from OpenAI messages."""
        system_parts: List[str] = []
        conversation: List[Dict[str, Any]] = []
        for msg in messages:
            role = msg.get("role", "user")
            text = _extract_text(msg.get("content"))
            if role == "system":
                if text:
                    system_parts.append(text)
            else:
                mapped_role = "assistant" if role == "assistant" else "user"
                # Tool/function messages are not native-Claude shaped; fold the
                # tool result into a user turn so the conversation stays valid.
                if role == "tool":
                    mapped_role = "user"
                conversation.append({"role": mapped_role, "content": text})
        # Merge consecutive same-role messages (Claude requires alternation).
        merged: List[Dict[str, Any]] = []
        for turn in conversation:
            if merged and merged[-1]["role"] == turn["role"]:
                merged[-1]["content"] = (merged[-1]["content"] + "\n\n" + turn["content"]).strip()
            else:
                merged.append(dict(turn))
        # Claude requires the first turn to be a user message.
        if merged and merged[0]["role"] != "user":
            merged.insert(0, {"role": "user", "content": "(conversation start)"})
        # Claude requires the conversation to end with a user turn for a reply;
        # append a neutral user turn if the last is assistant.
        if merged and merged[-1]["role"] == "assistant":
            merged.append({"role": "user", "content": "(continue)"})
        return "\n\n".join(system_parts).strip(), merged

    def build_request(
        self,
        messages: List[Dict[str, Any]],
        temperature: float = 0.7,
        max_tokens: int = 1024,
        top_p: Optional[float] = None,
        top_k: Optional[int] = None,
        stream: bool = False,
        enable_caching: bool = True,
    ) -> Dict[str, Any]:
        system_text, conversation = self._split_system(messages)

        # Build system as a content block so we can attach a cache_control marker.
        system_field: Any = None
        if system_text:
            system_block: Dict[str, Any] = {"type": "text", "text": system_text}
            if enable_caching:
                system_block["cache_control"] = {"type": "ephemeral"}
            system_field = [system_block]

        # Mark the last conversation turn for caching (optional, best-effort).
        if enable_caching and conversation:
            last = conversation[-1]
            text = last.get("content", "")
            last["content"] = [{"type": "text", "text": text, "cache_control": {"type": "ephemeral"}}]

        body: Dict[str, Any] = {
            "model": self.model_id,
            "max_tokens": int(max_tokens) if max_tokens else 1024,
            "messages": conversation,
            "temperature": float(temperature),
            "stream": bool(stream),
        }
        if system_field is not None:
            body["system"] = system_field
        if top_p is not None:
            body["top_p"] = float(top_p)
        if top_k is not None:
            body["top_k"] = int(top_k)

        return {
            "url": f"{self.base_url}/v1/messages",
            "headers": {
                "x-api-key": self.api_key,
                "anthropic-version": _ANTHROPIC_VERSION,
                "content-type": "application/json",
            },
            "json": body,
        }

    # ------------------------------------------------------------------ #
    # Non-streaming
    # ------------------------------------------------------------------ #
    async def complete(
        self,
        messages: List[Dict[str, Any]],
        temperature: float = 0.7,
        max_tokens: int = 1024,
        top_p: Optional[float] = None,
        top_k: Optional[int] = None,
    ) -> Dict[str, Any]:
        req = self.build_request(
            messages,
            temperature=temperature,
            max_tokens=max_tokens,
            top_p=top_p,
            top_k=top_k,
            stream=False,
        )
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.post(req["url"], headers=req["headers"], json=req["json"])
            resp.raise_for_status()
            data = resp.json()

        content_parts: List[str] = []
        reasoning_parts: List[str] = []
        for block in data.get("content", []) or []:
            btype = block.get("type")
            if btype == "text":
                content_parts.append(block.get("text", ""))
            elif btype == "thinking":
                reasoning_parts.append(block.get("thinking", ""))

        usage_in = data.get("usage", {}) or {}
        usage = {
            "total_tokens": int(usage_in.get("input_tokens", 0)) + int(usage_in.get("output_tokens", 0)),
            "prompt_tokens": int(usage_in.get("input_tokens", 0)),
            "completion_tokens": int(usage_in.get("output_tokens", 0)),
            "reasoning_tokens": 0,
            "cache_creation_input_tokens": int(usage_in.get("cache_creation_input_tokens", 0)),
            "cache_read_input_tokens": int(usage_in.get("cache_read_input_tokens", 0)),
        }
        return {
            "content": "".join(content_parts),
            "reasoning_content": "".join(reasoning_parts),
            "usage": usage,
        }

    # ------------------------------------------------------------------ #
    # Streaming
    # ------------------------------------------------------------------ #
    async def stream(
        self,
        messages: List[Dict[str, Any]],
        temperature: float = 0.7,
        max_tokens: int = 1024,
        top_p: Optional[float] = None,
        top_k: Optional[int] = None,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        req = self.build_request(
            messages,
            temperature=temperature,
            max_tokens=max_tokens,
            top_p=top_p,
            top_k=top_k,
            stream=True,
        )
        usage: Dict[str, int] = {}
        # Track which content block index is a "thinking" block to route deltas.
        thinking_blocks: Dict[int, bool] = {}

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            async with client.stream("POST", req["url"], headers=req["headers"], json=req["json"]) as resp:
                resp.raise_for_status()
                event_type: Optional[str] = None
                async for raw_line in resp.aiter_lines():
                    line = raw_line.rstrip("\n")
                    if not line:
                        event_type = None
                        continue
                    if line.startswith("event:"):
                        event_type = line[len("event:"):].strip()
                        continue
                    if not line.startswith("data:"):
                        continue
                    payload = line[len("data:"):].strip()
                    if not payload or payload == "[DONE]":
                        continue
                    try:
                        data = json.loads(payload)
                    except json.JSONDecodeError:
                        continue

                    etype = data.get("type", event_type)
                    if etype == "content_block_start":
                        idx = data.get("index", 0)
                        block = data.get("content_block", {}) or {}
                        thinking_blocks[idx] = block.get("type") == "thinking"
                    elif etype == "content_block_delta":
                        idx = data.get("index", 0)
                        delta = data.get("delta", {}) or {}
                        dtype = delta.get("type")
                        if dtype == "text_delta":
                            yield {"content": delta.get("text", "")}
                        elif dtype == "thinking_delta":
                            yield {"reasoning": delta.get("thinking", "")}
                        elif dtype == "input_json_delta":
                            # Tool-use argument fragments — emit as content for
                            # minimal compatibility.
                            yield {"content": delta.get("partial_json", "")}
                    elif etype == "message_delta":
                        u = data.get("usage", {}) or {}
                        if u:
                            usage = {
                                "total_tokens": int(u.get("input_tokens", usage.get("prompt_tokens", 0)))
                                + int(u.get("output_tokens", 0)),
                                "prompt_tokens": int(u.get("input_tokens", usage.get("prompt_tokens", 0))),
                                "completion_tokens": int(u.get("output_tokens", 0)),
                                "reasoning_tokens": 0,
                            }
                    elif etype == "message_start":
                        msg = data.get("message", {}) or {}
                        u = msg.get("usage", {}) or {}
                        if u:
                            usage = {
                                "total_tokens": int(u.get("input_tokens", 0)) + int(u.get("output_tokens", 0)),
                                "prompt_tokens": int(u.get("input_tokens", 0)),
                                "completion_tokens": int(u.get("output_tokens", 0)),
                                "reasoning_tokens": 0,
                                "cache_creation_input_tokens": int(u.get("cache_creation_input_tokens", 0)),
                                "cache_read_input_tokens": int(u.get("cache_read_input_tokens", 0)),
                            }

        if usage:
            yield {"usage": usage}
