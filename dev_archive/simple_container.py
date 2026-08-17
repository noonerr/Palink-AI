
import json
import struct
import zlib
from io import BytesIO

def extract_chara_card_from_png(png_data):
    chunks = []
    f = BytesIO(png_data)
    
    header = f.read(8)
    if header != b'\x89PNG\r\n\x1a\n':
        print("Invalid PNG header")
        return None
    
    print("Valid PNG header")
    
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
        print("Found chunk:", chunk_type_str, "length:", length)
        
        chunks.append({
            'type': chunk_type_str,
            'data': data
        })
        
        if chunk_type == b'IEND':
            break
    
    text_chunks = [c for c in chunks if c['type'] in ['tEXt', 'zTXt', 'iTXt']]
    print("\nFound", len(text_chunks), "text chunks")
    
    supported_keywords = ['chara', 'character', 'tavern', 'chara_card']
    
    for chunk_idx, chunk in enumerate(text_chunks):
        print("\nProcessing text chunk", chunk_idx+1, "/", len(text_chunks), ":", chunk['type'])
        null_pos = chunk['data'].find(b'\x00')
        if null_pos != -1:
            try:
                keyword = chunk['data'][:null_pos].decode('utf-8', errors='replace')
                keyword_lower = keyword.lower()
                print("  Keyword found:", repr(keyword))
                raw_data = chunk['data'][null_pos+1:]
                print("  Raw data length:", len(raw_data))
                
                extracted_data = None
                
                if chunk['type'] == 'zTXt':
                    print("  Processing zTXt chunk")
                    try:
                        decompressed = zlib.decompress(raw_data)
                        print("  Decompressed successfully, length:", len(decompressed))
                        extracted_data = decompressed.decode('utf-8', errors='replace')
                    except Exception as e:
                        print("  zTXt decompress error:", e)
                elif chunk['type'] == 'iTXt':
                    print("  Processing iTXt chunk")
                    try:
                        parts = raw_data.split(b'\x00', 2)
                        if len(parts) &gt;= 3:
                            compressed_flag = parts[0]
                            lang_flag = parts[1]
                            text_data = parts[2]
                            print("  Compressed flag:", compressed_flag)
                            if compressed_flag == b'\x01':
                                decompressed = zlib.decompress(text_data)
                                print("  Decompressed successfully, length:", len(decompressed))
                                extracted_data = decompressed.decode('utf-8', errors='replace')
                            else:
                                extracted_data = text_data.decode('utf-8', errors='replace')
                    except Exception as e:
                        print("  iTXt process error:", e)
                else:
                    print("  Processing tEXt chunk")
                    try:
                        try:
                            decompressed = zlib.decompress(raw_data)
                            print("  Decompressed successfully, length:", len(decompressed))
                            extracted_data = decompressed.decode('utf-8', errors='replace')
                        except:
                            extracted_data = raw_data.decode('utf-8', errors='replace')
                    except Exception as e:
                        print("  tEXt process error:", e)
                
                if extracted_data:
                    print("  Extracted data length:", len(extracted_data))
                    try:
                        result = json.loads(extracted_data)
                        print("  JSON parsed successfully!")
                        print("  Result keys:", list(result.keys()))
                        return result
                    except Exception as e:
                        print("  JSON parse error:", e)
            except Exception as e:
                print("Error processing chunk:", e)
    
    print("\nNo valid character card data found in PNG")
    return None

with open('/tmp/test_card.png', 'rb') as f:
    png_data = f.read()

result = extract_chara_card_from_png(png_data)
if result:
    print("\nSUCCESS!")
    print(json.dumps(result, indent=2, ensure_ascii=False))
else:
    print("\nFAILED to extract character card!")

