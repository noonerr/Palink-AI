
import sys
sys.path.insert(0, '/app')

from app.character_card import extract_chara_card_from_png

with open('/tmp/test_card.png', 'rb') as f:
    png_data = f.read()

result = extract_chara_card_from_png(png_data)
if result:
    print("SUCCESS!")
    import json
    print(json.dumps(result, indent=2))
else:
    print("FAILED!")

