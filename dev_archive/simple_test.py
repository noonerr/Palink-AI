
import json
import struct
import zlib
from io import BytesIO

def extract_chara_card_from_png(png_data):
    """从 PNG 文件中提取 Silly Tavern 角色卡数据"""
    chunks = []
    f = BytesIO(png_data)
    
    header = f.read(8)
    if header != b'\x89PNG\r\n\x1a\n':
        return None
    
    print("Valid PNG header")
    
    while True:
        length_data = f.read(4)
        if len(length_data) &lt; 4:
            break
        length = struct.unpack('&gt;I', length_data)[0]
        
        chunk_type = f.read(4)
        if len(chunk_type) &lt; 4:
            break
        
        data = f.read(length)
        if len(data) &lt; length:
            break
        
        crc = f.read(4)
        
        chunk_type_str = chunk_type.decode('ascii', errors='replace')
        print(f"Found chunk: {chunk_type_str}, length: {length}")
        
        chunks.append({
            'type': chunk_type_str,
            'data': data
        })
        
        if chunk_type == b'IEND':
            break
    
    text_chunks = [c for c in chunks if c['type'] == 'tEXt']
    print(f"\nFound {len(text_chunks)} tEXt chunks")
    
    for chunk in text_chunks:
        null_pos = chunk['data'].find(b'\x00')
        if null_pos != -1:
            keyword = chunk['data'][:null_pos].decode('utf-8', errors='replace')
            data = chunk['data'][null_pos+1:]
            
            print(f"\nFound keyword: '{keyword}'")
            
            if keyword == 'chara':
                print("  Trying to decompress...")
                try:
                    decompressed = zlib.decompress(data)
                    print("  Decompressed successfully!")
                    result = json.loads(decompressed.decode('utf-8'))
                    print("  JSON parsed successfully!")
                    print(f"  Keys: {list(result.keys())}")
                    return result
                except Exception as e:
                    print(f"  Decompress/JSON error: {e}")
                    try:
                        result = json.loads(data.decode('utf-8'))
                        print("  Uncompressed JSON parsed!")
                        return result
                    except Exception as e2:
                        print(f"  Uncompressed JSON error: {e2}")
    
    print("\nNo chara chunk found!")
    return None

# Test
file_path = r"c:\Users\Pall\OneDrive\桌面\Palink-AI\Koseki Bijou 🗿✨.png"
with open(file_path, 'rb') as f:
    png_data = f.read()

result = extract_chara_card_from_png(png_data)
if result:
    print("\nSUCCESS!")
    print(json.dumps(result, indent=2, ensure_ascii=False)[:3000])
else:
    print("\nFAILED to extract character card!")

