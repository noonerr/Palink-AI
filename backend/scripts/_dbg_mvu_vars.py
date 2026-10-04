# -*- coding: utf-8 -*-
"""只读排障：对比某个会话的 chat_metadata.variables 与 chat_variables 表行。

用于判断「面板回落到 schema 默认值」到底是哪一路数据缺了。
中文经 psql 会 GBK 乱码，故一律 base64 取回本地解码。
"""
import base64
import json
import subprocess
import sys

DB = "palink-ai-db-1"
PSQL = ["docker", "exec", DB, "psql", "-U", "ai_user", "-d", "ai_hub", "-t", "-A"]


def q(sql: str) -> str:
    r = subprocess.run(PSQL + ["-c", sql], capture_output=True)
    if r.returncode != 0:
        print("psql 失败:", r.stderr.decode("utf-8", "replace")[:500])
        sys.exit(1)
    return r.stdout.decode("utf-8", "replace").strip()


def b64(text: str) -> str:
    return q(f"SELECT encode(convert_to({text}, 'UTF8'), 'base64')")


def unb64(s: str) -> str:
    if not s:
        return ""
    try:
        return base64.b64decode(s).decode("utf-8")
    except Exception as e:
        return f"<decode fail {e}>"


def main() -> int:
    # 1) 最近有 stat_data 的会话
    rows = q(
        "SELECT id || '|' || to_char(updated_at,'MM-DD HH24:MI') || '|' ||"
        " coalesce(length(chat_metadata),0) "
        "FROM character_chat_sessions WHERE chat_metadata LIKE '%stat_data%' "
        "ORDER BY updated_at DESC LIMIT 6;"
    )
    print("=== 最近含 stat_data 的会话 (id|updated|metadata长度) ===")
    print(rows or "  (无)")
    if not rows:
        return 0

    sid = rows.splitlines()[0].split("|")[0]
    print(f"\n=== 选中会话 {sid} ===")

    # 2) chat_metadata.variables
    md_b64 = q(
        "SELECT encode(convert_to(chat_metadata,'UTF8'),'base64') FROM character_chat_sessions "
        f"WHERE id = '{sid}';"
    )
    md_text = unb64(md_b64)
    try:
        meta = json.loads(md_text)
    except Exception as e:
        print("chat_metadata 解析失败:", e, md_text[:200])
        meta = {}
    variables = meta.get("variables") or {}
    stat = variables.get("stat_data") if isinstance(variables, dict) else None
    print(f"\n--- chat_metadata.variables 顶层键: {list(variables) if isinstance(variables, dict) else type(variables)}")
    print(f"--- chat_metadata stat_data 键: {list(stat) if isinstance(stat, dict) else stat}")

    # 3) chat_variables 表行
    cv = q(
        "SELECT key || '|' || coalesce(length(value),0) || '|' ||"
        " encode(convert_to(coalesce(value,''),'UTF8'),'base64') "
        f"FROM chat_variables WHERE session_id = '{sid}' ORDER BY key;"
    )
    print(f"\n--- chat_variables 表行数: {len(cv.splitlines()) if cv else 0}")
    for line in (cv.splitlines() if cv else []):
        parts = line.split("|")
        key = parts[0]
        ln = parts[1] if len(parts) > 1 else "?"
        val = unb64(parts[2]) if len(parts) > 2 else ""
        print(f"    key={key!r} len={ln}")
        print(f"      value 前 300: {val[:300]}")

    # 4) 消息级快照
    msg = q(
        "SELECT id || '|' || coalesce(length(extra),0) FROM character_chat_messages "
        f"WHERE session_id = '{sid}' ORDER BY id DESC LIMIT 3;"
    )
    print(f"\n--- 最近 3 条消息 (id|extra长度) ---")
    print(msg or "  (无)")
    if msg:
        mid = msg.splitlines()[0].split("|")[0]
        ex_b64 = q(
            "SELECT encode(convert_to(coalesce(extra,''),'UTF8'),'base64') "
            f"FROM character_chat_messages WHERE id = '{mid}';"
        )
        ex_text = unb64(ex_b64)
        print(f"  最新消息 extra 前 400: {ex_text[:400]}")
        try:
            ex = json.loads(ex_text)
            v = ex.get("variables")
            st = v.get("stat_data") if isinstance(v, dict) else None
            print(f"  消息级 stat_data 键: {list(st) if isinstance(st, dict) else st}")
        except Exception as e:
            print("  extra 解析失败:", e)
    return 0


if __name__ == "__main__":
    sys.exit(main())
