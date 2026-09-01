"""按型号精确 token 计数（配额回退链第二层）。

定位（与调用方的分工，见 quota_service.compute_deduct_tokens）：
1. 供应商上报 usage —— 主路径（openai 兼容流的 include_usage 尾块 / resp.usage），
   这是供应商计费用的同一个数字；
2. 本模块 —— 供应商未上报时，按型号选 tokenizer 精确计数（本文件）；
3. 字符启发式 —— 本模块也无可用 tokenizer 时的最后兜底。

型号 → tokenizer 解析顺序：
1. DATA_DIR/tokenizers.json 的 "models" 显式映射（model_id → spec）；
2. DATA_DIR/tokenizers.json 的 "families" 正则覆盖（可升级新模型而无需改代码）；
3. 内置家族正则（本文件 _FAMILY_PATTERNS）；
4. 无匹配 → None，调用方回退启发式。

spec 语法：
- "tiktoken:<encoding>"        —— OpenAI 系（o200k_base / cl100k_base），字节级精确；
- "hf:<repo_id>"               —— HuggingFace 词表（tokenizers 库按 repo 加载 tokenizer.json），
                                  DeepSeek/Qwen/GLM/Kimi/Mistral/Llama 等开源系精确；
- claude/gemini/grok 的 API 模型无公开离线词表 → 家族映射为 None，
  精确计数依赖其 API 返回的 usage（Gemini 有 countTokens、Claude 有
  count_tokens 官方在线端点，未来可接，见 TODOS）。

性能与健壮性：
- tokenizer 实例 LRU 缓存（默认 8 个），HF 下载走 HF_ENDPOINT 镜像、
  缓存目录可由 HF_HUB_CACHE 指到挂载卷（见 docker-compose）；
- 加载失败按 (spec) 记负缓存，进程内不再重试——永不阻塞/永不抛出，
  计数失败一律返回 None 让调用方降级。

词库常识（为什么不是"全行业一个词库"）：词库与模型一起训练，同厂商同代系
通常复用（DeepSeek V2/V3/R1 同词表、Qwen 全系同词表、OpenAI cl100k→o200k 两代），
跨厂商不通用；同厂商换词库等于换模型。因此映射是"家族级"而非"每型号一个"。
"""

import json
import logging
import os
import re
import threading
from collections import OrderedDict
from typing import Any, Dict, List, Optional

from ..core import settings

logger = logging.getLogger(__name__)

# 内置家族 → tokenizer spec。正则按 model_id（小写）匹配，先命中先得。
# 家族词表在同代系内复用，新增型号通常无需动这里（tokenizers.json 可覆盖/扩展）。
_FAMILY_PATTERNS: List[tuple] = [
    # OpenAI：gpt-4o/o1/o3/o4/gpt-5 时代用 o200k_base；gpt-3.5/gpt-4 用 cl100k_base
    (re.compile(r"gpt-5|gpt-4o|o[1-5]-|o[1-5]$|chatgpt"), "tiktoken:o200k_base"),
    (re.compile(r"gpt-4|gpt-3"), "tiktoken:cl100k_base"),
    (re.compile(r"openai"), "tiktoken:o200k_base"),
    # DeepSeek：V2/V3/R1 全系同一词表
    (re.compile(r"deepseek"), "hf:deepseek-ai/DeepSeek-V3"),
    # Qwen/QwQ 全系同一词表
    (re.compile(r"qwen|qwq"), "hf:Qwen/Qwen3-32B"),
    # GLM/ChatGLM
    (re.compile(r"glm"), "hf:THUDM/glm-4-9b-chat"),
    # Kimi/Moonshot
    (re.compile(r"kimi|moonshot"), "hf:moonshotai/Kimi-K2"),
    # Mistral/Mixtral
    (re.compile(r"mistral|mixtral"), "hf:mistralai/Mistral-7B-Instruct-v0.3"),
    # Llama 3+
    (re.compile(r"llama"), "hf:meta-llama/Meta-Llama-3-8B"),
    # Grok：xAI 未公开 API 模型词表 → 用 o200k 近似（真实消耗以 xAI 返回的 usage 为准）
    (re.compile(r"grok"), "tiktoken:o200k_base"),
    # Claude / Gemini：无公开离线词表 → 显式 None（不猜），精确计数走其 API usage
    (re.compile(r"claude"), None),
    (re.compile(r"gemini|gemma"), None),
]

_TOKENIZERS_CACHE_LOCK = threading.Lock()
_tokenizers_cache: Optional[Dict[str, Any]] = None  # {"models": {...}, "families": {...}}
_tokenizers_mtime: Optional[float] = None

_TOKENIZER_INSTANCES_LOCK = threading.Lock()
_tokenizer_instances: "OrderedDict[str, Any]" = OrderedDict()
_MAX_INSTANCE_CACHE = 8
_failed_specs: set = set()


def _registry_path() -> str:
    return os.path.join(settings.DATA_DIR, "tokenizers.json")


def _load_registry() -> Dict[str, Any]:
    """读取 tokenizers.json（型号/家族显式映射），带 mtime 缓存。文件缺省 = 全空。"""
    global _tokenizers_cache, _tokenizers_mtime
    path = _registry_path()
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        with _TOKENIZERS_CACHE_LOCK:
            _tokenizers_cache = {"models": {}, "families": {}}
            _tokenizers_mtime = None
        return _tokenizers_cache

    with _TOKENIZERS_CACHE_LOCK:
        if _tokenizers_cache is not None and _tokenizers_mtime == mtime:
            return _tokenizers_cache
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, dict):
                data = {}
        except Exception:
            data = {}
        _tokenizers_cache = {
            "models": data.get("models", {}) if isinstance(data.get("models"), dict) else {},
            "families": data.get("families", {}) if isinstance(data.get("families"), dict) else {},
        }
        _tokenizers_mtime = mtime
        return _tokenizers_cache


def invalidate_registry_cache() -> None:
    global _tokenizers_cache, _tokenizers_mtime
    with _TOKENIZERS_CACHE_LOCK:
        _tokenizers_cache = None
        _tokenizers_mtime = None


def resolve_tokenizer_spec(model_id: str) -> Optional[str]:
    """按型号解析 tokenizer spec；None = 无可用词表（调用方回退启发式）。"""
    mid = (model_id or "").strip().lower()
    if not mid:
        return None

    registry = _load_registry()
    # 1) 显式型号映射
    spec = registry["models"].get(mid) or registry["models"].get(model_id or "")
    if spec is not None:
        return spec or None
    # 2) 用户自定义家族正则（先于内置，便于升级/纠偏）
    for pattern, family_spec in registry["families"].items():
        try:
            if re.search(pattern, mid):
                return family_spec or None
        except re.error:
            continue
    # 3) 内置家族
    for pattern, family_spec in _FAMILY_PATTERNS:
        if pattern.search(mid):
            return family_spec
    return None


def _get_tokenizer(spec: str) -> Optional[Any]:
    """按 spec 懒加载 tokenizer 实例（LRU）；失败记负缓存并返回 None。"""
    if spec in _failed_specs:
        return None

    with _TOKENIZER_INSTANCES_LOCK:
        cached = _tokenizer_instances.get(spec)
        if cached is not None:
            _tokenizer_instances.move_to_end(spec)
            return cached

    try:
        if spec.startswith("tiktoken:"):
            import tiktoken
            instance = tiktoken.get_encoding(spec.split(":", 1)[1])
        elif spec.startswith("hf:"):
            from tokenizers import Tokenizer
            instance = Tokenizer.from_pretrained(spec.split(":", 1)[1])
        else:
            logger.warning("Unknown tokenizer spec: %s", spec)
            _failed_specs.add(spec)
            return None
    except Exception as e:
        # 下载失败/库缺失/网络不可达：负缓存，进程内不再重试
        logger.warning("Tokenizer load failed for spec=%s: %s", spec, e)
        _failed_specs.add(spec)
        return None

    with _TOKENIZER_INSTANCES_LOCK:
        _tokenizer_instances[spec] = instance
        _tokenizer_instances.move_to_end(spec)
        while len(_tokenizer_instances) > _MAX_INSTANCE_CACHE:
            _tokenizer_instances.popitem(last=False)
    return instance


def count_text_tokens(model_id: str, text: str) -> Optional[int]:
    """按型号计数一段文本；无可用 tokenizer 返回 None（调用方降级）。"""
    if not text:
        return 0
    spec = resolve_tokenizer_spec(model_id)
    if spec is None:
        return None
    tokenizer = _get_tokenizer(spec)
    if tokenizer is None:
        return None
    try:
        if hasattr(tokenizer, "encode"):  # tiktoken 与 tokenizers 接口同名
            return len(tokenizer.encode(text))
        return None
    except Exception as e:
        logger.warning("Tokenize failed for model=%s: %s", model_id, e)
        return None


def count_messages_tokens(model_id: str, messages: Optional[List[Dict[str, Any]]]) -> Optional[int]:
    """按型号计数消息数组（prompt 侧）；只数文本内容，模板结构开销不建模。

    无可用 tokenizer 返回 None。注意：模板开销（system 合并、轮次标记）
    因供应商实现而异，本地精确计数以供应商 usage 为准，本值用于配额回退。
    """
    if not messages:
        return 0
    spec = resolve_tokenizer_spec(model_id)
    if spec is None:
        return None
    tokenizer = _get_tokenizer(spec)
    if tokenizer is None:
        return None

    total = 0
    try:
        for msg in messages:
            if not isinstance(msg, dict):
                continue
            content = msg.get("content")
            if isinstance(content, str):
                if content:
                    total += len(tokenizer.encode(content))
            elif isinstance(content, list):
                for part in content:
                    if isinstance(part, dict) and part.get("type") == "text":
                        text = str(part.get("text", ""))
                        if text:
                            total += len(tokenizer.encode(text))
            # role/name 等模板结构开销不建模（各家 chat template 不同）
    except Exception as e:
        logger.warning("Message tokenize failed for model=%s: %s", model_id, e)
        return None
    return total
