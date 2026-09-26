import asyncio
import json
import logging
import re
from typing import Optional

from sqlalchemy.orm import Session

from ..models.system import SystemSetting
from ..core.config import settings
from .inference_dispatcher import complete_text_completion, ensure_model_available
from .inference_queue import inference_queue


logger = logging.getLogger(__name__)

DEFAULT_TITLE = "新对话"

# [TITLE-MARKER-FIX] character_message_builder 的标题指令让模型在回复末尾输出
# 「[标题: xxx]」。两条生成路径都要"提取为短标题 + 从正文剥离"：
# SSE 路径（character_ext）此前有内联实现，WS 主路径（websocket）只起标题、
# 不剥正文 → 标记原样显示在消息末尾（2026-09-25 实测）。正则对收口在这里。
_RESPONSE_TITLE_RE = re.compile(r"\[标题[:：]\s*(.{1,15})\s*\]")
_RESPONSE_TITLE_TAIL_RE = re.compile(r"\s*\[标题[:：]\s*.{1,15}\s*\]\s*$")
# 整行只有标记的行（模型偶尔在标记后再写一行，如 [标题:..] 后跟【声音：..】，
# 2026-09-25 实测消息 2304）
_RESPONSE_TITLE_LINE_RE = re.compile(r"(?m)^[ \t]*\[标题[:：]\s*.{1,15}\s*\][ \t]*$\n?")


def extract_response_title(content: str) -> tuple[Optional[str], str]:
    """从模型回复中提取 [标题: xxx] 标记，并从正文剥离。

    返回 (标题或 None, 处理后的正文)。匹配不到标记时原样返回 (None, content)。
    剥离顺序：先剥末尾标记（含尾随空白）；不在末尾时剥「整行只有标记」的行；
    行内嵌在散文里的标记保守保留，避免误伤正文。
    """
    if not content:
        return None, content
    match = _RESPONSE_TITLE_RE.search(content)
    if not match:
        return None, content
    title = match.group(1).strip() or None
    cleaned = _RESPONSE_TITLE_TAIL_RE.sub("", content, count=1)
    cleaned = _RESPONSE_TITLE_LINE_RE.sub("", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    return title, cleaned


def _strip_think_blocks(text: str) -> str:
    return re.sub(r"<think[\s\S]*?<\/think>", "", text or "", flags=re.IGNORECASE)


def _strip_smart_card_html(text: str) -> str:
    if not text:
        return ""
    cleaned = re.sub(r"<palink-html>[\s\S]*?</palink-html>", " ", text, flags=re.IGNORECASE)
    cleaned = re.sub(r"(`{3,})html\s*[\r\n]+[\s\S]*?[\r\n]+\1", " ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"(?:html\s*)?(?:<!DOCTYPE\s+html|<html\b)[\s\S]*?</html\s*>", " ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"<(?:script|style)\b[\s\S]*?</(?:script|style)>", " ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"</?[a-zA-Z][a-zA-Z0-9]*(?:\s[^>]*)?/?>", " ", cleaned)
    return cleaned


def _clean_source_text(text: str) -> str:
    if not text:
        return ""
    cleaned = _strip_smart_card_html(_strip_think_blocks(text))
    cleaned = re.sub(r"https?://\S+", " ", cleaned)
    cleaned = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", cleaned)
    cleaned = re.sub(r"\[[^\]]*\]\([^)]*\)", " ", cleaned)
    cleaned = re.sub(r"[`*_#>\-]{1,}", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def _normalize_title_text(text: str) -> str:
    title = _clean_source_text(text)
    title = title.strip("\"'`，。！？：；、【】（）()[]{}")
    title = re.sub(r"\s+", "", title)
    return title


def _truncate_title(text: str, chinese_max: int = 12, latin_max: int = 24, max_len: Optional[int] = None) -> str:
    if not text:
        return ""
    has_cjk = bool(re.search(r"[\u4e00-\u9fff]", text))
    target_len = max_len or (chinese_max if has_cjk else latin_max)
    target_len = max(int(target_len), 1)
    return text[:target_len]


def rule_based_compact_title(source_text: str, default_title: str = DEFAULT_TITLE, max_len: Optional[int] = None) -> str:
    cleaned = _normalize_title_text(source_text)
    if not cleaned:
        return default_title
    compact = _truncate_title(cleaned, max_len=max_len)
    return compact or default_title


def _get_default_summarization_model(db: Session) -> Optional[str]:
    setting = db.query(SystemSetting).filter(SystemSetting.key == "default_model_config").first()
    if setting and setting.value:
        try:
            config = json.loads(setting.value)
            model_id = (config.get("default_summarization_model") or "").strip()
            if model_id:
                return model_id
        except Exception:
            pass
    return settings.SUMMARY_MODEL if settings.SUMMARY_MODEL else None


def _is_local_model(model_id: str) -> bool:
    return model_id.startswith("local:") or model_id.startswith("llama")


async def generate_compact_title(
    db: Session,
    source_text: str,
    fallback_model_id: Optional[str] = None,
    default_title: str = DEFAULT_TITLE,
    timeout_seconds: float = 15.0,
    max_len: Optional[int] = None,
) -> str:
    cleaned_source = _clean_source_text(source_text)
    logger.info("generate_compact_title - cleaned_source: %s", cleaned_source[:100] if cleaned_source else "empty")
    if not cleaned_source:
        logger.info("generate_compact_title - cleaned_source is empty, returning default_title: %s", default_title)
        return default_title

    target_model = _get_default_summarization_model(db) or (fallback_model_id or "").strip()
    logger.info("generate_compact_title - target_model: %s", target_model)
    if not target_model:
        logger.info("generate_compact_title - target_model is None, using rule_based")
        return rule_based_compact_title(cleaned_source, default_title=default_title, max_len=max_len)

    try:
        ensure_model_available(target_model)
        logger.info("generate_compact_title - model %s is available", target_model)
    except ValueError as e:
        logger.warning("generate_compact_title - model %s not available: %s, falling back to rule_based", target_model, e)
        return rule_based_compact_title(cleaned_source, default_title=default_title, max_len=max_len)

    is_local = _is_local_model(target_model)
    effective_timeout = max(timeout_seconds, 15.0) if is_local else timeout_seconds
    logger.debug("generate_compact_title - is_local: %s, effective_timeout: %s", is_local, effective_timeout)

    prompt = (
        "请把下面的对话内容压缩成会话导航标题。\n"
        "要求：\n"
        "1. 使用简体中文\n"
        "2. 8到12个中文字符\n"
        "3. 不要标点、引号、括号\n"
        "4. 只输出标题本身\n\n"
        f"内容：{cleaned_source}"
    )

    try:
        logger.debug("generate_compact_title - using inference_queue")

        async def generate_title():
            logger.debug("generate_compact_title - calling complete_text_completion")
            return await asyncio.wait_for(
                complete_text_completion(
                    model_id=target_model,
                    messages=[
                        {"role": "system", "content": "你是一个只输出短标题的助手。"},
                        {"role": "user", "content": prompt},
                    ],
                    temperature=0.1,
                    max_tokens=24,
                    timeout=max(effective_timeout, 0.8),
                ),
                timeout=effective_timeout,
            )

        completion = await inference_queue.submit_and_wait(
            target_model,
            generate_title,
            max_retries=3,
            retry_delay=2.0,
        )
        logger.debug("generate_compact_title - completion: %s", completion)
        content = completion.get("content") or ""
        logger.debug("generate_compact_title - content: %s", content)

        normalized = _normalize_title_text(content)
        logger.debug("generate_compact_title - normalized: %s", normalized)
        normalized = _truncate_title(normalized, max_len=max_len)
        logger.debug("generate_compact_title - truncated: %s", normalized)
        if normalized:
            return normalized
    except Exception as exc:
        logger.exception("Compact title model fallback triggered: %s", exc)

    return rule_based_compact_title(cleaned_source, default_title=default_title, max_len=max_len)
