import json
import logging
import re
from datetime import datetime, timezone, timedelta
from typing import Optional, List

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from openai import AsyncOpenAI

from ..core import get_db, settings
from ..models import SystemSetting
from ..services.provider_registry import find_model

router = APIRouter(prefix="/api/recommendations", tags=["recommendations"])
logger = logging.getLogger(__name__)


@router.get("/starters")
async def get_starter_questions(db: Session = Depends(get_db)):
    """获取推荐对话开场问题，必要时自动用 AI 生成"""
    setting = db.query(SystemSetting).filter(SystemSetting.key == "starter_questions").first()
    last_update_setting = db.query(SystemSetting).filter(SystemSetting.key == "last_starters_update").first()
    config_setting = db.query(SystemSetting).filter(SystemSetting.key == "default_model_config").first()

    questions: List[str] = json.loads(setting.value) if setting else []

    # Check if auto-regeneration is needed (every 24h)
    should_regenerate = False
    if last_update_setting:
        try:
            last_date = datetime.fromisoformat(last_update_setting.value.replace("Z", "+00:00"))
            if datetime.now(timezone.utc) - last_date > timedelta(hours=24):
                should_regenerate = True
        except Exception:
            should_regenerate = True
    else:
        should_regenerate = True

    model_id = ""
    if config_setting:
        try:
            conf = json.loads(config_setting.value)
            model_id = conf.get("daily_topic_model", "")
        except Exception:
            pass

    if should_regenerate and model_id:
        provider, _ = find_model(model_id)
        if provider:
            try:
                client = AsyncOpenAI(api_key=provider["api_key"], base_url=provider["base_url"])
                prompt = (
                    "Generate 4 short, interesting, and diverse conversation starter questions/topics "
                    "for an AI assistant. Output ONLY a JSON array of strings, e.g., ['Topic 1', 'Topic 2']."
                )
                resp = await client.chat.completions.create(
                    model=model_id,
                    messages=[{"role": "user", "content": prompt}],
                    temperature=0.7,
                )
                content = resp.choices[0].message.content
                match = re.search(r"\[.*\]", content, re.DOTALL)
                if match:
                    new_questions = json.loads(match.group(0))
                    if isinstance(new_questions, list) and len(new_questions) > 0:
                        questions = new_questions[:4]
                        val = json.dumps(questions, ensure_ascii=False)
                        if setting:
                            setting.value = val
                        else:
                            db.add(SystemSetting(key="starter_questions", value=val))
                        now_iso = datetime.now(timezone.utc).isoformat()
                        if last_update_setting:
                            last_update_setting.value = now_iso
                        else:
                            db.add(SystemSetting(key="last_starters_update", value=now_iso))
                        db.commit()
            except Exception as e:
                logger.error(f"Auto-generate starters failed: {e}")

    return questions
