# -*- coding: utf-8 -*-
"""一次性数据修复：把被写歪的 stat_data 按卡片 schema 归一化（2026-10-05）。

用法（**默认干跑**，只打印不写库）：
    py -3 backend/scripts/_fix_stat_shape.py --session <sid>
    py -3 backend/scripts/_fix_stat_shape.py --session <sid> --apply

流程：取会话 chat_metadata + 该角色 schema 骨架 → 归一化 → 打印变更日志；
`--apply` 时才写回，同时修复该会话所有含 stat_data 的消息级快照
（装配侧 `_load_effective_stat_data` 是消息级优先，只修会话级不够）。

中文经 psql 会 GBK 乱码，全程走 base64。
"""
import argparse
import base64
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# ⚠️ 不能直接 `from app.services.mvu_engine import ...`：`app/services/__init__.py`
# 会拉起 chat_service → core.config → Settings()，而 .env 里有若干本模型未声明的键，
# 独立脚本跑（没有 pytest 的 conftest 兜底）会直接 ValidationError。
# mvu_engine 与 mvu_stat_normalize 都只依赖标准库，故把 `app.services` 这个包
# 短路成一个空壳，绕开它的 __init__，只加载目标模块本身。
import types  # noqa: E402

_services_pkg = types.ModuleType("app.services")
_services_pkg.__path__ = [str(Path(__file__).resolve().parents[1] / "app" / "services")]
sys.modules.setdefault("app.services", _services_pkg)

from app.services.mvu_engine import extract_schema_defaults  # noqa: E402
from app.services.mvu_stat_normalize import normalize_variables  # noqa: E402

PSQL = ["docker", "exec", "palink-ai-db-1", "psql", "-U", "ai_user", "-d", "ai_hub", "-t", "-A"]


def q(sql: str) -> str:
    r = subprocess.run(PSQL + ["-c", sql], capture_output=True)
    if r.returncode != 0:
        print("psql 失败:", r.stderr.decode("utf-8", "replace")[:500])
        sys.exit(1)
    return r.stdout.decode("utf-8", "replace").strip()


def b64_of(expr: str) -> str:
    return q(f"SELECT encode(convert_to({expr},'UTF8'),'base64')")


def from_b64(s: str) -> str:
    return base64.b64decode(s).decode("utf-8") if s else ""


def to_b64(s: str) -> str:
    return base64.b64encode(s.encode("utf-8")).decode("ascii")


def get_skeleton(character_id: str) -> dict:
    raw = from_b64(b64_of(f"(SELECT coalesce(extensions,'') FROM characters WHERE id='{character_id}')"))
    try:
        ext = json.loads(raw)
    except Exception:
        return {}
    th = ext.get("tavern_helper")
    return extract_schema_defaults(th) if isinstance(th, dict) else {}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--session", required=True)
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    sid = args.session

    cid = q(f"SELECT character_id FROM character_chat_sessions WHERE id='{sid}';")
    if not cid:
        print("会话不存在")
        return 1
    skeleton = get_skeleton(cid)
    print(f"会话 {sid[:8]}…  角色 {cid[:8]}…")
    print(f"schema 骨架顶层键: {list(skeleton)}  （空=解析不到，将拒绝改动）")
    if not skeleton:
        print("!! 没有骨架 → 按设计不做任何改动")
        return 2

    # ---- ① 会话级 ----
    md = json.loads(from_b64(b64_of(f"(SELECT chat_metadata FROM character_chat_sessions WHERE id='{sid}')")))
    new_md, log = normalize_variables(md.get("variables"), skeleton)
    print(f"\n=== ① 会话级 chat_metadata ===")
    print(f"变更 {len([l for l in log if not l.startswith('skip')])} 条:")
    for l in log:
        print("   ", l)
    if new_md != md.get("variables"):
        md2 = dict(md)
        md2["variables"] = new_md
        if args.apply:
            q(f"UPDATE character_chat_sessions SET chat_metadata = "
              f"convert_from(decode('{to_b64(json.dumps(md2, ensure_ascii=False))}','base64'),'UTF8') "
              f"WHERE id='{sid}';")
            print("   → 已写回会话级")
        else:
            print("   → (干跑，未写库)")

    # ---- ② 消息级 ----
    ids = q(f"SELECT id FROM character_chat_messages WHERE session_id='{sid}' "
            f"AND extra LIKE '%stat_data%' ORDER BY id;").split()
    print(f"\n=== ② 消息级快照（{len(ids)} 条）===")
    changed = 0
    for mid in ids:
        ex = json.loads(from_b64(b64_of(f"(SELECT extra FROM character_chat_messages WHERE id='{mid}')")))
        newv, mlog = normalize_variables(ex.get("variables"), skeleton)
        real = [l for l in mlog if not l.startswith("skip")]
        if newv == ex.get("variables"):
            continue
        changed += 1
        print(f"  msg {mid}: 变更 {len(real)} 条  {real[:2]}")
        ex2 = dict(ex)
        ex2["variables"] = newv
        if args.apply:
            q(f"UPDATE character_chat_messages SET extra = "
              f"convert_from(decode('{to_b64(json.dumps(ex2, ensure_ascii=False))}','base64'),'UTF8') "
              f"WHERE id='{mid}';")
    print(f"  需要修的快照: {changed}/{len(ids)}")
    if args.apply:
        print("\n已全部写回。")
    else:
        print("\n（干跑结束，未写库。加 --apply 执行）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
