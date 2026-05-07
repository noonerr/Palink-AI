
import json
import struct
import zlib
import base64
from io import BytesIO
from PIL import Image
import uuid
import os


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
    
    supported_keywords = ['chara', 'character', 'tavern', 'chara_card', 'ccv3']
    
    for chunk in text_chunks:
        null_pos = chunk['data'].find(b'\x00')
        if null_pos != -1:
            try:
                keyword = chunk['data'][:null_pos].decode('utf-8', errors='replace').lower()
                raw_data = chunk['data'][null_pos+1:]
                
                if keyword not in supported_keywords:
                    continue
                
                extracted_data = None
                
                if chunk['type'] == 'zTXt':
                    try:
                        decompressed = zlib.decompress(raw_data)
                        extracted_data = decompressed.decode('utf-8', errors='replace')
                    except Exception:
                        pass
                elif chunk['type'] == 'iTXt':
                    try:
                        parts = raw_data.split(b'\x00', 2)
                        if len(parts) >= 3:
                            compressed_flag = parts[0]
                            lang_flag = parts[1]
                            text_data = parts[2]
                            if compressed_flag == b'\x01':
                                decompressed = zlib.decompress(text_data)
                                extracted_data = decompressed.decode('utf-8', errors='replace')
                            else:
                                extracted_data = text_data.decode('utf-8', errors='replace')
                    except Exception:
                        pass
                else:
                    try:
                        try:
                            decompressed = zlib.decompress(raw_data)
                            extracted_data = decompressed.decode('utf-8', errors='replace')
                        except Exception:
                            extracted_data = raw_data.decode('utf-8', errors='replace')
                    except Exception:
                        pass
                
                if extracted_data:
                    try:
                        result = json.loads(extracted_data)
                        return result
                    except Exception:
                        try:
                            decoded = base64.b64decode(extracted_data)
                            try:
                                decompressed = zlib.decompress(decoded)
                                return json.loads(decompressed.decode('utf-8', errors='replace'))
                            except Exception:
                                return json.loads(decoded.decode('utf-8', errors='replace'))
                        except Exception:
                            pass
            except Exception:
                continue
    
    return None


def create_png_with_chara_card(image_data, chara_card_data):
    """创建包含角色卡数据的 PNG 文件"""
    img = Image.open(BytesIO(image_data))
    
    output = BytesIO()
    img.save(output, format='PNG')
    output.seek(0)
    
    png_bytes = output.getvalue()
    
    chara_json = json.dumps(chara_card_data, ensure_ascii=False)
    compressed = zlib.compress(chara_json.encode('utf-8'))
    
    tEXt_chunk = b'chara\x00' + compressed
    
    new_png = bytearray()
    new_png.extend(png_bytes[:8])
    
    i = 8
    while i < len(png_bytes):
        length_data = png_bytes[i:i+4]
        length = struct.unpack('>I', length_data)[0]
        chunk_type = png_bytes[i+4:i+8]
        
        if chunk_type == b'IEND':
            text_length = struct.pack('>I', len(tEXt_chunk))
            new_png.extend(text_length)
            new_png.extend(b'tEXt')
            new_png.extend(tEXt_chunk)
            crc = zlib.crc32(b'tEXt' + tEXt_chunk) & 0xffffffff
            new_png.extend(struct.pack('>I', crc))
        
        new_png.extend(png_bytes[i:i+8+length+4])
        i += 8 + length + 4
    
    return bytes(new_png)


def convert_chara_card_to_character(chara_card):
    """将 Silly Tavern 角色卡转换为 Character 对象数据"""
    data = chara_card.get('data', chara_card)
    
    character_data = {
        'id': str(uuid.uuid4()),
        'name': data.get('name', ''),
        'description': data.get('description', ''),
        'scenario': data.get('scenario', ''),
        'first_mes': data.get('first_mes', ''),
        'mes_example': data.get('mes_example', ''),
        'system_prompt': data.get('system_prompt', ''),
        'tags': json.dumps(data.get('tags', [])) if data.get('tags') else None,
        'creator': data.get('creator', ''),
        'character_version': data.get('character_version', ''),
        'extensions': json.dumps(data.get('extensions', {})) if data.get('extensions') else None
    }
    
    return character_data


def convert_character_to_chara_card(character):
    """将 Character 对象转换为 Silly Tavern 角色卡格式"""
    return {
        'spec': 'chara_card_v2',
        'spec_version': '2.0',
        'data': {
            'name': character.name or '',
            'description': character.description or '',
            'scenario': character.scenario or '',
            'first_mes': character.first_mes or '',
            'mes_example': character.mes_example or '',
            'system_prompt': character.system_prompt or '',
            'tags': json.loads(character.tags) if character.tags else [],
            'creator': character.creator or '',
            'character_version': character.character_version or '',
            'extensions': json.loads(character.extensions) if character.extensions else {}
        }
    }

