"""[MODE-SEALED] 运行时封存验证（容器内执行，直连 DB + 归一化函数）。"""

import sys

sys.path.insert(0, "/app")

from sqlalchemy import text

from app.core.database import SessionLocal
from app.api.users import _normalize_silly_tavern_mode as norm_users
from app.api.silly_tavern import _normalize_silly_tavern_mode as norm_st
from app.services.roleplay_prompt_assembly import (
    SEALED_ST_MODES,
    _is_st_compat_mode,
    _st_mode_effective,
)

ok = True


def check(label: str, cond: bool) -> None:
    global ok
    print(f"  {'PASS' if cond else 'FAIL'}  {label}")
    if not cond:
        ok = False


print("== [MODE-SEALED] runtime seal verification ==")

# 1. admin DB 存量值（应为 st-compat，不回写）
db = SessionLocal()
try:
    row = db.execute(
        text("SELECT s.silly_tavern_mode FROM user_settings s JOIN users u ON u.id=s.user_id WHERE u.username='admin'")
    ).mappings().first()
    raw = row["silly_tavern_mode"] if row else None
    print(f"1. admin DB raw value = {raw!r}")

    # 2. GET 出口归一化
    check("2a. users.GET normalize(st-compat) == palink-native", norm_users(raw) == "palink-native")
    check("2b. silly_tavern.GET normalize(st-compat) == palink-native", norm_st(raw) == "palink-native")

    # 3. 装配入口归一化
    eff = _st_mode_effective(raw or "")
    check("3a. entrance effective(st-compat) not st-compat", not _is_st_compat_mode(eff or ""))
    check("3b. entrance effective('st-native') sealed", not _is_st_compat_mode(_st_mode_effective("st-native") or ""))
    check("3c. entrance passthrough palink-native", _st_mode_effective("palink-native") == "palink-native")

    # 4. PUT 重定向语义
    check("4a. PUT st-compat -> palink-native", norm_users("st-compat") == "palink-native")
    check("4b. PUT st-native -> palink-native", norm_users("st-native") == "palink-native")
    check("4c. PUT iframe(alias) -> palink-native", norm_users("iframe") == "palink-native")
    check("4d. PUT compat(alias) -> palink-native", norm_users("compat") == "palink-native")

    # 5. 封存集合一致性
    check("5a. SEALED covers legacy", {"compat", "st-compat", "st-native"} <= SEALED_ST_MODES)
    check("5b. palink-native never sealed", "palink-native" not in SEALED_ST_MODES)
finally:
    db.close()

print("\nRESULT:", "ALL-PASS" if ok else "HAS-FAILURES")
sys.exit(0 if ok else 1)
