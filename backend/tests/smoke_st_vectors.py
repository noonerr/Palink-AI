# -*- coding: utf-8 -*-
"""T8 冒烟脚本：在容器内对运行中的服务做 ST 向量端点 + settings/save 合并 +
extensions/discover 降级 的端到端验证。

用法（宿主机）:
    docker compose exec -T backend python /app/tests/smoke_st_vectors.py

认证方式：直接用 app.core.security.create_access_token 为一个临时冒烟用户
签发 JWT（用户写入服务所连的真实 DB，脚本结束时清理该用户与其 st-vec:: 数据）。
"""
import json
import sys
import time

import requests

sys.path.insert(0, "/app")

BASE = "http://localhost:8000"
SMOKE_USER = f"smoke_st_vec_{int(time.time())}"
COLL = f"smoke-coll-{int(time.time())}"

results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name} {detail}")


def main():
    from sqlalchemy import text as sa_text

    from app.core.database import SessionLocal
    from app.core.security import create_access_token, get_password_hash
    from app.models import User

    db = SessionLocal()
    user = User(
        username=SMOKE_USER,
        hashed_password=get_password_hash("SmokeTest1!"),
        role="user",
        is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    uid = user.id
    token = create_access_token({"sub": SMOKE_USER})
    H = {"Authorization": f"Bearer {token}"}

    try:
        # 1. insert（ST 格式）
        r = requests.post(f"{BASE}/api/vector/insert", headers=H, json={
            "collectionId": COLL,
            "items": [
                {"hash": 901, "text": "smoke alpha", "index": 0},
                {"hash": 902, "text": "smoke beta", "index": 1},
            ],
            "source": "transformers",
        }, timeout=30)
        check("insert", r.status_code == 200 and r.json().get("inserted") == 2,
              f"{r.status_code} {r.text[:120]}")

        # 2. list → 裸 hash 数组
        r = requests.post(f"{BASE}/api/vector/list", headers=H,
                          json={"collectionId": COLL}, timeout=10)
        ok = r.status_code == 200 and sorted(r.json()) == [901, 902]
        check("list", ok, f"{r.status_code} {r.text[:120]}")

        # 3. 补 embedding（insert 为异步计算，冒烟直接等 + 兜底 UPDATE）
        time.sleep(2)
        db.execute(sa_text(
            "UPDATE conversation_memories SET embedding = :emb "
            "WHERE user_id = :uid AND embedding IS NULL"),
            {"emb": json.dumps([1.0] * 8), "uid": uid})
        db.commit()

        # 4. query（ST 形状）
        r = requests.post(f"{BASE}/api/vector/query", headers=H, json={
            "collectionId": COLL, "searchText": "smoke", "topK": 5,
            "threshold": -1.0,
        }, timeout=30)
        d = r.json() if r.status_code == 200 else {}
        ok = r.status_code == 200 and set(d.keys()) == {"metadata", "hashes"} \
            and sorted(d.get("hashes", [])) == [901, 902]
        check("query", ok, f"{r.status_code} {r.text[:160]}")

        # 5. query-multi → Record
        r = requests.post(f"{BASE}/api/vector/query-multi", headers=H, json={
            "collectionIds": [COLL], "searchText": "smoke", "topK": 5,
            "threshold": -1.0,
        }, timeout=30)
        d = r.json() if r.status_code == 200 else {}
        check("query-multi", r.status_code == 200 and COLL in d,
              f"{r.status_code} {r.text[:120]}")

        # 6. delete（按 hash）
        r = requests.post(f"{BASE}/api/vector/delete", headers=H, json={
            "collectionId": COLL, "hashes": [902]}, timeout=10)
        check("delete", r.status_code == 200 and r.json().get("deleted") == 1,
              f"{r.status_code} {r.text[:120]}")

        # 7. purge
        r = requests.post(f"{BASE}/api/vector/purge", headers=H,
                          json={"collectionId": COLL}, timeout=10)
        check("purge", r.status_code == 200, f"{r.status_code} {r.text[:120]}")

        # 8. purge-all（此用户无其他 st-vec:: 数据 → deleted 0）
        r = requests.post(f"{BASE}/api/vector/purge-all", headers=H, json={},
                          timeout=10)
        check("purge-all", r.status_code == 200, f"{r.status_code} {r.text[:120]}")

        # 9. Palink 旧格式 query 向后兼容
        r = requests.post(f"{BASE}/api/vector/query", headers=H,
                          json={"query": "anything", "top_k": 3}, timeout=30)
        check("palink-query-compat",
              r.status_code == 200 and "results" in r.json(),
              f"{r.status_code} {r.text[:120]}")

        # 10. settings/save extension_settings 命名空间合并
        requests.post(f"{BASE}/api/settings/save", headers=H, json={
            "extension_settings": {"pluginA": {"k": 1}}}, timeout=10)
        requests.post(f"{BASE}/api/settings/save", headers=H, json={
            "extension_settings": {"pluginB": {"k": 2}}}, timeout=10)
        r = requests.post(f"{BASE}/api/settings/get", headers=H, json={},
                          timeout=10)
        merged = {}
        if r.status_code == 200:
            try:
                body = r.json()
                settings = body.get("settings") if isinstance(body.get("settings"), (dict, str)) else body
                if isinstance(settings, str):
                    settings = json.loads(settings)
                merged = (settings or {}).get("extension_settings", {})
            except Exception:
                pass
        ok = "pluginA" in merged and "pluginB" in merged
        check("settings-merge", ok, f"{r.status_code} keys={list(merged)[:6]}")

        # 11. extensions/discover（ST 源码为 GET；sidecar 在 → 透传列表，
        #     不在 → 降级 200 + []）
        r = requests.get(f"{BASE}/api/extensions/discover", headers=H,
                         timeout=15)
        ok = r.status_code == 200 and isinstance(r.json(), list)
        check("extensions-discover", ok, f"{r.status_code} {r.text[:120]}")

        # 12. extensions/install 代理：sidecar 不在 → 502；sidecar 在 →
        #     透传上游状态（假 git URL 预期 4xx/5xx，非本服务崩溃）
        r = requests.post(f"{BASE}/api/extensions/install", headers=H,
                          json={"url": "https://example.com/x.git"}, timeout=15)
        check("extensions-install-proxy", r.status_code in (400, 422, 500, 502),
              f"{r.status_code} {r.text[:120]}")
    finally:
        # 清理冒烟数据与用户
        db.execute(sa_text(
            "DELETE FROM conversation_memories WHERE user_id = :uid"), {"uid": uid})
        db.execute(sa_text(
            "DELETE FROM user_settings WHERE user_id = :uid"), {"uid": uid})
        db.execute(sa_text("DELETE FROM users WHERE id = :uid"), {"uid": uid})
        db.commit()
        db.close()

    failed = [n for n, ok, _ in results if not ok]
    print(f"\n== 冒烟结果: {len(results) - len(failed)}/{len(results)} 通过 ==")
    if failed:
        print("失败项:", failed)
        sys.exit(1)


if __name__ == "__main__":
    main()
