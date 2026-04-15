#!/bin/sh
set -eu

is_pos_int() {
  case "$1" in
    ""|*[!0-9]*)
      return 1
      ;;
    *)
      [ "$1" -gt 0 ] 2>/dev/null
      ;;
  esac
}

is_true() {
  value="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  case "$value" in
    1|true|yes|on)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

detect_cpu_threads() {
  if [ -f /sys/fs/cgroup/cpu.max ]; then
    quota="$(awk '{print $1}' /sys/fs/cgroup/cpu.max 2>/dev/null || true)"
    period="$(awk '{print $2}' /sys/fs/cgroup/cpu.max 2>/dev/null || true)"
    if [ "${quota:-max}" != "max" ] && is_pos_int "${quota:-}" && is_pos_int "${period:-}"; then
      cpus=$(( (quota + period - 1) / period ))
      if [ "$cpus" -gt 0 ]; then
        echo "$cpus"
        return
      fi
    fi
  fi

  if [ -f /sys/fs/cgroup/cpu/cpu.cfs_quota_us ] && [ -f /sys/fs/cgroup/cpu/cpu.cfs_period_us ]; then
    quota="$(cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us 2>/dev/null || true)"
    period="$(cat /sys/fs/cgroup/cpu/cpu.cfs_period_us 2>/dev/null || true)"
    if is_pos_int "${quota:-}" && is_pos_int "${period:-}"; then
      cpus=$(( (quota + period - 1) / period ))
      if [ "$cpus" -gt 0 ]; then
        echo "$cpus"
        return
      fi
    fi
  fi

  if command -v getconf >/dev/null 2>&1; then
    cpus="$(getconf _NPROCESSORS_ONLN 2>/dev/null || true)"
    if is_pos_int "${cpus:-}"; then
      echo "$cpus"
      return
    fi
  fi

  if command -v nproc >/dev/null 2>&1; then
    cpus="$(nproc 2>/dev/null || true)"
    if is_pos_int "${cpus:-}"; then
      echo "$cpus"
      return
    fi
  fi

  echo 2
}

detect_memory_mb() {
  if [ -f /sys/fs/cgroup/memory.max ]; then
    memory_limit="$(cat /sys/fs/cgroup/memory.max 2>/dev/null || true)"
    if [ "${memory_limit:-max}" != "max" ] && is_pos_int "${memory_limit:-}"; then
      memory_mb=$((memory_limit / 1024 / 1024))
      if [ "$memory_mb" -gt 0 ] && [ "$memory_mb" -lt 4194304 ]; then
        echo "$memory_mb"
        return
      fi
    fi
  fi

  if [ -f /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then
    memory_limit="$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || true)"
    if is_pos_int "${memory_limit:-}"; then
      memory_mb=$((memory_limit / 1024 / 1024))
      if [ "$memory_mb" -gt 0 ] && [ "$memory_mb" -lt 4194304 ]; then
        echo "$memory_mb"
        return
      fi
    fi
  fi

  if [ -r /proc/meminfo ]; then
    memory_kb="$(awk '/MemAvailable:/ {print $2; exit}' /proc/meminfo 2>/dev/null || true)"
    if is_pos_int "${memory_kb:-}"; then
      memory_mb=$((memory_kb / 1024))
      if [ "$memory_mb" -gt 0 ]; then
        echo "$memory_mb"
        return
      fi
    fi
  fi

  echo 2048
}

if is_pos_int "${CPU_THREADS_OVERRIDE:-}"; then
  CPU_THREADS="$CPU_THREADS_OVERRIDE"
else
  CPU_THREADS="$(detect_cpu_threads)"
fi
if ! is_pos_int "${CPU_THREADS:-}"; then
  CPU_THREADS=2
fi

if is_pos_int "${AVAILABLE_MEMORY_MB_OVERRIDE:-}"; then
  AVAILABLE_MEMORY_MB="$AVAILABLE_MEMORY_MB_OVERRIDE"
else
  AVAILABLE_MEMORY_MB="$(detect_memory_mb)"
fi
if ! is_pos_int "${AVAILABLE_MEMORY_MB:-}"; then
  AVAILABLE_MEMORY_MB=2048
fi

MEMORY_RESERVE_MB="${APP_MEMORY_RESERVE_MB:-1536}"
if ! is_pos_int "${MEMORY_RESERVE_MB:-}"; then
  MEMORY_RESERVE_MB=1536
fi

MEMORY_PER_WORKER_MB="${APP_MEMORY_PER_WORKER_MB:-900}"
if ! is_pos_int "${MEMORY_PER_WORKER_MB:-}"; then
  MEMORY_PER_WORKER_MB=900
fi
if [ "$MEMORY_PER_WORKER_MB" -lt 256 ]; then
  MEMORY_PER_WORKER_MB=256
fi

USABLE_MEMORY_MB=$((AVAILABLE_MEMORY_MB - MEMORY_RESERVE_MB))
if [ "$USABLE_MEMORY_MB" -lt 512 ]; then
  USABLE_MEMORY_MB=512
fi

WORKERS_MAX="${UVICORN_WORKERS_MAX:-8}"
if ! is_pos_int "${WORKERS_MAX:-}"; then
  WORKERS_MAX=8
fi

APP_MAX_WORKERS="${APP_MAX_WORKERS:-}"
if is_pos_int "${APP_MAX_WORKERS:-}" && [ "$APP_MAX_WORKERS" -gt 0 ] && [ "$APP_MAX_WORKERS" -lt "$WORKERS_MAX" ]; then
  WORKERS_MAX="$APP_MAX_WORKERS"
fi

PERFORMANCE_PROFILE="$(printf '%s' "${APP_PERFORMANCE_PROFILE:-balanced}" | tr '[:upper:]' '[:lower:]')"
WORKER_CPU_DIVISOR="${APP_WORKER_CPU_DIVISOR:-}"
if ! is_pos_int "${WORKER_CPU_DIVISOR:-}"; then
  case "$PERFORMANCE_PROFILE" in
    throughput)
      WORKER_CPU_DIVISOR=2
      ;;
    eco)
      WORKER_CPU_DIVISOR=6
      ;;
    *)
      PERFORMANCE_PROFILE="balanced"
      WORKER_CPU_DIVISOR=4
      ;;
  esac
fi
if [ "$WORKER_CPU_DIVISOR" -lt 1 ]; then
  WORKER_CPU_DIVISOR=4
fi

if is_pos_int "${APP_MIN_WORKERS:-}"; then
  MIN_WORKERS="$APP_MIN_WORKERS"
  MIN_WORKERS_EXPLICIT=1
else
  MIN_WORKERS=1
  MIN_WORKERS_EXPLICIT=0
fi
if [ "$MIN_WORKERS_EXPLICIT" -eq 0 ] && [ "$CPU_THREADS" -ge 4 ] && [ "$MIN_WORKERS" -lt 2 ]; then
  MIN_WORKERS=2
fi

WORKER_SOURCE="manual"
WORKERS_BY_CPU="-"
WORKERS_BY_MEMORY="-"
if is_pos_int "${UVICORN_WORKERS:-}"; then
  WORKERS="$UVICORN_WORKERS"
else
  WORKER_SOURCE="auto"

  WORKERS_BY_CPU=$(( (CPU_THREADS + WORKER_CPU_DIVISOR - 1) / WORKER_CPU_DIVISOR ))
  if [ "$WORKERS_BY_CPU" -lt 1 ]; then
    WORKERS_BY_CPU=1
  fi

  WORKERS_BY_MEMORY=$((USABLE_MEMORY_MB / MEMORY_PER_WORKER_MB))
  if [ "$WORKERS_BY_MEMORY" -lt 1 ]; then
    WORKERS_BY_MEMORY=1
  fi

  WORKERS="$WORKERS_BY_CPU"
  if [ "$WORKERS_BY_MEMORY" -lt "$WORKERS" ]; then
    WORKERS="$WORKERS_BY_MEMORY"
  fi
fi

if [ "$WORKERS" -gt "$WORKERS_MAX" ]; then
  WORKERS="$WORKERS_MAX"
fi
if [ "$WORKERS" -gt "$CPU_THREADS" ]; then
  WORKERS="$CPU_THREADS"
fi
if [ "$WORKERS" -lt "$MIN_WORKERS" ]; then
  WORKERS="$MIN_WORKERS"
fi
if [ "$WORKERS" -gt "$CPU_THREADS" ]; then
  WORKERS="$CPU_THREADS"
fi
if [ "$WORKERS" -lt 1 ]; then
  WORKERS=1
fi

THREADS_PER_WORKER_MAX="${APP_CPU_THREADS_PER_WORKER_MAX:-4}"
if ! is_pos_int "${THREADS_PER_WORKER_MAX:-}"; then
  THREADS_PER_WORKER_MAX=4
fi

if is_pos_int "${APP_CPU_THREADS_PER_WORKER:-}"; then
  THREADS_PER_WORKER="$APP_CPU_THREADS_PER_WORKER"
else
  THREADS_PER_WORKER=$((CPU_THREADS / WORKERS))
  if [ "$THREADS_PER_WORKER" -lt 1 ]; then
    THREADS_PER_WORKER=1
  fi
fi
if [ "$THREADS_PER_WORKER" -gt "$THREADS_PER_WORKER_MAX" ]; then
  THREADS_PER_WORKER="$THREADS_PER_WORKER_MAX"
fi

if ! is_pos_int "${OMP_NUM_THREADS:-}"; then
  OMP_NUM_THREADS="$THREADS_PER_WORKER"
fi
if ! is_pos_int "${OPENBLAS_NUM_THREADS:-}"; then
  OPENBLAS_NUM_THREADS="$THREADS_PER_WORKER"
fi
if ! is_pos_int "${MKL_NUM_THREADS:-}"; then
  MKL_NUM_THREADS="$THREADS_PER_WORKER"
fi
if ! is_pos_int "${NUMEXPR_NUM_THREADS:-}"; then
  NUMEXPR_NUM_THREADS="$THREADS_PER_WORKER"
fi

if ! is_pos_int "${API_THREADPOOL_TOKENS:-}"; then
  API_THREADPOOL_TOKENS=$((THREADS_PER_WORKER * 4))
  if [ "$API_THREADPOOL_TOKENS" -lt 8 ]; then
    API_THREADPOOL_TOKENS=8
  fi
  if [ "$API_THREADPOOL_TOKENS" -gt 32 ]; then
    API_THREADPOOL_TOKENS=32
  fi
fi

DB_POOL_AUTO_TUNE="${DB_POOL_AUTO_TUNE:-true}"
if is_true "$DB_POOL_AUTO_TUNE"; then
  DB_CONNECTION_BUDGET="${DB_CONNECTION_BUDGET:-40}"
  if ! is_pos_int "${DB_CONNECTION_BUDGET:-}"; then
    DB_CONNECTION_BUDGET=40
  fi

  DB_PER_WORKER_BUDGET=$((DB_CONNECTION_BUDGET / WORKERS))
  if [ "$DB_PER_WORKER_BUDGET" -lt 4 ]; then
    DB_PER_WORKER_BUDGET=4
  fi

  DB_POOL_SIZE=$((DB_PER_WORKER_BUDGET / 2))
  if [ "$DB_POOL_SIZE" -lt 2 ]; then
    DB_POOL_SIZE=2
  fi
  if [ "$DB_POOL_SIZE" -gt 4 ]; then
    DB_POOL_SIZE=4
  fi

  DB_MAX_OVERFLOW="$DB_POOL_SIZE"
else
  if ! is_pos_int "${DB_POOL_SIZE:-}"; then
    DB_POOL_SIZE=4
  fi
  if ! is_pos_int "${DB_MAX_OVERFLOW:-}"; then
    DB_MAX_OVERFLOW=$((DB_POOL_SIZE * 2))
  fi
fi

if ! is_pos_int "${UVICORN_PORT:-}"; then
  UVICORN_PORT=8000
fi
if ! is_pos_int "${UVICORN_TIMEOUT:-}"; then
  UVICORN_TIMEOUT=600
fi
if ! is_pos_int "${UVICORN_KEEPALIVE_TIMEOUT:-}"; then
  UVICORN_KEEPALIVE_TIMEOUT=600
fi

TOKENIZERS_PARALLELISM="${TOKENIZERS_PARALLELISM:-false}"

export OMP_NUM_THREADS
export OPENBLAS_NUM_THREADS
export MKL_NUM_THREADS
export NUMEXPR_NUM_THREADS
export API_THREADPOOL_TOKENS
export DB_POOL_SIZE
export DB_MAX_OVERFLOW
export TOKENIZERS_PARALLELISM

printf '%s\n' "[startup] profile=$PERFORMANCE_PROFILE worker_source=$WORKER_SOURCE cpu_threads=$CPU_THREADS worker_cpu_divisor=$WORKER_CPU_DIVISOR min_workers=$MIN_WORKERS memory_mb=$AVAILABLE_MEMORY_MB memory_reserve_mb=$MEMORY_RESERVE_MB memory_per_worker_mb=$MEMORY_PER_WORKER_MB workers_cpu_cap=$WORKERS_BY_CPU workers_mem_cap=$WORKERS_BY_MEMORY workers=$WORKERS per_worker_threads=$THREADS_PER_WORKER omp=$OMP_NUM_THREADS api_threadpool_tokens=$API_THREADPOOL_TOKENS db_pool=$DB_POOL_SIZE db_overflow=$DB_MAX_OVERFLOW"

exec uvicorn app.main:app \
  --host 0.0.0.0 \
  --port "$UVICORN_PORT" \
  --workers "$WORKERS" \
  --timeout-keep-alive "$UVICORN_KEEPALIVE_TIMEOUT" \
  --timeout-graceful-shutdown "$UVICORN_TIMEOUT"
