#!/bin/bash
echo "=== cgroup 保护组中的进程 ==="
cat /sys/fs/cgroup/frp_protected/cgroup.procs
echo ""
echo "=== 检查这些进程的 Swap 使用情况 ==="
for pid in $(cat /sys/fs/cgroup/frp_protected/cgroup.procs 2>/dev/null); do
    if [ -f "/proc/$pid/status" ]; then
        swap=$(grep VmSwap /proc/$pid/status 2>/dev/null | awk '{print $2}')
        cmd=$(cat /proc/$pid/comm 2>/dev/null)
        cmdline=$(cat /proc/$pid/cmdline 2>/dev/null | tr '\0' ' ')
        echo "✓ PID $pid | $cmd | Swap: ${swap:-0} kB"
        if echo "$cmdline" | grep -q "frps\|frpc\|nginx\|gunicorn"; then
            echo "  → $cmdline"
        fi
    else
        echo "✗ PID $pid 不存在"
    fi
done
echo ""
echo "=== FRP 相关进程检查 ==="
ps aux | grep -E "frps|frpc|frp" | grep -v grep
echo ""
echo "=== 检查是否有遗漏的 FRP 进程 ==="
pgrep -af "frp" || echo "没有找到 frp 进程"
