
import struct
import zlib
import json
from io import BytesIO

def analyze_png(file_path):
    print(f"正在分析文件: {file_path}\n")
    
    with open(file_path, 'rb') as f:
        png_data = f.read()
    
    f = BytesIO(png_data)
    
    header = f.read(8)
    if header != b'\x89PNG\r\n\x1a\n':
        print("❌ 不是有效的PNG文件")
        return
    
    print("✅ PNG文件头验证通过\n")
    
    chunks = []
    text_chunks = []
    
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
            'length': length,
            'data': data
        })
        
        if chunk_type_str in ['tEXt', 'zTXt', 'iTXt']:
            text_chunks.append({
                'type': chunk_type_str,
                'length': length,
                'data': data
            })
        
        if chunk_type == b'IEND':
            break
    
    print(f"📊 总共有 {len(chunks)} 个chunk")
    print(f"📝 文本chunk数量: {len(text_chunks)}\n")
    
    print("=== 所有Chunk列表 ===")
    for i, chunk in enumerate(chunks):
        print(f"  [{i+1}] {chunk['type']} - {chunk['length']} 字节")
    
    print("\n=== 文本Chunk详细信息 ===")
    
    supported_keywords = ['chara', 'character', 'tavern', 'chara_card']
    
    for i, chunk in enumerate(text_chunks):
        print(f"\n--- 文本Chunk {i+1} ({chunk['type']}) ---")
        
        null_pos = chunk['data'].find(b'\x00')
        if null_pos != -1:
            keyword = chunk['data'][:null_pos].decode('utf-8', errors='replace')
            print(f"  关键词: {keyword}")
            print(f"  关键词小写: {keyword.lower()}")
            print(f"  是否在支持列表中: {keyword.lower() in supported_keywords}")
            
            raw_data = chunk['data'][null_pos+1:]
            print(f"  数据长度: {len(raw_data)} 字节")
            
            if chunk['type'] == 'zTXt':
                print("  类型: zTXt (压缩)")
                try:
                    decompressed = zlib.decompress(raw_data)
                    print(f"  ✅ 解压成功! 解压后长度: {len(decompressed)}")
                    try:
                        json_data = json.loads(decompressed.decode('utf-8', errors='replace'))
                        print(f"  ✅ JSON解析成功!")
                        print(f"  数据键: {list(json_data.keys()) if isinstance(json_data, dict) else '不是字典'}")
                        if isinstance(json_data, dict) and 'data' in json_data:
                            print(f"  data键存在! data的键: {list(json_data['data'].keys()) if isinstance(json_data['data'], dict) else '不是字典'}")
                    except Exception as e:
                        print(f"  ❌ JSON解析失败: {e}")
                        print(f"  前200字符: {decompressed[:200]}")
                except Exception as e:
                    print(f"  ❌ 解压失败: {e}")
            elif chunk['type'] == 'iTXt':
                print("  类型: iTXt (国际文本)")
                try:
                    parts = raw_data.split(b'\x00', 2)
                    if len(parts) &gt;= 3:
                        compressed_flag = parts[0]
                        lang_flag = parts[1]
                        text_data = parts[2]
                        print(f"  压缩标志: {compressed_flag}")
                        print(f"  语言标志: {lang_flag}")
                        if compressed_flag == b'\x01':
                            decompressed = zlib.decompress(text_data)
                            print(f"  ✅ 解压成功! 长度: {len(decompressed)}")
                            try:
                                json_data = json.loads(decompressed.decode('utf-8', errors='replace'))
                                print(f"  ✅ JSON解析成功!")
                            except Exception as e:
                                print(f"  ❌ JSON解析失败: {e}")
                except Exception as e:
                    print(f"  ❌ 处理失败: {e}")
            else:
                print("  类型: tEXt (普通文本)")
                try:
                    try:
                        decompressed = zlib.decompress(raw_data)
                        print(f"  ✅ 解压成功!")
                        try:
                            json_data = json.loads(decompressed.decode('utf-8', errors='replace'))
                            print(f"  ✅ JSON解析成功!")
                        except Exception as e:
                            print(f"  ❌ JSON解析失败: {e}")
                    except:
                        text_content = raw_data.decode('utf-8', errors='replace')
                        print(f"  文本内容长度: {len(text_content)}")
                        try:
                            json_data = json.loads(text_content)
                            print(f"  ✅ JSON解析成功!")
                        except Exception as e:
                            print(f"  ❌ JSON解析失败: {e}")
                except Exception as e:
                    print(f"  ❌ 处理失败: {e}")
    
    print("\n=== 分析完成 ===")

if __name__ == "__main__":
    analyze_png(r"c:\Users\Pall\OneDrive\桌面\Palink-AI\Koseki Bijou 🗿✨.png")

