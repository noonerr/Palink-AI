import json
import struct
import zlib
from io import BytesIO

def extract_chara_card_from_png(png_data):
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
            except:
                continue
    
    return None

file_path = r"c:\Users\Pall\OneDrive\桌面\Palink-AI\eve_marie_clarke_the_rebellious_teen.png"
output_path = r"c:\Users\Pall\OneDrive\桌面\Palink-AI\character_card_data.json"

with open(file_path, "rb") as f:
    file_data = f.read()

chara_card = extract_chara_card_from_png(file_data)

if chara_card:
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(chara_card, f, ensure_ascii=False, indent=2)
    print(f"Data saved to {output_path}")
else:
    print("Failed to extract")
