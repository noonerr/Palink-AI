import json
import logging
from typing import Any, AsyncIterator, Awaitable, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)


class StreamResult:
    __slots__ = ("full_content", "full_reasoning", "total_tokens", "prompt_tokens", "completion_tokens", "reasoning_tokens")

    def __init__(self):
        self.full_content = ""
        self.full_reasoning = ""
        self.total_tokens = 0
        self.prompt_tokens = 0
        self.completion_tokens = 0
        self.reasoning_tokens = 0

    @property
    def has_content(self) -> bool:
        return bool(self.full_content or self.full_reasoning)

    def final_text(self) -> str:
        if self.full_reasoning:
            return f"  thinking{self.full_reasoning}  response\n{self.full_content}"
        return self.full_content

    def token_count(self) -> int:
        if self.completion_tokens > 0:
            return self.completion_tokens
        return _estimate_tokens(self.full_content) + _estimate_tokens(self.full_reasoning)

    def effective_reasoning_tokens(self) -> int:
        if self.reasoning_tokens > 0:
            return self.reasoning_tokens
        if self.full_reasoning:
            return _estimate_tokens(self.full_reasoning)
        return 0

    def output_token_count(self) -> int:
        if self.completion_tokens > 0:
            return self.completion_tokens - self.effective_reasoning_tokens()
        return _estimate_tokens(self.full_content)


def _estimate_tokens(text: str) -> int:
    if not text:
        return 0
    chinese_chars = sum(1 for c in text if '\u4e00' <= c <= '\u9fff')
    other_chars = len(text) - chinese_chars
    return int(chinese_chars * 1.5 + other_chars * 0.25)


async def stream_chat_deltas(
    stream: AsyncIterator[Dict[str, Any]],
    result: StreamResult,
    initial_events: Optional[List[Dict[str, Any]]] = None,
    enable_tools: bool = False,
) -> AsyncIterator[str]:
    if initial_events:
        for evt in initial_events:
            yield f"data: {json.dumps(evt, ensure_ascii=False)}\n\n"

    async for delta in stream:
        queue_info = delta.get("type")
        if queue_info == "queue":
            yield f"data: {json.dumps(delta, ensure_ascii=False)}\n\n"
            continue

        usage = delta.get("usage")
        if usage:
            result.total_tokens = int(usage.get("total_tokens", 0) or 0)
            result.prompt_tokens = int(usage.get("prompt_tokens", 0) or 0)
            result.completion_tokens = int(usage.get("completion_tokens", 0) or 0)
            _rt = int(usage.get("reasoning_tokens", 0) or 0)
            if not _rt:
                _details = usage.get("completion_tokens_details") or {}
                _rt = int(_details.get("reasoning_tokens", 0) or 0)
            result.reasoning_tokens = _rt
            continue

        if enable_tools:
            tool_call = delta.get("tool_call")
            if tool_call:
                yield f"data: {json.dumps({'type': 'tool_call', 'id': tool_call.get('id', ''), 'name': tool_call.get('name', ''), 'arguments': tool_call.get('arguments', {})}, ensure_ascii=False)}\n\n"
                continue

            tool_result = delta.get("tool_result")
            if tool_result:
                yield f"data: {json.dumps({'type': 'tool_result', 'id': tool_result.get('id', ''), 'name': tool_result.get('name', ''), 'content': tool_result.get('content', '')[:2000]}, ensure_ascii=False)}\n\n"
                continue

        reasoning = delta.get("reasoning")
        content = delta.get("content")
        resp = {}
        if isinstance(reasoning, str) and reasoning:
            result.full_reasoning += reasoning
            resp["reasoning"] = reasoning
        if isinstance(content, str) and content:
            result.full_content += content
            resp["content"] = content
        if resp:
            yield f"data: {json.dumps(resp, ensure_ascii=False)}\n\n"

    if not result.has_content:
        result.full_content = "Error: 模型未返回任何可显示内容，请切换模型或稍后重试。"
        yield f"data: {json.dumps({'content': result.full_content, 'error': True}, ensure_ascii=False)}\n\n"

    if result.total_tokens > 0:
        yield f"data: {json.dumps({'type': 'usage', 'total_tokens': result.total_tokens, 'prompt_tokens': result.prompt_tokens, 'completion_tokens': result.completion_tokens, 'reasoning_tokens': result.effective_reasoning_tokens()})}\n\n"

    yield "data: [DONE]\n\n"


async def parse_stream_deltas(
    stream: AsyncIterator[Dict[str, Any]],
    result: StreamResult,
    on_chunk: Optional[Callable[[Dict[str, Any]], Awaitable[None]]] = None,
    enable_tools: bool = False,
) -> None:
    async for delta in stream:
        queue_info = delta.get("type")
        if queue_info == "queue":
            if on_chunk:
                await on_chunk(delta)
            continue

        usage = delta.get("usage")
        if usage:
            result.total_tokens = int(usage.get("total_tokens", 0) or 0)
            result.prompt_tokens = int(usage.get("prompt_tokens", 0) or 0)
            result.completion_tokens = int(usage.get("completion_tokens", 0) or 0)
            _rt = int(usage.get("reasoning_tokens", 0) or 0)
            if not _rt:
                _details = usage.get("completion_tokens_details") or {}
                _rt = int(_details.get("reasoning_tokens", 0) or 0)
            result.reasoning_tokens = _rt
            continue

        if enable_tools:
            tool_call = delta.get("tool_call")
            if tool_call:
                if on_chunk:
                    await on_chunk({
                        "type": "tool_call",
                        "id": tool_call.get("id", ""),
                        "name": tool_call.get("name", ""),
                        "arguments": tool_call.get("arguments", {}),
                    })
                continue

            tool_result = delta.get("tool_result")
            if tool_result:
                if on_chunk:
                    await on_chunk({
                        "type": "tool_result",
                        "id": tool_result.get("id", ""),
                        "name": tool_result.get("name", ""),
                        "content": tool_result.get("content", "")[:2000],
                    })
                continue

        reasoning = delta.get("reasoning")
        content = delta.get("content")
        resp = {}
        if isinstance(reasoning, str) and reasoning:
            result.full_reasoning += reasoning
            resp["reasoning"] = reasoning
        if isinstance(content, str) and content:
            result.full_content += content
            resp["content"] = content
        if resp and on_chunk:
            await on_chunk(resp)


async def run_stream_to_completion(
    stream: AsyncIterator[Dict[str, Any]],
    result: StreamResult,
    on_chunk: Optional[Callable[[Dict[str, Any]], Awaitable[None]]] = None,
    enable_tools: bool = False,
) -> None:
    await parse_stream_deltas(stream, result, on_chunk=on_chunk, enable_tools=enable_tools)
    if not result.has_content:
        result.full_content = "Error: 模型未返回任何可显示内容，请切换模型或稍后重试。"
        if on_chunk:
            await on_chunk({"content": result.full_content, "error": True})
