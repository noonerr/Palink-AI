import requests
import json

resp = requests.post('http://localhost:8000/api/token', data={'username': 'admin', 'password': 'admin123'})
data = resp.json()
token = data.get('access_token', '')
print(token)
