"""Google Gemini native API adapter.

Converts OpenAI-format chat messages to Gemini's ``generateContent`` format and
performs the HTTP call. Key differences from OpenAI:
  - Messages live under a ``contents`` array with ``parts`` (each part holds a
    ``text`` field).
  - Roles are ``user`` / ``model`` (assistant maps to model).
  - The system prompt is a top-level ``systemInstruction`` field.
  - Generation params go under ``generationConfig``.
  - Streaming uses ``streamGenerateContent?alt=sse``.

Reference: https://ai.google.dev/api/rest/v1beta/models/generateContent
"""

from __future__ import annotations

import json
import logging
from typing import Any, AsyncGenerator, Dict, List, Optional

import httpx

from . import _extract_text

logger = logging.getLogger(__name__)

_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com"


class GeminiAdapter:
    """Native adapter for the Google Gemini API."""

    def __init__(
        self,
        api_key: str,
        base_url: str,
        model_id: str,
        timeout: float = 30.0,
    ) -> None:
        self.api_key = api_key
        base = (base_url or "").strip().rstrip("/")
        # Strip a trailing /v1beta so we control the path ourselves.
        if base.endswith("/v1beta"):
            base = base[: -len("/v1beta")]
        self.base_url = base or _DEFAULT_BASE_URL
        self.model_id = model_id
        self.timeout = timeout

    # ------------------------------------------------------------------ #
    # Message conversion
    # ------------------------------------------------------------------ #
    @staticmethod
    def _to_contents(messages: List[Dict[str, Any]]) -> tuple[Optional[Dict[str, Any]], List[Dict[str, Any]]]:
        system_parts: List[str] = []
        contents: List[Dict[str, Any]] = []
        for msg in messages:
            role = msg.get("role", "user")
            text = _extract_text(msg.get("content"))
            if role == "system":
                if text:
                    system_parts.append(text)
                continue
            mapped_role = "model" if role == "assistant" else "user"
            # Tool result messages become user turns.
            if role == "tool":
                mapped_role = "user"
            contents.append({"role": mapped_role, "parts": [{"text": text}]})

        # Gemini expects the conversation to begin with a user turn.
        if contents and contents[0]["role"] != "user":
            contents.insert(0, {"role": "user", "parts": [{"text": "(conversation start)"}]})
        # Gemini requires alternating user/model turns; merge consecutive
        # same-role turns so the request stays valid.
        merged: List[Dict[str, Any]] = []
        for turn in contents:
            if merged and merged[-1]["role"] == turn["role"]:
                merged[-1]["parts"][0]["text"] += "\n\n" + turn["parts"][0]["text"]
            else:
                merged.append(turn)

        system_instruction: Optional[Dict[str, Any]] = None
        if system_parts:
            system_instruction = {"parts": [{"text": "\n\n".join(system_parts).strip()}]}
        return system_instruction, merged

    def build_request(
        self,
        messages: List[Dict[str, Any]],
        temperature: float = 0.7,
        max_tokens: int = 1024,
        top_p: Optional[float] = None,
        top_k: Optional[int] = None,
        stream: bool = False,
    ) -> Dict[str, Any]:
        system_instruction, contents = self._to_contents(messages)

        generation_config: Dict[str, Any] = {
            "temperature": float(temperature),
            "maxOutputTokens": int(max_tokens) if max_tokens else 1024,
        }
        if top_p is not None:
            generation_config["topP"] = float(top_p)
        if top_k is not None:
            generation_config["topK"] = int(top_k)

        body: Dict[str, Any] = {
            "contents": contents,
            "generationConfig": generation_config,
        }
        if system_instruction is not None:
            body["systemInstruction"] = system_instruction

        action = "streamGenerateContent" if stream else "generateContent"
        url = f"{self.base_url}/v1beta/models/{self.model_id}:{action}"
        if stream:
            url += "?alt=sse"

        return {
            "url": url,
            "headers": {
                "x-goog-api-key": self.api_key,
                "content-type": "application/json",
            },
            "json": body,
        }

    # ------------------------------------------------------------------ #
    # Helpers
    # ------------------------------------------------------------------ #
    @staticmethod
    def _usage_from(metadata: Optional[Dict[str, Any]]) -> Dict[str, int]:
        if not metadata:
            return {}
        return {
            "total_tokens": int(metadata.get("totalTokenCount", 0)),
            "prompt_tokens": int(metadata.get("promptTokenCount", 0)),
            "completion_tokens": int(metadata.get("candidatesTokenCount", 0)),
            "reasoning_tokens": int(metadata.get("thoughtsTokenCount", 0)),
        }

    @classmethod
    def _iter_candidate_parts(cls, data: Dict[str, Any]) -> tuple[List[str], List[str]]:
        content_parts: List[str] = []
        reasoning_parts: List[str] = []
        for cand in data.get("candidates", []) or []:
            content = (cand.get("content") or {})
            for part in content.get("parts", []) or []:
                if part.get("thought"):
                    reasoning_parts.append(str(part.get("text", "")))
                elif "text" in part:
                    content_parts.append(str(part.get("text", "")))
            # Some responses surface thoughts under a dedicated thoughtsContent.
            thoughts = cand.get("thoughtsContent")
            if thoughts:
                for part in thoughts.get("parts", []) or []:
                    if "text" in part:
                        reasoning_parts.append(str(part.get("text", "")))
        return content_parts, reasoning_parts

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

        content_parts, reasoning_parts = self._iter_candidate_parts(data)
        usage = self._usage_from(data.get("usageMetadata"))
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

                    content_parts, reasoning_parts = self._iter_candidate_parts(data)
                    if content_parts:
                        yield {"content": "".join(content_parts)}
                    if reasoning_parts:
                        yield {"reasoning": "".join(reasoning_parts)}

                    meta = data.get("usageMetadata")
                    if meta:
                        usage = self._usage_from(meta)

        if usage:
            yield {"usage": usage}
