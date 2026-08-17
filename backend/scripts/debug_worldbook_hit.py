"""Focused debug script — investigate worldbook hit & author note injection."""
from __future__ import annotations

import json
import time
import urllib.request
import urllib.error
from urllib.parse import urlencode

BASE_URL = "http://localhost:8000"


def http_request(method, path, *, token=None, body=None, form=None, files=None, timeout=60):
    url = f"{BASE_URL}{path}"
    headers = {"Accept": "application/json"}
    data = None
    if form:
        data = urlencode(form).encode("utf-8")
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    elif files:
        boundary = "----debugboundary" + str(int(time.time() * 1000))
        parts = []
        for field, (filename, content) in files.items():
            parts.append(f"--{boundary}\r\n".encode())
            parts.append(f'Content-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'.encode())
            parts.append(b"Content-Type: application/json\r\n\r\n")
            parts.append(content)
            parts.append(b"\r\n")
        parts.append(f"--{boundary}--\r\n".encode())
        data = b"".join(parts)
        headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
    elif body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            try:
                return resp.status, json.loads(raw.decode("utf-8"))
            except Exception:
                return resp.status, raw.decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw.decode("utf-8"))
        except Exception:
            return e.code, raw.decode("utf-8", errors="replace")


def stream_request(method, path, *, token=None, body=None, timeout=120):
    url = f"{BASE_URL}{path}"
    headers = {"Accept": "text/event-stream"}
    data = json.dumps(body).encode("utf-8") if body is not None else None
    if data:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    events = []
    full_text = ""
    status = 0
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status = resp.status
            for raw_line in resp:
                line = raw_line.decode("utf-8", errors="replace").rstrip("\n")
                if not line:
                    continue
                if line.startswith("data:"):
                    payload = line[5:].strip()
                    try:
                        evt = json.loads(payload)
                        events.append(evt)
                        if "delta" in evt:
                            full_text += evt["delta"]
                        elif "token" in evt:
                            full_text += evt["token"]
                    except json.JSONDecodeError:
                        full_text += payload
    except urllib.error.HTTPError as e:
        status = e.code
        full_text = e.read().decode("utf-8", errors="replace")
    except Exception as exc:
        full_text = f"<stream error: {exc}>"
    return status, full_text, events


def main():
    # Login
    status, resp = http_request("POST", "/api/token", form={"username": "admin", "password": "admin123"})
    token = resp["access_token"]
    print(f"Logged in, token len={len(token)}")

    # 1) Create character with macros
    char_body = {
        "name": "DbgTestChar",
        "description": "{{char}} 是一位剑客，誓死守护 {{user}}。",
        "personality": "{{char}} 性格冷静。",
        "scenario": "在雪原上。",
        "first_mes": "（{{char}} 收剑）「你来了。」",
        "mes_example": "<START>\n{{user}}: 走。\n{{char}}: 嗯。",
    }
    status, resp = http_request("POST", "/api/characters", token=token, body=char_body)
    char_id = resp["character"]["id"]
    print(f"Character created: {char_id}")

    # 2) Create worldbook with constant + selective
    wb_payload = {
        "name": "DbgTestWorld",
        "description": "debug worldbook",
        "entries": {
            "0": {
                "uid": 0,
                "key": ["龙脊山脉"],
                "keysecondary": [],
                "comment": "dbg_constant",
                "content": "[DBG_CONSTANT] 龙脊山脉海拔 4000 米。{{char}} 守护 {{user}}。",
                "constant": True,
                "selective": True,
                "selectiveLogic": 0,
                "order": 100,
                "position": 4,
                "disable": False,
                "probability": 100,
                "useProbability": True,
                "displayIndex": 0,
                "scanDepth": 4,
            },
            "1": {
                "uid": 1,
                "key": ["篝火"],
                "keysecondary": [],
                "comment": "dbg_selective",
                "content": "[DBG_SELECTIVE] {{user}} 拾来干柴，{{char}} 点燃篝火。",
                "constant": False,
                "selective": True,
                "selectiveLogic": 0,
                "order": 50,
                "position": 4,
                "disable": False,
                "probability": 100,
                "useProbability": True,
                "displayIndex": 1,
                "scanDepth": 4,
            },
        },
    }
    wb_bytes = json.dumps(wb_payload).encode("utf-8")
    status, resp = http_request(
        "POST", "/api/worldbooks/import", token=token, files={"file": ("dbg.json", wb_bytes)}
    )
    print(f"Worldbook import: status={status}")
    print(f"  Response keys: {list(resp.keys()) if isinstance(resp, dict) else type(resp)}")
    print(f"  stage_count: {resp.get('stage_count') if isinstance(resp, dict) else 'N/A'}")
    print(f"  id: {resp.get('id') if isinstance(resp, dict) else 'N/A'}")
    wb_id = resp.get("id")
    print(f"  full resp: {json.dumps(resp, ensure_ascii=False)[:500]}")

    # 3) Query worldbook detail to verify stages
    status, resp = http_request("GET", f"/api/worldbooks/{wb_id}", token=token)
    print(f"\nWorldbook detail: status={status}")
    print(f"  name: {resp.get('name')}")
    print(f"  type: {resp.get('type')}")
    print(f"  character_id: {resp.get('character_id')}")
    print(f"  is_parsed: {resp.get('is_parsed')}")
    stages = resp.get("stages", [])
    print(f"  stages count: {len(stages)}")
    for s in stages:
        print(f"    - stage {s.get('stage_index')}: title={s.get('title')} constant={s.get('constant')} selective={s.get('selective')} keys={s.get('keys')}")

    # 4) Set author note
    http_request(
        "PUT",
        "/api/users/me/settings",
        token=token,
        body={
            "author_note": "[DBG_AUTHOR_NOTE] 节奏缓慢。",
            "author_note_position": 1,
            "author_note_depth": 4,
            "author_note_frequency": 1,
        },
    )
    print("\nAuthor note set")

    # 5) Init session
    init_body = {
        "character_id": char_id,
        "message": "__INIT__",
        "model": "deepseek-v4-flash",
        "session_id": None,
    }
    status, full_text, events = stream_request(
        "POST", "/api/character-chat", token=token, body=init_body, timeout=60
    )
    session_id = None
    for evt in events:
        if evt.get("session_id"):
            session_id = evt["session_id"]
            break
    print(f"\nSession created: {session_id}")

    # 6) Append user message with keyword
    http_request(
        "POST",
        f"/api/character-sessions/{session_id}/messages",
        token=token,
        body={"content": "我们去捡柴火生篝火吧，远处的龙脊山脉看起来很冷。", "role": "user", "is_user": True},
    )
    print("User message appended")

    # 7) Debug prompt assembly
    debug_body = {
        "message": "篝火生好了。",
        "model": "deepseek-v4-flash",
        "dialogue_mode": "first_person",
        "max_tokens": 1024,
    }
    status, resp = http_request(
        "POST",
        f"/api/character-sessions/{session_id}/debug-prompt-assembly",
        token=token,
        body=debug_body,
        timeout=60,
    )
    print(f"\nDebug prompt assembly: status={status}")
    assembly = resp.get("assembly", {})
    report = assembly.get("report", [])
    print(f"  Report items: {len(report)}")
    for r in report:
        print(f"    - {r.get('key')}: {r.get('status')} | {r.get('detail', '')[:150]}")

    print(f"\n  message_count: {assembly.get('message_count')}")
    print(f"  dynamic_context_count: {assembly.get('dynamic_context_count')}")
    print(f"  total_tokens_estimate: {assembly.get('total_tokens_estimate')}")

    # Print all messages preview
    messages_preview = resp.get("messages_preview", [])
    print(f"\n  Messages preview ({len(messages_preview)}):")
    for i, m in enumerate(messages_preview):
        content = (m.get("content_preview") or "")
        print(f"    [{i}] role={m.get('role')}: {content[:200]}")

    # Search for worldbook content
    full_prompt_text = "\n".join(m.get("content_preview", "") for m in messages_preview)
    print(f"\n  DBG_CONSTANT in prompt: {'DBG_CONSTANT' in full_prompt_text}")
    print(f"  DBG_SELECTIVE in prompt: {'DBG_SELECTIVE' in full_prompt_text}")
    print(f"  DBG_AUTHOR_NOTE in prompt: {'DBG_AUTHOR_NOTE' in full_prompt_text}")
    print(f"  leftover {{user}}: {'{{user}}' in full_prompt_text}")
    print(f"  leftover {{char}}: {'{{char}}' in full_prompt_text}")

    # Cleanup
    print("\n=== Cleanup ===")
    http_request("DELETE", f"/api/character-sessions/{session_id}", token=token)
    http_request("DELETE", f"/api/characters/{char_id}", token=token)
    http_request("DELETE", f"/api/worldbooks/{wb_id}", token=token)
    http_request(
        "PUT",
        "/api/users/me/settings",
        token=token,
        body={"author_note": "", "author_note_position": 1, "author_note_depth": 4, "author_note_frequency": 0},
    )
    print("Cleanup done")


if __name__ == "__main__":
    main()
