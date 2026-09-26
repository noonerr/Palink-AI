"""
角色导入服务：PNG 解析、数据规范化、导入流程协调
"""
import json
import re
import struct
import base64
import uuid
import logging
import urllib.request
import zipfile
import io
from datetime import datetime, timezone
from typing import Optional, Dict, Set, Tuple
from sqlalchemy.orm import Session

from ..character_card import extract_chara_card_from_png
from ..core.cache import invalidate_cache
from ..models import Character
from ..models.worldbook import WorldBook, WorldBookStage
from ..schemas.character import character_to_dict
from ..utils import _is_public_http_url
from .worldbook_import_utils import (
    entry_is_disabled,
    entry_keys,
    entry_secondary_keys,
    normalize_worldbook_position,
)

try:
    import yaml as _yaml
except ImportError:  # pragma: no cover - YAML 导入为可选能力
    _yaml = None

_MAX_RESPONSE_SIZE = 50 * 1024 * 1024
_MAX_CHARACTER_CARD_UPLOAD_SIZE = 50 * 1024 * 1024
_CHUNK_SIZE = 8192


class _PublicUrlRedirectHandler(urllib.request.HTTPRedirectHandler):
    """[PENTEST-2026-09-02 P1-3] 重定向逐跳 SSRF 复检（清偿 TODOS 已登记遗留项）。

    裸 urlopen 默认跟随 301/302/307 且不复查目标：公网头像 URL 可被 302 跳板
    引向内网/云元数据。每跳用与首跳相同的 _is_public_http_url 口径复检
    （scheme 白名单 + 内网/环回/链路本地/CGNAT IP 拦截），非公网目标即中止。
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not _is_public_http_url(newurl):
            logger.warning("Avatar fetch redirect blocked by SSRF protection: %s", newurl)
            raise ValueError(f"Redirect to non-public URL blocked: {newurl}")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _open_public_url(req, timeout: int = 15):
    """带逐跳重定向校验的受限打开（替代裸 urlopen，防跳板 SSRF）。"""
    opener = urllib.request.build_opener(_PublicUrlRedirectHandler())
    return opener.open(req, timeout=timeout)


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

SILLYTAVERN_EXTENSION_FIELDS = (
    "group",
    "member",
    "members",
    "creator",
    "source",
    "system_prompt",
    "post_history_instructions",
    "creator_notes",
    "creator_comment",
    "character_book",
    "alternate_greetings",
    "tags",
    "talkativeness",
    "fav",
    "world",
    "depth_prompt",
    "role_book",
    "personality",
    "scenario",
    "mes_example",
)

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
    CARD_KEYWORDS = frozenset({'chara', 'character', 'tavern', 'chara_card', 'ccv3', 'chara_card_v3'})
    AI_IMAGE_KEYWORDS = frozenset({
        'parameters', 'exif', 'title', 'description', 'software',
        'source', 'generation time', 'comment', 'workflow',
        'prompt', 'negative prompt', 'steps', 'sampler', 'cfg scale',
        'seed', 'size', 'model hash', 'model', 'clip skip',
    })

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
        truncated_chunk: Optional[Dict] = None
        saw_iend = False

        while pos < len(content):
            if pos + 8 > len(content):
                truncated_chunk = {
                    'type': 'unknown',
                    'keyword': '',
                    'declared_length': 0,
                    'available_length': max(0, len(content) - pos),
                }
                break
            length = struct.unpack('>I', content[pos:pos + 4])[0]
            chunk_type = content[pos + 4:pos + 8]
            data_start = pos + 8
            chunk_end = data_start + length
            chunk_data = content[data_start:min(chunk_end, len(content))]
            keyword = ''

            if chunk_type in (b'tEXt', b'zTXt', b'iTXt'):
                has_text_chunks = True
                null_pos = chunk_data.find(b'\x00')
                if null_pos != -1:
                    keyword = chunk_data[:null_pos].decode('utf-8', errors='replace').lower()
                    if keyword in cls.CARD_KEYWORDS:
                        has_card_keyword = True
                    elif keyword in cls.AI_IMAGE_KEYWORDS:
                        non_card_keywords.add(keyword)

            if chunk_type == b'eXIf':
                has_text_chunks = True
                non_card_keywords.add('exif')

            if chunk_end + 4 > len(content):
                truncated_chunk = {
                    'type': chunk_type.decode('ascii', errors='replace'),
                    'keyword': keyword,
                    'declared_length': length,
                    'available_length': max(0, len(content) - data_start),
                }
                break

            pos += 12 + length
            if chunk_type == b'IEND':
                saw_iend = True
                break

        return {
            'has_text_chunks': has_text_chunks,
            'non_card_keywords': non_card_keywords,
            'has_card_keyword': has_card_keyword,
            'truncated_chunk': truncated_chunk,
            'has_truncated_card_chunk': bool(
                truncated_chunk
                and truncated_chunk.get('keyword') in cls.CARD_KEYWORDS
            ),
            'missing_iend': not saw_iend,
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

        logger.debug(
            "PNG chunk analysis: has_text=%s, has_card=%s, non_card=%s",
            chunk_analysis['has_text_chunks'],
            chunk_analysis['has_card_keyword'],
            chunk_analysis['non_card_keywords'],
        )

        char_data = cls.extract_character_data(content)

        if not char_data and chunk_analysis.get('has_truncated_card_chunk'):
            chunk = chunk_analysis.get('truncated_chunk') or {}
            declared = int(chunk.get('declared_length') or 0)
            available = int(chunk.get('available_length') or 0)
            error = (
                "该 PNG 检测到角色卡数据字段，但文件内容不完整，角色卡数据已经被截断或损坏。"
                f"角色卡数据块声明长度为 {declared} 字节，实际只剩 {available} 字节。"
                "请重新下载原始角色卡文件，或在聊天软件中以“文件”方式发送，避免图片压缩、截图或重新保存。"
            )
            logger.warning("Character card extraction failed: %s", error)
            return None, error

        if not char_data and chunk_analysis['has_text_chunks']:
            if cls.detect_ai_generated_image(chunk_analysis):
                error = "该 PNG 图片不包含角色卡数据。检测到这是 AI 生成图片（包含生成参数），而非 SillyTavern/TavernAI 角色卡文件。如需从图片创建角色，请使用「从图片解析角色」功能。"
            else:
                error = "该 PNG 图片不包含角色卡数据。请确保上传的是 SillyTavern 或 TavernAI 格式的角色卡文件。"
            logger.warning("Character card extraction failed: %s", error)
            return None, error

        if not char_data and not chunk_analysis['has_text_chunks']:
            return None, "该 PNG 图片是普通截图，不包含任何嵌入的角色卡数据。请上传 SillyTavern/TavernAI 格式的角色卡文件。"

        return char_data, None


def _extract_ui_config_from_extensions(extensions: dict) -> Optional[dict]:
    if not isinstance(extensions, dict):
        return None
    ui_config = {}
    if isinstance(extensions.get("palink_ui"), dict):
        st = extensions["palink_ui"]
        if st.get("theme"): ui_config["theme"] = st["theme"]
        if st.get("background"): ui_config["background"] = st["background"]
        if st.get("message_bubbles"): ui_config["message_bubbles"] = st["message_bubbles"]
        if st.get("effects"): ui_config["effects"] = st["effects"]
        if st.get("custom_css"): ui_config["custom_css"] = st["custom_css"]
    if isinstance(extensions.get("tavern_ui"), dict):
        tu = extensions["tavern_ui"]
        if tu.get("theme") and "theme" not in ui_config: ui_config["theme"] = tu["theme"]
        if tu.get("background") and "background" not in ui_config: ui_config["background"] = tu["background"]
        if tu.get("custom_css") and "custom_css" not in ui_config: ui_config["custom_css"] = tu["custom_css"]
    if isinstance(extensions.get("chroma"), dict):
        chroma = extensions["chroma"]
        if "theme" not in ui_config:
            theme = {}
            if chroma.get("primary_color"): theme["primary_color"] = chroma["primary_color"]
            if chroma.get("secondary_color"): theme["secondary_color"] = chroma["secondary_color"]
            if chroma.get("accent_color"): theme["accent_color"] = chroma["accent_color"]
            if theme: ui_config["theme"] = theme
    if extensions.get("custom_css") and "custom_css" not in ui_config:
        ui_config["custom_css"] = extensions["custom_css"]
    return ui_config if ui_config else None


def _preserve_sillytavern_fields(extensions: dict, char_data: Dict, raw_card_data: Dict) -> dict:
    if not isinstance(extensions, dict):
        extensions = {}

    if "palink_raw_card_data" not in extensions:
        extensions["palink_raw_card_data"] = raw_card_data

    preserved_fields = {
        field: char_data[field]
        for field in SILLYTAVERN_EXTENSION_FIELDS
        if field in char_data and char_data[field] is not None
    }
    if not preserved_fields:
        return extensions

    # [DEPTH-PROMPT-FIX 2026-09-27] V2 卡的 depth_prompt 常被导出器写在 data 顶层
    # （spec 允许的位置之一）。此前它只被收进 palink_sillytavern.card_fields 深水区，
    # 而唯一消费它的装配层 roleplay_prompt_assembly._insert_depth_prompt 只读
    # extensions **顶层**的 depth_prompt → 表现为"导入后深度提示词丢失"。
    # 这里把它抬到 extensions 顶层。
    # 取值优先级：data.extensions.depth_prompt（ST 标准位置）> data.depth_prompt。
    # 只抬 dict 形态（装配层按 dict 读取），非 dict 的脏数据不污染 extensions。
    lifted_depth_prompt = preserved_fields.get("depth_prompt")
    if isinstance(lifted_depth_prompt, dict) and not isinstance(extensions.get("depth_prompt"), dict):
        extensions["depth_prompt"] = lifted_depth_prompt

    palink_st = extensions.get("palink_sillytavern")
    if not isinstance(palink_st, dict):
        palink_st = {}
    card_fields = palink_st.get("card_fields")
    if not isinstance(card_fields, dict):
        card_fields = {}
    for field, value in preserved_fields.items():
        card_fields.setdefault(field, value)
    palink_st["card_fields"] = card_fields
    extensions["palink_sillytavern"] = palink_st
    return extensions


def _normalize_string_list(value) -> list:
    """B-3 修复: 字符串→数组归一（对齐 ST characters.js:572-593）。

    ST 对 tags / alternate_greetings 做类型归一：字符串按逗号 split，
    list 则过滤非字符串项。避免字符串被 json.dumps 存成字符串破坏结构。
    """
    if value is None:
        return []
    if isinstance(value, str):
        return [v.strip() for v in value.split(",") if v.strip()]
    if isinstance(value, list):
        return [v for v in value if isinstance(v, str) and v.strip()]
    return []


def _sanitize_import_name(value) -> str:
    """B-8 修复: 导入 name 清洗（对齐 ST sanitize 语义：XSS/空字节/路径穿越清洗）。

    去除控制字符/空字节，压缩空白，截断到 64 字符（ST isValidName 合法名上限）。
    """
    name = str(value or "").strip()
    # 去除空字节、控制字符与不可打印字符
    name = "".join(ch for ch in name if ch == "\t" or (ord(ch) >= 32 and ch.isprintable()))
    name = " ".join(name.split())
    return name[:64] or "Imported Character"


def _worldbook_to_charbook_basic(wb: WorldBook) -> Dict:
    """R-2 修复: 将已有 WorldBook 转为 character_book dict（供导入复制）。

    ST 语义: extensions.world 字符串为世界书名引用，命中已有世界书时按名复制
    为角色专属世界书。此转换提取 _create_worldbook_from_character_book 所需的
    基本结构（name/description/entries），并保留 keys/position/constant 等
    ST V2 charbook 字段。
    """
    entries: Dict = {}
    if wb.entries:
        _sorted_stages = sorted(
            wb.entries,
            key=lambda s: (s.order if s.order is not None else 0, str(s.id or "")),
        )
        for i, stage in enumerate(_sorted_stages):
            try:
                keys = json.loads(stage.keys) if stage.keys else []
            except (json.JSONDecodeError, TypeError):
                keys = []
            try:
                keysecondary = json.loads(stage.secondary_keys) if stage.secondary_keys else []
            except (json.JSONDecodeError, TypeError):
                keysecondary = []
            entries[str(stage.id or i)] = {
                "key": keys if isinstance(keys, list) else [],
                "keysecondary": keysecondary if isinstance(keysecondary, list) else [],
                "comment": stage.title or f"Entry {i}",
                "content": stage.content or "",
                "constant": bool(stage.constant),
                "selective": bool(stage.selective),
                "order": stage.order if stage.order is not None else 0,
                "position": stage.position if stage.position is not None else 4,
                "disable": not bool(stage.enabled),
                "probability": stage.probability if stage.probability is not None else 100,
                "group": stage.group,
            }
    return {
        "name": wb.name or "World Info",
        "description": wb.description or "",
        "entries": entries,
    }


class CharacterDataNormalizer:
    @staticmethod
    def normalize(char_data: Dict) -> Dict:
        raw_card_data = char_data
        if "data" in char_data and isinstance(char_data["data"], dict):
            char_data = char_data["data"]

        character_book = char_data.get("character_book")
        world_ref: Optional[str] = None
        if not character_book:
            extensions = char_data.get("extensions", {})
            if isinstance(extensions, dict):
                character_book = extensions.get("character_book") or extensions.get("lorebook")
                # B-6 修复: extensions.world 引用转世界书（ST 语义：world 为完整 V2 charbook）
                if not character_book and isinstance(extensions.get("world"), dict):
                    _world_ref = extensions["world"]
                    if _world_ref.get("entries"):
                        character_book = {
                            "name": _world_ref.get("name", "World Info"),
                            "description": _world_ref.get("description", ""),
                            "entries": _world_ref.get("entries", []),
                        }
                # R-2 修复: extensions.world 字符串引用（ST 主流格式，world 为世界书名）。
                # normalize 为纯函数，此处仅记录引用，由导入服务按名解析已有世界书。
                elif not character_book and isinstance(extensions.get("world"), str):
                    _world_name = str(extensions["world"]).strip()
                    if _world_name:
                        world_ref = _world_name
        has_character_book = (
            isinstance(character_book, dict)
            and bool(character_book.get("entries"))
        )

        extensions = char_data.get("extensions", {})
        if not isinstance(extensions, dict):
            extensions = {}
        else:
            extensions = dict(extensions)

        extensions = _preserve_sillytavern_fields(extensions, char_data, raw_card_data)

        if isinstance(extensions.get("regex_scripts"), list) and extensions["regex_scripts"]:
            palink_st = extensions.get("palink_sillytavern")
            if not isinstance(palink_st, dict):
                palink_st = {}
            palink_st.update({
                "scoped_regex": True,
                "scoped_regex_allowed": True,
                "regex_script_count": len(extensions["regex_scripts"]),
            })
            extensions["palink_sillytavern"] = palink_st

        ui_config = _extract_ui_config_from_extensions(extensions)

        raw_card_spec_version = None
        if isinstance(raw_card_data, dict):
            raw_card_spec_version = raw_card_data.get("spec_version") or None

        # ST V3 assets 字段（多模态资源，如 icon/cover 等）
        assets = char_data.get("assets")
        if assets is not None and not isinstance(assets, list):
            assets = None

        # ST 1.18.0 V3 chara card 字段（B-1 修复：与 convert_chara_card_to_character 对齐）
        talkativeness = char_data.get("talkativeness")
        if talkativeness is not None and not isinstance(talkativeness, (str, int, float)):
            talkativeness = None
        if talkativeness is not None:
            talkativeness = str(talkativeness)

        nickname = char_data.get("nickname")
        if nickname is not None and not isinstance(nickname, str):
            nickname = str(nickname) if nickname else None

        group_only_greetings = char_data.get("group_only_greetings")
        if group_only_greetings is not None and not isinstance(group_only_greetings, list):
            group_only_greetings = None

        # jailbreak: 优先 data.extensions.jailbreak，回退 data.jailbreak，再回退 PHI（V2 兼容）
        jailbreak_value = None
        if isinstance(extensions, dict):
            jailbreak_value = extensions.get("jailbreak")
        if not jailbreak_value:
            jailbreak_value = char_data.get("jailbreak")
        if not jailbreak_value:
            phi = char_data.get("post_history_instructions", "")
            if phi and phi.strip():
                jailbreak_value = phi

        return {
            "name": _sanitize_import_name(char_data.get("name")),
            "description": char_data.get("description") or char_data.get("char_persona", ""),
            "background": char_data.get("background", ""),
            "personality": char_data.get("personality", "") or char_data.get("char_persona", ""),
            # B-4 修复: V1/gradio 字段映射（creatorcomment/char_greeting/world_scenario/example_dialogue）
            "scenario": char_data.get("scenario") or char_data.get("world_scenario", ""),
            "first_mes": char_data.get("first_mes") or char_data.get("char_greeting", ""),
            "mes_example": char_data.get("mes_example") or char_data.get("example_dialogue", ""),
            "system_prompt": char_data.get("system_prompt", ""),
            "creator": char_data.get("creator", ""),
            "character_version": char_data.get("character_version", ""),
            # B-3 修复: tags/alternate_greetings 字符串→数组归一（ST 类型归一）
            "tags": _normalize_string_list(char_data.get("tags")),
            "extensions": extensions,
            "avatar": char_data.get("avatar"),
            "creator_notes": char_data.get("creator_notes") or char_data.get("creatorcomment", ""),
            "alternate_greetings": _normalize_string_list(char_data.get("alternate_greetings")),
            "post_history_instructions": char_data.get("post_history_instructions", ""),
            "talkativeness": talkativeness,
            "nickname": nickname,
            "group_only_greetings": group_only_greetings,
            "jailbreak": jailbreak_value,
            "character_book": character_book if has_character_book else None,
            "has_character_book": has_character_book,
            # R-2: extensions.world 字符串引用（世界书名），由导入服务按名解析
            "world_ref": world_ref,
            "ui_config": ui_config,
            "raw_card_spec_version": raw_card_spec_version,
            "assets": assets,
        }


class CharacterImportService:
    def __init__(self, db: Session):
        self.db = db

    async def import_from_file(self, filename: str, content: bytes, user_id: int) -> Dict:
        if len(content) > _MAX_CHARACTER_CARD_UPLOAD_SIZE:
            raise ValueError(
                f"角色卡文件过大，最大支持 {_MAX_CHARACTER_CARD_UPLOAD_SIZE // (1024 * 1024)}MB"
            )

        if filename.lower().endswith(".png"):
            char_data = self._import_from_png(content)
        elif filename.lower().endswith(".json"):
            char_data = self._import_from_json(content)
        elif filename.lower().endswith(".charx"):
            char_data = self._import_from_charx(content)
        elif filename.lower().endswith(".byaf"):
            char_data = self._import_from_byaf(content)
        elif filename.lower().endswith((".yaml", ".yml")):
            char_data = self._import_from_yaml(content)
        else:
            raise ValueError("不支持的文件格式，请使用 PNG / JSON / CharX / BYAF / YAML 文件")

        normalized = CharacterDataNormalizer.normalize(char_data)
        # R-2 修复: extensions.world 字符串引用（ST 主流格式）→ 按名解析已有世界书，
        # 复制为角色专属世界书（复用 character_book 建库路径）。
        if not normalized.get("character_book") and normalized.get("world_ref"):
            _ref_name = str(normalized["world_ref"]).strip()
            if _ref_name:
                _ref_wb = (
                    self.db.query(WorldBook)
                    .filter(WorldBook.name == _ref_name, WorldBook.user_id == user_id)
                    .first()
                )
                if _ref_wb is not None:
                    normalized["character_book"] = _worldbook_to_charbook_basic(_ref_wb)
                    normalized["has_character_book"] = True
        character = self._create_character(normalized, user_id, filename, content)

        self.db.add(character)
        self.db.commit()
        self.db.refresh(character)

        logger.info("Character imported successfully: %s", character.id)

        has_cb = normalized.get("has_character_book", False)
        result = character_to_dict(character, has_character_book=has_cb)

        if normalized.get("character_book"):
            worldbook = self._create_worldbook_from_character_book(
                normalized["character_book"], character.name, user_id, character.id
            )
            if worldbook:
                result["worldbook_id"] = worldbook.id
                result["worldbook_entry_count"] = len(worldbook.entries) if worldbook.entries else 0
                logger.info(
                    "WorldBook created from character_book: %s (%d entries)",
                    worldbook.id,
                    result["worldbook_entry_count"],
                )

        return result

    def _import_from_png(self, content: bytes) -> Dict:
        char_data, error = PngCharacterCardParser.parse_character_card(content)
        if error:
            raise ValueError(error)
        if not char_data:
            raise ValueError("无法从 PNG 文件中提取角色数据")
        return char_data

    def _import_from_json(self, content: bytes) -> Dict:
        try:
            data = json.loads(content.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            raise ValueError(f"无效的 JSON 文件: {e}")

        # 检测是否为SillyTavern预设文件（而非角色卡）
        if "prompts" in data and isinstance(data.get("prompts"), list) and "name" not in data:
            raise ValueError(
                "该文件是SillyTavern预设文件，不是角色卡。"
                "请使用角色对话中的「ST预设」功能导入预设文件。"
            )

        return data

    def _import_from_charx(self, content: bytes) -> Dict:
        """B-5 修复: CharX 格式导入（zip 内包含角色卡 JSON）。

        CharX 为 ST 1.18.0 支持的打包格式：zip 内含 card.json（V3/CCv3）
        或 character.json（旧版）。优先取 card.json。
        """
        try:
            with zipfile.ZipFile(io.BytesIO(content)) as zf:
                candidates = [n for n in zf.namelist() if n.endswith(".json")]
                if not candidates:
                    raise ValueError("CharX 包内未找到 JSON 角色卡")
                # 优先 card.json，其次 character.json，最后按字典序取一个
                pick = None
                for pref in ("card.json", "character.json"):
                    for n in candidates:
                        if n.lower().endswith(pref):
                            pick = n
                            break
                    if pick:
                        break
                if pick is None:
                    pick = sorted(candidates)[0]
                raw = zf.read(pick)
        except zipfile.BadZipFile as e:
            raise ValueError(f"无效的 CharX 文件: {e}")
        except Exception as e:
            raise ValueError(f"CharX 解析失败: {e}")
        try:
            return json.loads(raw.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            raise ValueError(f"CharX 内角色卡 JSON 无效: {e}")

    def _import_from_byaf(self, content: bytes) -> Dict:
        """B-5/G2 修复: BYAF（Banner of Yggdrasil）格式导入。

        真实 .byaf 是 ZIP 包（manifest.json + characters + scenarios，ST
        byaf.js:310-322/438-446），此前按纯 JSON 解析 → 真实文件 100% 失败。
        ZIP 路径解析并映射为 V2 卡 data（对齐 ST ByafParser.getCharacterCard）；
        纯 JSON 结构保留兼容（历史 B-5 行为，"fields" 子结构或顶层字段）。
        """
        if content[:4] == b"PK\x03\x04":
            return self._import_from_byaf_zip(content)
        try:
            data = json.loads(content.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            raise ValueError(f"无效的 BYAF 文件: {e}")
        if isinstance(data, dict):
            if isinstance(data.get("fields"), dict):
                return data["fields"]
            if data.get("data") and isinstance(data["data"], dict):
                return data["data"]
            return data
        raise ValueError("无效的 BYAF 角色卡结构")

    @staticmethod
    def _byaf_replace_macros(text) -> str:
        """BYAF 宏归一（对齐 ST byaf.js replaceMacros）: {character}→{{char}}、{user}→{{user}}。"""
        if not isinstance(text, str):
            return ""
        text = re.sub(r"\{character\}(?!})", "{{char}}", text, flags=re.IGNORECASE)
        text = re.sub(r"\{user\}(?!})", "{{user}}", text, flags=re.IGNORECASE)
        return text

    @classmethod
    def _byaf_format_example_messages(cls, examples) -> str:
        """对齐 ST byaf.js formatExampleMessages: 每条 <START> 分块。"""
        if not isinstance(examples, list):
            return ""
        parts = []
        for example in examples:
            text = example.get("text") if isinstance(example, dict) else None
            if not text:
                continue
            parts.append(f"<START>\n{cls._byaf_replace_macros(text)}")
        return "\n".join(parts)

    @classmethod
    def _byaf_alternate_greetings(cls, scenarios) -> list:
        """对齐 ST byaf.js formatAlternateGreetings: scenarios[1:] 的 firstMessages[0] 去重。"""
        if not isinstance(scenarios, list) or len(scenarios) <= 1:
            return []
        first = None
        if isinstance(scenarios[0], dict):
            fm0 = scenarios[0].get("firstMessages")
            if isinstance(fm0, list) and fm0 and isinstance(fm0[0], dict):
                first = fm0[0].get("text")
        greetings, seen = [], set()
        for scenario in scenarios[1:]:
            if not isinstance(scenario, dict):
                continue
            fm = scenario.get("firstMessages")
            if not isinstance(fm, list) or not fm or not isinstance(fm[0], dict):
                continue
            text = fm[0].get("text")
            if text and text != first:
                replaced = cls._byaf_replace_macros(text)
                if replaced not in seen:
                    seen.add(replaced)
                    greetings.append(replaced)
        return greetings

    @classmethod
    def _byaf_character_book(cls, items) -> Optional[Dict]:
        """对齐 ST byaf.js convertCharacterBook: loreItems → character_book（V3 数组）。"""
        if not isinstance(items, list) or not items:
            return None
        entries = []
        for index, item in enumerate(items):
            if not isinstance(item, dict):
                continue
            keys = [
                k.strip()
                for k in cls._byaf_replace_macros(item.get("key") or "").split(",")
                if k.strip()
            ]
            entries.append({
                "keys": keys,
                "content": cls._byaf_replace_macros(item.get("value")),
                "extensions": {},
                "enabled": True,
                "insertion_order": index,
            })
        if not entries:
            return None
        return {"entries": entries, "extensions": {}}

    def _import_from_byaf_zip(self, content: bytes) -> Dict:
        """G2 修复（批次 F）: ZIP 形态 BYAF → V2 卡 data（对齐 ST getCharacterCard
        byaf.js:249-277 的逐字段映射，含宏替换/示例消息/问候/loreItems 书）。"""
        try:
            with zipfile.ZipFile(io.BytesIO(content)) as zf:
                names = set(zf.namelist())
                if "manifest.json" not in names:
                    raise ValueError("无效的 BYAF 压缩包: 缺少 manifest.json")

                def _read_json(name):
                    return json.loads(zf.read(name).decode("utf-8"))

                manifest = _read_json("manifest.json")
                if not isinstance(manifest, dict):
                    raise ValueError("无效的 BYAF manifest")
                characters = manifest.get("characters") or []
                if not isinstance(characters, list) or not characters:
                    raise ValueError("无效的 BYAF manifest: 缺少 characters")
                character = _read_json(characters[0])
                if not isinstance(character, dict):
                    character = {}
                scenarios = []
                for sp in (manifest.get("scenarios") or [])[:20]:
                    try:
                        scenario = _read_json(sp)
                        if isinstance(scenario, dict):
                            scenarios.append(scenario)
                    except (KeyError, json.JSONDecodeError, UnicodeDecodeError):
                        continue

                author = manifest.get("author") if isinstance(manifest.get("author"), dict) else {}
                scenario0 = scenarios[0] if scenarios else {}
                fm0 = scenario0.get("firstMessages") if isinstance(scenario0.get("firstMessages"), list) else []
                first_text = fm0[0].get("text") if fm0 and isinstance(fm0[0], dict) else None
                display_name = character.get("displayName")
                data: Dict = {
                    "name": character.get("name") or display_name or "",
                    "description": self._byaf_replace_macros(character.get("persona")),
                    "personality": "",
                    "scenario": self._byaf_replace_macros(scenario0.get("narrative")),
                    "first_mes": self._byaf_replace_macros(first_text),
                    "mes_example": self._byaf_format_example_messages(scenario0.get("exampleMessages")),
                    "creator_notes": author.get("backyardURL") or "",
                    "system_prompt": self._byaf_replace_macros(scenario0.get("formattingInstructions")),
                    "post_history_instructions": "",
                    "alternate_greetings": self._byaf_alternate_greetings(scenarios),
                    "character_book": self._byaf_character_book(character.get("loreItems")),
                    "tags": ["nsfw"] if character.get("isNSFW") else [],
                    "creator": author.get("name") or "",
                    "character_version": "",
                }
                if display_name:
                    data["extensions"] = {"display_name": display_name}
                return data
        except zipfile.BadZipFile as e:
            raise ValueError(f"无效的 BYAF 压缩包: {e}")

    def _import_from_yaml(self, content: bytes) -> Dict:
        """B-5 修复: YAML 格式导入（需 pyyaml，缺失时给出明确提示）。

        G5 修复（批次 F）: TavernAI YAML 方言 context→description、greeting→
        first_mes（ST characters.js:740-741 importFromYaml 同款映射）——此前
        TavernAI YAML 卡 description/first_mes 全空。
        """
        if _yaml is None:
            raise ValueError(
                "YAML 导入需要 PyYAML 支持，请在 backend 环境安装 PyYAML 后重试"
            )
        try:
            data = _yaml.safe_load(content.decode("utf-8"))
        except Exception as e:
            raise ValueError(f"无效的 YAML 文件: {e}")
        if isinstance(data, dict):
            # G5: TavernAI YAML 方言映射（ST importFromYaml: context→description,
            # greeting→first_mes；仅目标字段缺失时回填，不覆盖显式值）
            if data.get("context") and not data.get("description"):
                data["description"] = data["context"]
            if data.get("greeting") and not data.get("first_mes"):
                data["first_mes"] = data["greeting"]
            if data.get("data") and isinstance(data["data"], dict):
                return data["data"]
            return data
        raise ValueError("无效的 YAML 角色卡结构")

    def _create_worldbook_from_character_book(
        self, character_book: Dict, character_name: str, user_id: int, character_id: str
    ) -> Optional[WorldBook]:
        entries = character_book.get("entries", {})
        if not entries:
            return None

        if isinstance(entries, list):
            entries = {str(i): e for i, e in enumerate(entries)}

        now = datetime.now(timezone.utc)
        wb_name = character_book.get("name") or f"{character_name} 的世界书"
        wb_description = character_book.get("description", "")

        raw_parts = []
        for _key, entry in sorted(
            entries.items(),
            key=lambda x: x[1].get("insertion_order", x[1].get("order", 0)),
        ):
            if entry_is_disabled(entry):
                continue
            comment = entry.get("comment", "")
            entry_content = entry.get("content", "")
            if entry_content:
                raw_parts.append(f"## {comment}\n{entry_content}" if comment else entry_content)

        wb = WorldBook(
            id=str(uuid.uuid4()),
            user_id=user_id,
            character_id=character_id,
            name=wb_name[:200],
            description=wb_description[:5000] if wb_description else None,
            source_type="upload",
            raw_content="\n\n---\n\n".join(raw_parts) if raw_parts else None,
            format="silly_tavern_v2",
            tags=json.dumps(character_book.get("tags", [])),
            is_parsed=False,
            type="character_book",
            created_at=now,
            updated_at=now,
        )
        self.db.add(wb)

        MAX_IMPORT_ENTRIES = 500
        stage_index = 0
        # V2 charbook 规范排序字段是 insertion_order（ST world-info.js order: entry.insertion_order），
        # 旧卡/导出器可能写 order——双读兼容，否则规范卡所有条目排序静默归 0
        for _key, entry in sorted(
            entries.items(),
            key=lambda x: x[1].get("insertion_order", x[1].get("order", 0)),
        ):
            if stage_index >= MAX_IMPORT_ENTRIES:
                break
            # G6 修复（批次 F）: 禁用条目保留落库（enabled=False），对齐 ST
            # convertCharacterBook 的 disable: !entry.enabled（world-info.js:5513）
            # 语义——此前导入即丢条目，ST↔Palink 往返丢失。空内容条目维持跳过
            # （注入空串无意义，ST 侧等价无效果）。
            entry_content = entry.get("content", "").strip()
            if not entry_content:
                continue
            if len(entry_content) > 50000:
                entry_content = entry_content[:50000]
            is_constant = entry.get("constant", False)
            is_disabled = entry_is_disabled(entry)

            # V3 extensions 子字段（ST 1.18.0 convertCharacterBook 完整映射）
            ext = entry.get("extensions", {})
            if not isinstance(ext, dict):
                ext = {}

            # 收集未映射到独立列的扩展字段到 extensions_json
            ext_json_data = {}
            for _ek, _ev in ext.items():
                if _ek not in (
                    "excludeRecursion", "preventRecursion", "delayUntilRecursion",
                    "exclude_recursion", "prevent_recursion", "delay_until_recursion",
                    "depth", "selectiveLogic", "selective_logic", "outletName",
                    "groupOverride", "group_override",
                    "groupWeight", "caseSensitive", "matchWholeWords",
                    "case_sensitive", "match_whole_words",
                    "useGroupScoring", "use_group_scoring", "automationId", "role",
                    "vectorized",
                    "matchPersonaDescription", "matchCharacterDescription",
                    "matchCharacterPersonality", "matchCharacterDepthPrompt",
                    "matchScenario", "matchCreatorNotes",
                    "match_persona_description", "match_character_description",
                    "match_character_personality", "match_character_depth_prompt",
                    "match_scenario", "match_creator_notes",
                    "triggers", "ignoreBudget", "useProbability", "displayIndex",
                    "sticky", "cooldown", "delay", "probability", "scan_depth",
                ):
                    ext_json_data[_ek] = _ev
            # 保留一些有用的扩展字段
            for _useful in ("useProbability", "displayIndex", "automationId", "role", "useGroupScoring", "ignoreBudget"):
                if _useful in ext:
                    ext_json_data[_useful] = ext[_useful]

            stage = WorldBookStage(
                id=str(uuid.uuid4()),
                world_book_id=wb.id,
                stage_index=stage_index,
                title=entry.get("comment", f"Entry {stage_index}"),
                content=entry_content,
                summary=None,
                transition_hint=None,
                priority=10 if is_constant else 5,
                token_count=len(entry_content) // 4,
                keys=json.dumps(entry_keys(entry)),
                secondary_keys=json.dumps(entry_secondary_keys(entry)),
                scan_depth=(
                    entry.get("scanDepth")
                    or ext.get("scan_depth")
                    or ext.get("depth", 4)
                ),
                # G3 修复（批次 F）: ST convertCharacterBook（world-info.js:5512）中
                # extensions.position 数值（0-7）优先——ANTop/ANBottom/EMTop/EMBottom/
                # atDepth/outlet 仅存于 extensions，此前只读顶层字符串 → 全部降级
                # after_char。无任何 position 信息时缺省对齐 ST = after_char(1)（K2）。
                position=(
                    ext["position"]
                    if isinstance(ext.get("position"), int) and 0 <= ext["position"] <= 7
                    else (
                        normalize_worldbook_position(_top_pos)
                        if isinstance((_top_pos := entry.get("position")), (str, int))
                        else 1
                    )
                ),
                selective=entry.get("selective", False),
                # V2 规范 probability/useProbability 位于顶层，部分导出器写进 extensions——双读
                probability=entry.get("probability", ext.get("probability", 100)),
                # G8 修复（批次 F）: extensions.useProbability 回填（ST 语义 false=必现，
                # world-info.js:4911）——此前缺失 → 列默认 true 按概率掷骰，ST 卡
                # useProbability:false 的必现条目被随机丢弃。映射对齐 UI 导入路径
                # worldbook.py:502-506 与 ST 契约路径 silly_tavern.py:4538-4546。
                use_probability=(
                    entry["useProbability"]
                    if isinstance(entry.get("useProbability"), bool)
                    else (
                        ext["useProbability"]
                        if isinstance(ext.get("useProbability"), bool)
                        else True
                    )
                ),
                constant=is_constant,
                group=entry.get("group", None),
                created_at=now,
                # ST V2/V3 兼容字段：规范为 extensions 下 snake_case（world-info.js:5533-5534），
                # 旧导出器常见 camelCase——全部双读
                enabled=not is_disabled,
                case_sensitive=ext.get("case_sensitive", ext.get("caseSensitive", False)),
                match_whole_words=ext.get(
                    "match_whole_words", ext.get("matchWholeWords", False)
                ),
                selective_logic=ext.get("selective_logic", ext.get("selectiveLogic", 0)),
                sticky=ext.get("sticky", 0) or 0,
                cooldown=ext.get("cooldown", 0) or 0,
                delay=ext.get("delay", 0) or 0,
                depth=ext.get("depth", 4),
                order=entry.get("insertion_order", entry.get("order", 0)) or 0,
                exclude_recursion=ext.get(
                    "exclude_recursion", ext.get("excludeRecursion", False)
                ),
                prevent_recursion=ext.get(
                    "prevent_recursion", ext.get("preventRecursion", False)
                ),
                match_persona_description=ext.get(
                    "match_persona_description", ext.get("matchPersonaDescription", False)
                ),
                match_character_description=ext.get(
                    "match_character_description",
                    ext.get("matchCharacterDescription", False),
                ),
                match_character_personality=ext.get(
                    "match_character_personality",
                    ext.get("matchCharacterPersonality", False),
                ),
                match_character_depth_prompt=ext.get(
                    "match_character_depth_prompt",
                    ext.get("matchCharacterDepthPrompt", False),
                ),
                match_scenario=ext.get("match_scenario", ext.get("matchScenario", False)),
                match_creator_notes=ext.get(
                    "match_creator_notes", ext.get("matchCreatorNotes", False)
                ),
                vectorized=ext.get("vectorized", False),
                group_override=ext.get("group_override", ext.get("groupOverride", False)),
                group_weight=ext.get("group_weight", ext.get("groupWeight", 0)) or 0,
                add_memo=bool(entry.get("addMemo", False)),
                triggers=json.dumps(ext.get("triggers", [])) if ext.get("triggers") else None,
                outlet_name=ext.get("outletName", None),
                delay_until_recursion=(
                    ext.get("delay_until_recursion")
                    or ext.get("delayUntilRecursion")
                    or 0
                ),
                # Bug #6: ST 1.18.0 ignoreBudget — 顶层优先，回退 extensions.ignore_budget
                ignore_budget=bool(
                    entry.get("ignoreBudget")
                    or ext.get("ignore_budget", False)
                ),
                extensions_json=json.dumps(ext_json_data) if ext_json_data else None,
            )
            self.db.add(stage)
            stage_index += 1

        if stage_index > 0:
            wb.is_parsed = True

        self.db.commit()
        self.db.refresh(wb)
        invalidate_cache("worldbook_list")
        return wb

    def _create_character(self, data: Dict, user_id: int, filename: str, content: bytes) -> Character:
        avatar = self._extract_avatar(data, filename, content)

        # ST 1.18.0 V3 chara card fields
        talkativeness = data.get("talkativeness")
        nickname = data.get("nickname")
        group_only_greetings = data.get("group_only_greetings")
        group_only_greetings_json = (
            json.dumps(group_only_greetings, ensure_ascii=False)
            if isinstance(group_only_greetings, list)
            else None
        )
        jailbreak = data.get("jailbreak") or None

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
            alternate_greetings=json.dumps(data["alternate_greetings"], ensure_ascii=False) if data.get("alternate_greetings") else None,
            creator_notes=data.get("creator_notes") or None,
            post_history_instructions=data.get("post_history_instructions") or None,
            ui_config=json.dumps(data["ui_config"], ensure_ascii=False) if data.get("ui_config") else None,
            raw_card_spec_version=data.get("raw_card_spec_version") or None,
            assets=json.dumps(data["assets"], ensure_ascii=False) if data.get("assets") else None,
            talkativeness=talkativeness,
            nickname=nickname,
            group_only_greetings=group_only_greetings_json,
            jailbreak=jailbreak,
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
                with _open_public_url(req, 15) as resp:
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
                            with _open_public_url(req2, 15) as resp2:
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
