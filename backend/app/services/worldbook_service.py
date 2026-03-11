"""WorldBook service — AI-driven parsing and stage transition logic."""
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from openai import AsyncOpenAI
from sqlalchemy.orm import Session as DBSession

from ..models.worldbook import WorldBook, WorldBookStage, SessionWorldBook

logger = logging.getLogger(__name__)


PARSE_SYSTEM_PROMPT = """You are a narrative structure analyst. Your task is to split a world book / scenario / script into logical stages (chapters/phases).

Rules:
1. Split the content by narrative progression: scene changes, key events, plot turning points, or phase transitions.
2. Each stage should be self-contained enough to guide a roleplay AI for that phase.
3. For each stage, provide:
   - "title": A short descriptive title (max 20 chars)
   - "content": The full content for this stage (to be injected into the AI's system prompt)
   - "summary": A brief 1-2 sentence summary of what happens in this stage
   - "transition_hint": A description of what would indicate this stage is complete and the story should move on (e.g., "The characters have left the tavern and are on the road")
   - "priority": 1-10 importance rating (10 = critical global lore, 5 = normal stage, 1 = optional detail)
4. Content marked as "constant" or "always active" should have priority >= 8.
5. Aim for 3-10 stages depending on content length.

Respond in valid JSON format only:
{
  "stages": [
    {
      "title": "...",
      "content": "...",
      "summary": "...",
      "transition_hint": "...",
      "priority": 5
    }
  ]
}"""

TRANSITION_CHECK_PROMPT = """You are a narrative progress evaluator. Given the current stage description and recent conversation, determine if the story has progressed past the current stage.

Current stage:
Title: {stage_title}
Content summary: {stage_summary}
Transition condition: {transition_hint}

Analyze the recent conversation and determine:
1. Has the current stage's content been sufficiently explored/enacted?
2. Does the conversation naturally suggest moving to the next phase?

Respond in JSON only:
{{
  "should_transition": true/false,
  "confidence": 0.0-1.0,
  "reason": "brief explanation"
}}"""


def _find_model(model_id: Optional[str]):
    """Find a provider and model config. Duplicates logic from character_ext for decoupling."""
    import os
    from ..core import settings
    cfg = os.path.join(settings.DATA_DIR, "providers.json")
    try:
        with open(cfg, "r", encoding="utf-8") as f:
            providers = json.load(f)
    except Exception:
        return None, None

    for p in providers:
        if p.get("is_active"):
            for m in p.get("models", []):
                mid = m["id"] if isinstance(m, dict) else m
                if mid == model_id:
                    return p, (m if isinstance(m, dict) else {"id": m, "alias": m})
    return None, None


async def parse_worldbook_into_stages(
    db: DBSession,
    world_book_id: str,
    model_id: Optional[str] = None,
) -> WorldBook:
    """Use an LLM to parse raw world book content into logical stages."""
    wb = db.query(WorldBook).filter(WorldBook.id == world_book_id).first()
    if not wb:
        raise ValueError("World book not found")
    if not wb.raw_content:
        raise ValueError("World book has no content to parse")

    # Find model
    if not model_id:
        # Use first available model
        import os
        from ..core import settings
        cfg = os.path.join(settings.DATA_DIR, "providers.json")
        with open(cfg, "r", encoding="utf-8") as f:
            providers = json.load(f)
        for p in providers:
            if p.get("is_active"):
                for m in p.get("models", []):
                    model_id = m["id"] if isinstance(m, dict) else m
                    break
                if model_id:
                    break

    provider, model_cfg = _find_model(model_id)
    if not provider:
        raise ValueError("No available model for parsing")

    client = AsyncOpenAI(api_key=provider["api_key"], base_url=provider["base_url"])

    # Truncate very long content to avoid context overflow (keep ~12k chars)
    content = wb.raw_content
    if len(content) > 12000:
        content = content[:12000] + "\n\n[Content truncated for parsing...]"

    response = await client.chat.completions.create(
        model=model_id,
        messages=[
            {"role": "system", "content": PARSE_SYSTEM_PROMPT},
            {"role": "user", "content": f"Please parse the following world book content into stages:\n\n{content}"},
        ],
        temperature=0.3,
    )

    result_text = response.choices[0].message.content.strip()

    # Extract JSON from response (handle markdown code blocks)
    if "```json" in result_text:
        result_text = result_text.split("```json")[1].split("```")[0].strip()
    elif "```" in result_text:
        result_text = result_text.split("```")[1].split("```")[0].strip()

    try:
        parsed = json.loads(result_text)
    except json.JSONDecodeError:
        raise ValueError(f"Failed to parse AI response as JSON: {result_text[:200]}")

    stages_data = parsed.get("stages", [])
    if not stages_data:
        raise ValueError("AI returned no stages")

    # Clear existing stages
    db.query(WorldBookStage).filter(WorldBookStage.world_book_id == world_book_id).delete()
    db.flush()

    # Create new stages
    now = datetime.now(timezone.utc)
    for i, stage_data in enumerate(stages_data):
        content_text = stage_data.get("content", "")
        stage = WorldBookStage(
            id=str(uuid.uuid4()),
            world_book_id=world_book_id,
            stage_index=i,
            title=stage_data.get("title", f"Stage {i + 1}"),
            content=content_text,
            summary=stage_data.get("summary"),
            transition_hint=stage_data.get("transition_hint"),
            priority=max(1, min(10, stage_data.get("priority", 5))),
            token_count=len(content_text) // 4,
            created_at=now,
        )
        db.add(stage)

    wb.is_parsed = True
    wb.updated_at = now
    db.commit()
    db.refresh(wb)
    return wb


async def check_stage_transition(
    db: DBSession,
    session_id: str,
    recent_messages: list[dict],
    model_id: Optional[str] = None,
) -> Optional[dict]:
    """Check if the conversation has progressed past the current world book stage.
    
    Returns None if no transition needed, or {"should_transition": True, "reason": str}
    """
    swb = db.query(SessionWorldBook).filter(SessionWorldBook.session_id == session_id).first()
    if not swb:
        return None
    if swb.stage_transition_mode != "auto":
        return None

    # Get current stage
    current_stage = db.query(WorldBookStage).filter(
        WorldBookStage.world_book_id == swb.world_book_id,
        WorldBookStage.stage_index == swb.current_stage_index,
    ).first()
    if not current_stage:
        return None

    # Check if there's a next stage
    next_stage = db.query(WorldBookStage).filter(
        WorldBookStage.world_book_id == swb.world_book_id,
        WorldBookStage.stage_index == swb.current_stage_index + 1,
    ).first()
    if not next_stage:
        return None  # Already at last stage

    if not current_stage.transition_hint and not current_stage.summary:
        return None  # No criteria to judge

    provider, model_cfg = _find_model(model_id)
    if not provider:
        return None

    # Build conversation excerpt (last 6 messages)
    conversation = "\n".join(
        [f"{m['role'].upper()}: {m['content'][:300]}" for m in recent_messages[-6:]]
    )

    prompt = TRANSITION_CHECK_PROMPT.format(
        stage_title=current_stage.title or f"Stage {current_stage.stage_index}",
        stage_summary=current_stage.summary or current_stage.content[:200],
        transition_hint=current_stage.transition_hint or "No specific transition condition defined",
    )

    try:
        client = AsyncOpenAI(api_key=provider["api_key"], base_url=provider["base_url"])
        response = await client.chat.completions.create(
            model=model_id,
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": f"Recent conversation:\n{conversation}"},
            ],
            temperature=0.2,
        )

        result_text = response.choices[0].message.content.strip()
        if "```json" in result_text:
            result_text = result_text.split("```json")[1].split("```")[0].strip()
        elif "```" in result_text:
            result_text = result_text.split("```")[1].split("```")[0].strip()

        result = json.loads(result_text)

        if result.get("should_transition") and result.get("confidence", 0) >= 0.7:
            # Perform the transition
            swb.current_stage_index += 1
            swb.updated_at = datetime.now(timezone.utc)
            db.commit()
            return {
                "should_transition": True,
                "new_stage_index": swb.current_stage_index,
                "new_stage_title": next_stage.title,
                "reason": result.get("reason", ""),
            }
    except Exception as e:
        logger.warning(f"Stage transition check failed: {e}")

    return None


def build_worldbook_context(db: DBSession, session_id: str) -> Optional[str]:
    """Build the world book context string to inject into the system prompt.
    
    Strategy:
    - Current stage: full content
    - Previous stages: summary only (recency-weighted)
    - Future stages: nothing
    - High-priority stages (>=8): summary always included
    """
    swb = db.query(SessionWorldBook).filter(SessionWorldBook.session_id == session_id).first()
    if not swb:
        return None

    stages = db.query(WorldBookStage).filter(
        WorldBookStage.world_book_id == swb.world_book_id
    ).order_by(WorldBookStage.stage_index).all()

    if not stages:
        return None

    current_index = swb.current_stage_index
    parts = []

    # High-priority global lore (priority >= 8, from any stage that's not current)
    global_lore = []
    for s in stages:
        if s.priority >= 8 and s.stage_index != current_index:
            summary = s.summary or s.content[:150]
            global_lore.append(f"- {s.title}: {summary}")
    if global_lore:
        parts.append("[World Lore - Key Facts]\n" + "\n".join(global_lore))

    # Previous stages summaries (only the last 3 completed stages)
    prev_summaries = []
    for s in stages:
        if s.stage_index < current_index and s.priority < 8:
            summary = s.summary or s.content[:100]
            prev_summaries.append(f"Stage {s.stage_index + 1} ({s.title}): {summary}")
    if prev_summaries:
        # Keep only last 3
        prev_summaries = prev_summaries[-3:]
        parts.append("[Story Progress - Previous Stages]\n" + "\n".join(prev_summaries))

    # Current stage: full content
    for s in stages:
        if s.stage_index == current_index:
            parts.append(
                f"[Current World Book Stage {current_index + 1}/{len(stages)}: {s.title or 'Untitled'}]\n"
                f"{s.content}"
            )
            break

    if not parts:
        return None

    return "\n\n".join(parts)
