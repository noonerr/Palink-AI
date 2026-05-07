import asyncio
import json
import logging
from typing import Any, AsyncGenerator, Dict, List, Optional

from .llama_runtime import local_llama_runtime
from .llm_client import get_async_openai_client
from .local_model_registry import get_local_model_for_inference
from .inference_queue import inference_queue, RequestPriority
from .unified_model_registry import select_provider_for_model, find_model

logger = logging.getLogger(__name__)


def _estimate_tokens(text: str) -> int:
    if not text:
        return 0
    chinese_chars = sum(1 for c in text if '\u4e00' <= c <= '\u9fff')
    other_chars = len(text) - chinese_chars
    return int(chinese_chars * 1.5 + other_chars * 0.25)


def _resolve_local_model(model_id: str) -> Optional[Dict[str, Any]]:
    local_model = get_local_model_for_inference(model_id, require_enabled=True)
    if local_model:
        return local_model
    return None


def _get_mmproj_path(local_model: Dict[str, Any]) -> Optional[str]:
    if not local_model.get("mmproj_enabled"):
        return None
    mmproj = local_model.get("mmproj_path")
    if mmproj:
        return mmproj
    import os
    model_path = local_model.get("path", "")
    if model_path:
        base = model_path.rsplit(".", 1)[0]
        mmproj_candidates = [
            base.replace(".gguf", "-mmproj.gguf") if base.endswith(".gguf") else base + "-mmproj.gguf",
            base.replace("-Q4_K_M", "-mmproj-Q4_K_M").replace(".gguf", "-mmproj.gguf") if "-Q4_K_M" in base else None,
            os.path.join(os.path.dirname(model_path), "mmproj.gguf"),
        ]
        for candidate in mmproj_candidates:
            if candidate and os.path.isfile(candidate):
                return candidate
    return None


def ensure_model_available(model_id: str) -> None:
    local_model = _resolve_local_model(model_id)
    if local_model:
        return

    provider, _ = find_model(model_id)
    if not provider:
        raise ValueError("Model not configured or not available")


def _extract_images_from_messages(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    images = []
    for msg in messages:
        content = msg.get("content")
        if isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("type") == "image_url":
                    url = part.get("image_url", {}).get("url", "")
                    if url:
                        images.append({"url": url, "role": msg.get("role", "user")})
    return images


def _strip_images_from_messages(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    cleaned = []
    for msg in messages:
        content = msg.get("content")
        if isinstance(content, list):
            text_parts = []
            image_found = False
            for part in content:
                if isinstance(part, dict) and part.get("type") == "image_url":
                    image_found = True
                elif isinstance(part, dict) and part.get("type") == "text":
                    text_parts.append(part.get("text", ""))
                elif isinstance(part, str):
                    text_parts.append(part)
            if image_found and text_parts:
                new_msg = {k: v for k, v in msg.items() if k != "content"}
                new_msg["content"] = "\n".join(text_parts)
                cleaned.append(new_msg)
            elif not image_found:
                cleaned.append(msg)
            elif image_found and not text_parts:
                pass
        else:
            cleaned.append(msg)
    return cleaned


async def _describe_images_via_local_proxy(
    images: List[Dict[str, Any]],
    proxy_model_key: str,
) -> str:
    from .local_model_registry import get_local_model_for_inference

    proxy_model = get_local_model_for_inference(f"local:{proxy_model_key}", require_enabled=True)
    if not proxy_model:
        logger.error("Vision proxy model not found or not enabled: %s", proxy_model_key)
        return "[图片描述不可用：代理视觉模型未启用]"

    mmproj_path = _get_mmproj_path(proxy_model)
    if not mmproj_path:
        logger.error("Vision proxy model has no mmproj: %s", proxy_model_key)
        return "[图片描述不可用：代理视觉模型未配置mmproj]"

    vision_messages: List[Dict[str, Any]] = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "请详细描述以下图片的内容，包括所有可见的细节。如果有多张图片，请逐一描述。"},
            ] + [
                {"type": "image_url", "image_url": {"url": img["url"]}}
                for img in images
            ],
        }
    ]

    try:
        description = await local_llama_runtime.generate(
            model_key=proxy_model["key"],
            model_path=proxy_model["path"],
            messages=vision_messages,
            temperature=0.3,
            max_tokens=1024,
            top_p=0.95,
            mmproj_path=mmproj_path,
        )
        return description.strip() if description.strip() else "[图片描述为空]"
    except Exception as e:
        logger.error("Local vision proxy call failed: %s", e)
        return f"[图片描述失败: {str(e)[:100]}]"





async def complete_text_completion(
    model_id: str,
    messages: List[Dict[str, Any]],
    temperature: float = 0.7,
    max_tokens: int = 1024,
    top_p: float = 0.95,
    frequency_penalty: float = 0.0,
    presence_penalty: float = 0.0,
    timeout: float = 30.0,
) -> Dict[str, Any]:
    local_model = _resolve_local_model(model_id)
    if local_model:
        mmproj_path = _get_mmproj_path(local_model)

        content = await local_llama_runtime.generate(
            model_key=local_model["key"],
            model_path=local_model["path"],
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            top_p=top_p,
            mmproj_path=mmproj_path,
        )
        return {
            "content": content,
            "usage": {
                "total_tokens": len(content) // 2,
                "prompt_tokens": 0,
                "completion_tokens": len(content) // 2,
            },
        }

    provider, _ = find_model(model_id)
    if not provider:
        raise ValueError("Model not configured or not available")

    client = get_async_openai_client(
        api_key=provider["api_key"],
        base_url=provider["base_url"],
        timeout=timeout,
    )

    resp = await client.chat.completions.create(
        model=model_id,
        messages=messages,
        temperature=temperature,
        max_tokens=max_tokens,
        top_p=top_p,
        frequency_penalty=frequency_penalty,
        presence_penalty=presence_penalty,
    )

    content = ""
    reasoning_content = ""
    if resp and resp.choices:
        msg = resp.choices[0].message
        content = msg.content or ""
        reasoning_content = getattr(msg, "reasoning_content", None) or getattr(msg, "reasoning", None) or ""

    usage = getattr(resp, "usage", None)
    _rt = 0
    if usage:
        _details = getattr(usage, "completion_tokens_details", None)
        if _details:
            _rt = getattr(_details, "reasoning_tokens", 0) or 0
        if not _rt:
            _rt = getattr(usage, "reasoning_tokens", 0) or 0
    if not _rt and reasoning_content:
        _rt = _estimate_tokens(reasoning_content)
    usage_dict = {
        "total_tokens": getattr(usage, "total_tokens", 0) if usage else 0,
        "prompt_tokens": getattr(usage, "prompt_tokens", 0) if usage else 0,
        "completion_tokens": getattr(usage, "completion_tokens", 0) if usage else 0,
        "reasoning_tokens": _rt,
    }

    return {
        "content": content,
        "reasoning_content": reasoning_content,
        "usage": usage_dict,
    }


async def stream_text_completion(
    model_id: str,
    messages: List[Dict[str, Any]],
    temperature: float = 0.7,
    top_p: float = 0.95,
    max_tokens: int = 2048,
    frequency_penalty: float = 0.0,
    presence_penalty: float = 0.0,
    min_p: float = 0.05,
    top_k: int = 40,
    repetition_penalty: float = 1.1,
    timeout: float = 30.0,
    request_id: Optional[str] = None,
    user_id: Optional[int] = None,
    tools: Optional[List[Dict[str, Any]]] = None,
) -> AsyncGenerator[Dict[str, Any], None]:
    local_model = _resolve_local_model(model_id)
    if local_model:
        vision_source = local_model.get("vision_source")
        mmproj_path = _get_mmproj_path(local_model)

        processed_messages = messages
        images = _extract_images_from_messages(messages)
        if images and vision_source:
            description = None
            if vision_source.startswith("local:"):
                proxy_key = vision_source[len("local:"):]
                yield {"content": "🔍 正在通过本地视觉模型分析图片...\n\n"}
                description = await _describe_images_via_local_proxy(images, proxy_key)

            if description:
                text_messages = _strip_images_from_messages(messages)
                for msg in text_messages:
                    if msg.get("role") == "user" and msg.get("content"):
                        msg["content"] = f"[图片描述]\n{description}\n[/图片描述]\n\n{msg['content']}"
                        break
                else:
                    text_messages.append({
                        "role": "user",
                        "content": f"[图片描述]\n{description}\n[/图片描述]"
                    })
                processed_messages = text_messages

        if request_id:
            rid = inference_queue.submit_request(
                model_key=local_model["key"],
                user_id=user_id,
                priority=RequestPriority.NORMAL,
                max_concurrent=local_model.get("max_concurrent", 1),
            )

            status = inference_queue.get_queue_status(rid)
            yield {
                "type": "queue",
                "request_id": rid,
                "position": status.get("position", 0),
                "estimated_wait": status.get("estimated_wait", 0),
            }

            acquired = await inference_queue.acquire_slot(rid, model_key=local_model["key"], timeout=300.0)
            if not acquired:
                inference_queue.release_slot(rid, model_key=local_model["key"])
                yield {"content": "Error: 请求已取消或排队超时", "error": True}
                return

            cancel_event = inference_queue.get_cancel_event(rid)
            try:
                full_content = ""
                async for text_chunk in local_llama_runtime.generate_stream(
                    model_key=local_model["key"],
                    model_path=local_model["path"],
                    messages=processed_messages,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    top_p=top_p,
                    min_p=min_p,
                    top_k=top_k,
                    repetition_penalty=repetition_penalty,
                    mmproj_path=mmproj_path,
                ):
                    if cancel_event and cancel_event.is_set():
                        raise asyncio.CancelledError("Request cancelled")
                    full_content += text_chunk
                    yield {"content": text_chunk}

                if full_content:
                    chinese_chars = sum(1 for c in full_content if '\u4e00' <= c <= '\u9fff')
                    other_chars = len(full_content) - chinese_chars
                    completion_tokens = int(chinese_chars * 1.5 + other_chars * 0.25)
                    yield {
                        "usage": {
                            "total_tokens": completion_tokens,
                            "prompt_tokens": 0,
                            "completion_tokens": completion_tokens,
                            "reasoning_tokens": 0,
                        }
                    }
            finally:
                inference_queue.release_slot(rid, model_key=local_model["key"])
        else:
            async for text_chunk in local_llama_runtime.generate_stream(
                model_key=local_model["key"],
                model_path=local_model["path"],
                messages=processed_messages,
                temperature=temperature,
                max_tokens=max_tokens,
                top_p=top_p,
                min_p=min_p,
                top_k=top_k,
                repetition_penalty=repetition_penalty,
                mmproj_path=mmproj_path,
            ):
                yield {"content": text_chunk}

        return

    selection = select_provider_for_model(model_id)
    if not selection:
        raise ValueError("Model not configured or not available")

    provider_info, model_data = selection

    if provider_info.get("provider_type") == "local":
        lm = provider_info.get("local_model", {})
        mmproj_path = lm.get("mmproj_path") if lm.get("mmproj_enabled") else None
        async for text_chunk in local_llama_runtime.generate_stream(
            model_key=lm.get("key", ""),
            model_path=lm.get("path", ""),
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            top_p=top_p,
            mmproj_path=mmproj_path,
        ):
            yield {"content": text_chunk}
        return

    api_key = provider_info.get("api_key", "")
    base_url = provider_info.get("base_url", "")

    client = get_async_openai_client(
        api_key=api_key,
        base_url=base_url,
        timeout=timeout,
    )

    actual_model_id = model_id
    if model_data and isinstance(model_data, dict) and model_data.get("id"):
        actual_model_id = model_data["id"]

    stream_kwargs: Dict[str, Any] = {
        "model": actual_model_id,
        "messages": messages,
        "temperature": temperature,
        "top_p": top_p,
        "max_tokens": max_tokens,
        "frequency_penalty": frequency_penalty,
        "presence_penalty": presence_penalty,
        "stream": True,
    }

    if tools:
        stream_kwargs["tools"] = tools

    try:
        stream_kwargs["stream_options"] = {"include_usage": True}
        stream = await client.chat.completions.create(**stream_kwargs)
    except Exception as e:
        error_msg = str(e).lower()
        if "stream_options" in error_msg or "unknown parameter" in error_msg:
            logger.info("Provider does not support stream_options, retrying without it")
            stream_kwargs.pop("stream_options", None)
            stream = await client.chat.completions.create(**stream_kwargs)
        else:
            raise

    usage_payload: Optional[Dict[str, int]] = None
    tool_calls_accum: Dict[int, Dict[str, Any]] = {}

    async for chunk in stream:
        usage = getattr(chunk, "usage", None)
        if usage:
            _rt = 0
            _details = getattr(usage, "completion_tokens_details", None)
            if _details:
                _rt = getattr(_details, "reasoning_tokens", 0) or 0
            if not _rt:
                _rt = getattr(usage, "reasoning_tokens", 0) or 0
            usage_payload = {
                "total_tokens": getattr(usage, "total_tokens", 0) or 0,
                "prompt_tokens": getattr(usage, "prompt_tokens", 0) or 0,
                "completion_tokens": getattr(usage, "completion_tokens", 0) or 0,
                "reasoning_tokens": _rt,
            }

        if not chunk.choices:
            continue

        choice = chunk.choices[0]
        delta = choice.delta
        reasoning = getattr(delta, "reasoning_content", None) or getattr(delta, "reasoning", None)
        content = delta.content

        if hasattr(delta, "tool_calls") and delta.tool_calls:
            for tc in delta.tool_calls:
                idx = tc.index if hasattr(tc, "index") else 0
                if idx not in tool_calls_accum:
                    tool_calls_accum[idx] = {"id": "", "name": "", "arguments": ""}
                if hasattr(tc, "id") and tc.id:
                    tool_calls_accum[idx]["id"] = tc.id
                if hasattr(tc, "function") and tc.function:
                    if tc.function.name:
                        tool_calls_accum[idx]["name"] += tc.function.name
                    if tc.function.arguments:
                        tool_calls_accum[idx]["arguments"] += tc.function.arguments

        if reasoning:
            yield {"reasoning": reasoning}
        if content:
            yield {"content": content}

        if choice.finish_reason == "tool_calls" and tool_calls_accum:
            for idx in sorted(tool_calls_accum.keys()):
                tc_data = tool_calls_accum[idx]
                tool_name = tc_data["name"]
                tool_call_id = tc_data["id"]
                try:
                    tool_args = json.loads(tc_data["arguments"]) if tc_data["arguments"] else {}
                except json.JSONDecodeError:
                    tool_args = {}

                yield {"tool_call": {"id": tool_call_id, "name": tool_name, "arguments": tool_args}}

                try:
                    from .mcp_service import execute_tool_call
                    result = await execute_tool_call(tool_name, tool_args)
                    result_content = result.get("content", "") if isinstance(result, dict) else str(result)
                except Exception as e:
                    logger.warning("MCP tool %s execution failed: %s", tool_name, e)
                    result_content = f"Tool error: execution failed"

                yield {"tool_result": {"id": tool_call_id, "name": tool_name, "content": result_content}}

            tool_calls_accum.clear()

    if usage_payload and usage_payload.get("total_tokens", 0) > 0:
        yield {"usage": usage_payload}
