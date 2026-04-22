"""
角色扩展路由：会话、分支、对话流、导入/导出、解析、翻译
"""
import os
import io
import json
import uuid
import logging
import base64
import mimetypes
import socket
import ipaddress
import urllib.request
from typing import Optional, List
from datetime import datetime, timezone
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Request
from fastapi.responses import StreamingResponse, Response
from sqlalchemy.orm import Session
from pydantic import BaseModel

from ..core import get_db, settings
from ..core.rate_limit import enforce_rate_limit
from ..api.dependencies import get_current_user
from ..models import User, Character, CharacterChatSession, CharacterChatMessage, CharacterChatSessionBranch
from ..models.system import UserSetting
from ..character_card import extract_chara_card_from_png
from ..memory_module.service import MemoryService
from ..services.worldbook_service import build_worldbook_context
from ..services.plotline_service import build_plotline_context
from ..services.provider_registry import get_runtime_providers
from ..services.inference_dispatcher import (
    complete_text_completion,
    ensure_model_available,
    stream_text_completion,
)
from ..services.local_model_registry import list_enabled_chat_models
from ..services.compact_title_service import generate_compact_title

router_characters = APIRouter(prefix="/api/characters", tags=["character-ext"])
router_sessions = APIRouter(prefix="/api/character-sessions", tags=["character-sessions"])
router_chat = APIRouter(tags=["character-chat"])

logger = logging.getLogger(__name__)


# ───────────────────────────────────────────────
# Branch History Helpers
# ───────────────────────────────────────────────

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


def _get_full_branch_history(db: Session, session_id: str, branch_id: str, limit: int = 60) -> list:
    """Return ordered messages by traversing the ancestor branch chain.

    For the target branch itself all messages are loaded.  For each ancestor
    branch only messages up to (and including) the fork-point message are
    loaded so that messages after the fork on a parent branch are excluded.
    """
    branch = db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.id == branch_id,
        CharacterChatSessionBranch.session_id == session_id,
    ).first()
    if not branch:
        return []

    # Build chain from target branch back to root.
    # Each entry: (branch_obj, up_to_message_id | None)
    #   up_to_message_id=None  → load ALL messages on that branch
    #   up_to_message_id=<id>  → load messages up to (inclusive) that id
    chain: list = []
    cur = branch
    up_to: int | None = None  # target branch: load everything
    while cur:
        chain.append((cur, up_to))
        if cur.parent_branch_id:
            up_to = cur.parent_message_id  # limit parent to fork point
            parent = db.query(CharacterChatSessionBranch).filter(
                CharacterChatSessionBranch.id == cur.parent_branch_id,
                CharacterChatSessionBranch.session_id == session_id,
            ).first()
            cur = parent
        else:
            break

    chain.reverse()  # root-first order

    all_msgs: list = []
    for b, up_to_id in chain:
        msgs = _get_branch_messages_up_to(db, session_id, b.id, up_to_id)
        all_msgs.extend(msgs)

    # Deduplicate by id while preserving order
    seen: set = set()
    deduped: list = []
    for m in all_msgs:
        if m.id not in seen:
            seen.add(m.id)
            deduped.append(m)
    return deduped[-limit:]


# ───────────────────────────────────────────────
# Helpers
# ───────────────────────────────────────────────

def _is_public_http_url(url: str) -> bool:
    try:
        parsed = urlparse(url)
    except Exception:
        return False

    if parsed.scheme not in ("http", "https"):
        return False

    host = parsed.hostname
    if not host:
        return False

    lowered_host = host.lower()
    if lowered_host in {"localhost", "127.0.0.1", "::1"} or lowered_host.endswith(".local"):
        return False

    def _is_private_or_local_ip(ip_str: str) -> bool:
        try:
            ip_obj = ipaddress.ip_address(ip_str)
            return (
                ip_obj.is_private
                or ip_obj.is_loopback
                or ip_obj.is_link_local
                or ip_obj.is_multicast
                or ip_obj.is_reserved
                or ip_obj.is_unspecified
            )
        except ValueError:
            return False

    # Host can be a literal IP.
    if _is_private_or_local_ip(host):
        return False

    try:
        target_port = parsed.port or (443 if parsed.scheme == "https" else 80)
        addr_info = socket.getaddrinfo(host, target_port, proto=socket.IPPROTO_TCP)
    except Exception:
        return False

    for info in addr_info:
        ip_addr = info[4][0]
        if _is_private_or_local_ip(ip_addr):
            return False

    return True


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Disallow redirects to avoid SSRF bypass through redirect chains."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _normalize_model_image_url(img_url: str) -> str:
    if not isinstance(img_url, str):
        raise HTTPException(status_code=400, detail="Invalid image URL")

    normalized = img_url.strip()
    if not normalized:
        raise HTTPException(status_code=400, detail="Invalid image URL")

    if normalized.startswith("data:image"):
        return normalized

    upload_prefix = None
    if normalized.startswith("/api/uploads/"):
        upload_prefix = "/api/uploads/"
    elif normalized.startswith("/uploads/"):
        upload_prefix = "/uploads/"

    if upload_prefix:
        relative_path = normalized.split(upload_prefix, 1)[1]
        relative_path = relative_path.split("?", 1)[0].split("#", 1)[0]
        normalized_relative = os.path.normpath(relative_path).replace("\\", "/").lstrip("/")
        if not normalized_relative or normalized_relative.startswith("../"):
            raise HTTPException(status_code=400, detail="Invalid uploaded image path")

        upload_root = os.path.abspath(settings.UPLOAD_DIR)
        file_path = os.path.abspath(os.path.join(upload_root, normalized_relative))
        if os.path.commonpath([upload_root, file_path]) != upload_root:
            raise HTTPException(status_code=400, detail="Invalid uploaded image path")

        if not os.path.exists(file_path):
            raise HTTPException(status_code=404, detail="Uploaded image not found")

        file_size = os.path.getsize(file_path)
        if file_size > 10 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="Image too large (max 10MB)")

        mime_type, _ = mimetypes.guess_type(file_path)
        if not mime_type or not mime_type.startswith("image/"):
            mime_type = "image/png"

        with open(file_path, "rb") as image_file:
            encoded = base64.b64encode(image_file.read()).decode("ascii")

        return f"data:{mime_type};base64,{encoded}"

    if not _is_public_http_url(normalized):
        raise HTTPException(status_code=400, detail="Only public http(s) image URLs are allowed")

    return normalized


def _build_char_system_prompt(char: Character, user_nickname: str = "用户") -> str:
    parts = []
    if char.system_prompt:
        parts.append(char.system_prompt)
    parts.append(f"You are {char.name}. Stay in character at all times.")
    if char.personality:
        parts.append(f"Personality: {char.personality}")
    if char.background:
        parts.append(f"Background: {char.background}")
    if char.scenario:
        parts.append(f"Scenario: {char.scenario}")
    if char.description:
        parts.append(f"Description: {char.description}")
    parts.append(f'The user\'s name is "{user_nickname}".')
    parts.append(
        'Response format rules:\n'
        '- Wrap spoken dialogue in double quotes: "Hello!"\n'
        '- Wrap actions, narration, and internal thoughts in asterisks: *she smiled softly*\n'
        '- Do NOT use XML tags like <action> or <thinking>.\n'
        '- Never output chain-of-thought, analysis text, or labels like "Final Answer".\n'
        '- Write naturally, mixing dialogue and actions in the same response.'
    )
    return "\n\n".join(parts)


def _char_to_dict(c: Character) -> dict:
    result = {
        "id": c.id,
        "name": c.name,
        "description": c.description,
        "background": c.background,
        "personality": c.personality,
        "avatar": c.avatar,
        "scenario": c.scenario,
        "first_mes": c.first_mes,
        "mes_example": c.mes_example,
        "system_prompt": c.system_prompt,
        "creator": c.creator,
        "character_version": c.character_version,
        "user_nickname": c.user_nickname,
        "is_processing": c.is_processing or False,
        "processing_status": c.processing_status or "",
        "created_at": c.created_at,
        "updated_at": c.updated_at,
    }
    try:
        result["tags"] = json.loads(c.tags) if c.tags else []
        result["extensions"] = json.loads(c.extensions) if c.extensions else {}
    except Exception:
        result["tags"] = []
        result["extensions"] = {}
    return result


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

    try:
        tags = json.loads(char.tags) if char.tags else []
        extensions = json.loads(char.extensions) if char.extensions else {}
    except Exception:
        tags = []
        extensions = {}

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
        "tags": tags,
        "extensions": extensions,
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
        # PNG export: embed character data in PNG tEXt chunk
        try:
            from PIL import Image
            import struct
            import zlib

            # Create a simple 256x256 image with character avatar or default
            if char.avatar and char.avatar.startswith("data:image"):
                img_data = base64.b64decode(char.avatar.split(",", 1)[1])
                img = Image.open(io.BytesIO(img_data)).convert("RGBA")
            else:
                img = Image.new("RGBA", (256, 256), (100, 100, 200, 255))

            buf = io.BytesIO()
            img.save(buf, format="PNG")
            png_bytes = bytearray(buf.getvalue())

            # Inject chara tEXt chunk before IEND
            char_b64 = base64.b64encode(json.dumps(data, ensure_ascii=False).encode()).decode()
            keyword = b"chara"
            chunk_data = keyword + b"\x00" + char_b64.encode("utf-8")
            crc = zlib.crc32(b"tEXt" + chunk_data) & 0xFFFFFFFF
            chunk = struct.pack(">I", len(chunk_data)) + b"tEXt" + chunk_data + struct.pack(">I", crc)

            # Insert before last 12 bytes (IEND chunk)
            final_png = bytes(png_bytes[:-12]) + chunk + bytes(png_bytes[-12:])
            return Response(
                content=final_png,
                media_type="image/png",
                headers={"Content-Disposition": f'attachment; filename="{char.name}.png"'},
            )
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"PNG export failed: {e}")


@router_characters.post("/import")
async def import_character(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """导入角色卡（PNG 或 JSON 格式）"""
    content = await file.read()

    char_data = None
    if file.filename and file.filename.lower().endswith(".png"):
        char_data = extract_chara_card_from_png(content)
    elif file.filename and file.filename.lower().endswith(".json"):
        try:
            char_data = json.loads(content.decode("utf-8"))
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid JSON file")
    else:
        raise HTTPException(status_code=400, detail="Unsupported file format. Use PNG or JSON.")

    if not char_data:
        raise HTTPException(status_code=422, detail="Could not extract character data from file")

    # Normalize V1/V2/V3 format
    if "data" in char_data and isinstance(char_data["data"], dict):
        char_data = char_data["data"]

    char = Character(
        user_id=user.id,
        name=char_data.get("name", "Imported Character"),
        description=char_data.get("description") or char_data.get("char_persona", ""),
        background=char_data.get("background", ""),
        personality=char_data.get("personality", ""),
        scenario=char_data.get("scenario", ""),
        first_mes=char_data.get("first_mes", ""),
        mes_example=char_data.get("mes_example", ""),
        system_prompt=char_data.get("system_prompt", ""),
        creator=char_data.get("creator", ""),
        character_version=char_data.get("character_version", ""),
        tags=json.dumps(char_data.get("tags", []), ensure_ascii=False),
        extensions=json.dumps(char_data.get("extensions", {}), ensure_ascii=False),
        is_processing=False,
    )

    # Handle avatar from the file
    if char_data.get("avatar") and char_data["avatar"].startswith("data:image"):
        # 使用角色卡中提供的base64头像
        char.avatar = char_data["avatar"]
    elif file.filename and file.filename.lower().endswith(".png"):
        # 从PNG文件中提取头像
        try:
            import base64
            # 将PNG数据转换为base64格式
            base64_avatar = base64.b64encode(content).decode('utf-8')
            char.avatar = f"data:image/png;base64,{base64_avatar}"
        except Exception:
            pass

    db.add(char)
    db.commit()
    db.refresh(char)
    return {"status": "ok", "character": _char_to_dict(char)}


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
            normalized_url = _normalize_model_image_url(req.image_url)

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
                    img_data = r.read(10 * 1024 * 1024 + 1)

                if len(img_data) > 10 * 1024 * 1024:
                    raise HTTPException(status_code=413, detail="Image too large (max 10MB)")
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Failed to fetch image: {e}")

        char_data = extract_chara_card_from_png(img_data)
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
            providers = get_runtime_providers()
            provider = next((p for p in providers if p.get("is_active") and p.get("models")), None)
            if provider:
                model_id = provider["models"][0]["id"] if isinstance(provider["models"][0], dict) else provider["models"][0]
            else:
                local_models = list_enabled_chat_models()
                if not local_models:
                    char.is_processing = False
                    db.commit()
                    raise HTTPException(status_code=400, detail="No AI model configured")
                model_id = local_models[0]["id"]

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
            import re
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
            return {"status": "ok", "character": _char_to_dict(char)}
        except Exception as e:
            char.is_processing = False
            char.processing_status = f"Parsing failed: {e}"
            db.commit()
            raise HTTPException(status_code=500, detail=str(e))


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
        providers = get_runtime_providers()
        provider = next((p for p in providers if p.get("is_active") and p.get("models")), None)
        if provider:
            model_id = provider["models"][0]["id"] if isinstance(provider["models"][0], dict) else provider["models"][0]
        else:
            local_models = list_enabled_chat_models()
            if not local_models:
                char.is_processing = False
                db.commit()
                raise HTTPException(status_code=400, detail="No AI model configured")
            model_id = local_models[0]["id"]

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
        # Extract JSON
        import re
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
        return {"status": "ok", "character": _char_to_dict(char)}
    except Exception as e:
        char.is_processing = False
        char.processing_status = f"Translation failed: {e}"
        db.commit()
        raise HTTPException(status_code=500, detail=str(e))


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
    branch_name: str
    parent_message_id: Optional[int] = None
    parent_branch_id: Optional[str] = None


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
            branch_name="Main",
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

    branch = CharacterChatSessionBranch(
        session_id=session_id,
        branch_name=req.branch_name,
        parent_message_id=req.parent_message_id,
        parent_branch_id=req.parent_branch_id,
        is_active=False,
    )
    db.add(branch)
    db.commit()
    db.refresh(branch)
    return {"status": "ok", "branch": {"id": branch.id, "branch_name": branch.branch_name}}


@router_sessions.post("/{session_id}/branches/{branch_id}/switch")
async def switch_branch(
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
    hist = _get_full_branch_history(db, session_id, branch_id, limit=1000)
    messages = [{"id": m.id, "role": m.role, "content": m.content, "model": m.model, "created_at": m.created_at} for m in hist]
    return {"status": "ok", "messages": messages}


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
            branch_name="Main",
            is_active=True,
        )
        db.add(main_branch)
        db.commit()
        db.refresh(main_branch)
        branches = [main_branch]

    result_branches = []
    for branch in branches:
        msgs = (
            db.query(CharacterChatMessage)
            .filter(
                CharacterChatMessage.session_id == session_id,
                CharacterChatMessage.branch_id == branch.id,
            )
            .order_by(CharacterChatMessage.created_at)
            .all()
        )
        pairs = []
        pending_user = None
        for msg in msgs:
            if msg.role == "user":
                pending_user = msg
            elif msg.role == "assistant":
                if pending_user:
                    # Strip <think>...</think> blocks for summary
                    import re as _re
                    ai_display = _re.sub(r"<think>[\s\S]*?</think>", "", msg.content).strip()
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
                    # Init message (character's opening, no preceding user msg)
                    import re as _re
                    ai_display = _re.sub(r"<think>[\s\S]*?</think>", "", msg.content).strip()
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
            "created_at": branch.created_at.isoformat() if branch.created_at else None,
            "nodes": pairs,
        })

    active_branch = next((b for b in branches if b.is_active), None)
    return {
        "branches": result_branches,
        "active_branch_id": active_branch.id if active_branch else None,
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
    db.delete(branch)
    db.commit()
    return {"status": "ok"}


# ───────────────────────────────────────────────
# Character Chat (Streaming)
# ───────────────────────────────────────────────

class CharacterChatRequest(BaseModel):
    character_id: str
    message: str
    session_id: Optional[str] = None
    model: str
    temperature: float = 0.7
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
    enforce_rate_limit(
        request,
        "chat:character",
        settings.CHARACTER_CHAT_RATE_LIMIT_REQUESTS,
        settings.CHARACTER_CHAT_RATE_LIMIT_WINDOW_SECONDS,
    )

    char = db.query(Character).filter(Character.id == req.character_id, Character.user_id == user.id).first()
    if not char:
        raise HTTPException(status_code=404, detail="Character not found")

    try:
        ensure_model_available(req.model)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    user_nickname = req.user_nickname or user.username or "用户"
    is_init = req.message.strip() == "__INIT__"

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
                    branch_name="Main",
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

    # ── Build messages array ────────────────────────────────────────────
    system_prompt = _build_char_system_prompt(char, user_nickname)

    # ── Inject world book context (keyword-trigger) ─────────────────────
    try:
        from ..models.character import CharacterChatMessage as CCM
        recent_for_wb = db.query(CCM).filter(
            CCM.session_id == session_id
        ).order_by(CCM.created_at.desc()).limit(8).all()[::-1]
        recent_msgs_for_wb = [{"role": m.role, "content": m.content} for m in recent_for_wb]
        wb_context = build_worldbook_context(db, session_id, user.id, recent_msgs_for_wb)
        if wb_context:
            system_prompt += "\n\n" + wb_context
    except Exception as e:
        logger.warning(f"World book context injection failed: {e}")

    # ── Inject plot line context (linear stage) ──────────────────────────
    try:
        pl_context = build_plotline_context(db, session_id, user.id)
        if pl_context:
            system_prompt += "\n\n" + pl_context
    except Exception as e:
        logger.warning(f"Plot line context injection failed: {e}")

    if memory_mode != "disabled":
        try:
            mem_svc = MemoryService(db)
            if mem_svc.is_available():
                mem_ctx = mem_svc.get_context(
                    user_id=user.id,
                    query=req.message if not is_init else char.name,
                    session_id=session_id,
                    max_tokens=1500,
                )
                if mem_ctx and mem_ctx.memories:
                    mem_parts = []
                    if mem_ctx.user_profile and mem_ctx.user_profile.summary:
                        mem_parts.append(f"[User Profile]\n{mem_ctx.user_profile.summary}")
                    mem_lines = []
                    for mem in mem_ctx.memories:
                        prefix = "User" if mem.role == "user" else "Assistant"
                        mem_lines.append(f"- {prefix}: {mem.content[:200]}")
                    if mem_lines:
                        mem_parts.append("[Relevant Memories]\n" + "\n".join(mem_lines))
                    if mem_parts:
                        system_prompt += "\n\n" + "\n\n".join(mem_parts)
        except Exception as e:
            logger.warning(f"Memory context retrieval failed: {e}")

    messages = [{"role": "system", "content": system_prompt}]

    if char.mes_example:
        messages.append({"role": "system", "content": f"Example dialogue:\n{char.mes_example}"})

    # Load history using ancestor-chain traversal for correct branch context
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
        if not first_mes:
            return {"session_id": session_id, "message": ""}
        init_short_title = None
        try:
            init_short_title = await generate_compact_title(
                db,
                first_mes,
                fallback_model_id=req.model,
                max_len=10,
            )
        except Exception as e:
            logger.warning(f"Failed to generate init short_title: {e}")
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
            normalized_img_url = _normalize_model_image_url(img_url)
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
    db.commit()

    async def event_generator():
        full_content = ""
        full_reasoning = ""
        total_tokens = 0
        prompt_tokens = 0
        completion_tokens = 0
        try:
            # Send session_id on first chunk if new session
            if is_new_session:
                yield f"data: {json.dumps({'session_id': session_id, 'branch_id': branch_id})}\n\n"

            async for delta in stream_text_completion(
                model_id=req.model,
                messages=messages,
                temperature=req.temperature,
                timeout=30.0,
            ):
                usage = delta.get("usage")
                if usage:
                    total_tokens = int(usage.get("total_tokens", 0) or 0)
                    prompt_tokens = int(usage.get("prompt_tokens", 0) or 0)
                    completion_tokens = int(usage.get("completion_tokens", 0) or 0)
                    continue

                reasoning = delta.get("reasoning")
                content = delta.get("content")
                resp = {}
                if isinstance(reasoning, str) and reasoning:
                    full_reasoning += reasoning
                    resp["reasoning"] = reasoning
                if isinstance(content, str) and content:
                    full_content += content
                    resp["content"] = content
                if resp:
                    yield f"data: {json.dumps(resp, ensure_ascii=False)}\n\n"

            # Send usage info before DONE
            if total_tokens > 0:
                yield f"data: {json.dumps({'type': 'usage', 'total_tokens': total_tokens, 'prompt_tokens': prompt_tokens, 'completion_tokens': completion_tokens})}\n\n"

            yield "data: [DONE]\n\n"

            # Persist assistant message in a fresh DB session
            from ..core.database import SessionLocal
            new_db = SessionLocal()
            try:
                final = f"<think>{full_reasoning}</think>\n{full_content}" if full_reasoning else full_content
                # Use API-reported tokens if available, otherwise estimate
                token_count = completion_tokens if completion_tokens > 0 else len(full_content) // 2
                short_title = await generate_compact_title(
                    new_db,
                    f"{req.message}\n{full_content}",
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
                    prompt_tokens=prompt_tokens,
                ))
                new_db.commit()

                # Store memories if enabled
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
                                content=full_content,
                                branch_id=branch_id,
                            )
                            new_db.commit()
                    except Exception as e:
                        logger.warning(f"Memory storage failed: {e}")
            finally:
                new_db.close()

        except Exception as e:
            logger.exception("Character chat stream error")
            print(f"[character_chat_stream_error] {type(e).__name__}: {e}", flush=True)
            yield f"data: {json.dumps({'content': 'Error: 服务暂时不可用，请稍后重试。', 'error': True}, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream; charset=utf-8",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
