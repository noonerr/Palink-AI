import asyncio
import json
import logging
import re
from typing import Optional

from sqlalchemy.orm import Session

from ..models.system import SystemSetting
from ..core.config import settings
from .inference_dispatcher import complete_text_completion, ensure_model_available
from .model_queue_service import get_model_queue_service


logger = logging.getLogger(__name__)

DEFAULT_TITLE = "新对话"


def _strip_think_blocks(text: str) -> str:
    return re.sub(r"<think[\s\S]*?<\/think>", "", text or "", flags=re.IGNORECASE)


def _clean_source_text(text: str) -> str:
    if not text:
        return ""
    cleaned = _strip_think_blocks(text)
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
    timeout_seconds: float = 8.0,
    max_len: Optional[int] = None,
) -> str:
    cleaned_source = _clean_source_text(source_text)
    logger.info(f"[DEBUG] generate_compact_title - cleaned_source: {cleaned_source}")
    if not cleaned_source:
        logger.info(f"[DEBUG] generate_compact_title - cleaned_source is empty, returning default_title: {default_title}")
        return default_title

    target_model = _get_default_summarization_model(db) or (fallback_model_id or "").strip()
    logger.info(f"[DEBUG] generate_compact_title - target_model: {target_model}")
    if not target_model:
        logger.info(f"[DEBUG] generate_compact_title - target_model is None, using rule_based")
        return rule_based_compact_title(cleaned_source, default_title=default_title, max_len=max_len)

    try:
        ensure_model_available(target_model)
        logger.info(f"[DEBUG] generate_compact_title - model {target_model} is available")
    except ValueError as e:
        logger.info(f"[DEBUG] generate_compact_title - model {target_model} not available: {e}")
        return rule_based_compact_title(cleaned_source, default_title=default_title, max_len=max_len)

    is_local = _is_local_model(target_model)
    effective_timeout = max(timeout_seconds, 15.0) if is_local else timeout_seconds
    logger.info(f"[DEBUG] generate_compact_title - is_local: {is_local}, effective_timeout: {effective_timeout}")

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
        queue_service = get_model_queue_service()
        logger.info(f"[DEBUG] generate_compact_title - using queue_service")

        async def generate_title():
            logger.info(f"[DEBUG] generate_compact_title - calling complete_text_completion")
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

        completion = await queue_service.execute_with_queue_and_retry(
            target_model,
            generate_title
        )
        logger.info(f"[DEBUG] generate_compact_title - completion: {completion}")
        content = completion.get("content") or ""
        logger.info(f"[DEBUG] generate_compact_title - content: {content}")

        normalized = _normalize_title_text(content)
        logger.info(f"[DEBUG] generate_compact_title - normalized: {normalized}")
        normalized = _truncate_title(normalized, max_len=max_len)
        logger.info(f"[DEBUG] generate_compact_title - truncated: {normalized}")
        if normalized:
            return normalized
    except Exception as exc:
        logger.exception("Compact title model fallback triggered: %s", exc)

    return rule_based_compact_title(cleaned_source, default_title=default_title, max_len=max_len)
