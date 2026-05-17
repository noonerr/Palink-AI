#!/bin/bash
# Check swap usage per process
echo -e "PID\t\tSWAP (kB)\tCOMMAND"
echo "---------------------------------------------------"

# Get all PIDs
for pid in $(ls /proc | grep -E '^[0-9]+$' | sort -n); do
    if [ -f /proc/$pid/status ]; then
        # Get Swap usage from /proc/$pid/status
        swap=$(grep VmSwap /proc/$pid/status 2>/dev/null | awk '{print $2}')
        if [ -n "$swap" ] && [ "$swap" != "0" ]; then
            # Get command
            cmd=$(cat /proc/$pid/cmdline 2>/dev/null | tr '\0' ' ' | head -50)
            if [ -z "$cmd" ]; then
                cmd=$(cat /proc/$pid/comm 2>/dev/null)
            fi
            echo -e "$pid\t\t$swap\t\t$cmd"
        fi
    fi
done | sort -k2 -nr | head -30
