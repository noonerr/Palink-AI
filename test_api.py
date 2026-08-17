import requests
import json

resp = requests.post('http://localhost:8000/api/token', data={'username': 'admin', 'password': 'admin123'})
print('Login response:', resp.status_code)
data = resp.json()
token = data.get('access_token', '')
print('Token:', token[:20] + '...' if token else 'NONE')

if not token:
    print('Login failed, response:', data)
    exit(1)

headers = {'Authorization': f'Bearer {token}'}
char_id = '470076ba-9a92-442b-884a-8905af7bcb1d'

resp2 = requests.get(f'http://localhost:8000/api/worldbooks?character_id={char_id}', headers=headers)
print('WorldBooks response:', resp2.status_code)
wb_data = resp2.json()
print('WorldBooks count:', len(wb_data))
print('WorldBooks data:', json.dumps(wb_data, indent=2, ensure_ascii=False)[:2000])

resp3 = requests.get('http://localhost:8000/api/characters', headers=headers)
print('Characters response:', resp3.status_code)
chars = resp3.json()
for c in chars:
    if c.get('has_character_book'):
        print(f'  Character with book: id={c["id"]}, name={c["name"]}, has_character_book={c["has_character_book"]}')
