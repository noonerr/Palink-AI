#!/usr/bin/env python3
import os
import re
import subprocess
import sys
from typing import Iterable, List, Tuple

PATTERNS: List[Tuple[str, re.Pattern[str]]] = [
    ("OpenAI key", re.compile(r"sk-[A-Za-z0-9_-]{20,}")),
    ("AWS access key", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("Private key block", re.compile(r"-----BEGIN (?:RSA|EC|OPENSSH|DSA|PRIVATE) KEY-----")),
    ("Slack token", re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,}")),
    (
        "Plaintext provider api_key",
        re.compile(r'"api_key"\s*:\s*"(?!env:|\$\{)[^"]+"', re.IGNORECASE),
    ),
]

ALLOWLIST_SUBSTRINGS = (
    "your_api_key",
    "your-key",
    "example",
    "demo",
    "sample",
    "placeholder",
)

TEXT_EXTENSIONS = {
    ".py", ".ts", ".tsx", ".js", ".jsx", ".json", ".yaml", ".yml", ".md", ".toml", ".ini", ".env", ".sh", ".ps1", ".txt", ".html", ".css"
}


def run_git(args: List[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", *args], capture_output=True, text=True, encoding="utf-8", errors="ignore")


def staged_files() -> List[str]:
    result = run_git(["diff", "--cached", "--name-only", "--diff-filter=ACM"])
    if result.returncode != 0:
        print("[secret-scan] failed to list staged files")
        print(result.stderr.strip())
        sys.exit(2)

    files = []
    for line in result.stdout.splitlines():
        path = line.strip()
        if not path:
            continue
        _, ext = os.path.splitext(path)
        if ext.lower() in TEXT_EXTENSIONS or ext == "":
            files.append(path)
    return files


def read_staged_file(path: str) -> str:
    blob = run_git(["show", f":{path}"])
    if blob.returncode != 0:
        return ""
    return blob.stdout


def is_allowlisted(line: str) -> bool:
    lowered = line.lower()
    return any(token in lowered for token in ALLOWLIST_SUBSTRINGS)


def scan_content(path: str, content: str) -> Iterable[Tuple[str, int, str]]:
    for index, line in enumerate(content.splitlines(), start=1):
        if is_allowlisted(line):
            continue
        for label, pattern in PATTERNS:
            if pattern.search(line):
                yield (path, index, label)


def main() -> int:
    files = staged_files()
    if not files:
        return 0

    findings: List[Tuple[str, int, str]] = []
    for path in files:
        content = read_staged_file(path)
        if not content:
            continue
        findings.extend(scan_content(path, content))

    if not findings:
        print("[secret-scan] OK: no high-risk secrets found in staged changes")
        return 0

    print("[secret-scan] BLOCKED: potential secrets found in staged changes")
    for path, line, label in findings:
        print(f"  - {path}:{line} -> {label}")

    print("[secret-scan] Use env:VAR_NAME or ${VAR_NAME} references instead of plaintext secrets.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
