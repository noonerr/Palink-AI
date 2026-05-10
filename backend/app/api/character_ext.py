"""
角色扩展路由：会话、分支、对话流、导入/导出、解析、翻译
"""
import os
import io
import json
import uuid
import logging
import re
import base64
import urllib.request
import urllib.error
from typing import Optional, List, AsyncGenerator
from datetime import datetime, timezone
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Request
from fastapi.responses import StreamingResponse, Response
from sqlalchemy.orm import Session
from pydantic import BaseModel

from ..core import get_db, settings
from ..core.rate_limit import enforce_rate_limit
from ..core.exceptions import ServiceError
from ..api.dependencies import get_current_user
from ..models import User, Character, CharacterChatSession, CharacterChatMessage, CharacterChatSessionBranch
from ..models.system import UserSetting
from ..character_card import create_png_with_chara_card
from ..services.character_import_service import CharacterImportService, PngCharacterCardParser
from ..memory_module.service import MemoryService
from ..schemas.character import character_to_dict
from ..utils import normalize_image_url, build_memory_context, get_default_ai_model, _is_public_http_url
from ..services.worldbook_service import build_worldbook_context
from ..services.plotline_service import build_plotline_context
from ..services.inference_dispatcher import (
    complete_text_completion,
    ensure_model_available,
    stream_text_completion,
)
from ..services.compact_title_service import generate_compact_title, rule_based_compact_title

router_characters = APIRouter(prefix="/api/characters", tags=["character-ext"])
router_sessions = APIRouter(prefix="/api/character-sessions", tags=["character-sessions"])
router_chat = APIRouter(tags=["character-chat"])

logger = logging.getLogger(__name__)

_MAX_IMAGE_SIZE = 50 * 1024 * 1024
_CHUNK_SIZE = 8192


def _read_with_size_limit(resp, max_size: int = _MAX_IMAGE_SIZE) -> bytes:
    chunks = []
    total_read = 0
    while True:
        chunk = resp.read(_CHUNK_SIZE)
        if not chunk:
            break
        total_read += len(chunk)
        if total_read > max_size:
            raise ValueError(f"Response body exceeds {max_size // (1024 * 1024)}MB limit")
        chunks.append(chunk)
    return b"".join(chunks)


# ───────────────────────────────────────────────
# Branch History Helpers
# ───────────────────────────────────────────────

def _get_assistant_message_id_for_node(db: Session, session_id: str, branch_id: str, user_msg_id: int) -> Optional[int]:
    """
    Given a user message ID, find the immediately following assistant message ID in the same branch.
    This defines a "dialogue node" as (user_msg, assistant_msg) pair.
    Returns None if no assistant message follows.
    """
    assistant_msg = (
        db.query(CharacterChatMessage)
        .filter(
            CharacterChatMessage.session_id == session_id,
            CharacterChatMessage.branch_id == branch_id,
            CharacterChatMessage.role == "assistant",
            CharacterChatMessage.id > user_msg_id,
        )
        .order_by(CharacterChatMessage.id)
        .first()
    )
    return assistant_msg.id if assistant_msg else None


def _count_child_branches_from_node(db: Session, session_id: str, parent_branch_id: Optional[str], parent_message_id: Optional[int]) -> int:
    """
    Count how many branches fork from a specific node (identified by parent_branch_id + parent_message_id).
    This enforces the "max 3 branches per node" rule.

    Note: parent_message_id should always point to an assistant message (the end of a dialogue pair).
    """
    query = db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.session_id == session_id,
    )

    if parent_branch_id is None:
        query = query.filter(CharacterChatSessionBranch.parent_branch_id.is_(None))
    else:
        query = query.filter(CharacterChatSessionBranch.parent_branch_id == parent_branch_id)

    if parent_message_id is None:
        query = query.filter(CharacterChatSessionBranch.parent_message_id.is_(None))
    else:
        query = query.filter(CharacterChatSessionBranch.parent_message_id == parent_message_id)

    return query.count()


def _get_branch_messages_up_to(db: Session, session_id: str, branch_id: str, up_to_message_id: Optional[int] = None) -> list:
    """Get messages for a branch, optionally up to (and including) a specific message id."""
    msgs = (
        db.query(CharacterChatMessage)
        .filter(
            CharacterChatMessage.session_id == session_id,
            CharacterChatMessage.branch_id == branch_id,
        )
        .order_by(CharacterChatMessage.created_at)
        .all()
    )
    if up_to_message_id is None:
        return msgs
    result = []
    for m in msgs:
        result.append(m)
        if m.id == up_to_message_id:
            break
    return result


def _get_full_branch_history(db: Session, session_id: str, branch_id: str, limit: int = 60, up_to_message_id: Optional[int] = None) -> list:
    """Return ordered messages by traversing the ancestor branch chain.

    For the target branch itself all messages are loaded.  For each ancestor
    branch only messages up to (and including) the fork-point message are
    loaded so that messages after the fork on a parent branch are excluded.

    If up_to_message_id is provided, the target branch's messages are
    truncated at (and including) that message id - used for "fork from
    here" navigation.
    """
    branch = db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.id == branch_id,
        CharacterChatSessionBranch.session_id == session_id,
    ).first()
    if not branch:
        return []

    # Build chain from target branch back to root.
    chain: list = []
    cur = branch
    up_to: int | None = None
    while cur:
        chain.append((cur, up_to))
        if cur.parent_branch_id:
            up_to = cur.parent_message_id
            parent = db.query(CharacterChatSessionBranch).filter(
                CharacterChatSessionBranch.id == cur.parent_branch_id,
                CharacterChatSessionBranch.session_id == session_id,
            ).first()
            cur = parent
        else:
            break

    chain.reverse()

    all_branch_ids = [b.id for b, _ in chain]
    all_up_to_ids = [up_to_id for _, up_to_id in chain if up_to_id is not None]

    all_msgs_raw = (
        db.query(CharacterChatMessage)
        .filter(
            CharacterChatMessage.session_id == session_id,
            CharacterChatMessage.branch_id.in_(all_branch_ids),
        )
        .order_by(CharacterChatMessage.created_at)
        .all()
    )

    msgs_by_branch: dict = {}
    for m in all_msgs_raw:
        msgs_by_branch.setdefault(m.branch_id, []).append(m)

    all_msgs: list = []
    for idx, (b, up_to_id) in enumerate(chain):
        branch_msgs = msgs_by_branch.get(b.id, [])
        if up_to_id is not None:
            filtered = []
            for m in branch_msgs:
                filtered.append(m)
                if m.id == up_to_id:
                    break
            all_msgs.extend(filtered)
        elif idx == len(chain) - 1 and up_to_message_id is not None:
            filtered = []
            for m in branch_msgs:
                filtered.append(m)
                if m.id == up_to_message_id:
                    break
            all_msgs.extend(filtered)
        else:
            all_msgs.extend(branch_msgs)

    seen: set = set()
    deduped: list = []
    for m in all_msgs:
        if m.id not in seen:
            seen.add(m.id)
            deduped.append(m)
    return deduped[-limit:]

def _get_ancestor_branch_ids(db: Session, session_id: str, branch_id: str) -> list:
    """Return all branch IDs in the ancestry chain from root to the given branch."""
    from sqlalchemy import text
    cte_sql = text("""
        WITH RECURSIVE ancestor_tree AS (
            SELECT id, parent_branch_id FROM character_chat_session_branches WHERE id = :bid
            UNION ALL
            SELECT b.id, b.parent_branch_id
            FROM character_chat_session_branches b
            INNER JOIN ancestor_tree a ON b.id = a.parent_branch_id
        )
        SELECT id FROM ancestor_tree
    """)
    result = db.execute(cte_sql, {"bid": branch_id}).fetchall()
    if not result:
        return []
    return [row[0] for row in reversed(result)]


# ───────────────────────────────────────────────
# Helpers
# ───────────────────────────────────────────────

class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(newurl, code, msg, headers, fp)


def _replace_placeholders(text: str, user_nickname: str = "用户", char_name: str = "") -> str:
    if not text:
        return text
    result = text
    user_patterns = [
        r'\{\{user\}\}', r'\{user\}',
        r'\{\{用户\}\}', r'\{用户\}',
        r'\{\{你\}\}', r'\{你\}',
        r'\{\{您\}\}', r'\{您\}',
    ]
    for pat in user_patterns:
        result = re.sub(pat, user_nickname, result, flags=re.IGNORECASE if 'user' in pat.lower() else 0)
    if char_name:
        char_patterns = [
            r'\{\{char\}\}', r'\{char\}',
            r'\{\{character\}\}', r'\{character\}',
            r'\{\{角色\}\}', r'\{角色\}',
        ]
        for pat in char_patterns:
            result = re.sub(pat, char_name, result, flags=re.IGNORECASE)
    return result


def _build_char_system_prompt(char: Character, user_nickname: str = "用户", dialogue_mode: str = "first_person") -> str:
    parts = []
    if char.system_prompt:
        parts.append(_replace_placeholders(char.system_prompt, user_nickname, char.name))
    parts.append(f"You are {char.name}. Stay in character at all times.")
    if dialogue_mode == 'third_person':
        parts.append("Narrate in third person, describing the character's actions, dialogue, and inner thoughts from an outside perspective. Use the character's name instead of 'I'.")
    else:
        parts.append("Respond in first person as if you are the character. Speak and act as the character would.")
    if char.personality:
        parts.append(f"Personality: {_replace_placeholders(char.personality, user_nickname, char.name)}")
    if char.background:
        parts.append(f"Background: {_replace_placeholders(char.background, user_nickname, char.name)}")
    if char.scenario:
        parts.append(f"Scenario: {_replace_placeholders(char.scenario, user_nickname, char.name)}")
    if char.description:
        parts.append(f"Description: {_replace_placeholders(char.description, user_nickname, char.name)}")
    parts.append(f'The user\'s name is "{user_nickname}".')
    parts.append(
        'Response format rules:\n'
        '- Wrap spoken dialogue in double quotes: "Hello!"\n'
        '- Wrap inner thoughts and internal monologue in parentheses: (What should I do...)\n'
        '- Write actions, narration, and descriptions as plain text without special markers.\n'
        '- Do NOT use XML tags like <action> or <thinking>.\n'
        '- Never output chain-of-thought, analysis text, or labels like "Final Answer".\n'
        '- Stay immersive: respond as the character would, with emotions, gestures, and sensory details.\n'
        '- Vary response length based on the situation: short for quick exchanges, longer for emotional or dramatic moments.'
    )
    return "\n\n".join(parts)


# ───────────────────────────────────────────────
# Character Sessions
# ───────────────────────────────────────────────

@router_characters.get("/{character_id}/sessions")
async def get_character_sessions(
    character_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    char = db.query(Character).filter(Character.id == character_id, Character.user_id == user.id).first()
    if not char:
        raise HTTPException(status_code=404, detail="Character not found")
    sessions = (
        db.query(CharacterChatSession)
        .filter(CharacterChatSession.character_id == character_id, CharacterChatSession.user_id == user.id)
        .order_by(CharacterChatSession.updated_at.desc())
        .all()
    )
    return [
        {
            "id": s.id,
            "title": s.title,
            "character_id": s.character_id,
            "user_id": s.user_id,
            "dialogue_mode": s.dialogue_mode,
            "created_at": s.created_at,
            "updated_at": s.updated_at,
        }
        for s in sessions
    ]


# ───────────────────────────────────────────────
# Character status / export / import / parse / translate
# ───────────────────────────────────────────────

@router_characters.get("/{character_id}/status")
async def get_character_status(
    character_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    char = db.query(Character).filter(Character.id == character_id, Character.user_id == user.id).first()
    if not char:
        raise HTTPException(status_code=404, detail="Character not found")
    return {
        "id": char.id,
        "is_processing": char.is_processing or False,
        "processing_status": char.processing_status or "",
    }


@router_characters.post("/{character_id}/reset-status")
async def reset_character_status(
    character_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    char = db.query(Character).filter(Character.id == character_id, Character.user_id == user.id).first()
    if not char:
        raise HTTPException(status_code=404, detail="Character not found")
    char.is_processing = False
    char.processing_status = ""
    db.commit()
    return {"status": "ok"}


@router_characters.get("/{character_id}/export")
async def export_character(
    character_id: str,
    format: str = "json",
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    char = db.query(Character).filter(Character.id == character_id, Character.user_id == user.id).first()
    if not char:
        raise HTTPException(status_code=404, detail="Character not found")

    char_dict = character_to_dict(char)
    data = {
        "name": char.name,
        "description": char.description or "",
        "personality": char.personality or "",
        "scenario": char.scenario or "",
        "first_mes": char.first_mes or "",
        "mes_example": char.mes_example or "",
        "system_prompt": char.system_prompt or "",
        "background": char.background or "",
        "creator": char.creator or "",
        "character_version": char.character_version or "",
        "tags": char_dict["tags"],
        "extensions": char_dict["extensions"],
        "avatar": char.avatar or "",
    }

    if format == "json":
        content = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
        return Response(
            content=content,
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="{char.name}.json"'},
        )
    else:
        try:
            from PIL import Image

            if char.avatar and char.avatar.startswith("data:image"):
                img_data = base64.b64decode(char.avatar.split(",", 1)[1])
            else:
                default_img = Image.new("RGBA", (256, 256), (100, 100, 200, 255))
                buf = io.BytesIO()
                default_img.save(buf, format="PNG")
                img_data = buf.getvalue()

            final_png = create_png_with_chara_card(img_data, data)
            return Response(
                content=final_png,
                media_type="image/png",
                headers={"Content-Disposition": f'attachment; filename="{char.name}.png"'},
            )
        except Exception:
            logger.exception("PNG export failed")
            raise HTTPException(status_code=500, detail="PNG export failed")


@router_characters.post("/import")
async def import_character(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """导入角色卡（PNG 或 JSON 格式）"""
    try:
        content = await file.read()
        service = CharacterImportService(db)
        result = await service.import_from_file(
            filename=file.filename or "",
            content=content,
            user_id=user.id,
        )
        return {"status": "ok", "character": result}
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        logger.exception("Failed to import character")
        raise HTTPException(status_code=500, detail="导入角色失败")


class ImportParseImageRequest(BaseModel):
    image_url: str
    model: Optional[str] = None


@router_characters.post("/import-parse-image")
async def import_parse_image(
    req: ImportParseImageRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """从图片自动解析并创建角色（用于 AI 生成图片等非角色卡 PNG）"""
    if not req.image_url:
        raise HTTPException(status_code=400, detail="image_url is required")

    image_data = None
    if req.image_url.startswith("data:image"):
        try:
            image_data = base64.b64decode(req.image_url.split(",", 1)[1])
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid base64 image data")
    else:
        if not _is_public_http_url(req.image_url):
            raise HTTPException(status_code=400, detail="Only public http(s) image URLs are allowed")
        try:
            opener = urllib.request.build_opener(_NoRedirectHandler())
            request = urllib.request.Request(
                req.image_url,
                headers={"User-Agent": "Palink-AI/1.0"}
            )
            with opener.open(request, timeout=15) as r:
                image_data = _read_with_size_limit(r)
        except ValueError:
            raise HTTPException(status_code=413, detail="Image too large (max 50MB)")
        except Exception as e:
            raise HTTPException(status_code=400, detail="Failed to download image")

    if not image_data:
        raise HTTPException(status_code=400, detail="Could not read image data")

    base64_avatar = base64.b64encode(image_data).decode('utf-8')
    content_type = "image/png" if PngCharacterCardParser.validate_png_format(image_data) else "image/jpeg"
    avatar_url = f"data:{content_type};base64,{base64_avatar}"

    char = Character(
        user_id=user.id,
        name="AI Image Character",
        description="",
        background="",
        personality="",
        scenario="",
        first_mes="",
        mes_example="",
        system_prompt="",
        creator="auto-import",
        tags="[]",
        avatar=avatar_url,
        is_processing=True,
    )
    db.add(char)
    db.commit()
    db.refresh(char)

    try:
        char.is_processing = True
        char.processing_status = "Parsing..."
        db.commit()

        model_id = req.model
        if not model_id:
            try:
                model_id = get_default_ai_model()
            except HTTPException:
                char.is_processing = False
                db.commit()
                return {"status": "ok", "character_id": str(char.id), "auto_parsed": True}

        try:
            ensure_model_available(model_id)
        except ValueError as exc:
            char.is_processing = False
            db.commit()
            return {"status": "ok", "character_id": str(char.id), "auto_parsed": True}

        prompt = (
            "Analyze this character image and generate a detailed character profile. "
            "The image shows an anime-style character. Create a character card based on what you see.\n\n"
            "Return a valid JSON object with these fields:\n"
            "- name: A fitting name for the character based on appearance\n"
            "- description: Detailed physical appearance and visual traits\n"
            "- personality: Personality traits inferred from the image\n"
            "- scenario: A possible scenario or setting for this character\n"
            "- background: Background story or origin\n"
            "- first_mes: An opening message/greeting in character\n"
            "- mes_example: Example dialogues (3-4 exchanges)"
        )
        completion = await complete_text_completion(
            model_id=model_id,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.5,
            max_tokens=1500,
            timeout=60.0,
        )
        content = completion.get("content") or ""
        match = re.search(r"\{.*\}", content, re.DOTALL)
        if match:
            parsed = json.loads(match.group(0))
            if parsed.get("name"):
                char.name = parsed["name"][:100]
            if parsed.get("description"):
                char.description = parsed["description"]
            if parsed.get("personality"):
                char.personality = parsed["personality"]
            if parsed.get("scenario"):
                char.scenario = parsed["scenario"]
            if parsed.get("background"):
                char.background = parsed["background"]
            if parsed.get("first_mes"):
                char.first_mes = parsed["first_mes"]
            if parsed.get("mes_example"):
                char.mes_example = parsed["mes_example"]

        char.is_processing = False
        char.processing_status = ""
        db.commit()
    except Exception as e:
        logger.exception("Parse failed for character %s", char.id)
        char.is_processing = False
        char.processing_status = "Parsing failed"
        db.commit()

    return {"status": "ok", "character_id": str(char.id), "auto_parsed": True}


class ParseCharacterRequest(BaseModel):
    character_id: Optional[str] = None
    image_url: Optional[str] = None
    model: Optional[str] = None


@router_characters.post("/parse")
async def parse_character_card(
    req: ParseCharacterRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """解析角色卡：支持从 URL 或从已导入的角色卡用 AI 解析"""
    if not req.character_id and not req.image_url:
        raise HTTPException(status_code=400, detail="Either character_id or image_url is required")

    if req.image_url:
        try:
            normalized_url = normalize_image_url(req.image_url, check_size=True)

            if normalized_url.startswith("data:image"):
                img_data = base64.b64decode(normalized_url.split(",", 1)[1])
            else:
                if not _is_public_http_url(normalized_url):
                    raise HTTPException(status_code=400, detail="Only public http(s) image URLs are allowed")

                opener = urllib.request.build_opener(_NoRedirectHandler())
                request = urllib.request.Request(
                    normalized_url,
                    headers={"User-Agent": "Palink-AI/1.0"}
                )

                with opener.open(request, timeout=10) as r:  # nosec B310
                    content_type = (r.headers.get("Content-Type") or "").lower()
                    if content_type and not content_type.startswith("image/"):
                        raise HTTPException(status_code=415, detail="URL did not return an image")
                    img_data = _read_with_size_limit(r, max_size=10 * 1024 * 1024)

        except ValueError:
            raise HTTPException(status_code=413, detail="Image too large (max 10MB)")
        except HTTPException:
            raise
        except Exception:
            logger.exception("Failed to fetch character image from URL")
            raise HTTPException(status_code=400, detail="Failed to fetch image")

        char_data = PngCharacterCardParser.extract_character_data(img_data)
        if not char_data:
            raise HTTPException(status_code=422, detail="No character data found in image")

        if "data" in char_data and isinstance(char_data["data"], dict):
            char_data = char_data["data"]

        return {"status": "ok", "character": char_data}

    if req.character_id:
        char = db.query(Character).filter(Character.id == req.character_id, Character.user_id == user.id).first()
        if not char:
            raise HTTPException(status_code=404, detail="Character not found")

        char.is_processing = True
        char.processing_status = "Parsing..."
        db.commit()

        model_id = req.model
        if not model_id:
            try:
                model_id = get_default_ai_model()
            except HTTPException:
                char.is_processing = False
                db.commit()
                raise

        try:
            ensure_model_available(model_id)
        except ValueError as exc:
            char.is_processing = False
            db.commit()
            raise HTTPException(status_code=400, detail=str(exc))

        fields_to_parse = {
            "description": char.description or "",
            "personality": char.personality or "",
            "scenario": char.scenario or "",
            "background": char.background or "",
        }

        try:
            prompt = (
                "Parse the following character card content, extract and organize the information. "
                "Return a valid JSON object with the same keys, clean up any messy format, "
                "and improve the content to be more coherent and structured.\n\n"
                + json.dumps(fields_to_parse, ensure_ascii=False)
            )
            completion = await complete_text_completion(
                model_id=model_id,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.3,
                max_tokens=1200,
                timeout=30.0,
            )
            content = completion.get("content") or ""
            match = re.search(r"\{.*\}", content, re.DOTALL)
            if match:
                parsed = json.loads(match.group(0))
                if parsed.get("description"):
                    char.description = parsed["description"]
                if parsed.get("personality"):
                    char.personality = parsed["personality"]
                if parsed.get("scenario"):
                    char.scenario = parsed["scenario"]
                if parsed.get("background"):
                    char.background = parsed["background"]

            char.is_processing = False
            char.processing_status = ""
            db.commit()
            return {"status": "ok", "character": character_to_dict(char)}
        except Exception:
            char.is_processing = False
            char.processing_status = "Parsing failed"
            db.commit()
            logger.exception("Character parsing failed")
            raise HTTPException(status_code=500, detail="Character parsing failed")


class TranslateRequest(BaseModel):
    character_id: str
    target_language: str = "zh"
    model: Optional[str] = None


@router_characters.post("/translate")
async def translate_character(
    req: TranslateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """用 AI 翻译角色卡内容"""
    char = db.query(Character).filter(Character.id == req.character_id, Character.user_id == user.id).first()
    if not char:
        raise HTTPException(status_code=404, detail="Character not found")

    # Mark as processing
    char.is_processing = True
    char.processing_status = "Translating..."
    db.commit()

    lang_name = "Chinese (Simplified)" if req.target_language == "zh" else req.target_language

    model_id = req.model
    if not model_id:
        try:
            model_id = get_default_ai_model()
        except HTTPException:
            char.is_processing = False
            db.commit()
            raise

    try:
        ensure_model_available(model_id)
    except ValueError as exc:
        char.is_processing = False
        db.commit()
        raise HTTPException(status_code=400, detail=str(exc))

    fields_to_translate = {
        "description": char.description or "",
        "personality": char.personality or "",
        "scenario": char.scenario or "",
        "first_mes": char.first_mes or "",
        "background": char.background or "",
        "system_prompt": char.system_prompt or "",
    }

    try:
        prompt = (
            f"Translate the following character card fields to {lang_name}. "
            f"Return a valid JSON object with the same keys. You MUST translate ALL 6 fields. "
            f"Keep proper nouns (character names) unchanged. Do not omit any field.\n\n"
            + json.dumps(fields_to_translate, ensure_ascii=False)
        )
        completion = await complete_text_completion(
            model_id=model_id,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
            max_tokens=1500,
            timeout=30.0,
        )
        content = completion.get("content") or ""
        match = re.search(r"\{.*\}", content, re.DOTALL)
        if match:
            translated = json.loads(match.group(0))
            if translated.get("description"):
                char.description = translated["description"]
            if translated.get("personality"):
                char.personality = translated["personality"]
            if translated.get("scenario"):
                char.scenario = translated["scenario"]
            if translated.get("first_mes"):
                char.first_mes = translated["first_mes"]
            if translated.get("background"):
                char.background = translated["background"]
            if translated.get("system_prompt"):
                char.system_prompt = translated["system_prompt"]

        char.is_processing = False
        char.processing_status = ""
        db.commit()
        db.refresh(char)
        return {"status": "ok", "character": character_to_dict(char)}
    except Exception:
        char.is_processing = False
        char.processing_status = "Translation failed"
        db.commit()
        logger.exception("Character translation failed")
        raise HTTPException(status_code=500, detail="Character translation failed")


# ───────────────────────────────────────────────
# Session management
# ───────────────────────────────────────────────

@router_sessions.delete("/{session_id}")
async def delete_character_session(
    session_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    session = db.query(CharacterChatSession).filter(
        CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    db.delete(session)
    db.commit()
    return {"status": "ok"}


@router_sessions.get("/{session_id}/messages")
async def get_character_session_messages(
    session_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    session = db.query(CharacterChatSession).filter(
        CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # Get active branch
    active_branch = db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.session_id == session_id,
        CharacterChatSessionBranch.is_active == True
    ).first()

    # Use full ancestor-chain traversal so child branches include
    # parent messages up to the fork point (fixes empty-message bug).
    if active_branch:
        messages = _get_full_branch_history(db, session_id, active_branch.id, limit=1000)
    else:
        latest_branch = db.query(CharacterChatSessionBranch).filter(
            CharacterChatSessionBranch.session_id == session_id
        ).order_by(CharacterChatSessionBranch.created_at.desc()).first()
        if latest_branch:
            messages = _get_full_branch_history(db, session_id, latest_branch.id, limit=1000)
        else:
            messages = (
                db.query(CharacterChatMessage)
                .filter(
                    CharacterChatMessage.session_id == session_id,
                    CharacterChatMessage.branch_id == None,
                )
                .order_by(CharacterChatMessage.created_at)
                .all()
            )

    return [
        {
            "id": m.id,
            "role": m.role,
            "content": m.content,
            "model": m.model,
            "created_at": m.created_at,
            "tokens": m.tokens,
            "branch_id": m.branch_id,
        }
        for m in messages
    ]


@router_sessions.delete("/{session_id}/messages/{message_id}")
async def delete_character_message(
    session_id: str,
    message_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    session = db.query(CharacterChatSession).filter(
        CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    msg = db.query(CharacterChatMessage).filter(
        CharacterChatMessage.id == message_id,
        CharacterChatMessage.session_id == session_id
    ).first()
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")
    db.delete(msg)
    db.commit()
    return {"status": "ok"}


class MessageEditRequest(BaseModel):
    content: str


@router_sessions.put("/{session_id}/messages/{message_id}")
async def edit_character_message(
    session_id: str,
    message_id: int,
    req: MessageEditRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    session = db.query(CharacterChatSession).filter(
        CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    msg = db.query(CharacterChatMessage).filter(
        CharacterChatMessage.id == message_id,
        CharacterChatMessage.session_id == session_id
    ).first()
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")
    msg.content = req.content
    db.commit()
    return {"status": "ok"}


# ───────────────────────────────────────────────
# Branches
# ───────────────────────────────────────────────

class BranchCreateRequest(BaseModel):
    session_id: str
    branch_name: Optional[str] = None
    parent_message_id: Optional[int] = None
    parent_branch_id: Optional[str] = None
    same_level: bool = True


@router_sessions.get("/{session_id}/branches")
async def get_branches(
    session_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    session = db.query(CharacterChatSession).filter(
        CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    branches = db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.session_id == session_id
    ).all()
    if not branches:
        # Auto-create main branch
        main_branch = CharacterChatSessionBranch(
            session_id=session_id,
                branch_name="分支 1",
            is_active=True,
        )
        db.add(main_branch)
        db.commit()
        db.refresh(main_branch)
        branches = [main_branch]
    return [
        {
            "id": b.id,
            "session_id": b.session_id,
            "branch_name": b.branch_name,
            "is_active": b.is_active,
            "parent_message_id": b.parent_message_id,
            "created_at": b.created_at,
        }
        for b in branches
    ]


@router_sessions.post("/{session_id}/branches")
async def create_branch(
    session_id: str,
    req: BranchCreateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    session = db.query(CharacterChatSession).filter(
        CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    existing_branches = db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.session_id == session_id
    ).all()
    is_first_branch = len(existing_branches) == 0

    branch_name = req.branch_name
    if not branch_name:
        # 计算同级分支数量
        sibling_branches = [
            b for b in existing_branches
         if b.parent_branch_id == req.parent_branch_id
            and b.parent_message_id == req.parent_message_id
        ]
        branch_num = len(sibling_branches) + 1
        branch_name = f"分支 {branch_num}"

    effective_parent_branch_id = req.parent_branch_id
    effective_parent_message_id = req.parent_message_id

    # Validate that parent_message_id points to an assistant message if provided
    if effective_parent_message_id is not None and effective_parent_branch_id is not None:
        parent_msg = db.query(CharacterChatMessage).filter(
            CharacterChatMessage.id == effective_parent_message_id,
            CharacterChatMessage.session_id == session_id,
         CharacterChatMessage.branch_id == effective_parent_branch_id,
        ).first()
        if parent_msg and parent_msg.role != "assistant":
          raise HTTPException(
                status_code=400,
                detail="parent_message_id must point to an assistant message (end of dialogue pair)"
        )

    if req.same_level and not is_first_branch:
        active_branch = next((b for b in existing_branches if b.is_active), None)
        if active_branch:
            effective_parent_branch_id = active_branch.parent_branch_id
            effective_parent_message_id = active_branch.parent_message_id

    # Check branch limit: max 3 branches per node (dialogue pair)
    child_count = _count_child_branches_from_node(
        db, session_id, effective_parent_branch_id, effective_parent_message_id
    )
    if child_count >= 3:
        raise HTTPException(status_code=400, detail="每个节点最多只能创建3个分支")

    is_root_branch = effective_parent_branch_id is None and effective_parent_message_id is None

    branch = CharacterChatSessionBranch(
        session_id=session_id,
        branch_name=branch_name,
        parent_message_id=effective_parent_message_id,
        parent_branch_id=effective_parent_branch_id,
        is_active=True,
    )
    db.add(branch)

    if not is_first_branch:
        db.query(CharacterChatSessionBranch).filter(
            CharacterChatSessionBranch.session_id == session_id,
            CharacterChatSessionBranch.id != branch.id,
        ).update({"is_active": False}, synchronize_session=False)

    db.commit()
    db.refresh(branch)

    greeting_msg = None
    messages_result = []

    if session.character_id:
        char = db.query(Character).filter(Character.id == session.character_id).first()
        if char and char.first_mes:
            should_add_greeting = False
            if is_root_branch:
                should_add_greeting = True
            elif is_first_branch:
                should_add_greeting = True
            elif not req.same_level and req.parent_message_id is not None:
                should_add_greeting = False
            else:
                branch_depth = 0
                current_bid = effective_parent_branch_id
                visited = set()
                while current_bid and current_bid not in visited:
                    visited.add(current_bid)
                    parent_b = db.query(CharacterChatSessionBranch).filter(
                        CharacterChatSessionBranch.id == current_bid
                    ).first()
                    if parent_b:
                        branch_depth += 1
                        current_bid = parent_b.parent_branch_id
                    else:
                        break
                if branch_depth <= 1:
                    should_add_greeting = True

            if should_add_greeting:
                greeting_msg = CharacterChatMessage(
                    session_id=session_id,
                    branch_id=branch.id,
                    role="assistant",
                    content=char.first_mes,
                )
                db.add(greeting_msg)
                db.commit()
                db.refresh(greeting_msg)
                messages_result.append({
                    "id": greeting_msg.id,
                    "role": greeting_msg.role,
                    "content": greeting_msg.content,
                })

    return {
        "status": "ok",
        "branch": {"id": branch.id, "branch_name": branch.branch_name, "is_active": branch.is_active},
        "greeting": {
            "id": greeting_msg.id if greeting_msg else None,
            "content": greeting_msg.content if greeting_msg else None,
            "role": "assistant",
        } if greeting_msg else None,
        "messages": messages_result,
    }


@router_sessions.post("/{session_id}/branches/{branch_id}/switch")
async def switch_branch(
    session_id: str,
    branch_id: str,
    up_to_message_id: Optional[int] = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    session = db.query(CharacterChatSession).filter(
        CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # Deactivate all branches
    db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.session_id == session_id
    ).update({"is_active": False}, synchronize_session=False)

    # Activate target branch
    branch = db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.id == branch_id,
        CharacterChatSessionBranch.session_id == session_id
    ).first()
    if not branch:
        raise HTTPException(status_code=404, detail="Branch not found")
    branch.is_active = True
    db.commit()

    # Return messages using full ancestor-chain traversal
    hist = _get_full_branch_history(db, session_id, branch_id, limit=1000, up_to_message_id=up_to_message_id)
    messages = [{"id": m.id, "role": m.role, "content": m.content, "model": m.model, "created_at": m.created_at} for m in hist]
    return {"status": "ok", "messages": messages, "up_to_message_id": up_to_message_id}


@router_sessions.post("/{session_id}/branches/{branch_id}/favorite")
async def toggle_favorite_branch(
    session_id: str,
    branch_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """收藏或取消收藏分支"""
    session = db.query(CharacterChatSession).filter(
     CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id
    ).first()
    if not session:
      raise HTTPException(status_code=404, detail="Session not found")

    branch = db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.id == branch_id,
        CharacterChatSessionBranch.session_id == session_id
    ).first()
    if not branch:
        raise HTTPException(status_code=404, detail="Branch not found")

    branch.is_favorited = not branch.is_favorited
    db.commit()

    return {"status": "ok", "is_favorited": branch.is_favorited}


@router_sessions.post("/{session_id}/branches/{branch_id}/unfreeze")
async def unfreeze_branch(
    session_id: str,
    branch_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """解冻分支(用户重新进入冻结的分支时调用)"""
    session = db.query(CharacterChatSession).filter(
        CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    branch = db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.id == branch_id,
        CharacterChatSessionBranch.session_id == session_id
    ).first()
    if not branch:
        raise HTTPException(status_code=404, detail="Branch not found")

    branch.is_frozen = False
    branch.last_message_at = datetime.now(timezone.utc)
    db.commit()

    return {"status": "ok"}


@router_sessions.post("/{session_id}/check-frozen-branches")
async def check_frozen_branches(
    session_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """检查并冻结超过5个对话（10条消息）未继续的分支"""
    session = db.query(CharacterChatSession).filter(
      CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    branches = db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.session_id == session_id,
        CharacterChatSessionBranch.is_favorited == False  # 收藏的分支不冻结
    ).all()

    frozen_count = 0
    for branch in branches:
        # 计算该分支的消息数量
        message_count = db.query(CharacterChatMessage).filter(
            CharacterChatMessage.branch_id == branch.id
        ).count()

        # 如果消息数量超过10条，检查最后消息时间
        if message_count >= 10:
            # 获取该分支的最后一条消息
            last_msg = db.query(CharacterChatMessage).filter(
                CharacterChatMessage.branch_id == branch.id
            ).order_by(CharacterChatMessage.created_at.desc()).first()

            if last_msg:
                # 计算距离最后一条消息的对话轮数
                messages_after = db.query(CharacterChatMessage).filter(
                    CharacterChatMessage.session_id == session_id,
                    CharacterChatMessage.created_at > last_msg.created_at
                ).count()

                # 如果之后有超过10条消息（5轮对话），则冻结
                if messages_after >= 10 and not branch.is_frozen:
                    branch.is_frozen = True
                    frozen_count += 1

    db.commit()

    return {"status": "ok", "frozen_count": frozen_count}


@router_sessions.get("/{session_id}/branch-tree")
async def get_branch_tree(
    session_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Return all branches and their message pairs for storyline visualization."""
    session = db.query(CharacterChatSession).filter(
        CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    branches = db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.session_id == session_id
    ).order_by(CharacterChatSessionBranch.created_at).all()

    if not branches:
        main_branch = CharacterChatSessionBranch(
            session_id=session_id,
                branch_name="分支 1",
            is_active=True,
        )
        db.add(main_branch)
        db.commit()
        db.refresh(main_branch)
        branches = [main_branch]

    all_messages = (
        db.query(CharacterChatMessage)
        .filter(
            CharacterChatMessage.session_id == session_id,
            CharacterChatMessage.branch_id.in_([b.id for b in branches]),
        )
        .order_by(CharacterChatMessage.created_at)
        .all()
    )

    msg_by_branch = {}
    for msg in all_messages:
        msg_by_branch.setdefault(msg.branch_id, []).append(msg)

    result_branches = []
    for branch in branches:
        msgs = msg_by_branch.get(branch.id, [])
        pairs = []
        pending_user = None
        for msg in msgs:
            if msg.role == "user":
                pending_user = msg
            elif msg.role == "assistant":
                if pending_user:
                    # Strip <think>...</think> blocks for summary
                    ai_display = re.sub(r"<thinking>[\s\S]*?</thinking>", "", msg.content).strip()
                    pairs.append({
                        "pair_id": f"pair_{pending_user.id}",
                        "user_msg_id": pending_user.id,
                        "ai_msg_id": msg.id,
                        "node_title": msg.short_title or ai_display[:20],
                        "user_summary": pending_user.content[:80],
                        "ai_summary": ai_display[:80],
                        "created_at": msg.created_at.isoformat() if msg.created_at else None,
                    })
                    pending_user = None
                else:
                    ai_display = re.sub(r"<thinking>[\s\S]*?</thinking>", "", msg.content).strip()
                    pairs.append({
                        "pair_id": f"ai_{msg.id}",
                        "user_msg_id": None,
                        "ai_msg_id": msg.id,
                        "node_title": msg.short_title or ai_display[:20],
                        "user_summary": None,
                        "ai_summary": ai_display[:80],
                        "created_at": msg.created_at.isoformat() if msg.created_at else None,
                    })
        result_branches.append({
            "id": branch.id,
            "branch_name": branch.branch_name,
            "parent_branch_id": branch.parent_branch_id,
            "parent_message_id": branch.parent_message_id,
            "is_active": branch.is_active,
          "is_frozen": branch.is_frozen,
            "is_favorited": branch.is_favorited,
            "last_message_at": branch.last_message_at.isoformat() if branch.last_message_at else None,
            "created_at": branch.created_at.isoformat() if branch.created_at else None,
            "nodes": pairs,
        })

    active_branch = next((b for b in branches if b.is_active), None)

    character_info = None
    if session.character_id:
        char = db.query(Character).filter(Character.id == session.character_id).first()
        if char:
            character_info = {
                "id": char.id,
                "name": char.name,
                "avatar": char.avatar or "",
                "first_mes": char.first_mes or "",
                "background": char.background or "",
                "user_nickname": char.user_nickname or "",
            }

    return {
        "branches": result_branches,
        "active_branch_id": active_branch.id if active_branch else None,
        "character_info": character_info,
    }


@router_sessions.delete("/{session_id}/branches/{branch_id}")
async def delete_branch(
    session_id: str,
    branch_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    session = db.query(CharacterChatSession).filter(
        CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    branch = db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.id == branch_id,
        CharacterChatSessionBranch.session_id == session_id
    ).first()
    if not branch:
        raise HTTPException(status_code=404, detail="Branch not found")
    if branch.is_active:
        raise HTTPException(status_code=400, detail="Cannot delete the active branch")

    def _collect_descendant_branch_ids(bid: str, collected: list):
        children = db.query(CharacterChatSessionBranch).filter(
            CharacterChatSessionBranch.parent_branch_id == bid
        ).all()
        for child in children:
            collected.append(child.id)
            _collect_descendant_branch_ids(child.id, collected)

    branch_ids_to_delete = [branch_id]
    _collect_descendant_branch_ids(branch_id, branch_ids_to_delete)

    db.query(CharacterChatMessage).filter(
        CharacterChatMessage.branch_id.in_(branch_ids_to_delete)
    ).delete(synchronize_session=False)

    db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.id.in_(branch_ids_to_delete)
    ).delete(synchronize_session=False)

    db.commit()
    return {"status": "ok", "deleted_branches": branch_ids_to_delete}


# ───────────────────────────────────────────────
# Character Chat (Streaming)
# ───────────────────────────────────────────────

class CharacterChatRequest(BaseModel):
    character_id: str
    message: str
    session_id: Optional[str] = None
    model: str
    temperature: float = 0.7
    top_p: float = 0.95
    max_tokens: int = 2048
    frequency_penalty: float = 0.0
    presence_penalty: float = 0.0
    min_p: float = 0.05
    top_k: int = 40
    repetition_penalty: float = 1.1
    dialogue_mode: str = "first_person"
    branch_id: Optional[str] = None
    user_nickname: Optional[str] = None
    images: List[str] = []
    files: List[str] = []


@router_chat.post("/api/character-chat")
async def character_chat(
    req: CharacterChatRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    try:
        return await _character_chat_impl(req, request, user, db)
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        logger.debug("[CHARACTER-CHAT-ERROR] %s: %s\n%s", type(e).__name__, e, tb)
        raise


async def _character_chat_impl(
    req: CharacterChatRequest,
    request: Request,
    user: User,
    db: Session,
):
    enforce_rate_limit(
        request,
        "chat:character",
        settings.CHARACTER_CHAT_RATE_LIMIT_REQUESTS,
        settings.CHARACTER_CHAT_RATE_LIMIT_WINDOW_SECONDS,
    )
    char = db.query(Character).filter(Character.id == req.character_id, Character.user_id == user.id).first()
    if not char:
        raise HTTPException(status_code=404, detail="Character not found")

    user_nickname = req.user_nickname or user.username or "用户"
    is_init = req.message.strip() == "__INIT__"

    if not is_init:
        try:
            ensure_model_available(req.model)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid model")

    # ── Ensure session ──────────────────────────────────────────────────
    session_id = req.session_id
    is_new_session = False
    if not session_id or session_id == "":
        session_id = str(uuid.uuid4())
        is_new_session = True
        initial_title = char.name
        if not is_init and (req.message or "").strip():
            try:
                initial_title = await generate_compact_title(
                    db,
                    req.message,
                    fallback_model_id=req.model,
                    max_len=10,
                )
            except Exception as e:
                logger.warning(f"Character session compact title fallback used: {e}")
                db.rollback()
        new_session = CharacterChatSession(
            id=session_id,
            character_id=char.id,
            user_id=user.id,
            title=initial_title,
            dialogue_mode=req.dialogue_mode,
        )
        db.add(new_session)
        db.commit()
    else:
        existing_session = db.query(CharacterChatSession).filter(
            CharacterChatSession.id == session_id,
            CharacterChatSession.user_id == user.id,
            CharacterChatSession.character_id == char.id,
        ).first()
        if not existing_session:
            raise HTTPException(status_code=404, detail="Session not found")

        existing_session.updated_at = datetime.now(timezone.utc)
        db.commit()

    # ── Ensure active branch ────────────────────────────────────────────
    branch_id = req.branch_id
    if not branch_id:
        active_branch = db.query(CharacterChatSessionBranch).filter(
            CharacterChatSessionBranch.session_id == session_id,
            CharacterChatSessionBranch.is_active == True
        ).first()
        if active_branch:
            branch_id = active_branch.id
        else:
            if is_new_session:
                main_branch = CharacterChatSessionBranch(
                    session_id=session_id,
                        branch_name="分支 1",
                    is_active=True,
                )
                db.add(main_branch)
                db.commit()
                db.refresh(main_branch)
                branch_id = main_branch.id
    else:
        branch = db.query(CharacterChatSessionBranch).filter(
            CharacterChatSessionBranch.id == branch_id,
            CharacterChatSessionBranch.session_id == session_id,
        ).first()
        if not branch:
            raise HTTPException(status_code=404, detail="Branch not found")

    # ── Memory context ───────────────────────────────────────────────
    memory_mode = "disabled"
    user_setting = db.query(UserSetting).filter(UserSetting.user_id == user.id).first()
    if user_setting and user_setting.memory_mode:
        memory_mode = user_setting.memory_mode

    author_note = None
    author_note_position = "after_char"
    author_note_frequency = 0
    if user_setting:
        if user_setting.author_note:
            author_note = user_setting.author_note
        if user_setting.author_note_position:
            author_note_position = user_setting.author_note_position
        if user_setting.author_note_frequency is not None:
            author_note_frequency = user_setting.author_note_frequency

    # ── Build messages array ────────────────────────────────────────────
    system_prompt = _build_char_system_prompt(char, user_nickname, req.dialogue_mode or "first_person")

    if author_note:
        note_text = _replace_placeholders(author_note, user_nickname, char.name or '')
        if author_note_position == "before_char":
            system_prompt = note_text + "\n\n" + system_prompt
        elif author_note_position == "after_system":
            system_prompt = system_prompt + "\n\n" + note_text
        else:
            system_prompt = system_prompt + "\n\n" + note_text

    # ── Inject world book context (keyword-trigger) ─────────────────────
    if not is_init:
        try:
            nested = db.begin_nested()
            from ..models.character import CharacterChatMessage as CCM
            recent_for_wb = db.query(CCM).filter(
                CCM.session_id == session_id
            ).order_by(CCM.created_at.desc()).limit(8).all()[::-1]
            recent_msgs_for_wb = [{"role": m.role, "content": m.content} for m in recent_for_wb]
            wb_context = build_worldbook_context(db, session_id, user.id, recent_msgs_for_wb)
            if wb_context:
                system_prompt += "\n\n" + _replace_placeholders(wb_context, user_nickname, char.name or '')
            nested.commit()
        except Exception as e:
            logger.warning(f"World book context injection failed: {e}")
            try:
                nested.rollback()
            except Exception:
                try:
                    db.rollback()
                except Exception:
                    pass

    if not is_init:
        try:
            nested = db.begin_nested()
            pl_context = build_plotline_context(db, session_id, user.id)
            if pl_context:
                system_prompt += "\n\n" + _replace_placeholders(pl_context, user_nickname, char.name or '')
            nested.commit()
        except Exception as e:
            logger.warning(f"Plot line context injection failed: {e}")
            try:
                nested.rollback()
            except Exception:
                try:
                    db.rollback()
                except Exception:
                    pass

    if memory_mode != "disabled" and not is_init:
        try:
            nested = db.begin_nested()
            mem_svc = MemoryService(db)
            if mem_svc.is_available():
                ancestor_branch_ids = _get_ancestor_branch_ids(db, session_id, branch_id)
                mem_ctx = await mem_svc.get_context(
                    user_id=user.id,
                    query=req.message,
                    session_id=session_id,
                    max_tokens=1500,
                    branch_ids=ancestor_branch_ids if ancestor_branch_ids else None,
                )
                if mem_ctx and mem_ctx.memories:
                    memory_text = build_memory_context(mem_ctx)
                    if memory_text:
                        system_prompt += "\n\n" + _replace_placeholders(memory_text, user_nickname, char.name or '')
            nested.commit()
        except Exception as e:
            logger.warning(f"Memory context retrieval failed: {e}")
            try:
                nested.rollback()
            except Exception:
                try:
                    db.rollback()
                except Exception:
                    pass

    messages = [{"role": "system", "content": system_prompt}]

    if char.mes_example:
        messages.append({"role": "system", "content": f"Example dialogue:\n{_replace_placeholders(char.mes_example, user_nickname, char.name or '')}"})

    # Load history using ancestor-chain traversal for correct branch context
    if not is_init:
        if branch_id:
            history = _get_full_branch_history(
                db,
                session_id,
                branch_id,
                limit=settings.CHARACTER_CHAT_HISTORY_LIMIT,
            )
        else:
            history = (
                db.query(CharacterChatMessage)
                .filter(
                    CharacterChatMessage.session_id == session_id,
                    CharacterChatMessage.branch_id == None,
                )
                .order_by(CharacterChatMessage.created_at.desc())
                .limit(settings.CHARACTER_CHAT_HISTORY_LIMIT)
                .all()[::-1]
            )
        for m in history:
            messages.append({"role": m.role, "content": m.content})

    # ── Handle __INIT__ (send character's first message) ────────────────
    if is_init:
        first_mes = (char.first_mes or "").strip()
        first_mes = _replace_placeholders(first_mes, user_nickname, char.name or "")
        if not first_mes:
            return {"session_id": session_id, "message": ""}
        init_short_title = rule_based_compact_title(first_mes, max_len=10)
        # Save the character's first message directly
        db.add(CharacterChatMessage(
            session_id=session_id,
            branch_id=branch_id,
            role="assistant",
            content=first_mes,
            short_title=init_short_title,
            model=req.model,
        ))
        db.commit()

        async def init_stream():
            yield f"data: {json.dumps({'session_id': session_id, 'branch_id': branch_id})}\n\n"
            # Stream the first message char by char in chunks
            chunk_size = 20
            for i in range(0, len(first_mes), chunk_size):
                yield f"data: {json.dumps({'content': first_mes[i:i+chunk_size]})}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(
            init_stream(),
            media_type="text/event-stream; charset=utf-8",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # ── Regular message ─────────────────────────────────────────────────
    user_content = req.message
    if req.images:
        content_payload = [{"type": "text", "text": user_content}]
        for img_url in req.images:
            normalized_img_url = normalize_image_url(img_url, check_size=True)
            content_payload.append({"type": "image_url", "image_url": {"url": normalized_img_url}})
        user_msg = {"role": "user", "content": content_payload}
    else:
        user_msg = {"role": "user", "content": user_content}

    messages.append(user_msg)

    # Save user message
    db.add(CharacterChatMessage(
        session_id=session_id,
        branch_id=branch_id,
      role="user",
        content=req.message,
        model=req.model,
    ))

    # 更新分支的最后消息时间
    if branch_id:
        branch = db.query(CharacterChatSessionBranch).filter(
            CharacterChatSessionBranch.id == branch_id
        ).first()
        if branch:
            branch.last_message_at = datetime.now(timezone.utc)
            branch.is_frozen = False  # 有新消息时解冻

    db.commit()

    async def event_generator() -> AsyncGenerator[str, None]:
        from ..services.stream_builder import StreamResult, stream_chat_deltas
        result = StreamResult()
        try:
            initial_events = []
            if is_new_session:
                initial_events.append({"session_id": session_id, "branch_id": branch_id})

            stream = stream_text_completion(
                model_id=req.model,
                messages=messages,
                temperature=req.temperature,
                top_p=req.top_p,
                max_tokens=req.max_tokens,
                frequency_penalty=req.frequency_penalty,
                presence_penalty=req.presence_penalty,
                min_p=req.min_p,
                top_k=req.top_k,
                repetition_penalty=req.repetition_penalty,
                timeout=30.0,
            )

            async for sse_event in stream_chat_deltas(stream, result, initial_events=initial_events):
                yield sse_event

            from ..core.database import SessionLocal
            new_db = SessionLocal()
            try:
                final = result.final_text()
                token_count = result.token_count()
                short_title = await generate_compact_title(
                    new_db,
                    f"{req.message}\n{result.full_content}",
                    fallback_model_id=req.model,
                    max_len=10,
                )
                new_db.add(CharacterChatMessage(
                    session_id=session_id,
                    branch_id=branch_id,
                    role="assistant",
                    content=final,
                    short_title=short_title,
                    model=req.model,
                    tokens=token_count,
                    prompt_tokens=result.prompt_tokens,
                    reasoning_tokens=result.effective_reasoning_tokens(),
                ))
                new_db.commit()

                if memory_mode != "disabled":
                    try:
                        mem_svc = MemoryService(new_db)
                        if mem_svc.is_available():
                            mem_svc.store_memory(
                                user_id=user.id,
                                session_id=session_id,
                                role="user",
                                content=req.message,
                                branch_id=branch_id,
                            )
                            mem_svc.store_memory(
                                user_id=user.id,
                                session_id=session_id,
                                role="assistant",
                                content=result.full_content,
                                branch_id=branch_id,
                            )
                            new_db.commit()
                    except Exception as e:
                        logger.warning(f"Memory storage failed: {e}")
            finally:
                new_db.close()

        except ServiceError as e:
            logger.exception("Character chat stream service error")
            yield f"data: {json.dumps({'content': 'Error: Service error', 'error': True}, ensure_ascii=False)}\n\n"
        except Exception as e:
            logger.exception("Character chat stream error")
            yield f"data: {json.dumps({'content': 'Error: Internal error', 'error': True}, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream; charset=utf-8",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
