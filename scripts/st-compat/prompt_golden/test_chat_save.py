"""测试 ST 聊天保存和加载是否正确。"""
import urllib.request
import json

ST_URL = "http://sillytavern:8000"

# 1. 创建测试角色
fields = {
    "ch_name": "ChatTest_Char",
    "description": "Test desc",
    "personality": "Test personality",
    "scenario": "Test scenario",
    "first_mes": "First message from character",
    "mes_example": "",
    "creator_notes": "", "system_prompt": "", "post_history_instructions": "",
}
boundary = "----Boundary7MA4YWxkTrZu0gW"
parts = []
for k, v in fields.items():
    parts.append("--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + k + "\"\r\n\r\n" + v + "\r\n")
parts.append("--" + boundary + "--\r\n")
body = "".join(parts).encode()
req = urllib.request.Request(
    ST_URL + "/api/characters/create", data=body,
    headers={"Content-Type": "multipart/form-data; boundary=" + boundary},
)
resp = urllib.request.urlopen(req, timeout=15)
avatar = resp.read().decode().strip('"')
print("Created avatar:", avatar)

# 2. 保存聊天（含多条消息）
chat_data = [
    {"name": "ChatTest_Char", "is_user": False, "is_system": False,
     "send_date": "2024-01-01T12:00:00Z", "mes": "First message from character",
     "swipe_id": 0, "swipes": [], "extra": {}},
    {"name": "User", "is_user": True, "is_system": False,
     "send_date": "2024-01-01T12:01:00Z", "mes": "User message 1",
     "swipe_id": 0, "swipes": [], "extra": {}},
    {"name": "ChatTest_Char", "is_user": False, "is_system": False,
     "send_date": "2024-01-01T12:02:00Z", "mes": "Assistant reply 1",
     "swipe_id": 0, "swipes": [], "extra": {}},
]
chat_body = json.dumps({
    "avatar_url": avatar, "chat": chat_data,
    "file_name": "ChatTest_Char - 2024-01-01T12:00:00Z", "force": True,
}).encode()
req2 = urllib.request.Request(
    ST_URL + "/api/chats/save", data=chat_body,
    headers={"Content-Type": "application/json"},
)
resp2 = urllib.request.urlopen(req2, timeout=15)
print("Save chat result:", resp2.read().decode()[:200])

# 3. 获取角色聊天列表
req3 = urllib.request.Request(
    ST_URL + "/api/characters/chats",
    data=json.dumps({"avatar_url": avatar}).encode(),
    headers={"Content-Type": "application/json"},
)
resp3 = urllib.request.urlopen(req3, timeout=15)
chats = json.loads(resp3.read().decode())
print("Chat list type:", type(chats).__name__)
if isinstance(chats, list):
    for c in chats[:5]:
        fname = c.get("file_name", c.get("name", "?"))
        print("  Chat file:", fname)
elif isinstance(chats, dict):
    for k, v in chats.items():
        print("  Key:", k, "| type:", type(v).__name__)
        if isinstance(v, list):
            for item in v[:3]:
                if isinstance(item, dict):
                    print("    file_name:", item.get("file_name", "?"))
                else:
                    print("    Item:", str(item)[:100])

# 4. 获取聊天内容
req4 = urllib.request.Request(
    ST_URL + "/api/chats/get",
    data=json.dumps({
        "avatar_url": avatar,
        "file_name": "ChatTest_Char - 2024-01-01T12:00:00Z",
    }).encode(),
    headers={"Content-Type": "application/json"},
)
resp4 = urllib.request.urlopen(req4, timeout=15)
chat_content = json.loads(resp4.read().decode())
if isinstance(chat_content, dict):
    msgs = chat_content.get("messages", chat_content.get("chat", []))
    print("Chat content messages count:", len(msgs) if isinstance(msgs, list) else "N/A")
    if isinstance(msgs, list):
        for m in msgs[:5]:
            mes = m.get("mes", "")
            print("  is_user=%s | %s" % (m.get("is_user"), mes[:60]))

# 清理
del_body = json.dumps({"avatar_url": avatar, "delete_chats": True}).encode()
req5 = urllib.request.Request(
    ST_URL + "/api/characters/delete", data=del_body,
    headers={"Content-Type": "application/json"},
)
try:
    urllib.request.urlopen(req5, timeout=15)
    print("Cleaned up")
except Exception as e:
    print("Clean err:", e)
