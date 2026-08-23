"""监控 backend 内存与健康状态，异常时抓取线程栈（用于定位无限加载/卡死）。

用法（宿主机 PowerShell）：
    python backend/scripts/_monitor_backend.py
"""

import json
import subprocess
import sys
import time
import os

BACKEND = "palink-ai-backend-1"
MEM_THRESHOLD_MB = 1500
HEALTH_TIMEOUT_S = 5
INTERVAL_S = 5
LOG_FILE = os.path.join(os.path.dirname(__file__), "_monitor_backend.log")


def run(cmd: list[str]) -> str:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return r.stdout.strip()
    except Exception as e:
        return f"ERR:{e}"


def get_mem_mb() -> float:
    out = run(["docker", "stats", "--no-stream", "--format", "{{.MemUsage}}", BACKEND])
    # 格式: "1.975GiB / 2GiB"
    try:
        part = out.split("/")[0].strip()
        if part.endswith("GiB"):
            return float(part[:-3]) * 1024
        if part.endswith("MiB"):
            return float(part[:-3])
        if part.endswith("KiB"):
            return float(part[:-3]) / 1024
    except Exception:
        pass
    return -1


def check_health() -> float:
    out = run(["docker", "exec", BACKEND, "sh", "-c",
               f"timeout {HEALTH_TIMEOUT_S} curl -s -o /dev/null -w '%{{time_total}}' http://localhost:8000/health"])
    try:
        return float(out)
    except Exception:
        return -1


def dump_threads(tag: str) -> None:
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(f"\n===== {tag} @ {time.strftime('%H:%M:%S')} =====\n")
        # 线程数
        out = run(["docker", "exec", BACKEND, "sh", "-c", "ls /proc/1/task | wc -l"])
        f.write(f"threads={out}\n")
        # 进程状态
        out = run(["docker", "exec", BACKEND, "sh", "-c",
                   "cat /proc/1/status | grep -E 'Threads|VmRSS|VmSize|State'"])
        f.write(f"{out}\n")
        # 尝试 py-spy（若存在）
        out = run(["docker", "exec", BACKEND, "sh", "-c",
                   "which py-spy && py-spy dump --pid 1 || echo 'no py-spy'"])
        f.write(f"{out}\n")
        # 最近日志
        out = run(["docker", "logs", BACKEND, "--tail", "20"])
        f.write(f"--- logs ---\n{out}\n")


def main() -> None:
    print(f"监控 backend 内存(>{MEM_THRESHOLD_MB}MB)与 /health 超时(>{HEALTH_TIMEOUT_S}s)，每 {INTERVAL_S}s 一次")
    print(f"日志写入: {LOG_FILE}")
    high_count = 0
    while True:
        mem = get_mem_mb()
        health = check_health()
        ts = time.strftime("%H:%M:%S")
        print(f"[{ts}] mem={mem:.0f}MB health={health}s")
        if mem > MEM_THRESHOLD_MB or health < 0:
            high_count += 1
            dump_threads(f"ANOMALY mem={mem:.0f}MB health={health}s")
            if high_count >= 3:
                print("连续异常 3 次，停止监控")
                break
        else:
            high_count = 0
        time.sleep(INTERVAL_S)


if __name__ == "__main__":
    main()