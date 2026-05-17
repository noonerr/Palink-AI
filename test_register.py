import urllib.request
import json

data = json.dumps({"username": "testuser", "password": "Test1234"}).encode()
req = urllib.request.Request(
    "http://localhost:5000/api/auth/register",
    data=data,
    headers={"Content-Type": "application/json"},
    method="POST"
)
try:
    resp = urllib.request.urlopen(req)
    print(resp.read().decode())
except Exception as e:
    print(f"Error: {e}")
    if hasattr(e, "read"):
        print(e.read().decode())
