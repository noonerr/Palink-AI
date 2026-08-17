"""Mistral native API adapter.

Mistral's Chat Completions API is closely modeled on the OpenAI format, with a
few provider-specific differences (endpoint, ``random_seed`` / ``safe_prompt``
flags, slightly different param support). This adapter converts OpenAI-format
messages and performs the HTTP call directly so it can be selected via
``chat_completion_source = "mistral"`` without routing through the OpenAI SDK.

Reference: https://docs.mistral.ai/api/#tag/chat
"""

from __future__ import annotations

import json
import logging
from typing import Any, AsyncGenerator, Dict, List, Optional

import httpx

from . import _extract_text

logger = logging.getLogger(__name__)

_DEFAULT_BASE_URL = "https://api.mistral.ai"


class MistralAdapter:
    """Native adapter for the Mistral Chat Completions API."""

    def __init__(
        self,
        api_key: str,
        base_url: str,
        model_id: str,
        timeout: float = 30.0,
    ) -> None:
        self.api_key = api_key
        base = (base_url or "").strip().rstrip("/")
        # Normalize to the host root; the adapter appends /v1/chat/completions.
        if base.endswith("/v1"):
            base = base[:-3]
        self.base_url = base or _DEFAULT_BASE_URL
        self.model_id = model_id
        self.timeout = timeout

    # ------------------------------------------------------------------ #
    # Message conversion
    # ------------------------------------------------------------------ #
    @staticmethod
    def _convert_messages(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Convert OpenAI messages to Mistral-compatible messages.

        Mistral accepts the OpenAI message shape but rejects empty content and
        tool-call payloads it cannot parse. For the minimal adapter we flatten
        multipart content to text and drop unsupported fields.
        """
        converted: List[Dict[str, Any]] = []
        for msg in messages:
            role = msg.get("role", "user")
            text = _extract_text(msg.get("content"))
            # Mistral requires non-empty assistant/user content; skip empty turns
            # rather than sending a 400-triggering payload.
            if role in ("user", "assistant") and not text:
                continue
            converted.append({"role": role, "content": text})
        return converted

    def build_request(
        self,
        messages: List[Dict[str, Any]],
        temperature: float = 0.7,
        max_tokens: int = 1024,
        top_p: Optional[float] = None,
        random_seed: Optional[int] = None,
        safe_prompt: Optional[bool] = None,
        stream: bool = False,
    ) -> Dict[str, Any]:
        body: Dict[str, Any] = {
            "model": self.model_id,
            "messages": self._convert_messages(messages),
            "temperature": float(temperature),
            "max_tokens": int(max_tokens) if max_tokens else 1024,
            "stream": bool(stream),
        }
        if top_p is not None:
            body["top_p"] = float(top_p)
        if random_seed is not None:
            body["random_seed"] = int(random_seed)
        if safe_prompt is not None:
            body["safe_prompt"] = bool(safe_prompt)

        return {
            "url": f"{self.base_url}/v1/chat/completions",
            "headers": {
                "Authorization": f"Bearer {self.api_key}",
                "content-type": "application/json",
                "accept": "application/json",
            },
            "json": body,
        }

    # ------------------------------------------------------------------ #
    # Helpers
    # ------------------------------------------------------------------ #
    @staticmethod
    def _usage_from(usage: Optional[Dict[str, Any]]) -> Dict[str, int]:
        if not usage:
            return {}
        return {
            "total_tokens": int(usage.get("total_tokens", 0)),
            "prompt_tokens": int(usage.get("prompt_tokens", 0)),
            "completion_tokens": int(usage.get("completion_tokens", 0)),
            "reasoning_tokens": 0,
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
        random_seed: Optional[int] = None,
        safe_prompt: Optional[bool] = None,
    ) -> Dict[str, Any]:
        req = self.build_request(
            messages,
            temperature=temperature,
            max_tokens=max_tokens,
            top_p=top_p,
            random_seed=random_seed,
            safe_prompt=safe_prompt,
            stream=False,
        )
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.post(req["url"], headers=req["headers"], json=req["json"])
            resp.raise_for_status()
            data = resp.json()

        choices = data.get("choices") or []
        content = ""
        reasoning = ""
        if choices:
            message = choices[0].get("message", {}) or {}
            content = message.get("content", "") or ""
        usage = self._usage_from(data.get("usage"))
        return {
            "content": content,
            "reasoning_content": reasoning,
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
        random_seed: Optional[int] = None,
        safe_prompt: Optional[bool] = None,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        req = self.build_request(
            messages,
            temperature=temperature,
            max_tokens=max_tokens,
            top_p=top_p,
            random_seed=random_seed,
            safe_prompt=safe_prompt,
            stream=True,
        )
        usage: Dict[str, int] = {}

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            async with client.stream("POST", req["url"], headers=req["headers"], json=req["json"]) as resp:
                resp.raise_for_status()
                async for raw_line in resp.aiter_lines():
                    line = raw_line.rstrip("\n")
                    if not line.startswith("data:"):
                        continue
                    payload = line[len("data:"):].strip()
                    if not payload or payload == "[DONE]":
                        continue
                    try:
                        data = json.loads(payload)
                    except json.JSONDecodeError:
                        continue

                    chunk_usage = data.get("usage")
                    if chunk_usage:
                        usage = self._usage_from(chunk_usage)

                    choices = data.get("choices") or []
                    if not choices:
                        continue
                    delta = choices[0].get("delta", {}) or {}
                    content = delta.get("content")
                    if content:
                        yield {"content": content}
                    # Some Mistral models surface reasoning under a dedicated field.
                    reasoning = delta.get("reasoning_content") or delta.get("reasoning")
                    if reasoning:
                        yield {"reasoning": reasoning}

        if usage:
            yield {"usage": usage}
