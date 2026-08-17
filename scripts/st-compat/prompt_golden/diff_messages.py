"""提示词黄金向量 diff 工具。

比较 Palink 侧与 ST 侧的 messages 数组，输出逐条等价率报告。

用法:
    python diff_messages.py palink_basic_char.json st_basic_char.json
    python diff_messages.py --dir results/  (自动配对 palink_*.json 与 st_*.json)
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from difflib import unified_diff


def load_golden(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def normalize_message(msg: dict) -> dict:
    """标准化消息格式以便比较。"""
    role = msg.get("role", "")
    content = msg.get("content", "")
    # content 可能是 str 或 list（多模态）
    if isinstance(content, list):
        # 提取文本部分
        text_parts = [p.get("text", "") for p in content if p.get("type") == "text"]
        content = "\n".join(text_parts)
    # V-1 修复: 保留 name 字段（ST 示例消息注入 example_user/example_assistant name）。
    # 之前丢弃 name 导致示例消息缺 name 的真实差异被掩盖，违反 spec 3.9"不允许字段差异"。
    name = msg.get("name")
    return {
        "role": role,
        "content": content.strip() if isinstance(content, str) else content,
        "name": str(name) if name is not None else None,
    }


def compare_messages(palink_msgs: list[dict], st_msgs: list[dict], verbose: bool = False) -> dict:
    """逐条比较两个 messages 数组，返回等价率报告。"""
    report = {
        "palink_count": len(palink_msgs),
        "st_count": len(st_msgs),
        "count_match": len(palink_msgs) == len(st_msgs),
        "comparisons": [],
        "equivalence_rate": 0.0,
        "role_mismatches": [],
        "name_mismatches": [],
        "content_mismatches": [],
        "extra_in_palink": [],
        "extra_in_st": [],
    }

    max_len = max(len(palink_msgs), len(st_msgs))
    matches = 0

    for i in range(max_len):
        p_msg = normalize_message(palink_msgs[i]) if i < len(palink_msgs) else None
        s_msg = normalize_message(st_msgs[i]) if i < len(st_msgs) else None

        comparison = {"index": i, "match": False, "issues": []}

        if p_msg is None:
            comparison["issues"].append("missing_in_palink")
            report["extra_in_st"].append({"index": i, "message": s_msg})
        elif s_msg is None:
            comparison["issues"].append("missing_in_st")
            report["extra_in_palink"].append({"index": i, "message": p_msg})
        else:
            # 比较 role
            if p_msg["role"] != s_msg["role"]:
                comparison["issues"].append(f"role_mismatch: palink={p_msg['role']} st={s_msg['role']}")
                report["role_mismatches"].append({
                    "index": i, "palink_role": p_msg["role"], "st_role": s_msg["role"]
                })

            # V-1: 比较 name 字段（spec 3.9 逐字段一致，示例消息 name 差异不应被掩盖）
            p_name = p_msg.get("name")
            s_name = s_msg.get("name")
            if (p_name or "") != (s_name or ""):
                comparison["issues"].append(
                    f"name_mismatch: palink={p_name!r} st={s_name!r}"
                )
                report["name_mismatches"].append({
                    "index": i, "palink_name": p_name, "st_name": s_name
                })

            # V-1: name/role 任一不一致则本条不算匹配（逐字段一致）
            structural_ok = not any(
                issue.startswith(("role_mismatch", "name_mismatch"))
                for issue in comparison["issues"]
            )

            # 比较 content
            p_content = p_msg["content"]
            s_content = s_msg["content"]
            if p_content != s_content:
                # 计算相似度
                if isinstance(p_content, str) and isinstance(s_content, str):
                    # 忽略首尾空白差异
                    p_stripped = p_content.strip()
                    s_stripped = s_content.strip()
                    if p_stripped == s_stripped:
                        comparison["issues"].append("whitespace_only_diff")
                        if structural_ok:
                            matches += 1  # 仅空白差异视为匹配
                            comparison["match"] = True
                    else:
                        # 计算字符级相似度
                        from difflib import SequenceMatcher
                        ratio = SequenceMatcher(None, p_stripped, s_stripped).ratio()
                        comparison["issues"].append(f"content_diff (similarity={ratio:.3f})")
                        comparison["similarity"] = ratio
                        report["content_mismatches"].append({
                            "index": i,
                            "role": p_msg["role"],
                            "similarity": ratio,
                            "palink_preview": p_stripped[:200],
                            "st_preview": s_stripped[:200],
                        })
                        if verbose:
                            diff_lines = list(unified_diff(
                                s_stripped.splitlines(keepends=True),
                                p_stripped.splitlines(keepends=True),
                                fromfile="st", tofile="palink", lineterm=""
                            ))
                            comparison["diff"] = diff_lines[:50]  # 限制 diff 行数
                        if ratio > 0.95:
                            matches += 0.5  # 高相似度给半分
                else:
                    comparison["issues"].append("content_type_mismatch")
                    report["content_mismatches"].append({
                        "index": i, "role": p_msg["role"],
                        "palink_type": type(p_content).__name__,
                        "st_type": type(s_content).__name__,
                    })
            else:
                if structural_ok:
                    matches += 1
                    comparison["match"] = True

        report["comparisons"].append(comparison)

    # 计算等价率
    if max_len > 0:
        report["equivalence_rate"] = round(matches / max_len * 100, 2)

    return report


def print_report(report: dict, fixture_name: str = ""):
    """打印人类可读的等价率报告。"""
    header = f"=== Prompt Equivalence Report: {fixture_name} ===" if fixture_name else "=== Prompt Equivalence Report ==="
    print(header)
    print(f"  Palink messages: {report['palink_count']}")
    print(f"  ST messages:     {report['st_count']}")
    print(f"  Count match:     {'YES' if report['count_match'] else 'NO'}")
    print(f"  Equivalence:     {report['equivalence_rate']}%")
    print()

    if report["role_mismatches"]:
        print(f"  Role mismatches ({len(report['role_mismatches'])}):")
        for rm in report["role_mismatches"][:10]:
            print(f"    [{rm['index']}] palink={rm['palink_role']} st={rm['st_role']}")
        print()

    if report["name_mismatches"]:
        print(f"  Name mismatches ({len(report['name_mismatches'])}):")
        for nm in report["name_mismatches"][:10]:
            print(f"    [{nm['index']}] palink={nm['palink_name']!r} st={nm['st_name']!r}")
        print()

    if report["content_mismatches"]:
        print(f"  Content mismatches ({len(report['content_mismatches'])}):")
        for cm in report["content_mismatches"][:10]:
            sim = cm.get("similarity", 0)
            print(f"    [{cm['index']}] role={cm['role']} similarity={sim:.3f}")
            if "palink_preview" in cm:
                print(f"      palink: {cm['palink_preview'][:100]}...")
                print(f"      st:     {cm['st_preview'][:100]}...")
        print()

    if report["extra_in_palink"]:
        print(f"  Extra in Palink ({len(report['extra_in_palink'])}):")
        for ep in report["extra_in_palink"][:5]:
            print(f"    [{ep['index']}] role={ep['message']['role']} content={ep['message']['content'][:80]}...")
        print()

    if report["extra_in_st"]:
        print(f"  Extra in ST ({len(report['extra_in_st'])}):")
        for es in report["extra_in_st"][:5]:
            print(f"    [{es['index']}] role={es['message']['role']} content={es['message']['content'][:80]}...")
        print()

    if report["equivalence_rate"] >= 99:
        print("  VERDICT: PASS (>=99% equivalence)")
    elif report["equivalence_rate"] >= 90:
        print("  VERDICT: PARTIAL (90-99% equivalence)")
    else:
        print("  VERDICT: FAIL (<90% equivalence)")
    print("=" * len(header))


def main():
    parser = argparse.ArgumentParser(description="Prompt golden vector diff tool")
    parser.add_argument("palink_file", nargs="?", help="Palink golden vector JSON")
    parser.add_argument("st_file", nargs="?", help="ST golden vector JSON")
    parser.add_argument("--dir", type=str, help="Directory containing paired palink_*/st_* files")
    parser.add_argument("--verbose", "-v", action="store_true", help="Show detailed diffs")
    parser.add_argument("--output", type=str, help="Write report as JSON")
    args = parser.parse_args()

    if args.dir:
        # 自动配对模式
        dir_path = Path(args.dir)
        palink_files = sorted(dir_path.glob("palink_*.json"))
        all_reports = []
        for pf in palink_files:
            fixture_name = pf.stem.replace("palink_", "")
            sf = dir_path / f"st_{fixture_name}.json"
            if not sf.exists():
                print(f"[SKIP] No ST counterpart for {pf.name}")
                continue
            palink_data = load_golden(str(pf))
            st_data = load_golden(str(sf))
            report = compare_messages(
                palink_data.get("messages", []),
                st_data.get("messages", []),
                verbose=args.verbose,
            )
            print_report(report, fixture_name)
            print()
            all_reports.append({"fixture": fixture_name, **report})

        if args.output:
            with open(args.output, "w", encoding="utf-8") as f:
                json.dump(all_reports, f, ensure_ascii=False, indent=2)
            print(f"[OK] Full report written to {args.output}")

    elif args.palink_file and args.st_file:
        palink_data = load_golden(args.palink_file)
        st_data = load_golden(args.st_file)
        fixture_name = palink_data.get("fixture", Path(args.palink_file).stem)
        report = compare_messages(
            palink_data.get("messages", []),
            st_data.get("messages", []),
            verbose=args.verbose,
        )
        print_report(report, fixture_name)

        if args.output:
            with open(args.output, "w", encoding="utf-8") as f:
                json.dump(report, f, ensure_ascii=False, indent=2)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
