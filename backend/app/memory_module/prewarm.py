"""[OLLAMA-PREWARM 2026-10-26] bge-m3 驻留预热（P2-26 修法①，用户拍板）。

## 为什么要有这个模块

机制链（docs/OPEN_ISSUES.md [P2-26]，2026-10-26 取证定性）：
ollama 的 bge-m3 被 ``OLLAMA_KEEP_ALIVE=24h`` 空闲卸载、或容器/引擎重启逐出
→ 冷轮首次嵌入的模型冷加载 **超过** ``OLLAMA_TIMEOUT=30s``
→ ``OllamaEmbedder.embed`` 吞掉超时并降级 fastembed（512 维，bge-m3 是 1024）
→ storage 的 ``[VEC-DIM]`` 维度门把整批向量判为不符 → 返回空**而不是报错**
→ 记忆注入只剩 STM，实测 10853 字 / 7127 tok 塌到 989 字 / 643 tok。
体感就是「重启后第一句特别笨」。

修法：进程启动 + 每 N 小时（< 24h，默认 6h）发一个极短 embed，让模型始终被
调用、不进保留期。代价约 160ms/次，而模型本来就常驻，**不新增常驻占用**。

## 红线

1. **必须走记忆检索同一条嵌入路径**：``embed_text`` → ``EmbedderFactory``
   → ``OllamaEmbedder`` → ``POST /api/embed``。不另造 HTTP 客户端、
   不直接连线 ollama、不绕过降级链——预热要证明的就是「生产这条路是热的」。
2. **不持有 DB Session、不建表、不阻塞启动**：纯内存 + 一次网络请求。
3. **线程永不因异常退出**：``prewarm_once`` 与循环各有一层 try/except，
   异常一律经 ``app.core.silent_failure.record`` 留痕后吞掉。
4. **开关默认开、可关**：``OLLAMA_PREWARM_ENABLED=false`` 时完全不启动线程。

降级判定：``embed_text`` 自身不会抛错（``OllamaEmbedder.embed`` 内部的
fallback 已经吞了），所以这里用「产出维度 / 降级标记」判断是否真的热了。
启动期第一次预热常常正好撞上 ollama 自己也在加载模型（首次冷加载 > 30s），
那一次降级属预期；模型加载在服务端继续进行，下一次真实请求（或下一次预热）
成功后 ``_degraded_dim`` 会被 ``OllamaEmbedder`` 自己清掉。
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Optional

import numpy as np

from ..core.config import settings
from ..core.silent_failure import record as record_silent_failure
from .config import memory_config
from .embedder import embed_text, get_embedder

logger = logging.getLogger("MemoryModule")

# 生产间隔的下限（秒）：start_prewarm_worker 对 interval_seconds 做此下限保护。
_MIN_INTERVAL_SECONDS = 1.0
# 循环内等待的下限（秒）：start_* 已保证间隔 ≥ 1s，这里只防直接调用传 0/负数
# ⇒ 空转占满一个核。取 0.01 而非 1，是为了让单测能用毫秒级间隔验证"间隔真的生效"。
_MIN_LOOP_WAIT_SECONDS = 0.01

_WORKER_STARTED = False
_WORKER_LOCK = threading.Lock()
_worker_thread: Optional[threading.Thread] = None
# 关闭信号：lifespan 退出时 set()，循环里的 wait 会立刻醒来返回。
_stop_event = threading.Event()


def _native_dimension(embedder) -> Optional[int]:
    """bge-m3 的「原生」维度（嵌入器声明的契约维度，不是降级后的实际维度）。"""
    try:
        return int(getattr(embedder, "_dimension", 0)) or None
    except Exception as exc:  # noqa: BLE001 - 取维度失败不得影响预热
        # 该分支只在替身/异常嵌入器上走到；照静默失败棘轮要求留痕
        record_silent_failure("memory.prewarm.dimension_unreadable", exc, once=True)
        return None


def prewarm_once() -> bool:
    """执行一次预热。

    Returns:
        True = 这次调用确实走通了原生嵌入（未降级）；False = 降级或异常
        （已留痕）。**本函数不抛异常**。
    """
    started_at = time.monotonic()
    try:
        vectors = embed_text(settings.OLLAMA_PREWARM_TEXT)
    except Exception as exc:  # noqa: BLE001 - 预热失败必须吞掉，线程不能死
        record_silent_failure("memory.prewarm.embed_failed", exc)
        logger.warning("[OLLAMA-PREWARM] 预热调用失败（不影响主流程）: %s", exc)
        return False

    elapsed_ms = (time.monotonic() - started_at) * 1000.0
    try:
        dim = int(vectors.shape[-1]) if isinstance(vectors, np.ndarray) and vectors.ndim else 0
        embedder = get_embedder()
        degraded_dim = getattr(embedder, "_degraded_dim", None)
        native_dim = _native_dimension(embedder)
    except Exception as exc:  # noqa: BLE001 - 读产出形状失败同样只记不抛
        record_silent_failure("memory.prewarm.inspect_failed", exc)
        return False

    # 降级标记只在 OllamaEmbedder 上存在；非 ollama provider 下它是 None，
    # 此时预热本来就是无意义动作（不碰 ollama），不报错也不算失败。
    if degraded_dim is not None:
        record_silent_failure(
            "memory.prewarm.degraded",
            None,
            level=logging.WARNING,
            degraded_dim=degraded_dim,
            expected_dim=native_dim,
        )
        logger.warning(
            "[OLLAMA-PREWARM] 预热落到降级路径（产出 %d 维，bge-m3 期望 %s 维，"
            "耗时 %.0fms）。冷加载很可能仍在进行；下一次调用会自行恢复。",
            dim, native_dim if native_dim is not None else "?",
            elapsed_ms,
        )
        return False

    logger.info(
        "[OLLAMA-PREWARM] 预热完成：%d 维 / %.0fms（bge-m3 已驻留）",
        dim, elapsed_ms,
    )
    return True


def _run_prewarm_cycle() -> None:
    """一轮预热（二次兜底 try/except：连 ``prewarm_once`` 的意外都不许把线程带走）。"""
    try:
        prewarm_once()
    except Exception as exc:  # noqa: BLE001 - 线程保活优先
        record_silent_failure("memory.prewarm.cycle_failed", exc)


def _worker_loop(interval_seconds: float,
                 stop_event: Optional[threading.Event] = None) -> None:
    """预热线程主循环：**先预热一次**，之后每 ``interval_seconds`` 一次。

    ``stop_event`` 只给测试注入；生产走模块级 ``_stop_event``。
    等待用 ``Event.wait`` 而不是 ``time.sleep``，关闭信号可立刻打断当前等待。
    """
    event = _stop_event if stop_event is None else stop_event
    interval = max(float(interval_seconds), _MIN_LOOP_WAIT_SECONDS)
    while not event.is_set():
        _run_prewarm_cycle()
        if event.wait(interval):
            return


def start_prewarm_worker() -> bool:
    """拉起预热 daemon 线程（幂等）。

    Returns:
        True = 线程在跑（本次拉起或此前已拉起）；False = 开关关闭/间隔非法。
    """
    global _WORKER_STARTED, _worker_thread

    if not bool(settings.OLLAMA_PREWARM_ENABLED):
        logger.info("[OLLAMA-PREWARM] OLLAMA_PREWARM_ENABLED=false，预热线程未启动")
        return False

    # 只有 provider=ollama 时才存在「bge-m3 被挤出驻留」这个问题；
    # 换成 fastembed/openai 等 provider 时预热既不碰 ollama，还会白加载本地模型。
    if memory_config.EMBEDDING_PROVIDER != "ollama":
        logger.info(
            "[OLLAMA-PREWARM] 当前嵌入 provider=%s（非 ollama），无需预热，线程未启动",
            memory_config.EMBEDDING_PROVIDER,
        )
        return False

    try:
        interval_hours = float(settings.OLLAMA_PREWARM_INTERVAL_HOURS)
    except (TypeError, ValueError) as exc:
        record_silent_failure("memory.prewarm.bad_config", exc)
        logger.warning("[OLLAMA-PREWARM] OLLAMA_PREWARM_INTERVAL_HOURS 非法，预热线程未启动")
        return False
    if interval_hours <= 0:
        logger.info("[OLLAMA-PREWARM] OLLAMA_PREWARM_INTERVAL_HOURS<=0，预热线程未启动")
        return False

    interval_seconds = max(interval_hours * 3600.0, _MIN_INTERVAL_SECONDS)
    with _WORKER_LOCK:
        if _WORKER_STARTED:
            return True
        _WORKER_STARTED = True
        _stop_event.clear()
        thread = threading.Thread(
            target=_worker_loop,
            args=(interval_seconds,),
            daemon=True,
            name="ollama-prewarm",
        )
        _worker_thread = thread
        thread.start()

    logger.info(
        "[OLLAMA-PREWARM] bge-m3 驻留预热线程已启动（启动即预热一次，之后每 %.1f 小时一次；"
        "文本=%r）",
        interval_hours, settings.OLLAMA_PREWARM_TEXT,
    )
    return True


def stop_prewarm_worker(timeout: float = 2.0) -> bool:
    """通知预热线程退出（lifespan 关闭期调用）。

    daemon 线程：即使正卡在 30s 的 httpx 超时里、join 超时返回，也不会拖住进程退出。
    Returns:
        True = 本次确实发出了停止信号；False = 线程本来就没启动。
    """
    global _WORKER_STARTED, _worker_thread

    with _WORKER_LOCK:
        if not _WORKER_STARTED:
            return False
        _WORKER_STARTED = False
        thread = _worker_thread
        _worker_thread = None

    _stop_event.set()
    if thread is not None and thread is not threading.current_thread():
        thread.join(timeout)
        if thread.is_alive():
            logger.info("[OLLAMA-PREWARM] 预热线程仍在收尾（daemon，不阻塞进程退出）")
    logger.info("[OLLAMA-PREWARM] 预热线程已停止")
    return True
