# -*- coding: utf-8 -*-
"""只读探针：确认 apply_patches 对「已存在 stat_data」的输入到底产出什么形状。"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.mvu_engine import apply_patches  # noqa: E402

CUR = {
    "stat_data": {"角色": {"络络": {"好感度": 10}}, "_meta": {"v": 1}},
}


def main() -> int:
    print("in :", json.dumps(CUR, ensure_ascii=False))
    for path in [
        "/stat_data/角色/络络/好感度",
        "stat_data/角色/络络/好感度",
        "/stat_data/角色/络络",
    ]:
        new, logs = apply_patches(CUR, [{"op": "replace", "path": path, "value": 42}])
        print(f"\npath={path!r}")
        print("  out:", json.dumps(new, ensure_ascii=False))
        print("  logs:", logs)
        print("  top-level keys:", list(new.keys()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
