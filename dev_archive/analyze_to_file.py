
import struct
import zlib
import json
from io import BytesIO
import sys

def main():
    output_file = open('png_analysis.txt', 'w', encoding='utf-8')
    
    def log(msg):
        print(msg)
        output_file.write(msg + '\n')
        output_file.flush()
    
    file_path = r"c:\Users\Pall\OneDrive\桌面\Palink-AI\Koseki Bijou 🗿✨.png"
    log(f"Reading file: {file_path}")
    
    with open(file_path, 'rb') as f:
        png_data = f.read()
    
    log(f"File size: {len(png_data)} bytes\n")
    
    chunks = []
    f = BytesIO(png_data)
    
    header = f.read(8)
    if header != b'\x89PNG\r\n\x1a\n':
        log("Invalid PNG header")
        return
    
    log("Valid PNG header found")
    
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
        chunks.append({
            'type': chunk_type_str,
            'data': data
        })
        
        log(f"Found chunk: {chunk_type_str}, length: {length}")
        
        if chunk_type == b'IEND':
            break
    
    text_chunks = [c for c in chunks if c['type'] in ['tEXt', 'zTXt', 'iTXt']]
    log(f"\nFound {len(text_chunks)} text chunks")
    
    supported_keywords = ['chara', 'character', 'tavern', 'chara_card']
    
    for chunk_idx, chunk in enumerate(text_chunks):
        log(f"\nProcessing text chunk {chunk_idx+1}/{len(text_chunks)}: {chunk['type']}")
        null_pos = chunk['data'].find(b'\x00')
        if null_pos != -1:
            try:
                keyword = chunk['data'][:null_pos].decode('utf-8', errors='replace')
                keyword_lower = keyword.lower()
                log(f"  Keyword found: '{keyword}' (lower: '{keyword_lower}')")
                raw_data = chunk['data'][null_pos+1:]
                log(f"  Raw data length: {len(raw_data)} bytes")
                
                if keyword_lower not in supported_keywords:
                    log(f"  Keyword '{keyword_lower}' not in supported list {supported_keywords}")
                    continue
                
                extracted_data = None
                
                if chunk['type'] == 'zTXt':
                    log("  Processing zTXt chunk")
                    try:
                        decompressed = zlib.decompress(raw_data)
                        log(f"  Decompressed successfully, length: {len(decompressed)}")
                        extracted_data = decompressed.decode('utf-8', errors='replace')
                    except Exception as e:
                        log(f"  zTXt decompress error: {e}")
                elif chunk['type'] == 'iTXt':
                    log("  Processing iTXt chunk")
                    try:
                        parts = raw_data.split(b'\x00', 2)
                        if len(parts) &gt;= 3:
                            compressed_flag = parts[0]
                            lang_flag = parts[1]
                            text_data = parts[2]
                            log(f"  Compressed flag: {compressed_flag}, lang flag: {lang_flag}")
                            if compressed_flag == b'\x01':
                                decompressed = zlib.decompress(text_data)
                                log(f"  Decompressed successfully, length: {len(decompressed)}")
                                extracted_data = decompressed.decode('utf-8', errors='replace')
                            else:
                                extracted_data = text_data.decode('utf-8', errors='replace')
                    except Exception as e:
                        log(f"  iTXt process error: {e}")
                else:
                    log("  Processing tEXt chunk")
                    try:
                        try:
                            decompressed = zlib.decompress(raw_data)
                            log(f"  Decompressed successfully, length: {len(decompressed)}")
                            extracted_data = decompressed.decode('utf-8', errors='replace')
                        except:
                            extracted_data = raw_data.decode('utf-8', errors='replace')
                    except Exception as e:
                        log(f"  tEXt process error: {e}")
                
                if extracted_data:
                    log(f"  Extracted data length: {len(extracted_data)}")
                    try:
                        result = json.loads(extracted_data)
                        log("  JSON parsed successfully!")
                        log(f"  Result keys: {list(result.keys()) if isinstance(result, dict) else 'not a dict'}")
                        if isinstance(result, dict) and 'data' in result:
                            log(f"  data keys: {list(result['data'].keys())}")
                        
                        log("\nSUCCESS! Found character card!")
                        log(json.dumps(result, indent=2, ensure_ascii=False))
                        output_file.close()
                        return result
                    except Exception as e:
                        log(f"  JSON parse error: {e}")
                        try:
                            import base64
                            decoded = base64.b64decode(extracted_data)
                            try:
                                decompressed = zlib.decompress(decoded)
                                result = json.loads(decompressed.decode('utf-8', errors='replace'))
                                log("  Base64+zlib JSON parsed successfully!")
                                log(json.dumps(result, indent=2, ensure_ascii=False))
                                output_file.close()
                                return result
                            except:
                                result = json.loads(decoded.decode('utf-8', errors='replace'))
                                log("  Base64 JSON parsed successfully!")
                                log(json.dumps(result, indent=2, ensure_ascii=False))
                                output_file.close()
                                return result
                        except Exception as e2:
                            log(f"  Base64 decode error: {e2}")
            except Exception as e:
                log(f"Error processing chunk {chunk_idx+1}: {e}")
                import traceback
                log(traceback.format_exc())
                continue
    
    log("\nNo valid character card data found in PNG")
    output_file.close()

if __name__ == "__main__":
    main()

