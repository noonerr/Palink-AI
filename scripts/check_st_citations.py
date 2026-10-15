#!/usr/bin/env python3
"""校验 docs/ 中对「上游源码 / 本仓源码」的 file:line 引用是否仍然可复核。

为什么有这个脚本（2026-10-15）：
    本项目的 ST 兼容准确性，一直是靠「读源码 -> 引用 file:line -> 修偏差」挣来的。
    实测 docs/ 里有近 400 处 `世界书.js:855-864` 形式的引用，它们直接支撑过多个 P0 修复
    （世界书 position 偏移 1、{{jailbreak}} 宏缺失、上传端点字段名 422 等）。
    但审计报告所引用的本地 ST 源码副本 `SillyTavern-1.18.0/` 一度从项目里消失，
    导致这些引用**在项目内无法复核** —— 换台机器、换个人，引用就成了一句无法验证的话。

    本脚本把「引用可复核」变成一条命令。上游锚定在 `_reference/sillytavern-1.18.0/`
    （见 .gitignore：该目录不入库，故换机器需按 _reference/README.md 重新锚定）。

引用引的是哪棵树（实测：文档同时引两棵，必须分开判）：
    ST上游  -> `_reference/sillytavern-1.18.0/`（public/ src/ default/）
    Palink  -> 本仓（st-plugins/ frontend/src/ backend/app/ scripts/）
    例：`chats.js:979` 指上游 `src/endpoints/chats.js`；
        而 `index.js:524` 指本仓 `st-plugins/memory/index.js`（同名文件极多，靠规则裁决）。

引用怎么定位（按可信度从高到低，绝不瞎猜）：
    0) 显式覆盖表（CITATION_OVERRIDES）—— 仅收录人工裁定过、证据充分的疑难引用
    1) 文档写全了路径（`src/endpoints/chats.js:483`）-> 直接命中；路径不存在时按**路径后缀**唯一匹配
       （`vectors/manifest.json` -> `public/scripts/extensions/vectors/manifest.json`）
    2) markdown 链接给出的完整 URL -> 从 URL 取路径
    3) 同一文档内对该文件名已有的显式写法 -> 沿用（文档自洽优先）
    4) 文件名在某一棵树中唯一 -> 直接用
    5) 同名文件有多个 -> 按**引用覆盖度**裁决：统计每个候选能容纳该文件名的多少条引用行号，
       取覆盖最多者；覆盖并列或全部落空才报 AMBIGUOUS（不猜）

判定口径：
    OK(ST上游) / OK(Palink)   定位成功，且引用行号在该文件行数范围内
    OUT_OF_RANGE              定位成功，但行号超出文件总行数   -> 失败（引用已陈旧）
    AMBIGUOUS                 无法唯一定位                     -> 失败（需在文档里补全路径）
    NOT_FOUND                 两棵树里都没有该文件名           -> 不计入失败（可能是第三方/已删文件）

用法：
    py scripts/check_st_citations.py              # 校验，失败时退出码 1
    py scripts/check_st_citations.py --list       # 逐条打印引用与实际内容
    py scripts/check_st_citations.py --json       # 机器可读输出
    py scripts/check_st_citations.py --explain    # 打印同名文件的覆盖度裁决过程
    py scripts/check_st_citations.py --manifest   # 输出上游参考副本 sha256 清单
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
REF_ROOT = REPO_ROOT / "_reference" / "sillytavern-1.18.0"
DOCS_DIR = REPO_ROOT / "docs"

DOCS_EXCLUDE_DIRS = {"_archive"}
SKIP_DIR_NAMES = {"node_modules", "dist", "dist_new", "__pycache__", ".git"}

# 同名文件超过这个数量就不做覆盖度裁决（见 coverage_resolve 注释）
MAX_COVERAGE_CANDIDATES = 6

# ── 人工裁定表：仅收录「按规则仍无法唯一裁决、但证据充分」的引用 ──────────────────
CITATION_OVERRIDES: dict[tuple[str, str], str] = {
    # 该引用论证「前端 canViewSecrets() 调 /api/secrets/settings，Palink 缺该端点」。
    # 证据：public/scripts/secrets.js:291 = `const response = await fetch('/api/secrets/settings', {`
    #       （位于 canViewSecrets() 内，:289 起）
    # 对照：src/endpoints/secrets.js:291 = `return;`（rotateSecret 内部，与本论点无关）
    ("DEEP_AUDIT_REPORT_2026-08-09.md", "secrets.js:291"): "public/scripts/secrets.js",
    ("PLUGIN_ISSUES_REPORT.md", "secrets.js:291"): "public/scripts/secrets.js",
    # 该引用论证「memory 插件以单对象调用 generateRaw，与本仓签名错位」。
    # 证据：st-plugins/memory/index.js:524 = `return removeReasoningFromString(await generateRaw({ prompt: text,
    #       systemPrompt: prompt, responseLength: extension_settings.memory.overrideResponseLength }));`
    #       :731 = `const rawSummary = await generateRaw(params);`（1131 行，两行号均在范围内）
    # 文档同句已写 "memory `index.js:524/731`"，即指向 memory 插件。
    ("DEEP_AUDIT_REPORT_2026-08-09.md", "index.js:524"): "st-plugins/memory/index.js",
}

CITE_RE = re.compile(
    r"(?<![\w.\-/])"
    r"(?:(?P<dir>(?:[A-Za-z0-9_.\-]+/)+))?"
    r"(?P<file>[A-Za-z0-9_.\-]+\.(?:js|json))"
    r":(?P<start>\d{1,5})(?:-(?P<end>\d{1,5}))?"
)
LINK_RE = re.compile(r"\[[^\]]*\]\(([^)]+)\)")
PATH_IN_URL_RE = re.compile(
    r"((?:public|src|default|st-plugins|frontend|backend|scripts)/[A-Za-z0-9_.\-/]*\.(?:js|json))"
)


class Tree:
    """一棵可校验的源码树。行数惰性计算，避免为几千个无关文件做 IO。"""

    def __init__(self, name: str, root: Path, subdirs: tuple[str, ...] | None = None,
                 exclude: tuple[str, ...] = ()):
        self.name = name
        self.root = root
        self.index: dict[str, list[str]] = collections.defaultdict(list)
        self._counts: dict[str, int | None] = {}
        if not root.is_dir():
            return
        bases = [root / s for s in subdirs] if subdirs else [root]
        for base in bases:
            if not base.is_dir():
                continue
            for p in base.rglob("*"):
                if not p.is_file() or p.suffix not in (".js", ".json"):
                    continue
                if SKIP_DIR_NAMES & set(p.parts) or any(part.startswith(".") for part in p.parts):
                    continue
                rel = p.relative_to(root).as_posix()
                if any(rel == ex or rel.startswith(ex + "/") for ex in exclude):
                    continue
                self.index[p.name].append(rel)

    def has(self, rel: str) -> bool:
        return (self.root / rel).is_file()

    def count(self, rel: str) -> int | None:
        if rel not in self._counts:
            try:
                self._counts[rel] = len(
                    (self.root / rel).read_text(encoding="utf-8", errors="replace").splitlines()
                )
            except OSError:
                self._counts[rel] = None
        return self._counts[rel]

    def lines(self, rel: str, start: int, end: int | None) -> list[str]:
        try:
            body = (self.root / rel).read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            return []
        end = end or start
        return [f"{i:5d}| {body[i - 1]}" for i in range(start, min(end, len(body)) + 1)]


REF_TREE = Tree("ST上游", REF_ROOT)
PALINK_TREE = Tree("Palink", REPO_ROOT,
                   subdirs=("st-plugins", "frontend/src", "backend/app", "scripts"),
                   # st-plugins/third-party/ 是 .gitignore 掉的第三方 vendor 转储，不属本仓可复核范围；
                   # 纳入它只会用同名副本污染后缀匹配（2026-10-15 实测：stable-diffusion/index.js 因此失配）。
                   exclude=("st-plugins/third-party",))
TREES = (REF_TREE, PALINK_TREE)


def collect_citations() -> list[dict]:
    out: list[dict] = []
    if not DOCS_DIR.is_dir():
        return out
    for md in sorted(DOCS_DIR.rglob("*.md")):
        rel = md.relative_to(DOCS_DIR)
        if any(part in DOCS_EXCLUDE_DIRS for part in rel.parts):
            continue
        try:
            text = md.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        doc = rel.as_posix()

        hints: dict[tuple[str, int], str] = {}
        for m in LINK_RE.finditer(text):
            found = PATH_IN_URL_RE.findall(m.group(1))
            if not found:
                continue
            path = max(found, key=len)
            for cm in CITE_RE.finditer(m.group(0)):
                hints[(cm.group("file"), int(cm.group("start")))] = path

        for m in CITE_RE.finditer(text):
            fname = m.group("file")
            start = int(m.group("start"))
            end = int(m.group("end")) if m.group("end") else None
            explicit = hints.get((fname, start))
            if explicit is None and m.group("dir"):
                explicit = m.group("dir") + fname
            out.append({
                "doc": doc, "file": fname, "start": start, "end": end, "explicit": explicit,
                "span": f"{fname}:{start}" + (f"-{end}" if end else ""),
            })
    return out


def resolve_explicit(explicit: str) -> tuple[Tree, str] | None:
    """把文档写明的候选路径落到某棵树里的真实文件：先直连，再按路径后缀唯一匹配。"""
    for t in TREES:
        if t.has(explicit):
            return t, explicit
    tail = "/" + explicit.lstrip("./")
    hits: list[tuple[Tree, str]] = []
    for t in TREES:
        for rels in t.index.values():
            for rel in rels:
                if rel.endswith(tail):
                    hits.append((t, rel))
    uniq = {(t.name, rel) for t, rel in hits}
    if len(uniq) == 1:
        name, rel = uniq.pop()
        return next(t for t in TREES if t.name == name), rel
    if uniq:
        # 多个同名副本时取**层级最浅**的那个（`stable-diffusion/index.js`
        # 显然指 st-plugins/stable-diffusion/index.js，而不是更深处的 vendor 副本）；
        # 最浅层级若并列则放弃，不猜。
        ranked = sorted(uniq, key=lambda x: (x[1].count("/"), x[1]))
        if len(ranked) == 1 or ranked[0][1].count("/") < ranked[1][1].count("/"):
            name, rel = ranked[0]
            return next(t for t in TREES if t.name == name), rel
    return None


def doc_scoped_prefs(cites) -> dict[tuple[str, str], tuple[Tree, str]]:
    """同一文档内对某文件名**只有唯一一种**显式写法时，才用它消除该文档内的裸文件名歧义。

    反例（2026-10-15 实测）：`docs/架构审查与缺陷总表_2026-10-03.md` 同一行里同时写了
    `memory/index.js:1127` 与 `stable-diffusion/index.js:5989` —— 同一 basename 指两个不同文件。
    此时任何"文档默认值"都是错的，必须放弃沿用，让它落到「未定位」。
    """
    seen: dict[tuple[str, str], set[tuple[str, str]]] = collections.defaultdict(set)
    for c in cites:
        if not c["explicit"]:
            continue
        hit = resolve_explicit(c["explicit"])
        if hit:
            seen[(c["doc"], c["file"])].add((hit[0].name, hit[1]))
    out: dict[tuple[str, str], tuple[Tree, str]] = {}
    for key, hits in seen.items():
        if len(hits) == 1:
            name, rel = next(iter(hits))
            out[key] = (next(t for t in TREES if t.name == name), rel)
    return out


def coverage_resolve(cites) -> tuple[dict[str, tuple[Tree, str]], dict[str, list]]:
    """对仍无法定位的同名文件，跨两棵树按引用覆盖度裁决。"""
    by_name: dict[str, set[int]] = collections.defaultdict(set)
    for c in cites:
        by_name[c["file"]].add(c["start"])
        by_name[c["file"]].add(c["end"] or c["start"])

    resolved: dict[str, tuple[Tree, str]] = {}
    scores: dict[str, list] = {}
    names = {n for t in TREES for n in t.index}
    for fname in names:
        cands = [(t, rel) for t in TREES for rel in t.index.get(fname, [])]
        if len(cands) == 1:
            resolved[fname] = cands[0]
            continue
        # 同名文件过多时，按 basename 聚合引用行号本身就失去意义
        # （index.js 的引用分散在 quick-reply / memory / stable-diffusion / electron 等不同文件里），
        # 此时不裁决，报「未定位」，等文档补全路径。
        if len(cands) > MAX_COVERAGE_CANDIDATES:
            continue
        lines = by_name.get(fname)
        if not lines:
            continue
        scored = [(t.name, rel, 0 if t.count(rel) is None else sum(1 for l in lines if l <= t.count(rel)))
                  for t, rel in cands]
        scored.sort(key=lambda x: (-x[2], x[0], x[1]))
        scores[fname] = scored
        # 保守门槛：胜者须覆盖 ≥90% 的引用行号、且严格优于次席，才敢裁决。
        # 否则宁可报「未定位」也不给假 OK —— 假 OK 比漏报危险得多（会让人误信引用已核）。
        total = len(lines)
        runner = scored[1][2] if len(scored) > 1 else 0
        if total and scored[0][2] >= 0.9 * total and scored[0][2] > runner:
            top = scored[0]
            resolved[fname] = next((t, rel) for t, rel in cands if t.name == top[0] and rel == top[1])
    return resolved, scores


def locate(c, prefs, resolved) -> tuple[str, Tree | None, str | None]:
    ov = CITATION_OVERRIDES.get((c["doc"], c["span"]))
    if ov:
        for t in TREES:
            if t.has(ov):
                n = t.count(ov)
                ok = n is not None and (c["end"] or c["start"]) <= n
                return ("OK(%s)" % t.name if ok else "OUT_OF_RANGE"), t, ov
        return "UNRESOLVED", None, ov

    if c["explicit"]:
        hit = resolve_explicit(c["explicit"])
        if hit:
            t, rel = hit
            n = t.count(rel)
            ok = n is not None and (c["end"] or c["start"]) <= n
            return ("OK(%s)" % t.name if ok else "OUT_OF_RANGE"), t, rel

    pref = prefs.get((c["doc"], c["file"]))
    if pref:
        t, rel = pref
        n = t.count(rel)
        ok = n is not None and (c["end"] or c["start"]) <= n
        return ("OK(%s)" % t.name if ok else "OUT_OF_RANGE"), t, rel

    cands = [(t, rel) for t in TREES for rel in t.index.get(c["file"], [])]
    if not cands:
        return "NOT_FOUND", None, None
    hit = resolved.get(c["file"])
    if hit is None:
        return "UNRESOLVED", cands[0][0], cands[0][1]
    t, rel = hit
    n = t.count(rel)
    if n is None:
        return "UNRESOLVED", t, rel
    return ("OK(%s)" % t.name if (c["end"] or c["start"]) <= n else "OUT_OF_RANGE"), t, rel


def tree_manifest() -> dict[str, str]:
    out: dict[str, str] = {}
    for p in sorted(REF_ROOT.rglob("*")):
        if p.is_file():
            out[p.relative_to(REF_ROOT).as_posix()] = hashlib.sha256(p.read_bytes()).hexdigest()
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="校验 docs 中的 file:line 引用是否可复核")
    ap.add_argument("--list", action="store_true", help="逐条打印引用与实际内容")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    ap.add_argument("--explain", action="store_true", help="打印同名文件的覆盖度裁决过程")
    ap.add_argument("--manifest", action="store_true", help="输出上游参考副本 sha256 清单")
    ap.add_argument("--strict", action="store_true",
                    help="把「未定位」（文档只写了裸文件名）也计为失败")
    args = ap.parse_args()

    if not REF_TREE.root.is_dir():
        print(f"[FAIL] 上游参考副本不存在: {REF_ROOT}")
        print("       锚定方法见 _reference/README.md（该目录不入库，换机器需重新锚定）")
        return 2

    if args.manifest:
        man = tree_manifest()
        print(json.dumps({"version": "1.18.0", "files": len(man), "sha256": man},
                         indent=2, ensure_ascii=False))
        return 0

    cites = collect_citations()
    prefs = doc_scoped_prefs(cites)
    resolved, scores = coverage_resolve(cites)

    buckets: dict[str, list] = collections.defaultdict(list)
    for c in cites:
        status, t, rel = locate(c, prefs, resolved)
        buckets[status].append((c, t, rel))

    # 失败 = 能唯一定位、但行号超出文件总行数（引用确已陈旧）。
    # 「未定位」不计失败：文档只写了裸文件名（index.js / package.json 等），
    # 无法证明它陈旧；但它确实是文档可复核性的短板，--strict 下升级为失败。
    fails = buckets["OUT_OF_RANGE"] + (buckets["UNRESOLVED"] if args.strict else [])
    n_ref = len(buckets["OK(ST上游)"])
    n_pal = len(buckets["OK(Palink)"])

    if args.json:
        print(json.dumps({
            "reference": str(REF_ROOT),
            "reference_files": sum(len(v) for v in REF_TREE.index.values()),
            "palink_files": sum(len(v) for v in PALINK_TREE.index.values()),
            "total_citations": len(cites),
            "ok_st_upstream": n_ref,
            "ok_palink": n_pal,
            "not_found": len(buckets["NOT_FOUND"]),
            "unresolved": len(buckets["UNRESOLVED"]),
            "failed": len(fails),
            "failures": [
                {"doc": c["doc"], "citation": c["span"], "status": st,
                 "resolved": f"{t.name}:{rel}" if t else rel}
                for st in (("OUT_OF_RANGE", "UNRESOLVED") if args.strict else ("OUT_OF_RANGE",))
                for (c, t, rel) in buckets[st]
            ],
        }, indent=2, ensure_ascii=False))
        return 1 if fails else 0

    print("=" * 72)
    print("docs 引用可复核性校验  (上游锚定版本 1.18.0)")
    print(f"上游参考副本: {REF_ROOT}")
    print("=" * 72)
    print(f"  文档中 file:line 引用总数        : {len(cites)}")
    print(f"  OK -> ST 上游                    : {n_ref}")
    print(f"  OK -> Palink 本仓                : {n_pal}")
    print(f"  两棵树都没有该文件名             : {len(buckets['NOT_FOUND'])}")
    print(f"  未定位（文档只写了裸文件名）     : {len(buckets['UNRESOLVED'])}")
    print(f"  失败（行号超出文件总行数）       : {len(buckets['OUT_OF_RANGE'])}")
    print()

    if fails:
        print("--- 失败明细（引用已陈旧）---")
        for c, t, rel in buckets["OUT_OF_RANGE"]:
            print(f"  [OUT_OF_RANGE] {c['span']}   <- docs/{c['doc']}")
            if t and rel:
                print(f"         定位到: [{t.name}] {rel}（共 {t.count(rel)} 行）")
        print()

    if buckets["UNRESOLVED"]:
        note = "--- 未定位明细（文档只写了裸文件名，无法证明其陈旧）---"
        print(note)
        by_name: dict[str, int] = collections.Counter()
        for c, _, _ in buckets["UNRESOLVED"]:
            by_name[c["file"]] += 1
        for fname, n in by_name.most_common():
            print(f"  {n:3d} 处  {fname}")
        print("  （这些引用要变成可复核，需在文档里写全路径，如 `src/endpoints/chats.js:979`）")
        print()

    if args.explain:
        print("--- 同名文件的覆盖度裁决过程 ---")
        for fname, scored in sorted(scores.items(), key=lambda kv: -len(kv[1]))[:12]:
            win = resolved.get(fname)
            w = f"{win[0].name}:{win[1]}" if win else "未裁决(未定位)"
            print(f"\n{fname}  ({len(scored)} 个候选)  裁决 -> {w}")
            for tname, rel, cov in scored[:5]:
                mark = "   <== 胜出" if win and (win[0].name, win[1]) == (tname, rel) else ""
                print(f"    {cov:4d} 条引用可容纳   [{tname}] {rel}{mark}")
        print()

    if args.list:
        print("--- 全部引用与实际内容 ---")
        for c in cites:
            status, t, rel = locate(c, prefs, resolved)
            extra = f"   (文档写明路径: {c['explicit']})" if c["explicit"] else ""
            print(f"\n[{status}] {c['span']}   <- docs/{c['doc']}{extra}")
            if t and rel and status.startswith("OK"):
                for ln in t.lines(rel, c["start"], c["end"]):
                    print(f"    {ln}")
        print()

    print(f"failed = {len(fails)}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
