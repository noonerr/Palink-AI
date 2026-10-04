"""真机验收脚本：新建会话连跑 N 轮，只打印 id 与协议标签计数，不回显正文。

用法（在仓库根执行）：
    py -3 backend/scripts/_accept_mvu_realrun.py [已有session_id]

Token 由脚本自己在后端容器内用 create_access_token 现场签发，不落盘任何 JWT。
"""

import json
import subprocess
import sys
import urllib.error
import urllib.request

BASE = "http://localhost:14000"
CHAR_ID = "c44f2ae6-5922-454d-8069-06ba48dc4408"  # 重导入后的 露缇雅1.2
MODEL = "deepseek-v4-flash"

TURNS = [
    "我揉了揉她的头发，问她今天早上想吃什么。",
    "我陪她在阳台晒了会儿太阳，说以后每天都会这样陪着她。",
    "她靠在我身上睡着了，我把外套给她盖上，顺手摸了摸她的尾巴。",
]


def mint_token() -> str:
    cmd = ["docker", "cp", "backend/scripts/_mint_token_inline.py",
           "palink-ai-backend-1:/tmp/_mint.py"]
    subprocess.run(cmd, check=True, capture_output=True)
    out = subprocess.run(
        ["docker", "exec", "-e", "PYTHONPATH=/app", "palink-ai-backend-1",
         "sh", "-c", "cd /app && python /tmp/_mint.py"],
        capture_output=True, text=True, check=True,
    ).stdout
    for line in out.splitlines():
        if line.startswith("TOKEN="):
            return line.split("=", 1)[1].strip()
    raise RuntimeError("未能签发 token；容器输出：\n" + out[-500:])


def send(token: str, message: str, session_id=None):
    body = {
        "character_id": CHAR_ID,
        "message": message,
        "model": MODEL,
        "max_tokens": 800,
        "extension_prompts": [],
    }
    if session_id:
        body["session_id"] = session_id
    req = urllib.request.Request(
        BASE + "/api/character-chat",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        },
        method="POST",
    )
    sid = session_id
    deltas = 0
    tag_counts = {"UpdateVariable": 0, "JSONPatch": 0, "status>": 0}
    try:
        with urllib.request.urlopen(req, timeout=900) as resp:
            for raw in resp:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if not payload or payload == "[DONE]":
                    continue
                try:
                    obj = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                if isinstance(obj, dict):
                    if obj.get("session_id") and not sid:
                        sid = obj["session_id"]
                    err = obj.get("error") or obj.get("detail")
                    if err:
                        print(f"  [后端返回错误] {str(err)[:200]}")
                        break
                    text = obj.get("content") or obj.get("delta") or ""
                    if isinstance(text, str) and text:
                        deltas += 1
                        for key in tag_counts:
                            tag_counts[key] += text.count(key)
                elif isinstance(obj, str):
                    deltas += 1
                    for key in tag_counts:
                        tag_counts[key] += obj.count(key)
    except urllib.error.HTTPError as e:
        body_txt = e.read().decode("utf-8", "replace")[:300]
        print(f"  [HTTP {e.code}] {body_txt}")
    return sid, deltas, tag_counts


def main() -> int:
    token = mint_token()
    print("token 已现场签发（不落盘）")
    sid = sys.argv[1] if len(sys.argv) > 1 else None
    for i, msg in enumerate(TURNS, 1):
        sid, deltas, tags = send(token, msg, sid)
        print(f"turn={i} session_id={sid} delta_chunks={deltas} tag_counts={tags}")
    if deltas == 0:
        print("提示：delta_chunks=0 通常是网关额度不足（查后端日志 insufficient_user_quota），"
              "不是脚本或代码问题。")
    return 0


if __name__ == "__main__":
    sys.exit(main())