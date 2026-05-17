import urllib.request
import json

data = json.dumps({"username": "testuser", "password": "Test1234"}).encode()
req = urllib.request.Request(
    "http://localhost:5000/api/auth/login",
    data=data,
    headers={"Content-Type": "application/json"},
    method="POST"
)
try:
    resp = urllib.request.urlopen(req)
    result = json.loads(resp.read().decode())
    print("Login OK:", result.get("message"))
    print("Username:", result.get("user", {}).get("username"))
    print("Token:", result.get("user", {}).get("token"))
    print("JWT length:", len(result.get("access_token", "")))
except Exception as e:
    print(f"Error: {e}")
    if hasattr(e, "read"):
        print(e.read().decode())
