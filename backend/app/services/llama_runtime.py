import asyncio
import gc
import logging
import os
from typing import Any, AsyncGenerator, Dict, List, Optional

from .inference_queue import inference_queue, RequestPriority

logger = logging.getLogger(__name__)

LLAMA_CPP_AVAILABLE: Optional[bool] = None

GEMMA_VISION_CHAT_FORMAT = (
    "{% for message in messages %}"
    "{% if message.role == 'system' %}"
    "<start_of_turn>user\n{{ message.content }}<end_of_turn>\n"
    "{% endif %}"
    "{% if message.role == 'user' %}"
    "{% if message.content is string %}"
    "<start_of_turn>user\n{{ message.content }}<end_of_turn>\n"
    "{% elif message.content is iterable %}"
    "<start_of_turn>user\n"
    "{% for content in message.content %}"
    "{% if content.type == 'image_url' and content.image_url is string %}"
    "{{ content.image_url }} "
    "{% endif %}"
    "{% if content.type == 'image_url' and content.image_url is mapping %}"
    "{{ content.image_url.url }} "
    "{% endif %}"
    "{% endfor %}"
    "{% for content in message.content %}"
    "{% if content.type == 'text' %}"
    "{{ content.text }}"
    "{% endif %}"
    "{% endfor %}"
    "<end_of_turn>\n"
    "{% endif %}"
    "{% endif %}"
    "{% if message.role == 'assistant' and message.content is not none %}"
    "<start_of_turn>model\n{{ message.content }}<end_of_turn>\n"
    "{% endif %}"
    "{% endfor %}"
    "{% if add_generation_prompt %}"
    "<start_of_turn>model\n"
    "{% endif %}"
)


def _get_llama_class() -> Any:
    global LLAMA_CPP_AVAILABLE

    try:
        from llama_cpp import Llama as LlamaClass  # type: ignore

        LLAMA_CPP_AVAILABLE = True
        return LlamaClass
    except Exception:
        LLAMA_CPP_AVAILABLE = False
        return None


def _create_vision_chat_handler(mmproj_path: str) -> Any:
    try:
        from llama_cpp.llama_chat_format import Llava15ChatHandler  # type: ignore
        handler = Llava15ChatHandler(clip_model_path=mmproj_path, verbose=False)
        handler.CHAT_FORMAT = GEMMA_VISION_CHAT_FORMAT
        handler.DEFAULT_SYSTEM_MESSAGE = None
        return handler
    except Exception as e:
        logger.warning("Failed to create vision chat handler for mmproj %s: %s", mmproj_path, e)
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
    parts: List[str] = []
    for message in messages:
        role = str(message.get("role") or "user").lower()
        text = _flatten_content(message.get("content"))
        if not text:
            continue

        if role == "system":
            parts.append(f"<start_of_turn>user\n{text}<end_of_turn>")
        elif role == "assistant":
            parts.append(f"<start_of_turn>model\n{text}<end_of_turn>")
        else:
            parts.append(f"<start_of_turn>user\n{text}<end_of_turn>")

    parts.append("<start_of_turn>model\n")
    return "\n".join(parts)


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
        self._load_lock = asyncio.Lock()
        self._loaded_model_key: Optional[str] = None
        self._loaded_model_path: Optional[str] = None
        self._llm: Any = None
        self._mmproj_enabled: bool = False
        self._mmproj_path: Optional[str] = None

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

    def _create_llm(self, model_path: str, mmproj_path: Optional[str] = None) -> Any:
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

        if mmproj_path and os.path.isfile(mmproj_path):
            chat_handler = _create_vision_chat_handler(mmproj_path)
            if chat_handler is not None:
                kwargs["chat_handler"] = chat_handler
                logger.info("Loading llama.cpp model with vision chat_handler: %s, mmproj: %s", model_path, mmproj_path)
            else:
                logger.warning("Vision chat_handler creation failed, loading model without vision support: %s", model_path)
        else:
            logger.info("Loading llama.cpp model: %s", model_path)

        return llama_class(**kwargs)

    def _ensure_model_loaded_blocking(self, model_key: str, model_path: str, mmproj_path: Optional[str] = None) -> None:
        mmproj_changed = (self._mmproj_path != mmproj_path) or (self._mmproj_enabled != bool(mmproj_path))
        if self._llm is not None and self._loaded_model_key == model_key and self._loaded_model_path == model_path and not mmproj_changed:
            return

        if self._llm is not None:
            self._llm = None
            self._loaded_model_key = None
            self._loaded_model_path = None
            self._mmproj_path = None
            self._mmproj_enabled = False
            gc.collect()

        self._llm = self._create_llm(model_path, mmproj_path=mmproj_path)
        self._loaded_model_key = model_key
        self._loaded_model_path = model_path
        self._mmproj_path = mmproj_path
        self._mmproj_enabled = bool(mmproj_path and os.path.isfile(mmproj_path))

    def _run_chat_completion_blocking(
        self,
        messages: List[Dict[str, Any]],
        temperature: float,
        max_tokens: int,
        top_p: float,
        min_p: float = 0.05,
        top_k: int = 40,
        repetition_penalty: float = 1.1,
    ) -> str:
        if self._llm is None:
            raise RuntimeError("No local model loaded")

        stop_tokens = ["<end_of_turn>", "<|end_of_turn|>", "<|im_end|>"]

        try:
            response = self._llm.create_chat_completion(
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
                top_p=top_p,
                min_p=min_p,
                top_k=top_k,
                repeat_penalty=repetition_penalty,
                stop=stop_tokens,
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
            min_p=min_p,
            top_k=top_k,
            repeat_penalty=repetition_penalty,
            stop=stop_tokens,
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
        min_p: float = 0.05,
        top_k: int = 40,
        repetition_penalty: float = 1.1,
        mmproj_path: Optional[str] = None,
    ) -> str:
        async with self._load_lock:
            await asyncio.to_thread(self._ensure_model_loaded_blocking, model_key, model_path, mmproj_path)
        return await asyncio.to_thread(
            self._run_chat_completion_blocking,
            messages,
            float(temperature),
            int(max_tokens),
            float(top_p),
            float(min_p),
            int(top_k),
            float(repetition_penalty),
        )

    async def generate_stream(
        self,
        model_key: str,
        model_path: str,
        messages: List[Dict[str, Any]],
        temperature: float = 0.7,
        max_tokens: int = 1024,
        top_p: float = 0.95,
        min_p: float = 0.05,
        top_k: int = 40,
        repetition_penalty: float = 1.1,
        mmproj_path: Optional[str] = None,
    ) -> AsyncGenerator[str, None]:
        async with self._load_lock:
            await asyncio.to_thread(self._ensure_model_loaded_blocking, model_key, model_path, mmproj_path)

        queue: asyncio.Queue[Optional[str]] = asyncio.Queue()
        loop = asyncio.get_running_loop()
        errors: List[BaseException] = []
        stop_tokens = ["<end_of_turn>", "<|end_of_turn|>", "<|im_end|>"]
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
                        min_p=float(min_p),
                        top_k=int(top_k),
                        repeat_penalty=float(repetition_penalty),
                        stream=True,
                        stop=stop_tokens,
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
                    min_p=float(min_p),
                    top_k=int(top_k),
                    repeat_penalty=float(repetition_penalty),
                    stream=True,
                    stop=stop_tokens,
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

        # Wait for worker to complete after the stream is done
        await worker

        if errors:
            raise RuntimeError(str(errors[0]))


local_llama_runtime = LlamaRuntime()
