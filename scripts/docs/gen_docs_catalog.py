#!/usr/bin/env python3
"""生成 docs/_CATALOG.md —— docs/ 全量文档的机器可读清单。

为什么有这个脚本（2026-10-05）：
    _CATALOG.md 之前是手工维护的，写完当天就注明"会立刻过时"。
    根因是别的 agent 新建文档时不会顺手更新它。本脚本把这个动作变成一条命令。

它能自动判定的（全部来自文件系统，客观）：
    文件是否存在、在哪个目录、前缀归类、文件名日期、mtime、
    首部内容里出现的第一个日期、文件大小、状态标记是否存在。

它**不能**自动判定的（绝不猜，缺就写"无"）：
    文档可不可信、能不能照做、工没完工。这些必须人读首部自己判断，
    结论写在 _INDEX.md 里。本脚本只提供判断所需的原料。

用法：
    python scripts/docs/gen_docs_catalog.py            # 写入 docs/_CATALOG.md
    python scripts/docs/gen_docs_catalog.py --check    # 只校验是否已过期（供 pre-commit 用）
    python scripts/docs/gen_docs_catalog.py --stdout   # 打到标准输出，不写文件

--check 的判定：重新生成的内容与磁盘上现有文件不一致则退出码 1。
用途是让 agent 在交付自检时能立刻知道"目录又该刷新了"，而不是等别人发现。

⚠️ 之所以**没有**挂进 .githooks/pre-commit：agents.md §备份与清理规范 第 6 条把
`.githooks/` 列为红线目录「一律不动」，且共享工作区里 hook 自动写文件会碰到别人的暂存区。
所以这里是「写进 agents.md 让每个 agent 自己跑」，不是 hook 强制。
"""

from __future__ import annotations

import argparse
import datetime as dt
import re
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DOCS_DIR = REPO_ROOT / "docs"
CATALOG_PATH = DOCS_DIR / "_CATALOG.md"

# _CATALOG.md 自己不入表（它是派生物，不是被索引对象）
SELF_NAME = "_CATALOG.md"

# 与 agents.md §文档存放规范 第 2 条保持一致：前缀必须在开头
PREFIXES = [
    ("SPEC_", "施工规格书 —— 动手前读"),
    ("REPORT_", "排查/审计结论"),
    ("DIAG_", "诊断报告"),
    ("PROMPT_", "交给 agent 的提示词"),
    ("HANDOFF_", "交接书"),
    ("PLAN_", "执行计划"),
    ("ANALYSIS", "分析报告"),
    ("AUDIT", "审计报告"),
    ("CHECKLIST_", "清单"),
    ("OPEN_", "长期台账"),
    ("GALGAME", "主题规格"),
    ("PALINK_", "项目级规格"),
    ("QUICK_FIX", "快速修复"),
    ("SOP_", "标准作业流程"),
    ("TODO", "待办"),
]

# 首部状态标记。只统计"文件里出现过"，不据此下判断 —— 出现≠当前有效。
STATUS_MARKERS = [
    "待施工",
    "施工中",
    "已完工待验收",
    "口径已作废",
    "已作废",
    "已完成",
]

# 内容日期：匹配 2026-09-04 / 2026年9月 / 2026/09 几种写法
CONTENT_DATE_RE = re.compile(r"(20\d{2})[-/年](\d{1,2})")
FILENAME_DATE_RE = re.compile(r"_(20\d{2})-(\d{2})(?:-\d{2})?")

# 目录归类：key = 显示名，value = 匹配函数
TOP_LEVEL_DESC = "docs/ 顶层（有入链的活文档，按纪律不能直接搬）"

# 本治理体系自建的四个层。_README.md 是各层的说明书，不算文档本体。
MANAGED_ROOTS = {
    "docs": (TOP_LEVEL_DESC, "顶层"),
    "docs/_active": ("**新文档放这里**（spec/ report/ prompt/）", "active"),
    "docs/_reference": ("长期有效配置指南，不过期", "reference"),
    "docs/_archive": ("已完工过保鲜期，按**内容**日期分月", "archive-root"),
}


def classify_dir(directory: str) -> tuple[str, str]:
    """把目录路径归到四层之一，外加「旧子目录」。

    注意 `_active/` 与 `_archive/` 只匹配**目录本身**，
    不能用 startswith —— 否则 `_active/spec/` 会被误当成别的 agent 的旧目录。
    """
    if directory in MANAGED_ROOTS:
        return MANAGED_ROOTS[directory]
    for root, (desc, kind) in MANAGED_ROOTS.items():
        if directory.startswith(root + "/"):
            if kind == "archive-root":
                # docs/_archive/2026-08/ 及其更深层
                if re.fullmatch(r"docs/_archive/\d{4}-\d{2}", directory):
                    return desc, "archive-month"
                return desc, kind
            if kind == "active":
                return desc, "active-sub"
            if kind == "reference":
                return desc, "reference-sub"
    return ("别人早先建的旧子目录，**本索引不搬它**", "legacy")


def detect_prefix(name: str) -> tuple[str, str]:
    """返回 (前缀分类, 含义)。没匹配到就是 '其他'。"""
    for prefix, desc in PREFIXES:
        if name.startswith(prefix):
            return prefix, desc
    return "其他", "混合（中文名/无前缀）"


def read_head(path: Path, lines: int = 30) -> str:
    try:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            return "".join(next(fh, "") for _ in range(lines))
    except OSError:
        return ""


def content_date(head: str) -> str:
    """首部第一个 YYYY-MM 归一化成 YYYY-MM-DD（缺月日则补 01）。"""
    m = CONTENT_DATE_RE.search(head)
    if not m:
        return ""
    year, month = m.group(1), int(m.group(2))
    if not 1 <= month <= 12:
        return ""
    return f"{year}-{month:02d}-01"


def filename_date(name: str) -> str:
    m = FILENAME_DATE_RE.search(name)
    if not m:
        return ""
    return f"{m.group(1)}-{m.group(2)}"


def month_of(value: str) -> str:
    return value[:7] if len(value) >= 7 else ""


def git_tracked_count(rel_paths: list[str]) -> int:
    """多少份文档在 git 里。靠 git 的事实回答，不猜。"""
    if not rel_paths:
        return 0
    try:
        out = subprocess.run(
            ["git", "ls-files", "--", *rel_paths],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return -1  # -1 = 问不到，不当成 0
    return len({line.strip() for line in out.stdout.splitlines() if line.strip()})


def collect() -> tuple[list[dict], dict]:
    """扫 docs/ 全部 markdown，返回 (记录列表, 统计)。"""
    if not DOCS_DIR.is_dir():
        sys.exit(f"[docs-catalog] 找不到 {DOCS_DIR}")

    records: list[dict] = []
    for path in sorted(DOCS_DIR.rglob("*.md")):
        if not path.is_file() or path.name == SELF_NAME:
            continue
        rel = path.relative_to(REPO_ROOT).as_posix()
        parent = path.parent.relative_to(REPO_ROOT).as_posix()
        head = read_head(path)
        prefix, prefix_desc = detect_prefix(path.name)
        marker = next((s for s in STATUS_MARKERS if s in head), "")
        try:
            mtime = dt.datetime.fromtimestamp(path.stat().st_mtime).strftime("%Y-%m-%d")
        except OSError:
            mtime = ""
        records.append(
            {
                "name": path.name,
                "dir": parent,
                "rel": rel,
                "prefix": prefix,
                "prefix_desc": prefix_desc,
                "fname_date": filename_date(path.name),
                "content_date": content_date(head),
                "marker": marker,
                "mtime": mtime,
                "size": path.stat().st_size,
            }
        )

    # 按"所在目录归类"分组
    buckets: dict[str, list[dict]] = defaultdict(list)
    for rec in records:
        buckets[rec["dir"]].append(rec)

    top = buckets.get("docs", [])
    tracked = git_tracked_count([r["rel"] for r in records])

    kind_counts: Counter[str] = Counter()
    for directory, recs in buckets.items():
        kind_counts[classify_dir(directory)[1]] += len(recs)

    # _archive 按月分列（只算月度目录下的文件，_README 不算）
    archive_months = sorted(
        (directory.rsplit("/", 1)[-1], len(recs))
        for directory, recs in buckets.items()
        if classify_dir(directory)[1] == "archive-month"
    )

    stats = {
        "total": len(records),
        "buckets": {k: len(v) for k, v in sorted(buckets.items())},
        "top": top,
        "archive_months": archive_months,
        "legacy": sorted(
            (directory, len(recs))
            for directory, recs in buckets.items()
            if classify_dir(directory)[1] == "legacy"
        ),
        "active_total": kind_counts.get("active", 0) + kind_counts.get("active-sub", 0),
        "reference_total": kind_counts.get("reference", 0)
        + kind_counts.get("reference-sub", 0),
        "archive_total": kind_counts.get("archive-month", 0),
        "tracked": tracked,
        "prefix_counts": Counter(r["prefix"] for r in records),
        "top_prefix_counts": Counter(r["prefix"] for r in top),
        "no_marker": sum(1 for r in records if not r["marker"]),
        "date_diverge": [
            r
            for r in records
            if r["fname_date"]
            and r["content_date"]
            and month_of(r["fname_date"]) != month_of(r["content_date"])
        ],
    }
    return records, stats


def render(records: list[dict], stats: dict) -> str:
    now = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    out: list[str] = []
    w = out.append

    w("# docs/ 文档总目录（机器可读 · 自动生成）")
    w("")
    w(f"> ⛔ **本文件由 `scripts/docs/gen_docs_catalog.py` 生成，不要手工编辑。**")
    w(f"> 手工改的内容会在下次生成时被覆盖。要改内容请改生成器，或改它指向的 `_INDEX.md` / `OPEN_ISSUES.md`。")
    w(f">")
    w(f"> 重新生成：`python scripts/docs/gen_docs_catalog.py`　｜　校验是否过期：`--check`")
    w(f">")
    w(f"> **生成时间：{now}**　｜　扫描到 **{stats['total']}** 份 markdown")
    w("")
    w("---")
    w("")
    w("## 这份文件能回答什么、不能回答什么")
    w("")
    w("| 问题 | 本文件 |")
    w("|---|---|")
    w("| 有没有这份文件 | ✅ 能（第一、三节全量列出） |")
    w("| 它在哪个目录 | ✅ 能 |")
    w("| 它是 SPEC 还是 REPORT | ✅ 能（按开头前缀） |")
    w("| 它首部有没有写状态 | ⚠️ 只反映**文字出现过**，不保证是当前状态 |")
    w("| 它能不能照做 | ❌ **不能**，必须打开读首部 |")
    w("| 它可不可信 | ❌ **不能**，看 [`_INDEX.md`](./_INDEX.md) 的可信度分级 |")
    w("")
    w("找不到想找的文件时，先直接搜：")
    w("")
    w("```bash")
    w("find docs -name \"*关键词*.md\"        # 跨所有子目录")
    w("```")
    w("")
    w("---")
    w("")

    # 一、前缀
    w("## 一、按前缀统计")
    w("")
    w("| 前缀 | 顶层 | 全仓 | 含义 |")
    w("|---|---|---|---|")
    for prefix, desc in PREFIXES:
        if stats["top_prefix_counts"].get(prefix) or stats["prefix_counts"].get(prefix):
            w(
                f"| `{prefix}` | {stats['top_prefix_counts'].get(prefix, 0)} "
                f"| {stats['prefix_counts'].get(prefix, 0)} | {desc} |"
            )
    other_top = stats["top_prefix_counts"].get("其他", 0)
    other_all = stats["prefix_counts"].get("其他", 0)
    w(f"| 其他（中文名/无前缀） | {other_top} | {other_all} | 混合，逐份读首部 |")
    w("")
    w("> 顶级数 = `docs/` 顶层；全仓数 = 含 `_archive/` `_reference/` 等全部子目录。")
    w("")

    # 二、状态标记
    w("## 二、首部状态标记覆盖情况")
    w("")
    have = stats["total"] - stats["no_marker"]
    w(f"- 有标记：**{have} / {stats['total']}**")
    w(f"- 无标记：**{stats['no_marker']}** —— ⚠️ 这不代表有效，只代表首部没写状态")
    w("")
    if stats["date_diverge"]:
        w(
            f"⚠️ **文件名日期与内容日期不同月的有 {len(stats['date_diverge'])} 份**"
            "（下表 ⚠️ 列标出）。归档按**内容**日期，不信文件名："
        )
        w("")
        w("| 文件 | 文件名日期 | 内容首现日期 |")
        w("|---|---|---|")
        for rec in stats["date_diverge"]:
            w(f"| `{rec['name']}` | {rec['fname_date']} | {rec['content_date']} |")
    else:
        w("本次扫描未发现文件名日期与内容日期不同月的文档。")
    w("")

    # 三、目录
    w("## 三、按目录（四层结构）")
    w("")
    w("| 层 | 目录 | 份数 | 说明 |")
    w("|---|---|---|---|")
    w(f"| 1 活 | `docs/` 顶层 | {len(stats['top'])} | {TOP_LEVEL_DESC} |")
    w(
        f"| 1 活 | `docs/_active/` | {stats['active_total']} "
        "| **新文档放这里**（`spec/` `report/` `prompt/`） |"
    )
    w(f"| 3 参考 | `docs/_reference/` | {stats['reference_total']} | 长期有效配置指南，不过期 |")
    w(f"| 4 归档 | `docs/_archive/YYYY-MM/` | {stats['archive_total']} | 已完工过保鲜期，按**内容**日期分月 |")
    w("")
    if stats["archive_months"]:
        w("归档分月明细：" + "、".join(f"`{m}` {n}" for m, n in stats["archive_months"]))
        w("")
    if stats["legacy"]:
        w(
            f"另有 **{sum(n for _, n in stats['legacy'])}** 份散在 "
            f"**{len(stats['legacy'])}** 个别人早先建的旧子目录（本索引不搬它们）："
        )
        w("")
        w("| 旧子目录 | 份数 |")
        w("|---|---|")
        for directory, count in stats["legacy"]:
            w(f"| `{directory}/` | {count} |")
        w("")

    # 四、入库状态
    w("## 四、⚠️ git 入库状态")
    w("")
    if stats["tracked"] < 0:
        w("**问不到 git 状态**（git 不可用），跳过本节。")
    else:
        untracked = stats["total"] - stats["tracked"]
        w(f"- 已被 git 跟踪：**{stats['tracked']}**")
        w(f"- **未入库（只存在本机）：{untracked}**")
        if untracked:
            w("")
            w(
                f"> ⚠️ 这 {untracked} 份**只存在这台机器上**。整理/移动时一旦弄丢且没提交，就是真没了。"
                "移动任何文档前先确认它已被 git 跟踪，或先做物理备份。"
            )
    w("")

    # 五、全量清单
    w("## 五、全量清单（按目录 → 文件名）")
    w("")
    for directory in sorted(stats["buckets"]):
        recs = sorted(
            (r for r in records if r["dir"] == directory), key=lambda r: r["name"]
        )
        w(f"### `{directory}/` — {len(recs)} 份")
        w("")
        w("| 文件 | 前缀 | 文件名日期 | 内容首现 | 状态标记 | mtime |")
        w("|---|---|---|---|---|---|")
        for rec in recs:
            w(
                f"| [`{rec['name']}`](./{rec['rel'].split('docs/', 1)[1]}) "
                f"| `{rec['prefix']}` "
                f"| {rec['fname_date'] or '—'} "
                f"| {rec['content_date'] or '—'} "
                f"| {rec['marker'] or '—'} "
                f"| {rec['mtime'] or '—'} |"
            )
        w("")

    w("---")
    w("")
    w("## 六、相关入口")
    w("")
    w("- [`_INDEX.md`](./_INDEX.md) —— **可信度分级**，判断一份文档能不能信")
    w("- [`OPEN_ISSUES.md`](./OPEN_ISSUES.md) —— 未解决问题与优先级")
    w("- [`_active/_README.md`](./_active/_README.md) —— 新文档怎么放、怎么起名")
    w("- [`_archive/_README.md`](./_archive/_README.md) —— 归档判据")
    w("- [`../agents.md`](../agents.md) —— 所有 agent 开工必读")
    w("")
    return "\n".join(out)


def main() -> int:
    parser = argparse.ArgumentParser(description="生成 docs/_CATALOG.md")
    parser.add_argument("--check", action="store_true", help="只校验是否过期，不写文件")
    parser.add_argument("--stdout", action="store_true", help="打到标准输出，不写文件")
    args = parser.parse_args()

    records, stats = collect()
    content = render(records, stats)

    if args.stdout:
        sys.stdout.buffer.write(content.encode("utf-8"))
        return 0

    if args.check:
        if not CATALOG_PATH.exists():
            print(f"[docs-catalog] MISSING {CATALOG_PATH.relative_to(REPO_ROOT)}")
            return 1
        current = CATALOG_PATH.read_text(encoding="utf-8", errors="replace")
        if _strip_volatile(current) != _strip_volatile(content):
            print(
                f"[docs-catalog] STALE  {CATALOG_PATH.relative_to(REPO_ROOT)} "
                f"已与 docs/ 实际内容不符"
            )
            print(f"[docs-catalog] 修复：python scripts/docs/gen_docs_catalog.py")
            print(
                f"[docs-catalog] （本 hook 不自动写文件，避免在共享工作区动别人的暂存区）"
            )
            return 1
        print(f"[docs-catalog] OK     {stats['total']} docs, catalog up to date")
        return 0

    CATALOG_PATH.write_text(content, encoding="utf-8")
    # 只打 ASCII，避免 Windows 终端 cp936 乱码
    print(
        f"[docs-catalog] wrote {CATALOG_PATH.relative_to(REPO_ROOT).as_posix()} "
        f"({stats['total']} docs, {len(stats['date_diverge'])} date-divergent, "
        f"tracked={stats['tracked']})"
    )
    return 0


def _strip_volatile(text: str) -> str:
    """抹掉每次都会变的字段，只比实质内容 —— 否则 --check 永远失败。

    抹掉两类：
      1. 生成时间戳 —— 每次运行都变。
      2. mtime 列 —— 任何人改一份文档就变，而"文档被改了"不是目录过期。
         目录过期指的是**文件增删/移动/改名**，那些不抹。
    """
    text = re.sub(r"> \*\*生成时间：.*?\*\*", "", text)
    # 全量清单表格的 mtime 是最后一列，只影响以 | 结尾且末列为日期的行
    text = re.sub(r"(\| 20\d{2}-\d{2}-\d{2}) \|", " |", text)
    return text


if __name__ == "__main__":
    raise SystemExit(main())
