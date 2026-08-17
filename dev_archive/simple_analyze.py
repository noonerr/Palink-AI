
import struct
import sys
import io

def main():
    file_path = r"c:\Users\Pall\OneDrive\桌面\Palink-AI\Koseki Bijou 🗿✨.png"
    
    try:
        with open(file_path, 'rb') as f:
            data = f.read()
        
        print("File size:", len(data), "bytes")
        
        # Check PNG header
        header = data[0:8]
        print("Header:", header.hex())
        
        if header != b'\x89PNG\r\n\x1a\n':
            print("Not a PNG file!")
            return
        
        print("Valid PNG header")
        
        # Parse chunks
        offset = 8
        chunks = []
        
        while offset &lt; len(data):
            # Read length
            length = struct.unpack('&gt;I', data[offset:offset+4])[0]
            offset += 4
            
            # Read type
            chunk_type = data[offset:offset+4]
            offset += 4
            
            # Read data
            chunk_data = data[offset:offset+length]
            offset += length
            
            # Read CRC
            crc = data[offset:offset+4]
            offset += 4
            
            chunks.append((chunk_type, length, chunk_data))
            
            print("Chunk:", chunk_type.decode('ascii', errors='replace'), "length:", length)
            
            if chunk_type == b'IEND':
                break
        
        # Check text chunks
        print("\nText chunks:")
        for chunk_type, length, chunk_data in chunks:
            if chunk_type in [b'tEXt', b'zTXt', b'iTXt']:
                print("\nFound text chunk:", chunk_type.decode('ascii'))
                print("Length:", length)
                
                # Try to find null byte
                null_pos = chunk_data.find(b'\x00')
                if null_pos != -1:
                    keyword = chunk_data[:null_pos]
                    print("Keyword:", keyword.decode('utf-8', errors='replace'))
                    
                    # Save raw data to file for inspection
                    with open('raw_chunk.bin', 'wb') as f:
                        f.write(chunk_data[null_pos+1:])
                    print("Raw data saved to raw_chunk.bin")
        
    except Exception as e:
        print("Error:", str(e))
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    main()

