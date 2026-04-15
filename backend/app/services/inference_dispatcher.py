from typing import Any, AsyncGenerator, Dict, List, Optional

from .llama_runtime import local_llama_runtime
from .llm_client import get_async_openai_client
from .local_model_registry import get_local_model_for_inference
from .provider_registry import find_model


def _resolve_local_model(model_id: str) -> Optional[Dict[str, Any]]:
    # Backward-compat: accept legacy local IDs without `local:` prefix.
    local_model = get_local_model_for_inference(model_id, require_enabled=True)
    if local_model:
        return local_model
    return None


def ensure_model_available(model_id: str) -> None:
    local_model = _resolve_local_model(model_id)
    if local_model:
        return

    provider, _ = find_model(model_id)
    if not provider:
        raise ValueError("Model not configured or not available")


async def complete_text_completion(
    model_id: str,
    messages: List[Dict[str, Any]],
    temperature: float = 0.7,
    max_tokens: int = 1024,
    timeout: float = 30.0,
) -> Dict[str, Any]:
    local_model = _resolve_local_model(model_id)
    if local_model:

        content = await local_llama_runtime.generate(
            model_key=local_model["key"],
            model_path=local_model["path"],
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            top_p=0.95,
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
    )

    content = ""
    if resp and resp.choices:
        content = resp.choices[0].message.content or ""

    usage = getattr(resp, "usage", None)
    usage_dict = {
        "total_tokens": getattr(usage, "total_tokens", 0) if usage else 0,
        "prompt_tokens": getattr(usage, "prompt_tokens", 0) if usage else 0,
        "completion_tokens": getattr(usage, "completion_tokens", 0) if usage else 0,
    }

    return {
        "content": content,
        "usage": usage_dict,
    }


async def stream_text_completion(
    model_id: str,
    messages: List[Dict[str, Any]],
    temperature: float = 0.7,
    timeout: float = 30.0,
) -> AsyncGenerator[Dict[str, Any], None]:
    local_model = _resolve_local_model(model_id)
    if local_model:

        full_content = ""
        async for text_chunk in local_llama_runtime.generate_stream(
            model_key=local_model["key"],
            model_path=local_model["path"],
            messages=messages,
            temperature=temperature,
            max_tokens=1024,
            top_p=0.95,
        ):
            full_content += text_chunk
            yield {"content": text_chunk}

        if full_content:
            completion_tokens = len(full_content) // 2
            yield {
                "usage": {
                    "total_tokens": completion_tokens,
                    "prompt_tokens": 0,
                    "completion_tokens": completion_tokens,
                }
            }
        return

    provider, _ = find_model(model_id)
    if not provider:
        raise ValueError("Model not configured or not available")

    client = get_async_openai_client(
        api_key=provider["api_key"],
        base_url=provider["base_url"],
        timeout=timeout,
    )

    stream_kwargs: Dict[str, Any] = {
        "model": model_id,
        "messages": messages,
        "temperature": temperature,
        "stream": True,
    }

    try:
        stream_kwargs["stream_options"] = {"include_usage": True}
        stream = await client.chat.completions.create(**stream_kwargs)
    except Exception:
        stream_kwargs.pop("stream_options", None)
        stream = await client.chat.completions.create(**stream_kwargs)

    usage_payload: Optional[Dict[str, int]] = None

    async for chunk in stream:
        usage = getattr(chunk, "usage", None)
        if usage:
            usage_payload = {
                "total_tokens": getattr(usage, "total_tokens", 0) or 0,
                "prompt_tokens": getattr(usage, "prompt_tokens", 0) or 0,
                "completion_tokens": getattr(usage, "completion_tokens", 0) or 0,
            }

        if not chunk.choices:
            continue

        delta = chunk.choices[0].delta
        reasoning = getattr(delta, "reasoning_content", None) or getattr(delta, "reasoning", None)
        content = delta.content

        if reasoning:
            yield {"reasoning": reasoning}
        if content:
            yield {"content": content}

    if usage_payload and usage_payload.get("total_tokens", 0) > 0:
        yield {"usage": usage_payload}
