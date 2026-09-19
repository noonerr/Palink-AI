# -*- coding: utf-8 -*-
"""对比 Palink 导入后的 Eldoria 世界书条目 vs ST 原版 JSON（只读审查）。"""
import json
import urllib.request

# [PENTEST-2026-09-02] 凭据不再硬编码：从环境变量 / 本目录 .env（gitignored）读取
from _credentials import BASE, USER, PASSWORD  # noqa: E402

ST_ORIG = r"d:\项目\Palink-AI\SillyTavern-1.18.0\SillyTavern-1.18.0\default\content\Eldoria.json"


def req(method, path, token=None, data=None):
    headers = {}
    body = None
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if data is not None:
        body = json.dumps(data).encode()
        headers["Content-Type"] = "application/json"
    r = urllib.request.Request(BASE + path, data=body, headers=headers, method=method)
    with urllib.request.urlopen(r) as resp:
        return json.loads(resp.read())


# 登录
import urllib.parse
r = urllib.request.Request(BASE + "/api/token",
                           data=urllib.parse.urlencode({"username": USER, "password": PASSWORD}).encode(),
                           headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST")
token = json.loads(urllib.request.urlopen(r).read())["access_token"]

# ST 原版
with open(ST_ORIG, encoding="utf-8") as f:
    orig = json.load(f)
orig_entries = orig.get("entries", {})
print(f"[ST original] Eldoria entries={len(orig_entries)}")
for uid, e in list(orig_entries.items())[:6]:
    print(f"  #{uid} key={e.get('key')} secondary={e.get('keysecondary')} "
          f"content[:40]={str(e.get('content'))[:40]!r} constant={e.get('constant')} "
          f"order={e.get('order')} position={e.get('position')} "
          f"selectiveLogic={e.get('selectiveLogic')} probability={e.get('probability')} "
          f"useProbability={e.get('useProbability')} depth={e.get('depth')}")

# Palink 侧：列出世界书
books = req("GET", "/api/worldbooks", token=token)
print(f"\n[Palink] /api/worldbooks status ok, type={type(books).__name__}")
book_list = books if isinstance(books, list) else books.get("items", books.get("books", []))
for b in book_list:
    print(f"  book id={b.get('id')} name={b.get('name')} entries={len(b.get('entries', []))}")
    if b.get("name") == "Eldoria":
        for e in b.get("entries", []):
            keys = ["keys", "secondary_keys", "content", "constant", "insertion_order",
                    "position", "selective_logic", "probability", "use_probability",
                    "depth", "enabled", "case_sensitive", "comment"]
            print("   entry:", {k: (str(e.get(k))[:50]) for k in keys if k in e})
