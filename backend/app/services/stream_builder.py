import asyncio
import json
import logging
from typing import Any, AsyncIterator, Awaitable, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)


class StreamResult:
    __slots__ = ("full_content", "full_reasoning", "total_tokens", "prompt_tokens", "completion_tokens", "reasoning_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")

    def __init__(self):
        self.full_content = ""
        self.full_reasoning = ""
        self.total_tokens = 0
        self.prompt_tokens = 0
        self.completion_tokens = 0
        self.reasoning_tokens = 0
        self.cache_creation_input_tokens = 0
        self.cache_read_input_tokens = 0

    @property
    def has_content(self) -> bool:
        return bool(self.full_content or self.full_reasoning)

    def final_text(self) -> str:
        # [REASONING-SEPARATE] 分离存储：只返回纯正文；思考经 extra.reasoning 单独持久化
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
    stream_timeout: float = 120.0,
    enable_thinking: Optional[bool] = None,
) -> AsyncIterator[str]:
    if initial_events:
        for evt in initial_events:
            yield f"data: {json.dumps(evt, ensure_ascii=False)}\n\n"

    timed_out = False
    try:
        while True:
            try:
                delta = await asyncio.wait_for(stream.__anext__(), timeout=stream_timeout)
            except StopAsyncIteration:
                break
            except asyncio.TimeoutError:
                logger.warning("Stream timed out after %.0fs with no data from LLM", stream_timeout)
                timed_out = True
                if not result.has_content:
                    result.full_content = "Error: 模型响应超时，请稍后重试。"
                else:
                    result.full_content += "\n\n[响应超时中断]"
                # N12 修复: 错误以 SSE error 事件发射（前端识别后抛错/toastr），
                # 不再把错误文本塞进 content —— 此前前端把 "Error: ..." 当正常
                # AI 回复渲染。result.full_content 仍保留供调用方判断失败。
                yield f"data: {json.dumps({'type': 'error', 'error': True, 'message': '模型响应超时，请稍后重试。'}, ensure_ascii=False)}\n\n"
                break

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
                result.cache_creation_input_tokens = int(usage.get("cache_creation_input_tokens", 0) or 0)
                prompt_details = usage.get("prompt_tokens_details") or {}
                result.cache_read_input_tokens = int(usage.get("cache_read_input_tokens", 0) or prompt_details.get("cached_tokens", 0) or 0)
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

            reasoning = delta.get("reasoning") or delta.get("reasoning_content")
            content = delta.get("content")
            resp = {}
            # 当 enable_thinking=False 时，将 reasoning 合并到 content
            if isinstance(reasoning, str) and reasoning:
                if enable_thinking is not False:
                    result.full_reasoning += reasoning
                    resp["reasoning"] = reasoning
                    # P2 修复: 同时发射 model_reasoning 别名字段，
                    # 对齐 ST 1.18.0 前端 generation-engine.ts:254 的检测逻辑
                    resp["model_reasoning"] = reasoning
                else:
                    result.full_content += reasoning
                    resp["content"] = resp.get("content", "") + reasoning
            if isinstance(content, str) and content:
                result.full_content += content
                resp["content"] = resp.get("content", "") + content
            if resp:
                yield f"data: {json.dumps(resp, ensure_ascii=False)}\n\n"
    finally:
        if hasattr(stream, 'aclose'):
            try:
                await stream.aclose()
            except Exception:
                pass

    if not timed_out and not result.has_content:
        result.full_content = "Error: 模型未返回任何可显示内容，请切换模型或稍后重试。"
        # N12 修复: error 事件（同超时分支），错误文本不再以 content 渲染
        yield f"data: {json.dumps({'type': 'error', 'error': True, 'message': '模型未返回任何可显示内容，请切换模型或稍后重试。'}, ensure_ascii=False)}\n\n"

    if result.total_tokens > 0:
        yield f"data: {json.dumps({'type': 'usage', 'total_tokens': result.total_tokens, 'prompt_tokens': result.prompt_tokens, 'completion_tokens': result.completion_tokens, 'reasoning_tokens': result.effective_reasoning_tokens(), 'cache_creation_input_tokens': result.cache_creation_input_tokens, 'cache_read_input_tokens': result.cache_read_input_tokens})}\n\n"

    # P2 修复: 发射 [DONE] 信号，对齐 OpenAI SSE 标准和 ST sse-stream.js 的流结束检测
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
            result.cache_creation_input_tokens = int(usage.get("cache_creation_input_tokens", 0) or 0)
            prompt_details = usage.get("prompt_tokens_details") or {}
            result.cache_read_input_tokens = int(usage.get("cache_read_input_tokens", 0) or prompt_details.get("cached_tokens", 0) or 0)
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

        reasoning = delta.get("reasoning") or delta.get("reasoning_content")
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
