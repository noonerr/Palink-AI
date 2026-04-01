#!/usr/bin/env python3
import argparse
import re
import subprocess
import sys
from dataclasses import dataclass
from typing import Dict, Iterable, List, Tuple

PATTERNS: List[Tuple[str, re.Pattern[str]]] = [
    ("OpenAI key", re.compile(r"sk-[A-Za-z0-9_-]{20,}")),
    ("AWS access key", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("Private key block", re.compile(r"-----BEGIN (?:RSA|EC|OPENSSH|DSA|PRIVATE) KEY-----")),
    ("Slack token", re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,}")),
    ("Plaintext provider api_key", re.compile(r'"api_key"\s*:\s*"(?!env:|\$\{)[^"]+"', re.IGNORECASE)),
]

ALLOWLIST_SUBSTRINGS = (
    "your_api_key",
    "your-key",
    "example",
    "demo",
    "sample",
    "placeholder",
)


@dataclass
class Finding:
    sha: str
    path: str
    line: int
    label: str


def run_git(args: List[str], input_text: str = "") -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        input=input_text,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="ignore",
    )


def collect_blob_paths() -> Dict[str, str]:
    result = run_git(["rev-list", "--objects", "--all"])
    if result.returncode != 0:
        print("[history-secret-scan] failed to list git objects")
        print(result.stderr.strip())
        sys.exit(2)

    blob_path_by_sha: Dict[str, str] = {}
    for line in result.stdout.splitlines():
        if not line.strip():
            continue
        parts = line.split(" ", 1)
        sha = parts[0].strip()
        path = parts[1].strip() if len(parts) > 1 else "<unknown>"
        if sha and sha not in blob_path_by_sha:
            blob_path_by_sha[sha] = path
    return blob_path_by_sha


def batch_type_size(shas: Iterable[str]) -> Dict[str, Tuple[str, int]]:
    sha_list = list(shas)
    if not sha_list:
        return {}

    payload = "\n".join(sha_list) + "\n"
    result = run_git(["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], input_text=payload)
    if result.returncode != 0:
        print("[history-secret-scan] failed to query object metadata")
        print(result.stderr.strip())
        sys.exit(2)

    output: Dict[str, Tuple[str, int]] = {}
    for line in result.stdout.splitlines():
        parts = line.strip().split()
        if len(parts) != 3:
            continue
        sha, obj_type, size_text = parts
        try:
            output[sha] = (obj_type, int(size_text))
        except ValueError:
            continue
    return output


def read_blob_text(sha: str) -> str:
    result = run_git(["cat-file", "-p", sha])
    if result.returncode != 0:
        return ""
    return result.stdout


def is_allowlisted(line: str) -> bool:
    lowered = line.lower()
    return any(token in lowered for token in ALLOWLIST_SUBSTRINGS)


def scan_blob(sha: str, path: str, content: str) -> List[Finding]:
    findings: List[Finding] = []
    for i, line in enumerate(content.splitlines(), start=1):
        if is_allowlisted(line):
            continue
        for label, pattern in PATTERNS:
            if pattern.search(line):
                findings.append(Finding(sha=sha, path=path, line=i, label=label))
    return findings


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Scan git history blobs for potential secret leaks")
    parser.add_argument("--max-blob-bytes", type=int, default=2 * 1024 * 1024, help="Skip blobs larger than this size")
    parser.add_argument("--max-findings", type=int, default=200, help="Stop after this many findings")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    blob_path_by_sha = collect_blob_paths()
    meta = batch_type_size(blob_path_by_sha.keys())

    findings: List[Finding] = []
    scanned = 0

    for sha, path in blob_path_by_sha.items():
        obj_type, size = meta.get(sha, ("", 0))
        if obj_type != "blob":
            continue
        if args.max_blob_bytes > 0 and size > args.max_blob_bytes:
            continue

        scanned += 1
        content = read_blob_text(sha)
        if not content:
            continue

        findings.extend(scan_blob(sha, path, content))
        if len(findings) >= args.max_findings:
            break

    print(f"[history-secret-scan] scanned blobs: {scanned}")

    if not findings:
        print("[history-secret-scan] OK: no high-risk secret patterns found in scanned history blobs")
        return 0

    print("[history-secret-scan] FOUND: potential secret leaks in git history")
    for finding in findings[: args.max_findings]:
        print(f"  - {finding.path}:{finding.line} ({finding.sha[:12]}) -> {finding.label}")

    print("[history-secret-scan] Next steps:")
    print("  1) Rotate exposed keys immediately.")
    print("  2) Rewrite git history if secrets were ever pushed.")
    print("  3) Run `git gc --prune=now --aggressive` after history cleanup.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
