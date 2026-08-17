
from PIL import Image
import json
import struct
import zlib

def analyze_png_chunks(png_path):
    """分析 PNG 文件的所有块"""
    chunks = []
    with open(png_path, 'rb') as f:
        # 检查 PNG 头
        header = f.read(8)
        if header != b'\x89PNG\r\n\x1a\n':
            print("Not a valid PNG file")
            return chunks
        
        while True:
            # 读取块长度
            length_data = f.read(4)
            if len(length_data) &lt; 4:
                break
            length = struct.unpack('&gt;I', length_data)[0]
            
            # 读取块类型
            chunk_type = f.read(4)
            if len(chunk_type) &lt; 4:
                break
            
            # 读取块数据
            data = f.read(length)
            if len(data) &lt; length:
                break
            
            # 读取 CRC
            crc = f.read(4)
            
            chunks.append({
                'type': chunk_type.decode('ascii', errors='replace'),
                'length': length,
                'data': data
            })
            
            # 检查是否到达 IEND 块
            if chunk_type == b'IEND':
                break
    
    return chunks

def extract_silly_tavern_data(png_path):
    """尝试从 PNG 中提取 Silly Tavern 角色卡数据"""
    chunks = analyze_png_chunks(png_path)
    
    print(f"Found {len(chunks)} chunks:")
    for chunk in chunks:
        print(f"  - {chunk['type']} (length: {chunk['length']})")
    
    # 检查 tEXt 块
    text_chunks = [c for c in chunks if c['type'] == 'tEXt']
    print(f"\nFound {len(text_chunks)} tEXt chunks")
    
    for i, chunk in enumerate(text_chunks):
        try:
            # tEXt 块格式：keyword + 0x00 + data
            null_pos = chunk['data'].find(b'\x00')
            if null_pos != -1:
                keyword = chunk['data'][:null_pos].decode('utf-8', errors='replace')
                data = chunk['data'][null_pos+1:]
                print(f"\ntEXt chunk {i} keyword: {keyword}")
                print(f"Data length: {len(data)}")
                
                # 尝试解码为 JSON
                try:
                    json_data = json.loads(data.decode('utf-8'))
                    print("Successfully parsed as JSON!")
                    print(json.dumps(json_data, indent=2, ensure_ascii=False))
                    return json_data
                except Exception as e:
                    print(f"Not valid JSON: {e}")
                    # 尝试 zlib 解压
                    try:
                        decompressed = zlib.decompress(data)
                        print("Successfully decompressed with zlib!")
                        try:
                            json_data = json.loads(decompressed.decode('utf-8'))
                            print("Successfully parsed decompressed data as JSON!")
                            print(json.dumps(json_data, indent=2, ensure_ascii=False))
                            return json_data
                        except Exception as e2:
                            print(f"Decompressed data not valid JSON: {e2}")
                            print(f"Decompressed data (first 500 bytes): {decompressed[:500]}")
                    except Exception as e2:
                        print(f"Not zlib compressed: {e2}")
                        print(f"Raw data (first 500 bytes): {data[:500]}")
        except Exception as e:
            print(f"Error processing tEXt chunk {i}: {e}")
    
    # 检查 iTXt 块
    itxt_chunks = [c for c in chunks if c['type'] == 'iTXt']
    print(f"\nFound {len(itxt_chunks)} iTXt chunks")
    
    for i, chunk in enumerate(itxt_chunks):
        try:
            print(f"\niTXt chunk {i} data (first 500 bytes): {chunk['data'][:500]}")
        except Exception as e:
            print(f"Error processing iTXt chunk {i}: {e}")
    
    return None

if __name__ == "__main__":
    png_path = r"c:\Users\Pall\OneDrive\桌面\Palink-AI\eve_marie_clarke_the_rebellious_teen.png"
    data = extract_silly_tavern_data(png_path)
    
    if data:
        print("\n✓ Successfully extracted character card data!")
    else:
        print("\n✗ Could not extract character card data from PNG")
