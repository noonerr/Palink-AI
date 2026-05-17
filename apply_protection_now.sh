#!/bin/bash
# Apply memory protection NOW (no sleep)
sudo mkdir -p /sys/fs/cgroup/frp_protected
echo 0 | sudo tee /sys/fs/cgroup/frp_protected/memory.swap.max > /dev/null
echo max | sudo tee /sys/fs/cgroup/frp_protected/memory.max > /dev/null
# Protect FRP containers
FRONTEND_PID=$(sudo docker inspect --format "{{.State.Pid}}" frp-frontend 2>/dev/null) || true
if [ -n "$FRONTEND_PID" ]; then echo $FRONTEND_PID | sudo tee /sys/fs/cgroup/frp_protected/cgroup.procs > /dev/null; echo "Protected frp-frontend (PID $FRONTEND_PID)"; fi
BACKEND_PID=$(sudo docker inspect --format "{{.State.Pid}}" frp-backend 2>/dev/null) || true
if [ -n "$BACKEND_PID" ]; then echo $BACKEND_PID | sudo tee /sys/fs/cgroup/frp_protected/cgroup.procs > /dev/null; echo "Protected frp-backend (PID $BACKEND_PID)"; fi
REDIS_PID=$(sudo docker inspect --format "{{.State.Pid}}" frp-redis 2>/dev/null) || true
if [ -n "$REDIS_PID" ]; then echo $REDIS_PID | sudo tee /sys/fs/cgroup/frp_protected/cgroup.procs > /dev/null; echo "Protected frp-redis (PID $REDIS_PID)"; fi
FRPS_PID=$(sudo docker inspect --format "{{.State.Pid}}" frps 2>/dev/null) || true
if [ -n "$FRPS_PID" ]; then echo $FRPS_PID | sudo tee /sys/fs/cgroup/frp_protected/cgroup.procs > /dev/null; echo "Protected frps container (PID $FRPS_PID)"; fi
# Also protect host frps process if running
HOST_FRPS_PID=$(pgrep -f "frps" 2>/dev/null || true)
if [ -n "$HOST_FRPS_PID" ]; then
    for pid in $HOST_FRPS_PID; do
        echo $pid | sudo tee /sys/fs/cgroup/frp_protected/cgroup.procs > /dev/null 2>/dev/null || true
        echo "Protected host frps (PID $pid)"
    done
fi
logger -t FRP-MEM-PROTECT "Manual FRP memory protection applied"
echo "Done"
