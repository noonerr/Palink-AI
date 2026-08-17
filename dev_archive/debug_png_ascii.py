
import json
import struct
import zlib
from io import BytesIO

def main():
    with open('/tmp/test_card.png', 'rb') as f:
        png_data = f.read()
    
    chunks = []
    f = BytesIO(png_data)
    
    header = f.read(8)
    if header != b'\x89PNG\r\n\x1a\n':
        print("Invalid PNG header")
        return
    
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
    
    text_chunks = []
    for c in chunks:
        if c['type'] in ['tEXt', 'zTXt', 'iTXt']:
            text_chunks.append(c)
    
    print("\nFound", len(text_chunks), "text chunks")
    
    for i, chunk in enumerate(text_chunks):
        print("\nProcessing chunk", i+1, ":", chunk['type'])
        null_pos = chunk['data'].find(b'\x00')
        if null_pos != -1:
            keyword = chunk['data'][:null_pos].decode('utf-8', errors='replace')
            print("  Keyword:", repr(keyword))
            
            raw_data = chunk['data'][null_pos+1:]
            print("  Raw data length:", len(raw_data))
            
            extracted = None
            
            if chunk['type'] == 'zTXt':
                try:
                    d = zlib.decompress(raw_data)
                    print("  Decompressed, len:", len(d))
                    extracted = d.decode('utf-8', errors='replace')
                except Exception as e:
                    print("  zTXt error:", e)
            elif chunk['type'] == 'iTXt':
                try:
                    parts = raw_data.split(b'\x00', 2)
                    if len(parts) >= 3:
                        cf = parts[0]
                        lf = parts[1]
                        td = parts[2]
                        print("  CF:", cf)
                        if cf == b'\x01':
                            d = zlib.decompress(td)
                            extracted = d.decode('utf-8', errors='replace')
                        else:
                            extracted = td.decode('utf-8', errors='replace')
                except Exception as e:
                    print("  iTXt error:", e)
            else:
                try:
                    try:
                        d = zlib.decompress(raw_data)
                        extracted = d.decode('utf-8', errors='replace')
                    except:
                        extracted = raw_data.decode('utf-8', errors='replace')
                except Exception as e:
                    print("  tEXt error:", e)
            
            if extracted:
                print("  Extracted len:", len(extracted))
                try:
                    res = json.loads(extracted)
                    print("  SUCCESS! JSON parsed!")
                    print("  Keys:", list(res.keys()))
                    if 'data' in res:
                        print("  Data keys:", list(res['data'].keys()))
                    print("\n", json.dumps(res, indent=2))
                    return
                except Exception as e:
                    print("  JSON error:", e)
    
    print("\nNo character card found!")

if __name__ == "__main__":
    main()

