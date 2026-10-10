#!/usr/bin/env python3
"""Palink 资源自适应调优器。

做什么
------
按**当前这台机器**的 CPU / 内存，算出各容器的资源上限与后端 worker 参数，
写进 `.env` 的 AUTOTUNE 段。`docker-compose.yml` 从 `.env` 读这些值，
于是同一份 compose 在 4 核小机和 32 核大机上得到不同的配置。

为什么需要它
------------
`backend/start-server.sh` 本身会自动检测 cgroup 限制来算 worker 数，
但那个"笼子"（compose 里的 cpus / memory）此前是写死的 2 核 2G，
导致无论多强的机器都只能算出 1 个 worker。本脚本解决的是笼子大小。

用法
----
    python scripts/autotune.py            # 写入 .env
    python scripts/autotune.py --dry-run  # 只打印，不写文件
    python scripts/autotune.py --check    # 检查 .env 是否与当前机器匹配
    python scripts/autotune.py --cpu 8 --memory 16384   # 手动指定（不放心里用它）

幂等：重复运行得到同样的结果；AUTOTUNE 段会被整体替换，不影响 .env 其他内容。
"""

from __future__ import annotations

import argparse
import ctypes
import datetime as _dt
import os
import re
import sys

# --------------------------------------------------------------------------
# 调优策略（改这里就能调整整体取向）
# --------------------------------------------------------------------------

# 各服务占宿主机 CPU 的比例；容器 limits 是上限、允许短暂超配，
# 但比例之和控制在 85% 以内，给系统/宿主留余量。
CPU_SHARE = {
    "backend": 0.30,
    "ollama": 0.40,   # 推理最吃 CPU，给最多
    "db": 0.15,
}

# 最小 CPU 下限（核），小机器也不至于饿死
CPU_FLOOR = {
    "backend": 2.0,
    "ollama": 2.0,
    "db": 1.0,
}

# 内存下限（MB）：低于这个数服务跑不起来/模型装不下
MEM_FLOOR_MB = {
    "backend": 2048,
    "ollama": 3072,   # bge-m3 1.2G + 一个对话模型 + 余量
    "db": 512,
}

# 内存占宿主机比例
MEM_SHARE = {
    "backend": 0.15,
    "ollama": 0.25,
    "db": 0.08,
}

# 前端 nginx 占用（MB）与系统预留（MB）
FRONTEND_MB = 512
HEADROOM_MB = 1024

# 压缩时任何服务都不低于此值（MB）
MEM_HARD_FLOOR_MB = 256

# 单个 backend worker 的内存预算（MB）。
# 实测单进程稳态 RSS ≈ 461 MB，取 700 留约 50% 余量应对峰值。
PER_WORKER_MB = 700

# backend 容器内留给 OS/连接池/缓存的预留比例（占 backend 限额）
RESERVE_RATIO = 0.20

# worker 上限，避免小机器上开一堆进程反而抖动
WORKER_CAP = 8

BEGIN = "# ===== PALINK AUTOTUNE BEGIN ====="
END = "# ===== PALINK AUTOTUNE END ====="


# --------------------------------------------------------------------------
# 硬件检测（跨平台，无第三方依赖）
# --------------------------------------------------------------------------

def detect_cpu() -> int:
    n = os.cpu_count()
    if n:
        return int(n)
    # 兜底：Linux cgroup 或环境变量
    for path in ("/sys/fs/cgroup/cpu.max",):
        try:
            with open(path, encoding="utf-8") as fh:
                q, p = fh.read().split()
                if q != "max":
                    return max(1, int(int(q) / int(p)))
        except Exception:
            pass
    return 2


def detect_memory_mb() -> int:
    # Linux
    try:
        with open("/proc/meminfo", encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("MemTotal:"):
                    return int(line.split()[1]) // 1024
    except Exception:
        pass

    # Windows
    if sys.platform == "win32":
        try:

            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            stat = MEMORYSTATUSEX()
            stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat))
            return int(stat.ullTotalPhys // (1024 * 1024))
        except Exception:
            pass

    # macOS
    try:
        import subprocess

        out = subprocess.check_output(["sysctl", "-n", "hw.memsize"], text=True)
        return int(out.strip()) // (1024 * 1024)
    except Exception:
        pass

    return 8192  # 保守兜底


# --------------------------------------------------------------------------
# 计算
# --------------------------------------------------------------------------

def _cpu_for(service: str, total_cpu: int) -> float:
    return max(CPU_FLOOR[service], round(total_cpu * CPU_SHARE[service], 1))


def _mem_for(service: str, total_mb: int) -> int:
    return int(max(MEM_FLOOR_MB[service], total_mb * MEM_SHARE[service]))


def compute(total_cpu: int, total_mb: int) -> dict:
    cpu = {s: _cpu_for(s, total_cpu) for s in ("backend", "ollama", "db")}
    mem = {s: _mem_for(s, total_mb) for s in ("backend", "ollama", "db")}

    # 内存总账：容器限额 + 前端 + 系统余量 不得超过物理内存
    warnings: list[str] = []
    budget = total_mb - HEADROOM_MB - FRONTEND_MB

    floor_total = sum(MEM_FLOOR_MB.values())
    if budget < floor_total:
        # 物理内存连"最低保障线"都撑不住 —— 必须压到线下，并明确告警。
        # 注意：这里**不能**再用 MEM_FLOOR 兜底，否则压缩会被顶回去，
        # 出现"限额总和 > 物理内存"的假配置（小机器上会真的 OOM）。
        scale = budget / floor_total
        mem = {s: max(MEM_HARD_FLOOR_MB, int(MEM_FLOOR_MB[s] * scale)) for s in mem}
        warnings.append(
            f"物理内存偏小（{total_mb} MB）：三个服务最低也要 {floor_total} MB，"
            f"现已整体压缩。建议加大内存，或改用云端模型关掉本地 ollama。"
        )
    elif sum(mem.values()) > budget:
        scale = budget / sum(mem.values())
        mem = {s: max(MEM_FLOOR_MB[s], int(mem[s] * scale)) for s in mem}
        # 保了下限之后可能又超预算：按优先级从 ollama → db 往下砍
        excess = sum(mem.values()) - budget
        for s in ("ollama", "db"):
            if excess <= 0:
                break
            cut = min(excess, mem[s] - MEM_HARD_FLOOR_MB)
            if cut > 0:
                mem[s] -= cut
                excess -= cut

    # backend worker 数
    reserve = int(mem["backend"] * RESERVE_RATIO)
    usable = max(256, mem["backend"] - reserve)
    by_mem = usable // PER_WORKER_MB
    by_cpu = int(cpu["backend"])
    workers = max(1, min(by_cpu, by_mem, WORKER_CAP))

    # profile：按每个 worker 能分到的内存宽裕度选
    per_worker = usable / workers
    if per_worker < 600:
        profile = "eco"          # divisor 6：尽量少开
    elif per_worker < 1200:
        profile = "balanced"     # divisor 4
    else:
        profile = "throughput"   # divisor 2

    if per_worker < 450:
        warnings.append(
            f"backend 每个 worker 仅 {int(per_worker)} MB，偏紧；"
            f"长会话大上下文下可能吃力。建议加大内存或减少 worker 数。"
        )

    result = {
        "PALINK_BACKEND_CPUS": f"{cpu['backend']:.1f}",
        "PALINK_BACKEND_MEMORY": f"{mem['backend']}M",
        "PALINK_OLLAMA_CPUS": f"{cpu['ollama']:.1f}",
        "PALINK_OLLAMA_MEMORY": f"{mem['ollama']}M",
        "PALINK_DB_CPUS": f"{cpu['db']:.1f}",
        "PALINK_DB_MEMORY": f"{mem['db']}M",
        "APP_PERFORMANCE_PROFILE": profile,
        "APP_MIN_WORKERS": str(workers),
        "APP_MAX_WORKERS": str(workers),
        "UVICORN_WORKERS_MAX": str(workers),
        "APP_MEMORY_RESERVE_MB": str(reserve),
        "APP_MEMORY_PER_WORKER_MB": str(PER_WORKER_MB),
        "APP_CPU_THREADS_PER_WORKER_MAX": str(max(2, min(4, int(cpu["backend"])))),
    }
    return result, warnings


def render_block(values: dict, total_cpu: int, total_mb: int) -> str:
    stamp = _dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    lines = [
        BEGIN,
        f"# 由 scripts/autotune.py 生成于 {stamp}",
        f"# 检测到的主机：{total_cpu} 核 / {total_mb / 1024:.1f} GB",
        "# 重新生成：python scripts/autotune.py",
        "",
    ]
    width = max(len(k) for k in values)
    for k, v in values.items():
        lines.append(f"{k:<{width}}={v}")
    lines += ["", END]
    return "\n".join(lines)


def read_env(path: str) -> str:
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read()
    except FileNotFoundError:
        return ""


def apply_block(content: str, block: str) -> str:
    """替换已有 AUTOTUNE 段；没有就追加。保持其余内容原样。"""
    pattern = re.compile(
        re.escape(BEGIN) + r".*?" + re.escape(END), re.DOTALL
    )
    if pattern.search(content):
        return pattern.sub(lambda _m: block, content, count=1)
    sep = "" if (content == "" or content.endswith("\n")) else "\n"
    return content + sep + "\n" + block + "\n"


def parse_existing(content: str) -> dict | None:
    pattern = re.compile(
        re.escape(BEGIN) + r"(.*?)" + re.escape(END), re.DOTALL
    )
    m = pattern.search(content)
    if not m:
        return None
    out = {}
    for line in m.group(1).splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


# --------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description="Palink 资源自适应调优")
    ap.add_argument("--dry-run", action="store_true", help="只打印，不写 .env")
    ap.add_argument("--check", action="store_true", help="检查 .env 是否与当前机器匹配")
    ap.add_argument("--cpu", type=int, default=None, help="手动指定 CPU 核数")
    ap.add_argument("--memory", type=int, default=None, help="手动指定总内存(MB)")
    ap.add_argument("--env", default=None, help=".env 路径（默认仓库根）")
    args = ap.parse_args()

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    env_path = args.env or os.path.join(root, ".env")

    total_cpu = args.cpu or detect_cpu()
    total_mb = args.memory or detect_memory_mb()

    values, warnings = compute(total_cpu, total_mb)

    print(f"[autotune] 主机：{total_cpu} 核 / {total_mb / 1024:.1f} GB")
    print(f"[autotune] 推荐配置：")
    width = max(len(k) for k in values)
    for k, v in values.items():
        print(f"    {k:<{width}} = {v}")
    print(
        f"\n[autotune] 解读：backend {values['PALINK_BACKEND_CPUS']} 核 / "
        f"{values['PALINK_BACKEND_MEMORY']}，开 {values['APP_MIN_WORKERS']} 个 worker，"
        f"档位 {values['APP_PERFORMANCE_PROFILE']}"
    )
    for w in warnings:
        print(f"[autotune] ⚠ {w}")

    if args.check:
        old = parse_existing(read_env(env_path))
        if old is None:
            print("\n[check] .env 里没有 AUTOTUNE 段 —— 需要生成")
            return 1
        diff = {k: (old.get(k), v) for k, v in values.items() if old.get(k) != v}
        if not diff:
            print("\n[check] OK —— .env 与当前机器匹配")
            return 0
        print("\n[check] STALE —— 以下项需要更新：")
        for k, (o, n) in diff.items():
            print(f"    {k}: {o} -> {n}")
        return 1

    if args.dry_run:
        print("\n[dry-run] 未写入任何文件")
        return 0

    content = read_env(env_path)
    new_content = apply_block(content, render_block(values, total_cpu, total_mb))
    with open(env_path, "w", encoding="utf-8") as fh:
        fh.write(new_content)
    print(f"\n[autotune] 已写入 {env_path}")
    print("[autotune] 生效方式：docker compose up -d（backend/ollama/db 会按新限额重建）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
