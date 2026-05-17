#!/bin/bash
sleep 15
sudo mkdir -p /sys/fs/cgroup/frp_protected
echo 0 | sudo tee /sys/fs/cgroup/frp_protected/memory.swap.max > /dev/null
echo max | sudo tee /sys/fs/cgroup/frp_protected/memory.max > /dev/null
# Protect FRP containers
FRONTEND_PID=$(sudo docker inspect --format "{{.State.Pid}}" frp-frontend 2>/dev/null) || true
if [ -n "$FRONTEND_PID" ]; then echo $FRONTEND_PID | sudo tee /sys/fs/cgroup/frp_protected/cgroup.procs > /dev/null; fi
BACKEND_PID=$(sudo docker inspect --format "{{.State.Pid}}" frp-backend 2>/dev/null) || true
if [ -n "$BACKEND_PID" ]; then echo $BACKEND_PID | sudo tee /sys/fs/cgroup/frp_protected/cgroup.procs > /dev/null; fi
REDIS_PID=$(sudo docker inspect --format "{{.State.Pid}}" frp-redis 2>/dev/null) || true
if [ -n "$REDIS_PID" ]; then echo $REDIS_PID | sudo tee /sys/fs/cgroup/frp_protected/cgroup.procs > /dev/null; fi
FRPS_PID=$(sudo docker inspect --format "{{.State.Pid}}" frps 2>/dev/null) || true
if [ -n "$FRPS_PID" ]; then echo $FRPS_PID | sudo tee /sys/fs/cgroup/frp_protected/cgroup.procs > /dev/null; fi
# Also protect host frps process if running (not in docker)
HOST_FRPS_PID=$(pgrep -f "frps" 2>/dev/null || true)
if [ -n "$HOST_FRPS_PID" ]; then
    for pid in $HOST_FRPS_PID; do
        echo $pid | sudo tee /sys/fs/cgroup/frp_protected/cgroup.procs > /dev/null 2>/dev/null || true
    done
fi
logger -t FRP-MEM-PROTECT "FRP memory protection initialized"
exit 0
