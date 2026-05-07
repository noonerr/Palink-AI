"""
角色导入服务：PNG 解析、数据规范化、导入流程协调
"""
import json
import struct
import base64
import logging
from typing import Optional, Dict, Set, Tuple
from sqlalchemy.orm import Session

from ..character_card import extract_chara_card_from_png
from ..models import Character
from ..schemas.character import character_to_dict
from ..utils import _is_public_http_url

_MAX_RESPONSE_SIZE = 50 * 1024 * 1024
_CHUNK_SIZE = 8192


def _read_with_size_limit(resp, max_size: int = _MAX_RESPONSE_SIZE) -> bytes:
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


logger = logging.getLogger(__name__)

_IMAGE_MAGIC = (
    b"\x89PNG\r\n\x1a\n",
    b"\xff\xd8\xff",
    b"GIF87a",
    b"GIF89a",
    b"RIFF",
    b"BM",
)


def _is_image_data(data: bytes) -> bool:
    if len(data) < 4:
        return False
    for magic in _IMAGE_MAGIC:
        if data.startswith(magic):
            if magic == b"RIFF" and len(data) >= 12:
                return data[8:12] == b"WEBP"
            return True
    return False


class PngCharacterCardParser:
    PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
    CARD_KEYWORDS = frozenset({'chara', 'character', 'tavern', 'chara_card', 'ccv3'})
    AI_IMAGE_KEYWORDS = frozenset({'parameters', 'exif'})

    @classmethod
    def validate_png_format(cls, content: bytes) -> bool:
        return len(content) >= 8 and content[:8] == cls.PNG_MAGIC

    @classmethod
    def analyze_png_chunks(cls, content: bytes) -> Dict:
        if not cls.validate_png_format(content):
            raise ValueError("Invalid PNG format")

        pos = 8
        has_text_chunks = False
        non_card_keywords: Set[str] = set()
        has_card_keyword = False

        while pos < len(content):
            if pos + 8 > len(content):
                break
            length = struct.unpack('>I', content[pos:pos + 4])[0]
            chunk_type = content[pos + 4:pos + 8]
            chunk_data = content[pos + 8:pos + 8 + length]

            if chunk_type in (b'tEXt', b'zTXt', b'iTXt'):
                has_text_chunks = True
                null_pos = chunk_data.find(b'\x00')
                if null_pos != -1:
                    keyword = chunk_data[:null_pos].decode('utf-8', errors='replace').lower()
                    if keyword in cls.CARD_KEYWORDS:
                        has_card_keyword = True
                    elif keyword in cls.AI_IMAGE_KEYWORDS:
                        non_card_keywords.add(keyword)

            pos += 12 + length
            if chunk_type == b'IEND':
                break

        return {
            'has_text_chunks': has_text_chunks,
            'non_card_keywords': non_card_keywords,
            'has_card_keyword': has_card_keyword,
        }

    @classmethod
    def detect_ai_generated_image(cls, chunk_analysis: Dict) -> bool:
        return bool(
            chunk_analysis['has_text_chunks']
            and not chunk_analysis['has_card_keyword']
            and bool(chunk_analysis['non_card_keywords'] & cls.AI_IMAGE_KEYWORDS)
        )

    @classmethod
    def extract_character_data(cls, content: bytes) -> Optional[Dict]:
        return extract_chara_card_from_png(content)

    @classmethod
    def parse_character_card(cls, content: bytes) -> Tuple[Optional[Dict], Optional[str]]:
        if not cls.validate_png_format(content):
            return None, "无效的 PNG 文件格式"

        try:
            chunk_analysis = cls.analyze_png_chunks(content)
        except ValueError:
            return None, "无效的 PNG 文件格式"

        char_data = cls.extract_character_data(content)

        if not char_data and chunk_analysis['has_text_chunks']:
            if cls.detect_ai_generated_image(chunk_analysis):
                error = "该 PNG 图片不包含角色卡数据。检测到这是 AI 生成图片（包含生成参数），而非 SillyTavern/TavernAI 角色卡文件。如需从图片创建角色，请使用「从图片解析角色」功能。"
            else:
                error = "该 PNG 图片不包含角色卡数据。请确保上传的是 SillyTavern 或 TavernAI 格式的角色卡文件。"
            return None, error

        if not char_data and not chunk_analysis['has_text_chunks']:
            return None, "该 PNG 图片是普通截图，不包含任何嵌入的角色卡数据。请上传 SillyTavern/TavernAI 格式的角色卡文件。"

        return char_data, None


class CharacterDataNormalizer:
    @staticmethod
    def normalize(char_data: Dict) -> Dict:
        if "data" in char_data and isinstance(char_data["data"], dict):
            char_data = char_data["data"]

        return {
            "name": char_data.get("name", "Imported Character"),
            "description": char_data.get("description") or char_data.get("char_persona", ""),
            "background": char_data.get("background", ""),
            "personality": char_data.get("personality", ""),
            "scenario": char_data.get("scenario", ""),
            "first_mes": char_data.get("first_mes", ""),
            "mes_example": char_data.get("mes_example", ""),
            "system_prompt": char_data.get("system_prompt", ""),
            "creator": char_data.get("creator", ""),
            "character_version": char_data.get("character_version", ""),
            "tags": char_data.get("tags", []),
            "extensions": char_data.get("extensions", {}),
            "avatar": char_data.get("avatar"),
        }


class CharacterImportService:
    def __init__(self, db: Session):
        self.db = db

    async def import_from_file(self, filename: str, content: bytes, user_id: int) -> Dict:
        if filename.lower().endswith(".png"):
            char_data = self._import_from_png(content)
        elif filename.lower().endswith(".json"):
            char_data = self._import_from_json(content)
        else:
            raise ValueError("不支持的文件格式，请使用 PNG 或 JSON 文件")

        normalized = CharacterDataNormalizer.normalize(char_data)
        character = self._create_character(normalized, user_id, filename, content)

        self.db.add(character)
        self.db.commit()
        self.db.refresh(character)

        logger.info("Character imported successfully: %s", character.id)
        return character_to_dict(character)

    def _import_from_png(self, content: bytes) -> Dict:
        char_data, error = PngCharacterCardParser.parse_character_card(content)
        if error:
            raise ValueError(error)
        if not char_data:
            raise ValueError("无法从 PNG 文件中提取角色数据")
        return char_data

    def _import_from_json(self, content: bytes) -> Dict:
        try:
            return json.loads(content.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            raise ValueError(f"无效的 JSON 文件: {e}")

    def _create_character(self, data: Dict, user_id: int, filename: str, content: bytes) -> Character:
        avatar = self._extract_avatar(data, filename, content)

        return Character(
            user_id=user_id,
            name=data["name"],
            description=data["description"],
            background=data["background"],
            personality=data["personality"],
            scenario=data["scenario"],
            first_mes=data["first_mes"],
            mes_example=data["mes_example"],
            system_prompt=data["system_prompt"],
            creator=data["creator"],
            character_version=data["character_version"],
            tags=json.dumps(data["tags"], ensure_ascii=False),
            extensions=json.dumps(data["extensions"], ensure_ascii=False),
            avatar=avatar,
            is_processing=False,
        )

    def _extract_avatar(self, data: Dict, filename: str, content: bytes) -> Optional[str]:
        if data.get("avatar") and data["avatar"].startswith("data:image"):
            return data["avatar"]

        if filename.lower().endswith(".png"):
            try:
                base64_avatar = base64.b64encode(content).decode('utf-8')
                return f"data:image/png;base64,{base64_avatar}"
            except Exception as e:
                logger.warning("Failed to extract avatar from PNG: %s", e)

        avatar_url = data.get("avatar")
        if avatar_url and (avatar_url.startswith("http://") or avatar_url.startswith("https://")):
            try:
                if not _is_public_http_url(avatar_url):
                    logger.warning("Avatar URL blocked by SSRF protection: %s", avatar_url)
                    return None
                import urllib.request
                import re as _re
                req = urllib.request.Request(avatar_url, headers={"User-Agent": "Palink-AI/1.0"})
                with urllib.request.urlopen(req, timeout=15) as resp:
                    img_data = _read_with_size_limit(resp)
                    content_type = resp.headers.get("Content-Type", "")
                    if content_type.startswith("text/html"):
                        match = _re.search(rb'<meta[^>]+property="og:image"[^>]+content="([^"]+)"', img_data)
                        if not match:
                            match = _re.search(rb"<meta[^>]+property='og:image'[^>]+content='([^']+)'", img_data)
                        if match:
                            og_url = match.group(1).decode("utf-8", errors="replace")
                            logger.info("Found og:image in page: %s", og_url)
                            if not _is_public_http_url(og_url):
                                logger.warning("og:image URL blocked by SSRF protection: %s", og_url)
                                return None
                            req2 = urllib.request.Request(og_url, headers={"User-Agent": "Palink-AI/1.0"})
                            with urllib.request.urlopen(req2, timeout=15) as resp2:
                                img_data = _read_with_size_limit(resp2)
                                content_type = resp2.headers.get("Content-Type", "image/png")
                        else:
                            logger.warning("Avatar URL returned HTML page, not an image: %s", avatar_url)
                            return None
                    if not content_type.startswith("image/"):
                        if not _is_image_data(img_data):
                            logger.warning("Avatar URL returned non-image content: %s", avatar_url)
                            return None
                        content_type = "image/png"
                    base64_avatar = base64.b64encode(img_data).decode('utf-8')
                    return f"data:{content_type};base64,{base64_avatar}"
            except ValueError as e:
                logger.warning("Avatar download size limit exceeded for %s: %s", avatar_url, e)
                return None
            except Exception as e:
                logger.warning("Failed to download avatar from URL %s: %s", avatar_url, e)

        return None
