"""反证脚本：把关键实现改坏，确认对应测试会变红（测试有效性验证）。

用法: py -3 _reverse_check.py   （在 backend/ 下运行）
跑完自动恢复原文件并做 sha256 校验。
"""
import hashlib
import pathlib
import re
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent
TMP = pathlib.Path(tempfile.gettempdir()) / "mvu_reverse"
TMP.mkdir(exist_ok=True)

NL = "\n"

CASES = [
    {
        "name": "① 还原 EXTRA-STR-FIX（extra 当 dict 判）",
        "file": "app/services/roleplay_prompt_assembly.py",
        "old": (
            "            if isinstance(extra, str):" + NL
            + "                try:" + NL
            + "                    extra = json.loads(extra)" + NL
            + "                except (json.JSONDecodeError, TypeError):" + NL
            + "                    continue" + NL
            + "            if not isinstance(extra, dict):"
        ),
        "new": "            if not isinstance(extra, dict):",
        "tests": [
            "tests/test_mvu_cleanup_safety.py::TestMessageLevelSnapshotActuallyRead"
            "::test_message_level_wins_over_session_level"
        ],
    },
    {
        "name": "② 锚点标记不写回（只把 pruned 当改动）",
        "file": "app/services/mvu_cleanup.py",
        "old": (
            "        if is_changed:" + NL
            + '            extra["variables"] = new_vars' + NL
            + "            changed.append(floor_no)" + NL
            + "            if is_pruned:" + NL
            + "                cleaned += 1"
        ),
        "new": (
            "        if is_pruned:" + NL
            + '            extra["variables"] = new_vars' + NL
            + "            changed.append(floor_no)" + NL
            + "            cleaned += 1"
        ),
        "tests": [
            "tests/test_mvu_cleanup.py::TestPruneSemantics"
            "::test_window_writes_back_anchor_marking",
            "tests/test_mvu_cleanup.py::TestEndToEnd"
            "::test_restore_rebuilds_pruned_floors_from_anchor",
        ],
    },
    {
        "name": "③ 忽略 enabled 开关（关掉也照清）",
        "file": "app/services/mvu_cleanup.py",
        "old": (
            "        settings = resolve_cleanup_settings(db, user_id, character_id)" + NL
            + "        if not settings.enabled:" + NL
            + "            return 0" + NL
            + "        floors = _load_branch_floors(db, session_id, branch_id)"
        ),
        "new": (
            "        settings = resolve_cleanup_settings(db, user_id, character_id)" + NL
            + "        floors = _load_branch_floors(db, session_id, branch_id)"
        ),
        "tests": [
            "tests/test_mvu_cleanup.py::TestEndToEnd::test_disabled_cleans_nothing"
        ],
    },
    {
        "name": "④ 清理时把整个 extra 换掉（丢掉 mvu_patch 等兄弟键）",
        "file": "app/services/mvu_cleanup.py",
        "old": (
            "        if is_changed:" + NL
            + '            extra["variables"] = new_vars' + NL
            + "            changed.append(floor_no)"
        ),
        "new": (
            "        if is_changed:" + NL
            + '            extras[floor_no] = {"variables": new_vars}' + NL
            + "            changed.append(floor_no)"
        ),
        "tests": [
            "tests/test_mvu_cleanup_safety.py::TestDoesNotTouchOtherData"
            "::test_mvu_patch_survives_cleanup",
            "tests/test_mvu_cleanup_safety.py::TestDoesNotTouchOtherData"
            "::test_other_extra_keys_survive",
        ],
    },
]


def main() -> int:
    all_ok = True
    for case in CASES:
        path = ROOT / case["file"]
        original = path.read_text(encoding="utf-8")
        sha_before = hashlib.sha256(original.encode("utf-8")).hexdigest()

        if case["old"] not in original:
            print(f"{case['name']}: 找不到锚点文本，跳过")
            all_ok = False
            continue

        path.write_text(
            original.replace(case["old"], case["new"], 1), encoding="utf-8"
        )
        try:
            proc = subprocess.run(
                [
                    sys.executable, "-m", "pytest", *case["tests"],
                    "-q", f"--basetemp={TMP / 'pt'}", "-p", "no:warnings",
                ],
                capture_output=True, text=True, encoding="utf-8", errors="replace",
                cwd=str(ROOT),
            )
            summary = ""
            for line in proc.stdout.splitlines():
                if re.search(r"\d+ (passed|failed)", line):
                    summary = line.strip()
            red = proc.returncode != 0
            verdict = "变红（测试有效）" if red else "仍绿（测试无效！）"
            print(f"{case['name']}: {verdict}  [{summary}]")
            if not red:
                all_ok = False
        finally:
            path.write_text(original, encoding="utf-8")
            sha_after = hashlib.sha256(
                path.read_text(encoding="utf-8").encode("utf-8")
            ).hexdigest()
            print(f"    恢复校验: {'一致' if sha_before == sha_after else '不一致!!'}")
            if sha_before != sha_after:
                all_ok = False

    print("\n总结:", "全部反证通过" if all_ok else "有反证未通过，需复查")
    return 0 if all_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
