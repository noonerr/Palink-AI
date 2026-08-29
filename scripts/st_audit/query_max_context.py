# -*- coding: utf-8 -*-
"""查现役用户的 max_context 配置（只读）。"""
import re
import subprocess

out = subprocess.run(
    ["docker", "exec", "palink-ai-db-1", "psql", "-U", "ai_user", "-d", "ai_hub",
     "-t", "-A", "-F", "|", "-c",
     "SELECT user_id, silly_tavern_settings::text FROM user_settings"],
    capture_output=True, text=True, encoding="utf-8").stdout

for line in out.splitlines():
    if "|" not in line:
        continue
    uid, cfg = line.split("|", 1)
    m = re.search(r'"openai_max_context"\s*:\s*(\d+)', cfg)
    print(f"user {uid}: openai_max_context = {m.group(1) if m else '(未配置)'}")
