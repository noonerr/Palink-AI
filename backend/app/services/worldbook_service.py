"""WorldBook service - keyword-trigger engine (Phase 6A)."""
import json
import logging
import random
from typing import Optional

from sqlalchemy.orm import Session as DBSession

from ..models.worldbook import WorldBook, WorldBookStage, SessionWorldBook

logger = logging.getLogger(__name__)


def build_worldbook_context(
    db: DBSession,
    session_id: str,
    recent_messages: list | None = None,
) -> Optional[str]:
    """
    关键词触发引擎：扫描最近消息，匹配词条关键词，返回注入文本。

    recent_messages: [{"role": "user"|"assistant", "content": "..."}]
    """
    swb = db.query(SessionWorldBook).filter(SessionWorldBook.session_id == session_id).first()
    if not swb:
        return None

    entries: list = (
        db.query(WorldBookStage)
        .filter(WorldBookStage.world_book_id == swb.world_book_id)
        .all()
    )
    if not entries:
        return None

    msgs = recent_messages or []
    matched: list = []

    for entry in entries:
        # constant=True -> always inject
        if entry.constant:
            matched.append(entry)
            continue

        # Parse keyword lists
        try:
            keys: list = json.loads(entry.keys) if entry.keys else []
        except (json.JSONDecodeError, TypeError):
            keys = []

        if not keys:
            continue

        # Scan recent scan_depth messages (case-insensitive)
        depth = entry.scan_depth if entry.scan_depth else 4
        recent = msgs[-depth:] if len(msgs) >= depth else msgs
        combined_text = " ".join(m.get("content", "") for m in recent).lower()

        primary_hit = any(k.lower() in combined_text for k in keys if k)
        if not primary_hit:
            continue

        # Selective mode: secondary_keys must also hit
        if entry.selective:
            try:
                sec_keys: list = json.loads(entry.secondary_keys) if entry.secondary_keys else []
            except (json.JSONDecodeError, TypeError):
                sec_keys = []
            if sec_keys and not any(k.lower() in combined_text for k in sec_keys if k):
                continue

        # Probability filter
        prob = entry.probability if entry.probability is not None else 100
        if prob < 100 and random.random() * 100 >= prob:
            continue

        matched.append(entry)

    if not matched:
        return None

    # Sort: priority DESC, stage_index ASC
    matched.sort(key=lambda e: (-e.priority, e.stage_index))

    # Greedy token budget (approx 4000 tokens ~ 16000 chars)
    budget = 16000
    used = 0
    selected_contents: list = []
    for entry in matched:
        est = len(entry.content)
        if used + est > budget:
            break
        selected_contents.append(entry.content)
        used += est

    if not selected_contents:
        return None

    return "[World Lore]\n" + "\n\n".join(selected_contents)
