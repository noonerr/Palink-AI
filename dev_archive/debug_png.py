
import struct
import zlib
import json
from io import BytesIO

def extract_chara_card_from_png(png_data):
    """从 PNG 文件中提取 Silly Tavern 角色卡数据（支持 V2/V3 规范）"""
    chunks = []
    f = BytesIO(png_data)
    
    header = f.read(8)
    if header != b'\x89PNG\r\n\x1a\n':
        print("Invalid PNG header")
        return None
    
    print("Valid PNG header found")
    
    while True:
        length_data = f.read(4)
        if len(length_data) < 4:
            break
        length = struct.unpack('&gt;I', length_data)[0]
        
        chunk_type = f.read(4)
        if len(chunk_type) < 4:
            break
        
        data = f.read(length)
        if len(data) < length:
            break
        
        crc = f.read(4)
        
        chunk_type_str = chunk_type.decode('ascii', errors='replace')
        chunks.append({
            'type': chunk_type_str,
            'data': data
        })
        
        print(f"Found chunk: {chunk_type_str}, length: {length}")
        
        if chunk_type == b'IEND':
            break
    
    text_chunks = [c for c in chunks if c['type'] in ['tEXt', 'zTXt', 'iTXt']]
    print(f"\nFound {len(text_chunks)} text chunks")
    
    supported_keywords = ['chara', 'character', 'tavern', 'chara_card']
    
    for chunk_idx, chunk in enumerate(text_chunks):
        print(f"\nProcessing text chunk {chunk_idx+1}/{len(text_chunks)}: {chunk['type']}")
        null_pos = chunk['data'].find(b'\x00')
        if null_pos != -1:
            try:
                keyword = chunk['data'][:null_pos].decode('utf-8', errors='replace')
                keyword_lower = keyword.lower()
                print(f"  Keyword found: '{keyword}' (lower: '{keyword_lower}')")
                raw_data = chunk['data'][null_pos+1:]
                print(f"  Raw data length: {len(raw_data)} bytes")
                
                if keyword_lower not in supported_keywords:
                    print(f"  Keyword '{keyword_lower}' not in supported list {supported_keywords}")
                    continue
                
                extracted_data = None
                
                if chunk['type'] == 'zTXt':
                    print("  Processing zTXt chunk")
                    try:
                        decompressed = zlib.decompress(raw_data)
                        print(f"  Decompressed successfully, length: {len(decompressed)}")
                        extracted_data = decompressed.decode('utf-8', errors='replace')
                    except Exception as e:
                        print(f"  zTXt decompress error: {e}")
                elif chunk['type'] == 'iTXt':
                    print("  Processing iTXt chunk")
                    try:
                        parts = raw_data.split(b'\x00', 2)
                        if len(parts) &gt;= 3:
                            compressed_flag = parts[0]
                            lang_flag = parts[1]
                            text_data = parts[2]
                            print(f"  Compressed flag: {compressed_flag}, lang flag: {lang_flag}")
                            if compressed_flag == b'\x01':
                                decompressed = zlib.decompress(text_data)
                                print(f"  Decompressed successfully, length: {len(decompressed)}")
                                extracted_data = decompressed.decode('utf-8', errors='replace')
                            else:
                                extracted_data = text_data.decode('utf-8', errors='replace')
                    except Exception as e:
                        print(f"  iTXt process error: {e}")
                else:
                    print("  Processing tEXt chunk")
                    try:
                        try:
                            decompressed = zlib.decompress(raw_data)
                            print(f"  Decompressed successfully, length: {len(decompressed)}")
                            extracted_data = decompressed.decode('utf-8', errors='replace')
                        except:
                            extracted_data = raw_data.decode('utf-8', errors='replace')
                    except Exception as e:
                        print(f"  tEXt process error: {e}")
                
                if extracted_data:
                    print(f"  Extracted data length: {len(extracted_data)}")
                    try:
                        result = json.loads(extracted_data)
                        print("  JSON parsed successfully!")
                        print(f"  Result keys: {list(result.keys()) if isinstance(result, dict) else 'not a dict'}")
                        return result
                    except Exception as e:
                        print(f"  JSON parse error: {e}")
                        try:
                            import base64
                            decoded = base64.b64decode(extracted_data)
                            try:
                                decompressed = zlib.decompress(decoded)
                                result = json.loads(decompressed.decode('utf-8', errors='replace'))
                                print("  Base64+zlib JSON parsed successfully!")
                                return result
                            except:
                                result = json.loads(decoded.decode('utf-8', errors='replace'))
                                print("  Base64 JSON parsed successfully!")
                                return result
                        except Exception as e2:
                            print(f"  Base64 decode error: {e2}")
            except Exception as e:
                print(f"Error processing chunk {chunk_idx+1}: {e}")
                import traceback
                print(traceback.format_exc())
                continue
    
    print("\nNo valid character card data found in PNG")
    return None

# Test with the file
file_path = r"c:\Users\Pall\OneDrive\桌面\Palink-AI\Koseki Bijou 🗿✨.png"
print(f"Reading file: {file_path}")

with open(file_path, 'rb') as f:
    png_data = f.read()

print(f"File size: {len(png_data)} bytes\n")

result = extract_chara_card_from_png(png_data)

if result:
    print("\nSUCCESS! Found character card:")
    print(json.dumps(result, indent=2, ensure_ascii=False)[:2000])

