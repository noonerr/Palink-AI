# -*- coding: utf-8 -*-
"""批次 C 行为变化影响模拟（只读）：递归关闭影响面 + 预算方案对比。"""
import subprocess
import json
import re

PSQL = ["docker", "exec", "palink-ai-db-1", "psql", "-U", "ai_user", "-d", "ai_hub",
        "-t", "-A", "-F", "\t", "-c"]


def q(sql: str) -> list[list[str]]:
    out = subprocess.run(PSQL + [sql], capture_output=True, text=True, encoding="utf-8").stdout
    rows = []
    for line in out.splitlines():
        if line.strip():
            rows.append(line.split("\t"))
    return rows


print("=" * 70)
print("【1】递归关闭影响面：非 constant 条目的 key 依赖分析")
print("=" * 70)
rows = q("""
SELECT b.name, s.id, s.title, s.keys::text, s.constant, replace(s.content, E'\\n', '\\\\n')
FROM world_book_stages s JOIN world_books b ON s.world_book_id = b.id
WHERE b.name IN ('猫娘神域', '和猫猫女仆长在府邸的日常生活')
ORDER BY b.name, s.title;
""")
books: dict[str, list[dict]] = {}
for name, sid, title, keys_json, constant, content in rows:
    try:
        keys = json.loads(keys_json)
    except Exception:
        keys = [k.strip() for k in (keys_json or "").split(",") if k.strip()]
    books.setdefault(name, []).append({
        "id": sid, "title": title, "keys": keys,
        "constant": str(constant).lower() == "t", "content": content or "",
    })

for name, entries in books.items():
    all_content = "\n".join(e["content"] for e in entries)
    non_const = [e for e in entries if not e["constant"]]
    print(f"\n■ {name}: {len(entries)} 条（constant {len(entries)-len(non_const)}）")
    for e in non_const:
        # key 是否被其他条目 content 引用（递归源候选）
        others = "\n".join(x["content"] for x in entries if x["id"] != e["id"])
        hit_keys = [k for k in e["keys"] if k and k.lower() in others.lower()]
        src = "被其他条目引用" if hit_keys else "无条目内引用"
        print(f"  [{e['title'][:20]}] keys={e['keys'][:3]} → {src} {hit_keys[:3]}")

print()
print("=" * 70)
print("【2】预算方案对比（基于生产 token_count 列）")
print("=" * 70)
rows = q("""
SELECT b.name, sum(s.token_count) AS total_tok,
       sum(s.token_count) FILTER (WHERE s.constant) AS const_tok,
       count(*) AS n
FROM world_book_stages s JOIN world_books b ON s.world_book_id = b.id
GROUP BY b.name ORDER BY total_tok DESC;
""")
print(f"{'书名':<22}{'全部tok':>9}{'constant':>10}{'条目':>5}")
total_all = 0
for name, total_tok, const_tok, n in rows:
    total_all += int(total_tok or 0)
    print(f"{name:<22}{total_tok:>9}{const_tok:>10}{n:>5}")
print(f"{'合计':<22}{total_all:>9}")

print("\n各模型上下文下的预算（ST 默认 25%）vs 当前固定 16000：")
for ctx, label in [(8192, "8k"), (32768, "32k"), (65536, "64k"), (131072, "128k")]:
    budget = round(0.25 * ctx)
    flag = " ← 低于合计，将触发裁剪" if budget < total_all else ""
    print(f"  {label:>5} 模型: 25% = {budget:>6} tok{flag}")
print(f"  当前固定 16000 tok（合计 {total_all} {'未' if total_all < 16000 else '已'}超）")

print("\n【3】用户配置现状：所有用户 silly_tavern_settings 均无 world_info_* 配置 → 全走代码默认，行为变化 100% 作用于现役会话")
