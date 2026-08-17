import json
import struct
import zlib
from io import BytesIO
from PIL import Image


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
    
    supported_keywords = ['chara', 'character', 'tavern', 'chara_card']
    
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
                    except:
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
                    except:
                        pass
                else:
                    try:
                        try:
                            decompressed = zlib.decompress(raw_data)
                            extracted_data = decompressed.decode('utf-8', errors='replace')
                        except:
                            extracted_data = raw_data.decode('utf-8', errors='replace')
                    except:
                        pass
                
                if extracted_data:
                    try:
                        result = json.loads(extracted_data)
                        return result
                    except:
                        try:
                            import base64
                            decoded = base64.b64decode(extracted_data)
                            try:
                                decompressed = zlib.decompress(decoded)
                                return json.loads(decompressed.decode('utf-8', errors='replace'))
                            except:
                                return json.loads(decoded.decode('utf-8', errors='replace'))
                        except:
                            pass
            except Exception as e:
                print(f"Error processing chunk: {e}")
                continue
    
    return None


def translate_text(text):
    """简单的翻译函数，使用在线翻译API"""
    if not text or not text.strip():
        return text
    
    try:
        import requests
        
        # 使用免费的翻译API
        url = "https://api.mymemory.translated.net/get"
        params = {
            'q': text[:5000],  # 限制长度
            'langpair': 'en|zh-CN'
        }
        
        response = requests.get(url, params=params, timeout=10)
        if response.ok:
            data = response.json()
            if data.get('responseStatus') == 200:
                return data.get('responseData', {}).get('translatedText', text)
    except Exception as e:
        print(f"Translation error: {e}")
    
    return text


# 主程序
if __name__ == "__main__":
    file_path = r"c:\Users\Pall\OneDrive\桌面\Palink-AI\eve_marie_clarke_the_rebellious_teen.png"
    
    print(f"正在读取文件: {file_path}")
    print("=" * 80)
    
    try:
        with open(file_path, "rb") as f:
            file_data = f.read()
        
        chara_card = extract_chara_card_from_png(file_data)
        
        if chara_card:
            print("✅ 成功提取角色卡数据！")
            print("=" * 80)
            print("\n原始数据:")
            print("-" * 80)
            print(json.dumps(chara_card, ensure_ascii=False, indent=2))
            
            # 处理数据
            if 'data' in chara_card and isinstance(chara_card['data'], dict):
                data = chara_card['data']
            else:
                data = chara_card
            
            print("\n" + "=" * 80)
            print("字段解析:")
            print("=" * 80)
            
            for key in ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'tags', 'creator', 'character_version']:
                value = data.get(key, '')
                if value:
                    print(f"\n【{key}】:")
                    print(f"  原文: {value}")
                    
                    # 尝试翻译
                    if isinstance(value, str) and len(value) > 0:
                        translated = translate_text(value)
                        if translated != value:
                            print(f"  翻译: {translated}")
            
            print("\n" + "=" * 80)
            
        else:
            print("❌ 无法提取角色卡数据")
            
    except Exception as e:
        print(f"❌ 错误: {e}")
        import traceback
        traceback.print_exc()
