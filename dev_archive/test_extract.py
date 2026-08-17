import json
import struct
import zlib
from io import BytesIO

file_path = r"c:\Users\Pall\OneDrive\桌面\Palink-AI\eve_marie_clarke_the_rebellious_teen.png"

print(f"=== Testing extraction for: {file_path} ===")
print()

# First, just check if we can read the file
try:
    with open(file_path, "rb") as f:
        file_data = f.read()
    print(f"✓ File read successfully, size: {len(file_data)} bytes")
except Exception as e:
    print(f"✗ Failed to read file: {e}")
    exit(1)

# Now parse PNG chunks
print()
print("=== Parsing PNG chunks ===")
f = BytesIO(file_data)

header = f.read(8)
print(f"Header: {header.hex()}")

if header != b'\x89PNG\r\n\x1a\n':
    print("✗ Not a valid PNG file")
    exit(1)
print("✓ Valid PNG header")

chunks = []
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
    
    chunk_type_str = chunk_type.decode('ascii', errors='replace')
    chunks.append({
        'type': chunk_type_str,
        'length': length,
        'data': data
    })
    
    print(f"  Chunk: {chunk_type_str}, length: {length}")
    
    if chunk_type == b'IEND':
        break

print()
print(f"✓ Found {len(chunks)} chunks")

# Look for text chunks
print()
print("=== Looking for text chunks ===")
text_chunks = [c for c in chunks if c['type'] in ['tEXt', 'zTXt', 'iTXt']]
print(f"Found {len(text_chunks)} text chunks")

for i, chunk in enumerate(text_chunks):
    print()
    print(f"--- Text chunk {i+1}: {chunk['type']} ---")
    
    null_pos = chunk['data'].find(b'\x00')
    if null_pos != -1:
        try:
            keyword = chunk['data'][:null_pos].decode('utf-8', errors='replace')
            raw_data = chunk['data'][null_pos+1:]
            print(f"  Keyword: {keyword}")
            print(f"  Data length: {len(raw_data)} bytes")
            
            # Try to decode
            if chunk['type'] == 'zTXt':
                try:
                    decompressed = zlib.decompress(raw_data)
                    print(f"  ✓ Decompressed zTXt, size: {len(decompressed)}")
                    try:
                        result = json.loads(decompressed.decode('utf-8', errors='replace'))
                        print()
                        print("="*80)
                        print("SUCCESS! Extracted character card:")
                        print("="*80)
                        print(json.dumps(result, ensure_ascii=False, indent=2))
                        
                        # Show detailed fields
                        if 'data' in result and isinstance(result['data'], dict):
                            data = result['data']
                        else:
                            data = result
                        
                        print()
                        print("="*80)
                        print("Detailed fields:")
                        print("="*80)
                        for key in sorted(data.keys()):
                            value = data[key]
                            print(f"\n{key}:")
                            if isinstance(value, str):
                                if len(value) > 500:
                                    print(f"  (long text: {len(value)} chars)")
                                    print(f"  Preview: {value[:500]}...")
                                else:
                                    print(f"  {value}")
                            else:
                                print(f"  {value}")
                        
                    except Exception as e:
                        print(f"  JSON parse error: {e}")
                        print(f"  First 200 chars: {decompressed[:200]}")
                except Exception as e:
                    print(f"  zTXt decompress error: {e}")
            else:
                try:
                    text = raw_data.decode('utf-8', errors='replace')
                    print(f"  Text length: {len(text)}")
                    try:
                        result = json.loads(text)
                        print()
                        print("SUCCESS! Extracted character card:")
                        print(json.dumps(result, ensure_ascii=False, indent=2))
                    except:
                        print(f"  Not JSON, first 200 chars: {text[:200]}")
                except Exception as e:
                    print(f"  Decode error: {e}")
                    
        except Exception as e:
            print(f"  Error: {e}")

print()
print("=== Done ===")
