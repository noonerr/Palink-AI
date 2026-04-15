import asyncio
import gc
import logging
import os
from typing import Any, AsyncGenerator, Dict, List, Optional


logger = logging.getLogger(__name__)

LLAMA_CPP_AVAILABLE: Optional[bool] = None


def _get_llama_class() -> Any:
    global LLAMA_CPP_AVAILABLE

    try:
        from llama_cpp import Llama as LlamaClass  # type: ignore

        LLAMA_CPP_AVAILABLE = True
        return LlamaClass
    except Exception:
        LLAMA_CPP_AVAILABLE = False
        return None


def _flatten_content(content: Any) -> str:
    if isinstance(content, str):
        return content

    if isinstance(content, list):
        parts: List[str] = []
        for item in content:
            if isinstance(item, dict):
                if item.get("type") == "text" and isinstance(item.get("text"), str):
                    parts.append(item["text"])
            elif isinstance(item, str):
                parts.append(item)
        return "\n".join(parts).strip()

    return ""


def _messages_to_prompt(messages: List[Dict[str, Any]]) -> str:
    lines: List[str] = []
    for message in messages:
        role = str(message.get("role") or "user").lower()
        text = _flatten_content(message.get("content"))
        if not text:
            continue

        if role == "system":
            lines.append(f"System: {text}")
        elif role == "assistant":
            lines.append(f"Assistant: {text}")
        else:
            lines.append(f"User: {text}")

    lines.append("Assistant:")
    return "\n\n".join(lines)


def _extract_chat_stream_text(chunk: Any) -> str:
    if isinstance(chunk, dict):
        choices = chunk.get("choices") or []
        if not choices:
            return ""
        choice = choices[0] or {}
        delta = choice.get("delta") or {}
        content = delta.get("content")
        if isinstance(content, str):
            return content
        message = choice.get("message") or {}
        content = message.get("content")
        if isinstance(content, str):
            return content
    return ""


def _extract_completion_stream_text(chunk: Any) -> str:
    if isinstance(chunk, dict):
        choices = chunk.get("choices") or []
        if not choices:
            return ""
        text = choices[0].get("text")
        if isinstance(text, str):
            return text
    return ""


class LlamaRuntime:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._loaded_model_key: Optional[str] = None
        self._loaded_model_path: Optional[str] = None
        self._llm: Any = None

    @staticmethod
    def _read_int_env(name: str, default: int) -> int:
        raw = os.getenv(name)
        if raw is None:
            return default
        try:
            return int(raw)
        except ValueError:
            return default

    @staticmethod
    def _read_float_env(name: str, default: float) -> float:
        raw = os.getenv(name)
        if raw is None:
            return default
        try:
            return float(raw)
        except ValueError:
            return default

    def _create_llm(self, model_path: str) -> Any:
        llama_class = _get_llama_class()
        if llama_class is None:
            raise RuntimeError(
                "llama-cpp-python is not available. Please ensure the dependency is installed."
            )

        n_ctx = self._read_int_env("LLAMA_CPP_N_CTX", 4096)
        n_gpu_layers = self._read_int_env("LLAMA_CPP_N_GPU_LAYERS", 0)
        n_threads = self._read_int_env("LLAMA_CPP_THREADS", 0)

        kwargs: Dict[str, Any] = {
            "model_path": model_path,
            "n_ctx": max(256, n_ctx),
            "verbose": False,
        }

        if n_gpu_layers >= 0:
            kwargs["n_gpu_layers"] = n_gpu_layers

        if n_threads > 0:
            kwargs["n_threads"] = n_threads

        logger.info("Loading llama.cpp model: %s", model_path)
        return llama_class(**kwargs)

    def _ensure_model_loaded_blocking(self, model_key: str, model_path: str) -> None:
        if self._llm is not None and self._loaded_model_key == model_key and self._loaded_model_path == model_path:
            return

        if self._llm is not None:
            self._llm = None
            self._loaded_model_key = None
            self._loaded_model_path = None
            gc.collect()

        self._llm = self._create_llm(model_path)
        self._loaded_model_key = model_key
        self._loaded_model_path = model_path

    def _run_chat_completion_blocking(
        self,
        messages: List[Dict[str, Any]],
        temperature: float,
        max_tokens: int,
        top_p: float,
    ) -> str:
        if self._llm is None:
            raise RuntimeError("No local model loaded")

        stop_tokens = ["\nUser:", "\n\nUser:", "<|im_end|>"]
        repeat_penalty = max(self._read_float_env("LLAMA_CPP_REPEAT_PENALTY", 1.1), 1.0)

        try:
            response = self._llm.create_chat_completion(
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
                top_p=top_p,
                stop=stop_tokens,
                repeat_penalty=repeat_penalty,
            )
            choices = response.get("choices") or []
            if choices:
                message = choices[0].get("message") or {}
                content = message.get("content")
                if isinstance(content, str) and content.strip():
                    return content.strip()
        except Exception:
            logger.debug("create_chat_completion failed, falling back to plain completion", exc_info=True)

        prompt = _messages_to_prompt(messages)
        response = self._llm(
            prompt,
            temperature=temperature,
            max_tokens=max_tokens,
            top_p=top_p,
            stop=stop_tokens,
            repeat_penalty=repeat_penalty,
        )
        choices = response.get("choices") or []
        if not choices:
            return ""

        text = choices[0].get("text")
        if isinstance(text, str):
            return text.strip()

        return ""

    async def generate(
        self,
        model_key: str,
        model_path: str,
        messages: List[Dict[str, Any]],
        temperature: float = 0.7,
        max_tokens: int = 1024,
        top_p: float = 0.95,
    ) -> str:
        async with self._lock:
            await asyncio.to_thread(self._ensure_model_loaded_blocking, model_key, model_path)
            return await asyncio.to_thread(
                self._run_chat_completion_blocking,
                messages,
                float(temperature),
                int(max_tokens),
                float(top_p),
            )

    async def generate_stream(
        self,
        model_key: str,
        model_path: str,
        messages: List[Dict[str, Any]],
        temperature: float = 0.7,
        max_tokens: int = 1024,
        top_p: float = 0.95,
    ) -> AsyncGenerator[str, None]:
        async with self._lock:
            await asyncio.to_thread(self._ensure_model_loaded_blocking, model_key, model_path)

            queue: asyncio.Queue[Optional[str]] = asyncio.Queue()
            loop = asyncio.get_running_loop()
            errors: List[BaseException] = []
            stop_tokens = ["\nUser:", "\n\nUser:", "<|im_end|>"]
            repeat_penalty = max(self._read_float_env("LLAMA_CPP_REPEAT_PENALTY", 1.1), 1.0)

            def _emit(piece: str) -> None:
                if not piece:
                    return
                loop.call_soon_threadsafe(queue.put_nowait, piece)

            def _stream_blocking() -> None:
                try:
                    if self._llm is None:
                        return

                    try:
                        stream = self._llm.create_chat_completion(
                            messages=messages,
                            temperature=float(temperature),
                            max_tokens=int(max_tokens),
                            top_p=float(top_p),
                            stream=True,
                            stop=stop_tokens,
                            repeat_penalty=repeat_penalty,
                        )
                        for chunk in stream:
                            _emit(_extract_chat_stream_text(chunk))
                        return
                    except Exception:
                        logger.debug("streaming create_chat_completion failed, falling back to plain completion", exc_info=True)

                    prompt = _messages_to_prompt(messages)
                    stream = self._llm(
                        prompt,
                        temperature=float(temperature),
                        max_tokens=int(max_tokens),
                        top_p=float(top_p),
                        stream=True,
                        stop=stop_tokens,
                        repeat_penalty=repeat_penalty,
                    )
                    for chunk in stream:
                        _emit(_extract_completion_stream_text(chunk))
                except BaseException as exc:
                    errors.append(exc)
                finally:
                    loop.call_soon_threadsafe(queue.put_nowait, None)

            worker = asyncio.create_task(asyncio.to_thread(_stream_blocking))

            last_piece = ""
            repeated = 0
            repeat_guard = max(self._read_int_env("LLAMA_STREAM_REPEAT_CHUNK_LIMIT", 6), 2)

            while True:
                piece = await queue.get()
                if piece is None:
                    break

                if piece == last_piece:
                    repeated += 1
                    if repeated >= repeat_guard:
                        continue
                else:
                    last_piece = piece
                    repeated = 0

                yield piece

            await worker

            if errors:
                raise RuntimeError(str(errors[0]))


local_llama_runtime = LlamaRuntime()
