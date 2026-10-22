"""静默失败「棘轮」守卫 —— 不允许**新增**吞异常且不留记录的分支。

## 这份测试解决什么

2026-10-22 外部审计的结论：本仓 `backend/app` 里 **562 处** `except` 分支
「吞掉异常且没有任何记录」，另有 40 处只打 `debug`（INFO 级下等于不记）。
用户侧表现是「点了没反应」，容器日志里一行都没有 —— 不可追溯。

一次改完 562 处不现实（且很多是合法的 best-effort 清理）。所以先立**棘轮**：

- 每个文件允许的「静默 handler 数」被冻结在 `silent_failure_baseline.json`；
- **任何文件不许变多**，也不许出现基线里没有的文件；
- 修好一处就调低基线，棘轮只往一个方向转。

## 判据（AST，不看注释）

一个 `except` 分支算「静默」当且仅当它的体内：
- 没有 `raise`
- 没有任何 `logger.debug/info/warning/error/exception/critical` 调用
- 没有任何记录器调用（`record` / `swallow` / `reportStubApi` / `capture_exception`）

只打 `logger.debug` 的单独计一档（`debug_only`），因为它在本仓 INFO 级别下不可见。

## 怎么降低基线

修掉一处 `except: pass` 后，把该文件在 baseline 里的数字减一即可。
整体重新生成：

    PALINK_SILENT_BASELINE_WRITE=1 python -m pytest tests/test_silent_failure_guard.py -q

⚠️ 重新生成会把**当前**状态当新基线，包括别人刚写进来的静默分支。
只有在确认「变多的是合法豁免」时才这么做，并在提交信息里说明原因。
"""

from __future__ import annotations

import ast
import json
import os
import pathlib

import pytest

APP_ROOT = pathlib.Path(__file__).resolve().parent.parent / "app"
BASELINE_PATH = pathlib.Path(__file__).resolve().parent / "silent_failure_baseline.json"

LOG_METHODS = {"debug", "info", "warning", "warn", "error", "exception", "critical", "log"}
# 记录调用的判据用**子串**而不是精确名：本仓大量用别名导入
# （如 `from app.core.silent_failure import record as _record_silent_failure`），
# 精确匹配会把它们全漏掉 —— 而漏掉的后果是「改了却仍被判成静默」。
RECORD_CALL_SUBSTRINGS = (
    "record",
    "swallow",
    "capture_exception",
    "capturemessage",
    "reportstubapi",
    "add_note",
)

# 记录器自身的兜底分支不通过自己记录（否则一旦它坏了就会递归）。
EXEMPT_FILES = {
    "core/silent_failure.py",
}


def _call_name(node: ast.AST) -> str:
    if not isinstance(node, ast.Call):
        return ""
    f = node.func
    if isinstance(f, ast.Attribute):
        return f.attr
    if isinstance(f, ast.Name):
        return f.id
    return ""


def _classify(handler: ast.ExceptHandler) -> str:
    has_raise = False
    levels = []
    has_record = False
    for node in ast.walk(handler):
        if isinstance(node, ast.Raise):
            has_raise = True
        name = _call_name(node)
        if not name:
            continue
        if name in LOG_METHODS:
            levels.append(name)
        elif any(s in name.lower() for s in RECORD_CALL_SUBSTRINGS):
            has_record = True
    if has_raise or has_record:
        return "ok"
    if not levels:
        return "silent"
    if all(lv == "debug" for lv in levels):
        return "debug_only"
    return "ok"


def scan(root: pathlib.Path | None = None) -> tuple[dict, dict, list]:
    """返回 ({rel_path: silent_count}, {rel_path: debug_only_count}, parse_errors)。

    `root` 可注入（测试用），默认扫真实 `backend/app`。
    """
    base = pathlib.Path(root) if root is not None else APP_ROOT
    silent: dict[str, int] = {}
    debug_only: dict[str, int] = {}
    errors: list[str] = []
    for path in sorted(base.rglob("*.py")):
        if "__pycache__" in path.parts:
            continue
        rel = path.relative_to(base).as_posix()
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except SyntaxError as exc:  # 语法坏掉的文件不该静默跳过
            errors.append("%s: %s" % (rel, exc))
            continue
        for node in ast.walk(tree):
            if not isinstance(node, ast.ExceptHandler):
                continue
            kind = _classify(node)
            if kind == "silent" and rel not in EXEMPT_FILES:
                silent[rel] = silent.get(rel, 0) + 1
            elif kind == "debug_only":
                debug_only[rel] = debug_only.get(rel, 0) + 1
    return silent, debug_only, errors


def _load_baseline() -> dict:
    return json.loads(BASELINE_PATH.read_text(encoding="utf-8"))


def test_no_source_file_fails_to_parse():
    """语法都解析不了就谈不上审计 —— 单独钉住，避免被下面的断言掩盖。"""
    _silent, _dbg, errors = scan()
    assert errors == [], "有文件无法解析：%s" % errors


def test_silent_swallows_do_not_increase():
    silent, _dbg, _err = scan()
    baseline = _load_baseline()
    base_silent: dict = baseline["silent"]

    if os.environ.get("PALINK_SILENT_BASELINE_WRITE") == "1":
        BASELINE_PATH.write_text(
            json.dumps(
                {
                    "_comment": baseline.get("_comment", ""),
                    "silent": dict(sorted(silent.items())),
                    "debug_only": dict(sorted(_dbg.items())),
                    "totals": {"silent": sum(silent.values()), "debug_only": sum(_dbg.values())},
                },
                ensure_ascii=False,
                indent=1,
            ),
            encoding="utf-8",
        )
        pytest.skip("已按当前状态重写基线（PALINK_SILENT_BASELINE_WRITE=1）")

    regressions = []
    for rel, count in sorted(silent.items()):
        allowed = base_silent.get(rel, 0)
        if count > allowed:
            regressions.append("%s: %d > 允许 %d" % (rel, count, allowed))
    for rel in sorted(base_silent):
        if rel not in silent and base_silent[rel] > 0:
            pass  # 变少是好事，不报

    assert regressions == [], (
        "新增了「吞异常且不留记录」的分支（%d 处）。请改用 "
        "`from app.core.silent_failure import swallow` / `record`，"
        "或在确认是合法豁免后调低基线：\n  %s"
        % (len(regressions), "\n  ".join(regressions))
    )


def test_debug_only_swallows_do_not_increase():
    _silent, debug_only, _err = scan()
    baseline = _load_baseline()
    if os.environ.get("PALINK_SILENT_BASELINE_WRITE") == "1":
        pytest.skip("基线重写模式")
    base_dbg: dict = baseline["debug_only"]
    regressions = [
        "%s: %d > 允许 %d" % (rel, count, base_dbg.get(rel, 0))
        for rel, count in sorted(debug_only.items())
        if count > base_dbg.get(rel, 0)
    ]
    assert regressions == [], (
        "新增了只打 debug 的吞异常分支（INFO 级别下不可见）：\n  %s"
        % "\n  ".join(regressions)
    )


def test_baseline_totals_match_its_entries():
    """基线自身不许自相矛盾：totals 必须等于各文件求和。"""
    baseline = _load_baseline()
    base_silent: dict = baseline["silent"]
    base_dbg: dict = baseline["debug_only"]
    totals = baseline["totals"]
    assert totals["silent"] == sum(base_silent.values()), "totals.silent 与明细不一致"
    assert totals["debug_only"] == sum(base_dbg.values()), "totals.debug_only 与明细不一致"


# ── 反向证明：分类器本身必须既能抓、也能放 ────────────────────────────
# 没有这组用例，上面三条「不许变多」的断言可能只是恒真。

def _scan_snippet(tmp_path, body: str):
    (tmp_path / "probe.py").write_text(body, encoding="utf-8")
    return scan(tmp_path)


def test_detects_a_plain_silent_swallow(tmp_path):
    silent, dbg, err = _scan_snippet(
        tmp_path,
        "def f():\n"
        "    try:\n"
        "        return 1\n"
        "    except Exception:\n"
        "        pass\n",
    )
    assert err == []
    assert silent == {"probe.py": 1}
    assert dbg == {}


def test_does_not_flag_a_recorded_swallow(tmp_path):
    silent, dbg, _err = _scan_snippet(
        tmp_path,
        "from app.core.silent_failure import swallow\n"
        "def f():\n"
        "    with swallow('demo.scope'):\n"
        "        return 1\n",
    )
    assert silent == {}, "用 swallow() 的写法不该被判成静默"


def test_does_not_flag_a_logged_handler(tmp_path):
    silent, dbg, _err = _scan_snippet(
        tmp_path,
        "import logging\n"
        "logger = logging.getLogger(__name__)\n"
        "def f():\n"
        "    try:\n"
        "        return 1\n"
        "    except Exception as exc:\n"
        "        logger.error('boom: %s', exc)\n",
    )
    assert silent == {}
    assert dbg == {}


def test_flags_debug_only_separately(tmp_path):
    silent, dbg, _err = _scan_snippet(
        tmp_path,
        "import logging\n"
        "logger = logging.getLogger(__name__)\n"
        "def f():\n"
        "    try:\n"
        "        return 1\n"
        "    except Exception:\n"
        "        logger.debug('nope')\n",
    )
    assert silent == {}
    assert dbg == {"probe.py": 1}


def test_does_not_flag_a_reraising_handler(tmp_path):
    silent, dbg, _err = _scan_snippet(
        tmp_path,
        "def f():\n"
        "    try:\n"
        "        return 1\n"
        "    except Exception:\n"
        "        raise\n",
    )
    assert silent == {} and dbg == {}
