"""ST-aligned tokenizer service — provides precise token counting for all
SillyTavern-supported model families.

Aligns with SillyTavern 1.18.0 ``src/endpoints/tokenizers.js``:

Tokenizer backends:
    - **tiktoken**: OpenAI models (gpt-4o, gpt-4, gpt-3.5-turbo, o1, etc.)
      Uses ``tiktoken.encoding_for_model(model)`` for model-specific BPE.
    - **sentencepiece**: Llama, Mistral, Yi, Gemma, Jamba, Nerdstash
      Loads ``.model`` files via ``sentencepiece.SentencePieceProcessor``.
    - **huggingface tokenizers**: Claude, Llama3, Qwen2, Command-R, etc.
      Loads ``.json`` files via ``tokenizers.Tokenizer.from_file``.

Model name → tokenizer type mapping mirrors ST's ``getTokenizerModel()``
(``tokenizers.js:441-528``). Tokenizer model files are bundled in
``app/tokenizers/`` directory (copied from ST's ``src/tokenizers/``).

Fallback chain:
    1. Model-specific tokenizer (tiktoken/sentencepiece/hf-tokenizers)
    2. tiktoken cl100k_base (if tiktoken available)
    3. Guesstimate: ``ceil(utf8_byte_length / 3.35)`` (ST's ``guesstimate()``)

All public functions are thread-safe (tokenizer loading uses a lock).
"""
from __future__ import annotations

import contextvars
import logging
import math
import os
import threading
import time
from typing import Any, Optional, Tuple

logger = logging.getLogger(__name__)

# ── Tokenizer model files directory ───────────────────────────────────
_TOKENIZER_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "tokenizers")

# 远程下载的 HF tokenizer（deepseek/qwen2/command-r 等）需要可写目录落盘。
# 容器运行时 tokenizers/ 目录为 root:root 只读，故下载缓存写到 /tmp。
_TOKENIZER_CACHE_DIR = "/tmp/palink_tokenizers"
os.makedirs(_TOKENIZER_CACHE_DIR, exist_ok=True)

# ── ST's BYTES_PER_TOKEN constant (tokenizers.js:60) ─────────────────
BYTES_PER_TOKEN = 3.35

# ── Context-local current model name (for thread-safe token counting) ─
# Set by roleplay_prompt_assembly at the start of prompt building, read by
# _estimate_tokens in prompt assembly and worldbook service.
_current_model: contextvars.ContextVar[str] = contextvars.ContextVar(
    "st_current_model", default=""
)


def set_current_model(model_name: str) -> contextvars.Token:
    """Set the current model name for token counting (contextvar).

    Returns a token that should be passed to ``reset_current_model`` to
    restore the previous value. This is thread-safe and async-safe.
    """
    return _current_model.set(model_name or "")


def reset_current_model(token: contextvars.Token) -> None:
    """Reset the current model name to its previous value."""
    _current_model.reset(token)


def get_current_model() -> str:
    """Get the current model name for token counting."""
    return _current_model.get()


def get_token_count_for_current_model(text: str) -> int:
    """Count tokens using the current model's tokenizer (from contextvar).

    This is the preferred entry point for token counting during prompt
    assembly, as it automatically uses the correct tokenizer for the
    current model. Falls back to ``guesstimate`` when no model is set
    or the tokenizer is unavailable.
    """
    model = _current_model.get()
    if model:
        return get_token_count(text, model)
    return guesstimate(text)

# ── SentencePiece model file mapping ──────────────────────────────────
_SENTENCEPIECE_FILES = {
    "llama": "llama.model",
    "mistral": "mistral.model",
    "yi": "yi.model",
    "gemma": "gemma.model",
    "jamba": "jamba.model",
    "nerdstash": "nerdstash.model",
    "nerdstash_v2": "nerdstash_v2.model",
}

# ── HuggingFace tokenizers JSON file mapping ──────────────────────────
_HF_TOKENIZER_FILES = {
    "claude": "claude.json",
    "llama3": "llama3.json",
    # Remote tokenizers (downloaded lazily from ST's GitHub repo)
    "qwen2": "qwen2.json",
    "command-r": "command-r.json",
    "command-a": "command-a.json",
    "nemo": "nemo.json",
    "deepseek": "deepseek.json",
}

# Remote tokenizer download URLs (ST's SillyTavern-Tokenizers GitHub repo)
_REMOTE_TOKENIZER_BASE = (
    "https://github.com/SillyTavern/SillyTavern-Tokenizers/raw/main"
)
_REMOTE_TOKENIZER_URLS = {
    "qwen2": f"{_REMOTE_TOKENIZER_BASE}/qwen2.json.gz",
    "command-r": f"{_REMOTE_TOKENIZER_BASE}/command-r.json.gz",
    "command-a": f"{_REMOTE_TOKENIZER_BASE}/command-a.json.gz",
    "nemo": f"{_REMOTE_TOKENIZER_BASE}/nemo.json.gz",
    "deepseek": f"{_REMOTE_TOKENIZER_BASE}/deepseek.json.gz",
}

# ── tiktoken encoding cache ───────────────────────────────────────────
_tiktoken_lib = None
_tiktoken_enc_cache: dict[str, Any] = {}
_tiktoken_lock = threading.Lock()

try:  # pragma: no cover - depends on environment
    import tiktoken as _tiktoken_lib  # type: ignore
except ImportError:  # pragma: no cover
    _tiktoken_lib = None

# ── SentencePiece cache ───────────────────────────────────────────────
_sentencepiece_lib = None
_sp_cache: dict[str, Any] = {}
_sp_lock = threading.Lock()

try:  # pragma: no cover
    import sentencepiece as _sentencepiece_lib  # type: ignore
except ImportError:  # pragma: no cover
    _sentencepiece_lib = None

# ── HuggingFace tokenizers cache ──────────────────────────────────────
_hf_tokenizers_lib = None
_hf_cache: dict[str, Any] = {}
_hf_lock = threading.Lock()

try:  # pragma: no cover
    from tokenizers import Tokenizer as _hf_tokenizers_lib  # type: ignore
except ImportError:  # pragma: no cover
    _hf_tokenizers_lib = None


# ── Guesstimate (ST tokenizers.js:69-72) ──────────────────────────────
def guesstimate(text: str) -> int:
    """ST's fallback token count: ``ceil(utf8_byte_length / 3.35)``.

    Aligns with SillyTavern 1.18.0 ``tokenizers.js:69-72``::
        function guesstimate(str) {
            const byteLength = Buffer.byteLength(str, 'utf8');
            return Math.ceil(byteLength / BYTES_PER_TOKEN);
        }
    """
    if not text:
        return 0
    byte_length = len(text.encode("utf-8"))
    return math.ceil(byte_length / BYTES_PER_TOKEN)


# ── Model name → tokenizer type mapping (ST tokenizers.js:441-528) ────
# ST's TEXT_COMPLETION_MODELS that use tiktoken
_TEXT_COMPLETION_MODELS = frozenset({
    "gpt-3.5-turbo-instruct",
    "gpt-3.5-turbo-instruct-0914",
    "text-davinci-003",
    "text-davinci-002",
    "text-davinci-001",
    "text-curie-001",
    "text-babbage-001",
    "text-ada-001",
    "code-davinci-002",
    "code-davinci-001",
    "code-cushman-002",
    "code-cushman-001",
    "text-davinci-edit-001",
    "code-davinci-edit-001",
    "text-embedding-ada-002",
    "text-similarity-davinci-001",
    "text-similarity-curie-001",
    "text-similarity-babbage-001",
    "text-similarity-ada-001",
    "text-search-davinci-doc-001",
    "text-search-curie-doc-001",
    "text-search-babbage-doc-001",
    "text-search-ada-doc-001",
    "code-search-babbage-code-001",
    "code-search-ada-code-001",
})


def get_tokenizer_model(request_model: str) -> str:
    """Map a model name to its tokenizer type.

    Mirrors ST 1.18.0 ``tokenizers.js:441-528`` ``getTokenizerModel()``.

    Returns one of:
        - OpenAI model names (``gpt-4o``, ``gpt-4``, ``gpt-3.5-turbo``, ``o1``, etc.)
          → resolved via ``tiktoken.encoding_for_model``
        - ``claude``, ``llama3``, ``llama``, ``mistral``, ``yi``, ``gemma``,
          ``jamba``, ``qwen2``, ``command-r``, ``command-a``, ``nemo``,
          ``deepseek``, ``nerdstash``, ``nerdstash_v2``
        - Default: ``gpt-3.5-turbo``
    """
    if not request_model:
        return "gpt-3.5-turbo"

    m = request_model.lower()

    # OpenAI reasoning models
    if m == "o1" or "o1-preview" in m or "o1-mini" in m or "o3-mini" in m:
        return "o1"
    if "gpt-5" in m or "o3" in m or "o4-mini" in m:
        return "o1"

    # OpenAI chat models
    if "gpt-4o" in m or "chatgpt-4o-latest" in m:
        return "gpt-4o"
    if "gpt-4.1" in m or "gpt-4.5" in m:
        return "gpt-4o"
    if "gpt-4-32k" in m:
        return "gpt-4-32k"
    if "gpt-4" in m:
        return "gpt-4"
    if "gpt-3.5-turbo-0301" in m:
        return "gpt-3.5-turbo-0301"
    if "gpt-3.5-turbo" in m:
        return "gpt-3.5-turbo"

    # OpenAI text completion models
    if request_model in _TEXT_COMPLETION_MODELS:
        return request_model

    # Non-OpenAI models
    if "claude" in m:
        return "claude"
    if "llama3" in m or "llama-3" in m:
        return "llama3"
    if "llama" in m:
        return "llama"
    if "mistral" in m or "mixtral" in m:
        return "mistral"
    if "yi" in m:
        return "yi"
    if "deepseek" in m:
        return "deepseek"
    if "gemma" in m or "gemini" in m or "learnlm" in m:
        return "gemma"
    if "jamba" in m:
        return "jamba"
    if "qwen2" in m:
        return "qwen2"
    if "command-r" in m:
        return "command-r"
    if "command-a" in m:
        return "command-a"
    if "nemo" in m or "pixtral" in m:
        return "nemo"

    # Default (ST: 'gpt-3.5-turbo')
    return "gpt-3.5-turbo"


# ── tiktoken loader ───────────────────────────────────────────────────
def _load_tiktoken(model_name: str) -> Optional[Any]:
    """Load a tiktoken encoder for the given OpenAI model name.

    Uses ``tiktoken.encoding_for_model(model)`` which maps model names to
    their BPE encoding (e.g., gpt-4o → o200k_base, gpt-4 → cl100k_base).
    Falls back to ``cl100k_base`` if the model is unknown.

    Special case: ``"gpt2"`` is treated as an encoding name (not a model name)
    and loaded via ``tiktoken.get_encoding("gpt2")``.
    """
    if _tiktoken_lib is None:
        return None
    with _tiktoken_lock:
        if model_name in _tiktoken_enc_cache:
            return _tiktoken_enc_cache[model_name]

        # "gpt2" is an encoding name, not a model name
        if model_name == "gpt2":
            try:
                enc = _tiktoken_lib.get_encoding("gpt2")
                _tiktoken_enc_cache[model_name] = enc
                logger.debug("Loaded tiktoken encoding: gpt2")
                return enc
            except Exception:  # pragma: no cover
                pass

        try:
            enc = _tiktoken_lib.encoding_for_model(model_name)
            _tiktoken_enc_cache[model_name] = enc
            logger.debug("Loaded tiktoken encoder for model: %s", model_name)
            return enc
        except Exception:
            pass
        # Fallback to cl100k_base
        try:
            enc = _tiktoken_lib.get_encoding("cl100k_base")
            _tiktoken_enc_cache[model_name] = enc
            return enc
        except Exception:  # pragma: no cover
            return None


# ── SentencePiece loader ──────────────────────────────────────────────
def _load_sentencepiece(tokenizer_type: str) -> Optional[Any]:
    """Load a SentencePiece processor from bundled ``.model`` files."""
    if _sentencepiece_lib is None:
        return None
    filename = _SENTENCEPIECE_FILES.get(tokenizer_type)
    if not filename:
        return None
    model_path = os.path.join(_TOKENIZER_DIR, filename)
    if not os.path.exists(model_path):
        logger.warning("SentencePiece model file not found: %s", model_path)
        return None
    with _sp_lock:
        if tokenizer_type in _sp_cache:
            return _sp_cache[tokenizer_type]
        try:
            sp = _sentencepiece_lib.SentencePieceProcessor()
            # SentencePiece 的 C++ 底层 sp.Load(path) 在 Windows 上无法打开含
            # 非 ASCII 字符的路径（例如安装目录含中文），会误报 NOT_FOUND。
            # 改为在 Python 侧读取文件字节（Python 正确处理 unicode 路径），
            # 通过 model_proto 加载，彻底规避该问题；失败时回退到路径加载。
            try:
                with open(model_path, "rb") as _mf:
                    _model_bytes = _mf.read()
                sp.LoadFromSerializedProto(_model_bytes)
            except Exception:
                sp.Load(model_path)
            _sp_cache[tokenizer_type] = sp
            logger.debug("Loaded SentencePiece tokenizer: %s", tokenizer_type)
            return sp
        except Exception as exc:
            logger.warning("Failed to load SentencePiece tokenizer %s: %s", tokenizer_type, exc)
            return None


# ── HuggingFace tokenizers loader ─────────────────────────────────────
# 远程下载失败缓存：某 tokenizer 下载失败后，在 _REMOTE_DL_RETRY_AFTER 秒内不再重试，
# 直接走 guesstimate 回退，避免在无外网环境下每次请求都同步阻塞等待超时（曾导致
# 发消息时整个后端假死——每组装一条 prompt 就对 deepseek 尝试下载并等 30s 超时）。
_REMOTE_DL_RETRY_AFTER = 600  # 10 分钟
_remote_dl_failed: dict[str, float] = {}
_remote_dl_lock = threading.Lock()


def _remote_download_failed(tokenizer_type: str) -> bool:
    """Return True if a recent download attempt for ``tokenizer_type`` failed."""
    with _remote_dl_lock:
        failed_at = _remote_dl_failed.get(tokenizer_type)
        if failed_at is None:
            return False
        return (time.monotonic() - failed_at) < _REMOTE_DL_RETRY_AFTER


def _mark_remote_download_failed(tokenizer_type: str) -> None:
    with _remote_dl_lock:
        _remote_dl_failed[tokenizer_type] = time.monotonic()


def _download_remote_tokenizer(tokenizer_type: str) -> Optional[str]:
    """Kick off (or reuse) a *non-blocking* background download of a remote
    tokenizer JSON file from ST's GitHub repo.

    The actual network download runs in a daemon thread so this function
    **never blocks the event loop** — critical because token counting runs
    inside the async message-send path on a single uvicorn worker. A blocking
    download here would freeze every other HTTP request (nginx → Bad Gateway →
    frontend "connection slow" / endless loading).

    Returns the local file path if already cached on disk, otherwise ``None``
    immediately while the background download populates the disk cache for
    subsequent calls. A failed download is cached (see ``_REMOTE_DL_RETRY_AFTER``).
    """
    if tokenizer_type not in _REMOTE_TOKENIZER_URLS:
        return None
    local_json = os.path.join(_TOKENIZER_CACHE_DIR, f"{tokenizer_type}.json")
    if os.path.exists(local_json):
        return local_json
    if _remote_download_failed(tokenizer_type):
        return None
    _maybe_start_background_download(tokenizer_type)
    return None


_download_started: dict[str, bool] = {}
_download_started_lock = threading.Lock()


def _maybe_start_background_download(tokenizer_type: str) -> None:
    with _download_started_lock:
        if _download_started.get(tokenizer_type):
            return
        _download_started[tokenizer_type] = True
    thread = threading.Thread(
        target=_download_remote_tokenizer_worker,
        args=(tokenizer_type,),
        name=f"palink-tokenizer-dl-{tokenizer_type}",
        daemon=True,
    )
    thread.start()


def _download_remote_tokenizer_worker(tokenizer_type: str) -> None:
    local_json = os.path.join(_TOKENIZER_CACHE_DIR, f"{tokenizer_type}.json")
    try:
        url = _REMOTE_TOKENIZER_URLS[tokenizer_type]
        import gzip
        import tempfile
        import urllib.request

        logger.info("Downloading remote tokenizer: %s from %s", tokenizer_type, url)
        with urllib.request.urlopen(url, timeout=10) as resp:
            gz_data = resp.read()
        json_data = gzip.decompress(gz_data)
        # Atomic write via temp file
        fd, tmp_path = tempfile.mkstemp(dir=_TOKENIZER_CACHE_DIR, suffix=".tmp")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(json_data)
            os.replace(tmp_path, local_json)
        except Exception:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise
        logger.info("Downloaded tokenizer %s (%d bytes)", tokenizer_type, len(json_data))
    except Exception as exc:
        _mark_remote_download_failed(tokenizer_type)
        logger.warning(
            "Failed to download tokenizer %s: %s (will not retry for %ds)",
            tokenizer_type, exc, _REMOTE_DL_RETRY_AFTER,
        )
    finally:
        with _download_started_lock:
            _download_started[tokenizer_type] = False


def _load_hf_tokenizer(tokenizer_type: str) -> Optional[Any]:
    """Load a HuggingFace tokenizer from a ``.json`` file.

    Bundled files: claude.json, llama3.json.
    Remote files (downloaded lazily): qwen2.json, command-r.json, etc.
    """
    if _hf_tokenizers_lib is None:
        return None
    filename = _HF_TOKENIZER_FILES.get(tokenizer_type)
    if not filename:
        return None
    model_path = os.path.join(_TOKENIZER_DIR, filename)

    # If not bundled, try downloading
    if not os.path.exists(model_path):
        model_path = _download_remote_tokenizer(tokenizer_type)
        if not model_path:
            return None

    with _hf_lock:
        if tokenizer_type in _hf_cache:
            return _hf_cache[tokenizer_type]
        try:
            tok = _hf_tokenizers_lib.from_file(model_path)
            _hf_cache[tokenizer_type] = tok
            logger.debug("Loaded HF tokenizer: %s", tokenizer_type)
            return tok
        except Exception as exc:
            logger.warning("Failed to load HF tokenizer %s: %s", tokenizer_type, exc)
            return None


# ── Unified tokenizer resolver ────────────────────────────────────────
def _resolve_tokenizer(tokenizer_type: str) -> Tuple[Optional[Any], str]:
    """Resolve a tokenizer type to an actual tokenizer instance.

    Returns ``(tokenizer_instance, backend_name)`` where backend_name is
    one of ``"tiktoken"``, ``"sentencepiece"``, ``"hf-tokenizers"``,
    or ``"none"`` (when no tokenizer is available).

    The resolution order follows ST's backend:
    1. SentencePiece types → sentencepiece loader
    2. HF tokenizers types → HF tokenizers loader
    3. OpenAI/text-completion types → tiktoken loader
    4. Default → tiktoken cl100k_base
    """
    # SentencePiece tokenizers
    if tokenizer_type in _SENTENCEPIECE_FILES:
        sp = _load_sentencepiece(tokenizer_type)
        if sp is not None:
            return sp, "sentencepiece"
        return None, "none"

    # HuggingFace tokenizers
    if tokenizer_type in _HF_TOKENIZER_FILES:
        tok = _load_hf_tokenizer(tokenizer_type)
        if tok is not None:
            return tok, "hf-tokenizers"
        return None, "none"

    # tiktoken (OpenAI models + default)
    enc = _load_tiktoken(tokenizer_type)
    if enc is not None:
        return enc, "tiktoken"
    return None, "none"


# ── Public API ────────────────────────────────────────────────────────
def tokenizer_available_for_model(model_name: str) -> bool:
    """Check if a real tokenizer backend is available for the given model."""
    tokenizer_type = get_tokenizer_model(model_name)
    _, backend = _resolve_tokenizer(tokenizer_type)
    return backend != "none"


def get_token_count(text: str, model_name: str = "") -> int:
    """Count tokens in ``text`` using the tokenizer for ``model_name``.

    Aligns with ST's token counting behavior:
    1. Resolve ``model_name`` → tokenizer type via ``get_tokenizer_model``
    2. Load the appropriate tokenizer backend
    3. If backend unavailable, fall back to ``guesstimate``

    For empty or ``None`` text, returns 0.
    """
    if not text:
        return 0

    tokenizer_type = get_tokenizer_model(model_name)
    tok, backend = _resolve_tokenizer(tokenizer_type)

    if tok is None:
        return guesstimate(text)

    try:
        if backend == "tiktoken":
            return len(tok.encode(text))
        elif backend == "sentencepiece":
            return len(tok.EncodeAsIds(text))
        elif backend == "hf-tokenizers":
            return len(tok.encode(text).ids)
    except Exception as exc:
        logger.warning("Token count failed (model=%s, backend=%s): %s", model_name, backend, exc)

    return guesstimate(text)


def encode_tokens(text: str, model_name: str = "") -> list[int]:
    """Encode ``text`` to a list of token IDs using the tokenizer for ``model_name``.

    Falls back to character codepoints if no tokenizer is available.
    """
    if not text:
        return []

    tokenizer_type = get_tokenizer_model(model_name)
    tok, backend = _resolve_tokenizer(tokenizer_type)

    if tok is None:
        # Fallback: character codepoints (same as api.tokenizer.encode_tokens)
        return [ord(ch) for ch in text]

    try:
        if backend == "tiktoken":
            return list(tok.encode_ordinary(text))
        elif backend == "sentencepiece":
            return tok.EncodeAsIds(text)
        elif backend == "hf-tokenizers":
            return tok.encode(text).ids
    except Exception as exc:
        logger.warning("Token encode failed (model=%s, backend=%s): %s", model_name, backend, exc)

    return [ord(ch) for ch in text]


def decode_tokens(ids: list[int], model_name: str = "") -> str:
    """Decode a list of token IDs back to text using the tokenizer for ``model_name``.

    Falls back to codepoint-to-character conversion if no tokenizer is available.
    """
    if not ids:
        return ""

    tokenizer_type = get_tokenizer_model(model_name)
    tok, backend = _resolve_tokenizer(tokenizer_type)

    if tok is None:
        return "".join(chr(t) for t in ids if isinstance(t, int) and 0 <= t <= 0x10FFFF)

    try:
        if backend == "tiktoken":
            return tok.decode(ids)
        elif backend == "sentencepiece":
            return tok.DecodeIds(ids)
        elif backend == "hf-tokenizers":
            return tok.decode(ids)
    except Exception as exc:
        logger.warning("Token decode failed (model=%s, backend=%s): %s", model_name, backend, exc)

    return "".join(chr(t) for t in ids if isinstance(t, int) and 0 <= t <= 0x10FFFF)


def get_tokenizer_info(model_name: str = "") -> dict:
    """Return tokenizer metadata for diagnostics.

    Returns a dict with:
    - ``model_name``: input model name
    - ``tokenizer_type``: resolved tokenizer type (e.g., "llama3", "claude")
    - ``backend``: backend name ("tiktoken" / "sentencepiece" / "hf-tokenizers" / "none")
    - ``available``: whether the backend is loaded
    """
    tokenizer_type = get_tokenizer_model(model_name)
    _, backend = _resolve_tokenizer(tokenizer_type)
    return {
        "model_name": model_name,
        "tokenizer_type": tokenizer_type,
        "backend": backend,
        "available": backend != "none",
    }


# ── Type-based API (for ST compat endpoint /api/tokenizers/{name}/{op}) ─
# These functions accept a tokenizer type name directly (e.g., "llama",
# "mistral", "gpt2", "openai") rather than a model name. Used by the
# ST tokenizer compat endpoint where the tokenizer type is in the URL path.

# Map ST tokenizer type names to internal tokenizer types
_ST_TYPE_MAP = {
    "llama": "llama",
    "mistral": "mistral",
    "yi": "yi",
    "gemma": "gemma",
    "jamba": "jamba",
    "nerdstash": "nerdstash",
    "nerdstash_v2": "nerdstash_v2",
    "claude": "claude",
    "llama3": "llama3",
    "qwen2": "qwen2",
    "command-r": "command-r",
    "command-a": "command-a",
    "nemo": "nemo",
    "deepseek": "deepseek",
    "gpt2": "gpt2",
    "openai": "gpt-3.5-turbo",  # default; overridden by model param
}


def _resolve_by_st_type(
    st_type: str, model_override: Optional[str] = None
) -> Tuple[Optional[Any], str, str]:
    """Resolve an ST tokenizer type name to a tokenizer instance.

    Args:
        st_type: ST tokenizer name from URL path (e.g., "llama", "openai")
        model_override: Optional model name (used for "openai" type to
            select the tiktoken encoding via ``get_tokenizer_model``)

    Returns:
        ``(tokenizer_instance, backend_name, internal_type)`` tuple.
        ``backend_name`` is "tiktoken" / "sentencepiece" / "hf-tokenizers" / "none".
        ``internal_type`` is the resolved internal tokenizer type.
    """
    # For "openai" type, use the model override to determine the tiktoken encoding
    if st_type == "openai":
        internal_type = get_tokenizer_model(model_override or "gpt-3.5-turbo")
        tok, backend = _resolve_tokenizer(internal_type)
        return tok, backend, internal_type

    # For "gpt2" type, use tiktoken's gpt2 encoding directly
    if st_type == "gpt2":
        internal_type = "gpt2"
        tok, backend = _resolve_tokenizer(internal_type)
        return tok, backend, internal_type

    # Map ST type to internal type
    internal_type = _ST_TYPE_MAP.get(st_type, st_type)
    tok, backend = _resolve_tokenizer(internal_type)
    return tok, backend, internal_type


def get_token_count_by_type(
    text: str, st_type: str, model_override: Optional[str] = None
) -> int:
    """Count tokens using a specific ST tokenizer type.

    Args:
        text: Text to tokenize
        st_type: ST tokenizer name (e.g., "llama", "openai", "gpt2")
        model_override: Model name (for "openai" type to select encoding)
    """
    if not text:
        return 0

    tok, backend, _ = _resolve_by_st_type(st_type, model_override)

    if tok is None:
        return guesstimate(text)

    try:
        if backend == "tiktoken":
            return len(tok.encode(text))
        elif backend == "sentencepiece":
            return len(tok.EncodeAsIds(text))
        elif backend == "hf-tokenizers":
            return len(tok.encode(text).ids)
    except Exception as exc:
        logger.warning("Token count by type failed (type=%s, backend=%s): %s", st_type, backend, exc)

    return guesstimate(text)


def encode_tokens_by_type(
    text: str, st_type: str, model_override: Optional[str] = None
) -> list[int]:
    """Encode text to token IDs using a specific ST tokenizer type."""
    if not text:
        return []

    tok, backend, _ = _resolve_by_st_type(st_type, model_override)

    if tok is None:
        return [ord(ch) for ch in text]

    try:
        if backend == "tiktoken":
            return list(tok.encode_ordinary(text))
        elif backend == "sentencepiece":
            return tok.EncodeAsIds(text)
        elif backend == "hf-tokenizers":
            return tok.encode(text).ids
    except Exception as exc:
        logger.warning("Token encode by type failed (type=%s, backend=%s): %s", st_type, backend, exc)

    return [ord(ch) for ch in text]


def decode_tokens_by_type(
    ids: list[int], st_type: str, model_override: Optional[str] = None
) -> str:
    """Decode token IDs back to text using a specific ST tokenizer type."""
    if not ids:
        return ""

    tok, backend, _ = _resolve_by_st_type(st_type, model_override)

    if tok is None:
        return "".join(chr(t) for t in ids if isinstance(t, int) and 0 <= t <= 0x10FFFF)

    try:
        if backend == "tiktoken":
            return tok.decode(ids)
        elif backend == "sentencepiece":
            return tok.DecodeIds(ids)
        elif backend == "hf-tokenizers":
            return tok.decode(ids)
    except Exception as exc:
        logger.warning("Token decode by type failed (type=%s, backend=%s): %s", st_type, backend, exc)

    return "".join(chr(t) for t in ids if isinstance(t, int) and 0 <= t <= 0x10FFFF)
