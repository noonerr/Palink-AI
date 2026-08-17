"""快速测试 ST REST API 是否可用。"""
import json
import urllib.request

ST_URL = "http://sillytavern:8000"

# Test 1: 创建角色卡
print("=== Test 1: Create character ===")
boundary = "----TestBoundary123"
fields = {
    "ch_name": "TestCapture",
    "description": "Test character for capture",
    "personality": "brave",
    "scenario": "test scenario",
    "first_mes": "Hello!",
    "mes_example": "",
    "creator_notes": "",
    "system_prompt": "",
    "post_history_instructions": "",
}
parts = []
for k, v in fields.items():
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n")
parts.append(f"--{boundary}--\r\n")
body = "".join(parts).encode("utf-8")

req = urllib.request.Request(
    f"{ST_URL}/api/characters/create",
    data=body,
    headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
)
try:
    with urllib.request.urlopen(req, timeout=10) as resp:
        result = resp.read().decode()
        print(f"Create result: {result}")
except Exception as e:
    print(f"Create failed: {e}")

# Test 2: 列出角色
print("\n=== Test 2: List characters ===")
req2 = urllib.request.Request(
    f"{ST_URL}/api/characters/all",
    data=b"{}",
    headers={"Content-Type": "application/json"},
)
try:
    with urllib.request.urlopen(req2, timeout=10) as resp2:
        chars = json.loads(resp2.read().decode())
        if isinstance(chars, dict):
            chars = chars.get("characters", [])
        names = [c.get("name") for c in chars] if isinstance(chars, list) else []
        print(f"Characters: {names}")
except Exception as e:
    print(f"List failed: {e}")

# Test 3: 保存聊天
print("\n=== Test 3: Save chat ===")
chat_data = [
    {"name": "TestCapture", "is_user": False, "is_system": False, "send_date": "2024-01-01T12:00:00Z", "mes": "Hello!", "swipe_id": 0, "swipes": [], "extra": {}},
    {"name": "GoldenUser", "is_user": True, "is_system": False, "send_date": "2024-01-01T12:01:00Z", "mes": "Hi there", "swipe_id": 0, "swipes": [], "extra": {}},
]
payload = {"avatar_url": "TestCapture.png", "chat": chat_data, "file_name": "TestCapture - 2024-01-01T12:00:00Z", "force": True}
req3 = urllib.request.Request(
    f"{ST_URL}/api/chats/save",
    data=json.dumps(payload).encode(),
    headers={"Content-Type": "application/json"},
)
try:
    with urllib.request.urlopen(req3, timeout=10) as resp3:
        result = resp3.read().decode()
        print(f"Save chat result: {result}")
except Exception as e:
    print(f"Save chat failed: {e}")

# Test 4: 删除角色
print("\n=== Test 4: Delete character ===")
req4 = urllib.request.Request(
    f"{ST_URL}/api/characters/delete",
    data=json.dumps({"avatar_url": "TestCapture.png"}).encode(),
    headers={"Content-Type": "application/json"},
)
try:
    with urllib.request.urlopen(req4, timeout=10) as resp4:
        result = resp4.read().decode()
        print(f"Delete result: {result}")
except Exception as e:
    print(f"Delete failed: {e}")

print("\n=== All tests done ===")
