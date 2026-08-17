
import json
import struct
import zlib
import base64
import logging
from io import BytesIO
from PIL import Image
import uuid
import os

logger = logging.getLogger(__name__)

MAX_EMBEDDED_CARD_TEXT_BYTES = 8 * 1024 * 1024
MAX_PNG_TEXT_CHUNK_BYTES = 16 * 1024 * 1024
CCV3_KEYWORDS = {'ccv3', 'chara_card_v3'}
SILLYTAVERN_CARD_KEYWORDS = {'chara', 'chara_card', 'character', 'tavern'}
SUPPORTED_CARD_KEYWORDS = CCV3_KEYWORDS | SILLYTAVERN_CARD_KEYWORDS


def _safe_zlib_decompress(data: bytes, max_size: int = MAX_EMBEDDED_CARD_TEXT_BYTES) -> bytes:
    if len(data) > MAX_PNG_TEXT_CHUNK_BYTES:
        raise ValueError("Embedded character card chunk is too large")

    decompressor = zlib.decompressobj()
    output = decompressor.decompress(data, max_size + 1)
    if len(output) > max_size or decompressor.unconsumed_tail:
        raise ValueError("Embedded character card data is too large after decompression")

    remaining = max_size + 1 - len(output)
    if remaining > 0:
        output += decompressor.flush(remaining)
    if len(output) > max_size:
        raise ValueError("Embedded character card data is too large after decompression")
    return output


def _decode_card_text(data: bytes) -> str:
    if len(data) > MAX_EMBEDDED_CARD_TEXT_BYTES:
        raise ValueError("Embedded character card text is too large")
    return data.decode('utf-8', errors='replace')


def _parse_itxt_raw_data(raw_data: bytes) -> tuple:
    """Parse iTXt chunk data after the keyword null separator.

    iTXt binary layout (after keyword\\0):
      compression_flag  (1 byte, 0 or 1)
      compression_method (1 byte, 0 = zlib)
      language_tag       (null-terminated Latin-1)
      translated_keyword (null-terminated UTF-8)
      text               (UTF-8 or compressed bytes)

    Returns (compression_flag: int, text_bytes: bytes).
    """
    if len(raw_data) < 2:
        return 0, b''

    compression_flag = raw_data[0]
    pos = 2

    while pos < len(raw_data) and raw_data[pos] != 0:
        pos += 1
    pos += 1

    while pos < len(raw_data) and raw_data[pos] != 0:
        pos += 1
    pos += 1

    text_bytes = raw_data[pos:]
    return compression_flag, text_bytes


def _decode_png_text_chunk(chunk_type: str, raw_data: bytes) -> str | None:
    extracted_data = None

    if chunk_type == 'zTXt':
        try:
            if len(raw_data) > 0:
                decompressed = _safe_zlib_decompress(raw_data[1:])
                extracted_data = _decode_card_text(decompressed)
        except Exception:
            try:
                decompressed = _safe_zlib_decompress(raw_data)
                extracted_data = _decode_card_text(decompressed)
            except Exception:
                pass
    elif chunk_type == 'iTXt':
        try:
            compression_flag, text_bytes = _parse_itxt_raw_data(raw_data)
            if compression_flag == 1:
                decompressed = _safe_zlib_decompress(text_bytes)
                extracted_data = _decode_card_text(decompressed)
            else:
                extracted_data = _decode_card_text(text_bytes)
        except Exception as exc:
            logger.debug("iTXt parse failed: %s", exc)
    else:
        try:
            try:
                decompressed = _safe_zlib_decompress(raw_data)
                extracted_data = _decode_card_text(decompressed)
            except Exception:
                extracted_data = _decode_card_text(raw_data)
        except Exception:
            pass

    return extracted_data


def _load_card_payload(extracted_data: str):
    try:
        return json.loads(extracted_data)
    except Exception:
        try:
            decoded = base64.b64decode(extracted_data)
            try:
                decompressed = _safe_zlib_decompress(decoded)
                return json.loads(_decode_card_text(decompressed))
            except Exception:
                return json.loads(_decode_card_text(decoded))
        except Exception:
            return None


def _is_ccv3_card(card_data) -> bool:
    if not isinstance(card_data, dict):
        return False
    spec = str(card_data.get('spec') or '').lower()
    spec_version = str(card_data.get('spec_version') or '')
    return spec == 'chara_card_v3' or spec_version.startswith('3')


def _score_png_card_candidate(candidate: dict) -> int:
    keyword = candidate.get('keyword')
    card_data = candidate.get('card_data')
    if keyword in CCV3_KEYWORDS or _is_ccv3_card(card_data):
        return 3
    if keyword in SILLYTAVERN_CARD_KEYWORDS:
        return 2
    return 1


def extract_chara_card_from_png(png_data):
    """从 PNG 文件中提取 Silly Tavern 角色卡数据（支持 V2/V3 规范）"""
    chunks = []
    f = BytesIO(png_data)
    
    header = f.read(8)
    if header != b'\x89PNG\r\n\x1a\n':
        return None
    
    while True:
        length_data = f.read(4)
        if len(length_data) < 4:
            break
        length = struct.unpack('>I', length_data)[0]
        
        chunk_type = f.read(4)
        if len(chunk_type) < 4:
            break
        
        data = f.read(length)
        if len(data) < length:
            break
        
        crc = f.read(4)
        
        chunks.append({
            'type': chunk_type.decode('ascii', errors='replace'),
            'data': data
        })
        
        if chunk_type == b'IEND':
            break
    
    text_chunks = [c for c in chunks if c['type'] in ['tEXt', 'zTXt', 'iTXt']]
    
    candidates = []
    
    for index, chunk in enumerate(text_chunks):
        null_pos = chunk['data'].find(b'\x00')
        if null_pos != -1:
            try:
                keyword = chunk['data'][:null_pos].decode('utf-8', errors='replace').lower()
                raw_data = chunk['data'][null_pos+1:]
                
                if keyword not in SUPPORTED_CARD_KEYWORDS:
                    continue
                
                extracted_data = _decode_png_text_chunk(chunk['type'], raw_data)
                if extracted_data:
                    result = _load_card_payload(extracted_data)
                    if result is not None:
                        candidates.append({
                            'index': index,
                            'keyword': keyword,
                            'card_data': result,
                        })
            except Exception:
                continue

    if candidates:
        best = max(candidates, key=lambda c: (_score_png_card_candidate(c), c['index']))
        return best['card_data']
    
    return None


def _build_text_chunk(keyword: str, text: str) -> bytes:
    """构建 PNG tEXt 块（keyword\\0 + text，base64 编码角色卡数据）"""
    keyword_bytes = keyword.encode('utf-8')
    text_bytes = text.encode('utf-8')
    chunk_data = keyword_bytes + b'\x00' + text_bytes
    chunk_length = struct.pack('>I', len(chunk_data))
    chunk_type = b'tEXt'
    crc = zlib.crc32(chunk_type + chunk_data) & 0xffffffff
    return chunk_length + chunk_type + chunk_data + struct.pack('>I', crc)


def create_png_with_chara_card(image_data, chara_card_data):
    """创建包含角色卡数据的 PNG 文件。

    与 ST 1.18.0 对齐：
    - 移除已有的 chara/ccv3 tEXt/zTXt/iTXt 块（防止重复导出累积）
    - 同时写入 chara（V2）和 ccv3（V3）两个 tEXt 块
    - 使用 base64 编码（与 ST 一致），非 zTXt 压缩
    """
    img = Image.open(BytesIO(image_data))

    output = BytesIO()
    img.save(output, format='PNG')
    output.seek(0)

    png_bytes = output.getvalue()

    # 构建 V2 (chara) 和 V3 (ccv3) 卡片数据
    v2_card_data = chara_card_data
    v3_card_data = json.loads(json.dumps(chara_card_data))  # deep copy
    if isinstance(v3_card_data, dict):
        v3_card_data['spec'] = 'chara_card_v3'
        v3_card_data['spec_version'] = '3.0'

    chara_b64 = base64.b64encode(
        json.dumps(v2_card_data, ensure_ascii=False).encode('utf-8')
    ).decode('ascii')
    ccv3_b64 = base64.b64encode(
        json.dumps(v3_card_data, ensure_ascii=False).encode('utf-8')
    ).decode('ascii')

    chara_text_chunk = _build_text_chunk('chara', chara_b64)
    ccv3_text_chunk = _build_text_chunk('ccv3', ccv3_b64)

    # 需要移除的关键词集合（防止重复导出累积旧数据）
    remove_keywords = {b'chara', b'ccv3', b'chara_card', b'chara_card_v3', b'character', b'tavern'}

    new_png = bytearray()
    new_png.extend(png_bytes[:8])  # PNG signature

    i = 8
    while i < len(png_bytes):
        length_data = png_bytes[i:i+4]
        if len(length_data) < 4:
            break
        length = struct.unpack('>I', length_data)[0]
        chunk_type = png_bytes[i+4:i+8]
        chunk_data = png_bytes[i+8:i+8+length]

        # 在 IEND 之前插入 chara 和 ccv3 块
        if chunk_type == b'IEND':
            new_png.extend(chara_text_chunk)
            new_png.extend(ccv3_text_chunk)

        # 跳过已有的 chara/ccv3 tEXt/zTXt/iTXt 块（避免重复）
        if chunk_type in (b'tEXt', b'zTXt', b'iTXt') and length > 0:
            null_pos = chunk_data.find(b'\x00')
            if null_pos != -1:
                kw = chunk_data[:null_pos].lower()
                if kw in remove_keywords:
                    i += 8 + length + 4  # skip this chunk (length + CRC)
                    continue

        new_png.extend(png_bytes[i:i+8+length+4])
        i += 8 + length + 4

    return bytes(new_png)


def convert_chara_card_to_character(chara_card):
    """将 Silly Tavern 角色卡转换为 Character 对象数据"""
    data = chara_card.get('data', chara_card)
    extensions = data.get('extensions', {})
    if not isinstance(extensions, dict):
        extensions = {}

    ui_config = None
    if isinstance(extensions.get("palink_ui"), dict):
        ui_config = extensions["palink_ui"]
    elif isinstance(extensions.get("tavern_ui"), dict):
        ui_config = extensions["tavern_ui"]

    # ST V3 assets 字段（多模态资源，如 icon/cover 等）
    assets = data.get('assets')
    if assets is not None and not isinstance(assets, list):
        assets = None

    # character_book：ST V2 卡内嵌的世界书（位于 data 顶层或 extensions 中），保留原值以便往返
    character_book = data.get('character_book')
    if not character_book and isinstance(extensions, dict):
        character_book = extensions.get('character_book') or extensions.get('lorebook')

    # group_only_greetings：ST V3 群聊专属问候语，保留原值以便往返
    group_only_greetings = data.get('group_only_greetings')
    if group_only_greetings is not None and not isinstance(group_only_greetings, list):
        group_only_greetings = None

    # ST 1.18.0 V3 chara card fields
    talkativeness = data.get('talkativeness')
    if talkativeness is not None and not isinstance(talkativeness, (str, int, float)):
        talkativeness = None
    if talkativeness is not None:
        talkativeness = str(talkativeness)

    nickname = data.get('nickname')
    if nickname is not None and not isinstance(nickname, str):
        nickname = str(nickname) if nickname else None

    # ST 1.18.0 jailbreak 字段提取 (D1 修复):
    # V3 卡: 优先 data.extensions.jailbreak，回退 data.jailbreak
    # V2 卡: data.post_history_instructions 同时写入 jailbreak（向后兼容）
    jailbreak_value = None
    if isinstance(extensions, dict):
        jailbreak_value = extensions.get('jailbreak')
    if not jailbreak_value:
        jailbreak_value = data.get('jailbreak')
    if not jailbreak_value:
        # V2 卡回退: post_history_instructions 同时作为 jailbreak
        phi = data.get('post_history_instructions', '')
        if phi and phi.strip():
            jailbreak_value = phi

    character_data = {
        'id': str(uuid.uuid4()),
        'name': data.get('name', ''),
        'description': data.get('description', ''),
        'personality': data.get('personality', ''),
        'scenario': data.get('scenario', ''),
        'first_mes': data.get('first_mes', ''),
        'mes_example': data.get('mes_example', ''),
        'system_prompt': data.get('system_prompt', ''),
        'tags': json.dumps(data.get('tags', []), ensure_ascii=False) if data.get('tags') else None,
        'creator': data.get('creator', ''),
        'character_version': data.get('character_version', ''),
        'extensions': json.dumps(extensions, ensure_ascii=False) if extensions else None,
        'alternate_greetings': json.dumps(data.get('alternate_greetings', []), ensure_ascii=False) if data.get('alternate_greetings') else None,
        'creator_notes': data.get('creator_notes', ''),
        'post_history_instructions': data.get('post_history_instructions', ''),
        'jailbreak': jailbreak_value,
        'ui_config': json.dumps(ui_config, ensure_ascii=False) if ui_config else None,
        'assets': json.dumps(assets, ensure_ascii=False) if assets else None,
        'character_book': character_book,
        'group_only_greetings': group_only_greetings,
        'talkativeness': talkativeness,
        'nickname': nickname,
    }

    return character_data


# Palink 私有扩展字段前缀，导出时需清除
_PALINK_PRIVATE_EXT_KEYS = {
    "palink_raw_card_data",
    "palink_sillytavern",
    "palink_ui",
    "tavern_ui",
}


def _unset_private_fields(card: dict) -> dict:
    """清除角色卡中的私有字段，与 ST 1.18.0 unsetPrivateFields 对齐。

    - fav 设为 false（用户偏好不应导出）
    - chat / json_data / shallow 移除（内部运行时状态）
    - Palink 私有扩展字段移除（palink_raw_card_data 等）
    """
    data = card.get("data")
    if not isinstance(data, dict):
        return card

    data["fav"] = False
    data.pop("chat", None)
    data.pop("json_data", None)
    data.pop("shallow", None)

    ext = data.get("extensions")
    if isinstance(ext, dict):
        ext["fav"] = False
        ext.pop("chat", None)
        ext.pop("json_data", None)
        ext.pop("shallow", None)
        for key in _PALINK_PRIVATE_EXT_KEYS:
            ext.pop(key, None)

    return card


def convert_character_to_chara_card(character, world_book_data=None):
    """将 Character 对象转换为 Silly Tavern 角色卡格式"""
    try:
        extensions = json.loads(character.extensions) if character.extensions else {}
    except (json.JSONDecodeError, TypeError):
        extensions = {}

    if character.ui_config:
        try:
            ui = json.loads(character.ui_config) if isinstance(character.ui_config, str) else character.ui_config
            if isinstance(ui, dict):
                extensions["palink_ui"] = ui
        except (json.JSONDecodeError, TypeError):
            pass

    try:
        alternate_greetings = json.loads(character.alternate_greetings) if character.alternate_greetings else []
    except (json.JSONDecodeError, TypeError):
        alternate_greetings = []

    # ST V3 assets 字段（多模态资源）
    try:
        assets = json.loads(character.assets) if character.assets else None
    except (json.JSONDecodeError, TypeError):
        assets = None

    raw_card_data = extensions.get("palink_raw_card_data")
    is_v3 = False
    if isinstance(raw_card_data, dict):
        spec_version = str(raw_card_data.get("spec_version") or "")
        spec = str(raw_card_data.get("spec") or "").lower()
        is_v3 = spec == "chara_card_v3" or spec_version.startswith("3")

    if is_v3:
        original_data = raw_card_data.get("data", {})
        if not isinstance(original_data, dict):
            original_data = {}

        data = dict(original_data)

        def _overlay_field(key, stored_value):
            original_value = data.get(key)
            if stored_value is not None and stored_value != "":
                if isinstance(original_value, dict) and isinstance(stored_value, str):
                    try:
                        parsed = json.loads(stored_value)
                        if isinstance(parsed, dict):
                            data[key] = parsed
                        else:
                            data[key] = original_value
                    except (json.JSONDecodeError, TypeError):
                        data[key] = original_value
                else:
                    data[key] = stored_value
            elif stored_value is None:
                # 列为 NULL（如旧版本导入的行未回填该字段）：视为"从未编辑"，
                # 保留原始卡值，避免把 Palink 不管理的字段导丢
                data[key] = original_value if original_value is not None else ""
            else:
                # E-1 修复: 列为空串说明用户在编辑器中显式清空过该字段，
                # 尊重清空结果，不再用原始卡值复活（旧版行为：清空的字段导出后
                # 又变回导入时的内容）
                data[key] = ""

        _overlay_field("name", character.name)
        _overlay_field("description", character.description)
        _overlay_field("personality", character.personality)
        _overlay_field("scenario", character.scenario)
        _overlay_field("first_mes", character.first_mes)
        _overlay_field("mes_example", character.mes_example)
        _overlay_field("system_prompt", character.system_prompt)
        _overlay_field("creator", character.creator)
        _overlay_field("character_version", character.character_version)
        _overlay_field("creator_notes", character.creator_notes)
        _overlay_field("post_history_instructions", character.post_history_instructions)
        # R-1 修复: V3 导出补 jailbreak 覆盖（此前遗漏，编辑后导出保留的是原始卡值）
        _overlay_field("jailbreak", character.jailbreak)

        # ST 1.18.0 V3 chara card fields: talkativeness / nickname / group_only_greetings
        talkativeness_val = getattr(character, "talkativeness", None)
        if talkativeness_val is not None and talkativeness_val != "":
            data["talkativeness"] = str(talkativeness_val)
        elif "talkativeness" not in data:
            data["talkativeness"] = "0.5"

        nickname_val = getattr(character, "nickname", None)
        if nickname_val is not None and nickname_val != "":
            data["nickname"] = str(nickname_val)
        elif "nickname" not in data:
            data["nickname"] = ""

        group_only_greetings_val = getattr(character, "group_only_greetings", None)
        if group_only_greetings_val:
            try:
                parsed_gog = json.loads(group_only_greetings_val) if isinstance(group_only_greetings_val, str) else group_only_greetings_val
                if isinstance(parsed_gog, list):
                    data["group_only_greetings"] = parsed_gog
                else:
                    data["group_only_greetings"] = []
            except (json.JSONDecodeError, TypeError):
                data["group_only_greetings"] = []
        elif "group_only_greetings" not in data:
            data["group_only_greetings"] = []

        if "depth_prompt" not in data and "depth_prompt" in extensions:
            data["depth_prompt"] = extensions["depth_prompt"]

        if character.tags:
            try:
                data["tags"] = json.loads(character.tags)
            except (json.JSONDecodeError, TypeError):
                data["tags"] = []
        elif "tags" not in data:
            data["tags"] = []

        data["extensions"] = extensions
        data["alternate_greetings"] = alternate_greetings

        # ST V3 assets：优先使用数据库存储的值，否则保留原始卡片的 assets
        if assets is not None:
            data["assets"] = assets
        elif "assets" not in data:
            data["assets"] = []

        if world_book_data:
            data["character_book"] = world_book_data

        return _unset_private_fields({
            "spec": "chara_card_v3",
            "spec_version": raw_card_data.get("spec_version", "3.0"),
            "data": data,
        })

    data = {
        'name': character.name or '',
        'description': character.description or '',
        'personality': character.personality or '',
        'scenario': character.scenario or '',
        'first_mes': character.first_mes or '',
        'mes_example': character.mes_example or '',
        'system_prompt': character.system_prompt or '',
        'tags': json.loads(character.tags) if character.tags else [],
        'creator': character.creator or '',
        'character_version': character.character_version or '',
        'extensions': extensions,
        'alternate_greetings': alternate_greetings,
        'creator_notes': character.creator_notes or '',
        'post_history_instructions': character.post_history_instructions or '',
    }
    if 'depth_prompt' in extensions:
        data['depth_prompt'] = extensions['depth_prompt']
    if world_book_data:
        data['character_book'] = world_book_data
    return _unset_private_fields({
        'spec': 'chara_card_v2',
        'spec_version': '2.0',
        'data': data
    })

