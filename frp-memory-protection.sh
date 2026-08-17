#!/bin/bash
# FRP Memory Protection Script
# Prevents FRP-related processes from being swapped out

echo "Applying FRP memory protection..."

# Get PIDs of FRP-related processes
PIDS=""

# frps container process
for pid in $(pgrep -f "frps" 2>/dev/null); do
    PIDS="$PIDS $pid"
done

# frp-backend (gunicorn) processes
for pid in $(pgrep -f "gunicorn" 2>/dev/null); do
    PIDS="$PIDS $pid"
done

# nginx (frontend) processes
for pid in $(pgrep -f "nginx" 2>/dev/null); do
    PIDS="$PIDS $pid"
done

# redis process
for pid in $(pgrep -f "redis-server" 2>/dev/null); do
    PIDS="$PIDS $pid"
done

# Apply memory protection
for pid in $PIDS; do
    if [ -d "/proc/$pid" ]; then
        echo -1000 > /proc/$pid/oom_score_adj 2>/dev/null && echo "Protected PID $pid (oom_score_adj=-1000)"
        
        # Try to lock memory using cgroup v2
        cgroup_path=$(cat /proc/$pid/cgroup 2>/dev/null | grep -oP 'docker-\K[a-f0-9]+' | head -1)
        if [ -n "$cgroup_path" ]; then
            cg_path="/sys/fs/cgroup/docker/$cgroup_path"
            if [ -d "$cg_path" ]; then
                echo 0 > "$cg_path/memory.swap.max" 2>/dev/null && echo "  Swap disabled for cgroup $cgroup_path"
            fi
        fi
    fi
done

# Also protect docker-containerd-shim processes for FRP containers
for pid in $(pgrep -f "containerd-shim" 2>/dev/null); do
    if [ -d "/proc/$pid" ]; then
        echo -500 > /proc/$pid/oom_score_adj 2>/dev/null
    fi
done

echo "FRP memory protection applied."
