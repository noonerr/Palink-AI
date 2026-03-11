
import struct
import zlib
import json

file_path = r"c:\Users\Pall\OneDrive\桌面\Palink-AI\Koseki Bijou 🗿✨.png"

with open(file_path, 'rb') as f:
    data = f.read()

print("File size:", len(data))

offset = 8
chunks = []

while offset &lt; len(data):
    length = struct.unpack('&gt;I', data[offset:offset+4])[0]
    offset += 4
    chunk_type = data[offset:offset+4]
    offset += 4
    chunk_data = data[offset:offset+length]
    offset += length
    crc = data[offset:offset+4]
    offset += 4
    
    chunks.append((chunk_type, chunk_data))
    print(chunk_type.decode('ascii', errors='replace'), length)
    
    if chunk_type == b'IEND':
        break

print("\n--- Checking text chunks ---")
for ct, cd in chunks:
    if ct in [b'tEXt', b'zTXt', b'iTXt']:
        print("\nFound", ct.decode('ascii'))
        null_pos = cd.find(b'\x00')
        if null_pos != -1:
            keyword = cd[:null_pos].decode('utf-8', errors='replace')
            print("Keyword:", repr(keyword))
            raw = cd[null_pos+1:]
            
            if ct == b'zTXt':
                try:
                    dec = zlib.decompress(raw)
                    print("Decompressed, len:", len(dec))
                    try:
                        j = json.loads(dec.decode('utf-8'))
                        print("JSON keys:", list(j.keys()) if isinstance(j, dict) else 'not dict')
                        if isinstance(j, dict) and 'data' in j:
                            print("data keys:", list(j['data'].keys()))
                    except Exception as e:
                        print("JSON error:", e)
                        print("First 200 chars:", repr(dec[:200]))
                except Exception as e:
                    print("Decompress error:", e)

