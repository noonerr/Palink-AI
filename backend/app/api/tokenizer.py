"""Tokenizer API routes — 提供 token 计数服务。

优先使用 tiktoken（若已安装）进行精确计数；否则回退到改进的启发式估算，
该估算区分 CJK 字符（约 1 字符 ≈ 1 token）与拉丁文（约 4 字符 ≈ 1 token）。
"""
import re
from typing import Any, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, status
from pydantic import BaseModel

from .dependencies import get_current_user
from ..models import User

router = APIRouter(prefix="/api/tokenizers", tags=["tokenizer"])

# 尝试加载 tiktoken（可选依赖，未安装时回退到启发式估算）
_tiktoken = None
_tiktoken_enc = None  # 默认 cl100k_base 编码器（向后兼容 count_tokens）
_tiktoken_enc_cache: dict[str, Any] = {}
try:  # pragma: no cover - 依赖环境决定
    import tiktoken  # type: ignore

    _tiktoken = tiktoken
    try:
        _tiktoken_enc = tiktoken.get_encoding("cl100k_base")
        _tiktoken_enc_cache["cl100k_base"] = _tiktoken_enc
    except Exception:  # pragma: no cover
        _tiktoken_enc = None
except ImportError:  # pragma: no cover
    _tiktoken = None


# 所有受支持的 tokenizer 名称（按 tiktoken 公开编码列出）
_SUPPORTED_TOKENIZERS = [
    "cl100k_base",
    "p50k_base",
    "r50k_base",
    "p50k_edit",
    "r50k_edit",
    "gpt2",
]


def _list_available_tokenizers() -> list[str]:
    """返回当前 tiktoken 实际可加载的 tokenizer 名称列表。"""
    if _tiktoken is None:
        return []
    available: list[str] = []
    for name in _SUPPORTED_TOKENIZERS:
        if name in _tiktoken_enc_cache:
            available.append(name)
            continue
        try:
            _tiktoken_enc_cache[name] = _tiktoken.get_encoding(name)
            available.append(name)
        except Exception:  # pragma: no cover - 依赖环境决定
            continue
    return available


def get_tokenizer_for_model(model: str) -> str:
    """根据模型名返回推荐的 tiktoken 编码名称。

    - GPT-4o / GPT-4-turbo / GPT-4 / GPT-3.5-turbo 系列 → cl100k_base
    - text-davinci-003 / text-davinci-002 → p50k_base
    - 其他（含 Llama 3 系列，无原生平替） → 默认 cl100k_base
    """
    if not model:
        return "cl100k_base"
    name = model.lower()
    if "text-davinci-003" in name or "text-davinci-002" in name:
        return "p50k_base"
    if (
        "gpt-4o" in name
        or "gpt-4-turbo" in name
        or "gpt-4" in name
        or "gpt-3.5" in name
    ):
        return "cl100k_base"
    # Llama 3 / Claude / Mistral 等其他模型暂无原生平替，使用 cl100k_base 近似
    return "cl100k_base"


def _resolve_encoding(
    tokenizer: Optional[str] = None,
    model: Optional[str] = None,
) -> Optional[Any]:
    """根据 tokenizer 名称或 model 名称解析出 tiktoken 编码器。

    解析失败（tiktoken 未安装 / 编码不存在）时返回 None，
    调用方需自行回退到启发式实现。
    """
    if _tiktoken is None:
        return None
    enc_name = tokenizer or (get_tokenizer_for_model(model) if model else "cl100k_base")
    if not enc_name:
        return None
    if enc_name in _tiktoken_enc_cache:
        return _tiktoken_enc_cache[enc_name]
    try:
        enc = _tiktoken.get_encoding(enc_name)
        _tiktoken_enc_cache[enc_name] = enc
        return enc
    except Exception:  # pragma: no cover - 依赖环境决定
        return None


# CJK Unicode 范围（中日韩统一表意文字 + 假名 + 谚文）
_CJK_RANGES = (
    (0x4E00, 0x9FFF),    # CJK 统一表意文字
    (0x3400, 0x4DBF),    # CJK 扩展 A
    (0x3040, 0x30FF),    # 平假名 + 片假名
    (0xAC00, 0xD7AF),    # 谚文音节
    (0xFF00, 0xFFEF),    # 全角字符
)

_CJK_PATTERN = re.compile(
    "[" + "".join(f"{chr(lo)}-{chr(hi)}" for lo, hi in _CJK_RANGES) + "]"
)

# 文本长度上限：1MB（按字符计），防止恶意超大请求耗尽资源
_MAX_TEXT_CHARS = 1 * 1024 * 1024

# token 数组长度上限：200K，防止恶意超大请求耗尽资源
_MAX_TOKENS_COUNT = 200 * 1000


def _heuristic_count(text: str) -> int:
    """改进的启发式 token 估算。

    - CJK 字符：约 1 字符 ≈ 1 token
    - 拉丁文/其他：约 4 字符 ≈ 1 token（与前端 _heuristicTokenCount 公式保持一致）
    - other_chars == 0 时仅返回 CJK 计数，避免对纯 CJK 文本多算 1
    """
    if not text:
        return 0

    cjk_chars = len(_CJK_PATTERN.findall(text))
    other_chars = len(text) - cjk_chars
    # CJK 约 1 token/字；拉丁文约 4 字符/token（(n+3)//4 等价于 ceil(n/4)）
    count = cjk_chars + (other_chars + 3) // 4
    return count


def count_tokens(text: str) -> int:
    """对文本进行 token 计数。

    优先使用 tiktoken（cl100k_base 编码），未安装时回退到启发式估算。
    """
    if not text:
        return 0
    if _tiktoken_enc is not None:
        try:
            return len(_tiktoken_enc.encode(text))
        except Exception:  # pragma: no cover
            pass
    return _heuristic_count(text)


def _default_tokenizer_label() -> str:
    """当前默认使用的 tokenizer 标签（供回退路径使用）。"""
    return "tiktoken" if _tiktoken_enc is not None else "heuristic"


def count_tokens_for(
    text: str,
    tokenizer: Optional[str] = None,
    model: Optional[str] = None,
) -> tuple[int, str]:
    """对文本进行 token 计数，支持按 tokenizer/model 选择编码。

    返回 ``(count, tokenizer_label)``，tokenizer_label 为 ``"tiktoken"`` 或
    ``"heuristic"``。当未指定 tokenizer/model 时，行为与 ``count_tokens`` 一致。
    """
    if not text:
        return 0, _default_tokenizer_label()
    if tokenizer is None and model is None:
        return count_tokens(text), _default_tokenizer_label()
    enc = _resolve_encoding(tokenizer=tokenizer, model=model)
    if enc is not None:
        try:
            return len(enc.encode(text)), "tiktoken"
        except Exception:  # pragma: no cover
            pass
    return _heuristic_count(text), "heuristic"


def encode_tokens(
    text: str,
    tokenizer: Optional[str] = None,
    model: Optional[str] = None,
) -> tuple[list[int], str]:
    """编码文本为 token ID 数组。

    优先使用 tiktoken 的 ``encode_ordinary`` 方法；若 tiktoken 未安装或编码失败，
    回退到启发式方法（返回字符 Unicode codepoint 数组作为近似）。
    """
    if not text:
        return [], _default_tokenizer_label()
    enc = _resolve_encoding(tokenizer=tokenizer, model=model)
    if enc is not None:
        try:
            return list(enc.encode_ordinary(text)), "tiktoken"
        except Exception:  # pragma: no cover
            pass
    # 启发式回退：将每个字符的 Unicode codepoint 作为近似 token ID
    return [ord(ch) for ch in text], "heuristic"


def decode_tokens(
    tokens: list[int],
    tokenizer: Optional[str] = None,
    model: Optional[str] = None,
) -> tuple[str, str]:
    """将 token ID 数组解码为文本。

    优先使用 tiktoken 的 ``decode`` 方法；若 tiktoken 未安装或解码失败，
    回退（将每个 int 视为 Unicode codepoint 转为字符）。
    """
    if not tokens:
        return "", _default_tokenizer_label()
    enc = _resolve_encoding(tokenizer=tokenizer, model=model)
    if enc is not None:
        try:
            return enc.decode(tokens), "tiktoken"
        except Exception:  # pragma: no cover
            pass
    # 启发式回退：将每个 int 视为 Unicode codepoint（忽略无效值）
    return "".join(chr(t) for t in tokens if isinstance(t, int) and 0 <= t <= 0x10FFFF), "heuristic"


class TokenCountRequest(BaseModel):
    text: str
    tokenizer: Optional[str] = None
    model: Optional[str] = None


def _extract_text_from_payload(payload: Any) -> str:
    """从 count/encode 端点的请求体中提取 text 字段（兼容纯字符串形式）。"""
    if isinstance(payload, dict):
        text = payload.get("text", "")
        if text is not None and not isinstance(text, str):
            text = str(text)
    elif isinstance(payload, str):
        text = payload
    else:
        text = str(payload) if payload is not None else ""
    return text or ""


@router.post("/count")
async def count_tokens_endpoint(payload: Any = Body(None), _user: User = Depends(get_current_user)):
    """POST /api/tokenizers/count

    请求体: ``{"text": "...", "tokenizer": "cl100k_base", "model": "gpt-4o"}`` 或纯字符串
    返回: ``{"count": <int>, "tokenizer": "tiktoken" | "heuristic"}``

    需要认证（Depends(get_current_user)），并对 text 长度设置 1MB 上限。
    当请求体包含 ``tokenizer`` 或 ``model`` 字段时，尝试使用对应的 tokenizer 编码；
    否则使用默认的 cl100k_base（或回退到启发式估算）。
    """
    text = _extract_text_from_payload(payload)
    req_tokenizer = payload.get("tokenizer") if isinstance(payload, dict) else None
    req_model = payload.get("model") if isinstance(payload, dict) else None

    if len(text) > _MAX_TEXT_CHARS:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Text too large: {len(text)} chars, max {_MAX_TEXT_CHARS} chars",
        )
    count, tokenizer_label = count_tokens_for(text, tokenizer=req_tokenizer, model=req_model)
    return {"count": count, "tokenizer": tokenizer_label}


@router.post("/encode")
async def encode_tokens_endpoint(payload: Any = Body(None), _user: User = Depends(get_current_user)):
    """POST /api/tokenizers/encode

    请求体: ``{"text": "...", "tokenizer": "cl100k_base", "model": "gpt-4o"}``
    返回: ``{"tokens": [<int>, ...], "tokenizer": "tiktoken" | "heuristic"}``

    使用 tiktoken 的 ``encode_ordinary`` 编码文本为 token ID 数组；tiktoken
    未安装或编码失败时回退到启发式方法（字符 codepoint 数组）。
    """
    if not isinstance(payload, dict) or "text" not in payload:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Request body must be a JSON object containing a 'text' field",
        )
    text = payload.get("text", "")
    if text is not None and not isinstance(text, str):
        text = str(text)
    text = text or ""
    if len(text) > _MAX_TEXT_CHARS:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Text too large: {len(text)} chars, max {_MAX_TEXT_CHARS} chars",
        )
    req_tokenizer = payload.get("tokenizer")
    req_model = payload.get("model")
    tokens, tokenizer_label = encode_tokens(text, tokenizer=req_tokenizer, model=req_model)
    return {"tokens": tokens, "tokenizer": tokenizer_label}


@router.post("/decode")
async def decode_tokens_endpoint(payload: Any = Body(None), _user: User = Depends(get_current_user)):
    """POST /api/tokenizers/decode

    请求体: ``{"tokens": [<int>, ...], "tokenizer": "cl100k_base", "model": "gpt-4o"}``
    返回: ``{"text": "...", "tokenizer": "tiktoken" | "heuristic"}``

    使用 tiktoken 的 ``decode`` 将 token ID 数组解码为文本；tiktoken 未安装
    或解码失败时回退（将每个 int 视为 Unicode codepoint 转为字符）。
    """
    if not isinstance(payload, dict) or "tokens" not in payload:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Request body must be a JSON object containing a 'tokens' field",
        )
    raw_tokens = payload.get("tokens") or []
    if not isinstance(raw_tokens, list):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="'tokens' field must be an array of integers",
        )
    # 防御：限制 token 数组长度，避免恶意超大请求
    if len(raw_tokens) > _MAX_TOKENS_COUNT:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Tokens too large: {len(raw_tokens)} tokens, max {_MAX_TOKENS_COUNT} tokens",
        )
    tokens: list[int] = []
    for t in raw_tokens:
        try:
            tokens.append(int(t))
        except (TypeError, ValueError):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="'tokens' array must contain only integers",
            )
    req_tokenizer = payload.get("tokenizer")
    req_model = payload.get("model")
    text, tokenizer_label = decode_tokens(tokens, tokenizer=req_tokenizer, model=req_model)
    return {"text": text, "tokenizer": tokenizer_label}


@router.get("/list")
async def list_tokenizers_endpoint(_user: User = Depends(get_current_user)):
    """GET /api/tokenizers/list

    返回: ``{"tokenizers": [<str>, ...], "available": [<str>, ...]}``

    - ``tokenizers``：所有受支持的 tokenizer 名称
    - ``available``：当前 tiktoken 实际可加载的 tokenizer 名称（未安装 tiktoken 时为空数组）
    """
    return {
        "tokenizers": list(_SUPPORTED_TOKENIZERS),
        "available": _list_available_tokenizers(),
    }
