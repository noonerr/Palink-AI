# -*- coding: utf-8 -*-
"""ST 兼容度审查辅助脚本：登录 → 导入 Seraphina 卡 → 导出 → 字段对照（只读审查用）。"""
import json
import sys
import urllib.request
import urllib.error
import uuid

# [PENTEST-2026-09-02] 凭据不再硬编码：从环境变量 / 本目录 .env（gitignored）读取
from _credentials import BASE, USER, PASSWORD  # noqa: E402

CARD = r"d:\项目\Palink-AI\scripts\st_audit_seraphina.png"


def req(method: str, path: str, token: str | None = None, data: dict | None = None,
        raw: bytes | None = None, content_type: str | None = None):
    url = BASE + path
    headers = {}
    body = None
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        headers["Content-Type"] = "application/json"
    elif raw is not None:
        body = raw
        headers["Content-Type"] = content_type or "application/octet-stream"
    r = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r) as resp:
            payload = resp.read()
            try:
                return resp.status, json.loads(payload)
            except Exception:
                return resp.status, payload
    except urllib.error.HTTPError as e:
        payload = e.read()
        try:
            return e.code, json.loads(payload)
        except Exception:
            return e.code, payload


def multipart(path: str, token: str, field: str, filename: str, filebytes: bytes,
              mime: str, extra_fields: dict | None = None):
    boundary = uuid.uuid4().hex
    parts = []
    for k, v in (extra_fields or {}).items():
        parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode())
    parts.append(
        (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"; "
         f"filename=\"{filename}\"\r\nContent-Type: {mime}\r\n\r\n").encode())
    parts.append(filebytes)
    parts.append(f"\r\n--{boundary}--\r\n".encode())
    body = b"".join(parts)
    return req("POST", path, token=token, raw=body,
               content_type=f"multipart/form-data; boundary={boundary}")


def main() -> int:
    # 1. 登录
    st, login = req("POST", "/api/token",
                    data=None,
                    raw=f"username={USER}&password={PASSWORD}".encode(),
                    content_type="application/x-www-form-urlencoded")
    token = login.get("access_token") if isinstance(login, dict) else None
    print(f"[login] status={st} token={'OK' if token else 'MISSING'}")
    if not token:
        print(login)
        return 1

    # 2. 导入 Seraphina 卡
    with open(CARD, "rb") as f:
        card_bytes = f.read()
    st, imp = multipart("/api/characters/import", token, "file",
                        "default_Seraphina.png", card_bytes, "image/png")
    print(f"[import] status={st}")
    print(json.dumps(imp, ensure_ascii=False, indent=1)[:2000])

    # 3. 角色列表
    st, chars = req("GET", "/api/characters", token=token)
    if isinstance(chars, list) and chars:
        ch = chars[0]
        cid = ch.get("id")
        print(f"[list] status={st} count={len(chars)} first_id={cid} name={ch.get('name')}")
        # 4. 导出 V2 卡并核对关键字段
        st, exported = req("GET", f"/api/characters/{cid}/export", token=token)
        print(f"[export] status={st} bytes={len(exported) if isinstance(exported, bytes) else 'json'}")
        if isinstance(exported, bytes):
            # PNG：提取 chara chunk 不方便，直接报告
            print("[export] PNG binary (含 chara/ccv3 chunk，解析略)")
        elif isinstance(exported, dict):
            data = exported.get("data", exported)
            for k in ["name", "description", "personality", "scenario", "first_mes",
                      "mes_example", "system_prompt", "post_history_instructions",
                      "alternate_greetings", "creator_notes", "character_book"]:
                v = data.get(k)
                preview = (json.dumps(v, ensure_ascii=False)[:120] if v is not None else "None")
                print(f"  {k}: {preview}")
    else:
        print(f"[list] status={st} body={str(chars)[:500]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
