"""Verify worldbook entries match via direct service call (bypassing palink_injection bug)."""
from __future__ import annotations

import json
import sys
import time
import urllib.request
import urllib.error
from urllib.parse import urlencode

sys.path.insert(0, "/app")

BASE_URL = "http://localhost:8000"


def http_request(method, path, *, token=None, body=None, form=None, files=None, timeout=60):
    url = f"{BASE_URL}{path}"
    headers = {"Accept": "application/json"}
    data = None
    if form:
        data = urlencode(form).encode("utf-8")
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    elif files:
        boundary = "----wbverify" + str(int(time.time() * 1000))
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


def main():
    # Login
    status, resp = http_request("POST", "/api/token", form={"username": "admin", "password": "admin123"})
    token = resp["access_token"]

    # Get user id
    status, resp = http_request("GET", "/api/users/me", token=token)
    user_id = resp["id"]
    print(f"User id: {user_id}")

    # Create character
    char_body = {
        "name": "WbVerifyChar",
        "description": "{{char}} 守护 {{user}}。",
        "first_mes": "「你来了。」",
    }
    status, resp = http_request("POST", "/api/characters", token=token, body=char_body)
    char_id = resp["character"]["id"]
    print(f"Character: {char_id}")

    # Create worldbook with constant + selective
    wb_payload = {
        "name": "WbVerifyWorld",
        "entries": {
            "0": {
                "uid": 0,
                "key": ["龙脊山脉"],
                "comment": "verify_constant",
                "content": "[VERIFY_CONSTANT] 龙脊山脉海拔 4000 米。{{char}} 守护 {{user}}。",
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
                "comment": "verify_selective",
                "content": "[VERIFY_SELECTIVE] {{user}} 拾柴，{{char}} 生火。",
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
        "POST", "/api/worldbooks/import", token=token, files={"file": ("wb_verify.json", wb_bytes)}
    )
    wb_id = resp["id"]
    print(f"Worldbook: {wb_id}, stage_count: {resp.get('stage_count')}")

    # Init session via API
    init_body = {
        "character_id": char_id,
        "message": "__INIT__",
        "model": "deepseek-v4-flash",
        "session_id": None,
    }
    req = urllib.request.Request(
        f"{BASE_URL}/api/character-chat",
        data=json.dumps(init_body).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        },
    )
    session_id = None
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            for raw in r:
                line = raw.decode("utf-8", errors="replace").rstrip()
                if line.startswith("data:"):
                    try:
                        evt = json.loads(line[5:].strip())
                        if evt.get("session_id"):
                            session_id = evt["session_id"]
                            break
                    except json.JSONDecodeError:
                        pass
    except Exception as exc:
        print(f"stream error: {exc}")
    print(f"Session: {session_id}")

    if not session_id:
        print("FAIL: no session")
        return

    # Append user message containing both keywords
    http_request(
        "POST",
        f"/api/character-sessions/{session_id}/messages",
        token=token,
        body={"content": "远处的龙脊山脉好冷，我们去生篝火吧。", "role": "user", "is_user": True},
    )

    # Now directly call build_worldbook_context using the app's DB session
    from app.core import SessionLocal
    from app.models import User, Character
    from app.services.worldbook_service import build_worldbook_context

    db = SessionLocal()
    try:
        user = db.query(User).filter(User.id == user_id).first()
        char = db.query(Character).filter(Character.id == char_id).first()

        recent_messages = [
            {"role": "user", "content": "远处的龙脊山脉好冷，我们去生篝火吧。"},
        ]

        result = build_worldbook_context(
            db=db,
            session_id=session_id,
            user_id=user_id,
            recent_messages=recent_messages,
            character=char,
        )

        print(f"\n=== build_worldbook_context result ===")
        print(f"text is None: {result.text is None}")
        print(f"text preview: {(result.text or '')[:500]}")
        print(f"total_tokens: {result.total_tokens}")
        print(f"budget_used: {result.budget_used}")
        print(f"depth_entries count: {len(result.depth_entries)}")
        print(f"\ndebug_report ({len(result.debug_report)} items):")
        for r in result.debug_report:
            print(f"  - entry_id={r.entry_id} title={r.title} status={r.status} reason={r.reason}")
            print(f"    matched_keywords={r.matched_keywords}")

        # Verify
        constant_activated = any(
            r.status == "activated" and "verify_constant" in (r.title or "")
            for r in result.debug_report
        )
        selective_activated = any(
            r.status == "activated" and "verify_selective" in (r.title or "")
            for r in result.debug_report
        )
        # depth_entries 是 list[tuple[int, str, int]] (depth, content, role) — ST position=4 (@D at depth) 的条目
        depth_text = "\n".join(content for _, content, _ in result.depth_entries)
        constant_in_text = "VERIFY_CONSTANT" in (result.text or "") or "VERIFY_CONSTANT" in depth_text
        selective_in_text = "VERIFY_SELECTIVE" in (result.text or "") or "VERIFY_SELECTIVE" in depth_text

        print(f"\n=== Verification ===")
        print(f"constant_activated: {constant_activated}")
        print(f"selective_activated: {selective_activated}")
        print(f"constant_in_text: {constant_in_text}")
        print(f"selective_in_text: {selective_in_text}")
        print(f"depth_entries preview:")
        for d, c, r in result.depth_entries:
            print(f"  depth={d} role={r}: {c[:120]}")

        if constant_activated and selective_activated and constant_in_text and selective_in_text:
            print("\n✅ PASS: Worldbook entries correctly activated and injected (as depth_entries)")
        else:
            print("\n❌ FAIL: Worldbook entries not correctly activated")

    finally:
        db.close()

    # Cleanup
    http_request("DELETE", f"/api/character-sessions/{session_id}", token=token)
    http_request("DELETE", f"/api/characters/{char_id}", token=token)
    http_request("DELETE", f"/api/worldbooks/{wb_id}", token=token)
    print("\nCleanup done")


if __name__ == "__main__":
    main()
