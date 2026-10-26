"""[OLLAMA-PREWARM] bge-m3 驻留预热（P2-26 修法①）的回归测试。

覆盖：
1. 开关语义：``OLLAMA_PREWARM_ENABLED=false`` 不启动线程、不调用嵌入；
   ``OLLAMA_PREWARM_INTERVAL_HOURS<=0`` 同样不启动。
2. 启动行为：线程拉起后**立即预热一次**（不是等一个间隔），且拉起幂等。
3. 间隔生效：``_worker_loop`` 按传入间隔重复预热（毫秒级间隔直测循环）。
4. 异常不外溢：嵌入抛错 / 降级 都被吞掉并经 ``silent_failure.record`` 留痕，
   线程循环在异常后继续跑。
5. 关闭：``stop_prewarm_worker`` 能让真实线程退出。

⚠️ 全部用例都把 ``prewarm_mod.embed_text`` 或 ``prewarm_once`` 换掉，
   不连 ollama、不加载 fastembed。
"""

import threading
import time

import numpy as np
import pytest

from app.core import silent_failure
from app.core.config import Settings, settings
from app.memory_module import prewarm as prewarm_mod
from app.memory_module.config import memory_config


class _FakeEmbedder:
    """替身嵌入器：只暴露预热判定要读的两个属性。"""

    def __init__(self, native_dim=1024, degraded_dim=None):
        self._dimension = native_dim
        self._degraded_dim = degraded_dim

    @property
    def dimension(self):
        return self._degraded_dim if self._degraded_dim is not None else self._dimension


@pytest.fixture()
def fresh_worker(monkeypatch):
    """把预热模块的线程状态复位，并在用例结束时确保线程停掉。"""
    monkeypatch.setattr(prewarm_mod, "_WORKER_STARTED", False)
    monkeypatch.setattr(prewarm_mod, "_worker_thread", None)
    monkeypatch.setattr(settings, "OLLAMA_PREWARM_ENABLED", True)
    monkeypatch.setattr(settings, "OLLAMA_PREWARM_INTERVAL_HOURS", 6)
    # 生产口径（docker-compose）就是 ollama；测试机默认 fastembed，需显式对齐
    monkeypatch.setattr(memory_config, "EMBEDDING_PROVIDER", "ollama")
    yield
    prewarm_mod.stop_prewarm_worker(timeout=2.0)
    prewarm_mod._stop_event.clear()


# ─────────────────────────────────────────────────────────────────────
# 配置：默认值 + env 可覆盖
# ─────────────────────────────────────────────────────────────────────

class TestConfig:
    def test_defaults(self):
        assert Settings.model_fields["OLLAMA_PREWARM_ENABLED"].default is True
        assert Settings.model_fields["OLLAMA_PREWARM_INTERVAL_HOURS"].default == 6

    def test_env_override(self, monkeypatch):
        monkeypatch.setenv("OLLAMA_PREWARM_ENABLED", "false")
        monkeypatch.setenv("OLLAMA_PREWARM_INTERVAL_HOURS", "1")
        s = Settings(APP_ENV="development", ADMIN_PASSWORD="admin123")
        assert s.OLLAMA_PREWARM_ENABLED is False
        assert s.OLLAMA_PREWARM_INTERVAL_HOURS == 1


# ─────────────────────────────────────────────────────────────────────
# prewarm_once：走真实嵌入入口（embed_text）、降级/异常留痕
# ─────────────────────────────────────────────────────────────────────

class TestPrewarmOnce:
    def test_uses_embed_text_with_configured_text(self, monkeypatch):
        """必须走记忆检索同一个 embed_text（不是另造 HTTP 客户端）。"""
        calls = []

        def fake_embed_text(text):
            calls.append(text)
            return np.zeros((1, 1024), dtype=np.float32)

        monkeypatch.setattr(prewarm_mod, "embed_text", fake_embed_text)
        monkeypatch.setattr(prewarm_mod, "get_embedder", lambda: _FakeEmbedder())
        monkeypatch.setattr(settings, "OLLAMA_PREWARM_TEXT", "预热")

        assert prewarm_mod.prewarm_once() is True
        assert calls == ["预热"], "预热必须把极短文本交给 embed_text 且只调一次"

    def test_degraded_embed_is_reported_but_not_raised(self, monkeypatch):
        """降级（fastembed 512 维）不抛错，但必须留痕且返回 False。"""
        monkeypatch.setattr(
            prewarm_mod, "embed_text",
            lambda text: np.zeros((1, 512), dtype=np.float32),
        )
        monkeypatch.setattr(
            prewarm_mod, "get_embedder",
            lambda: _FakeEmbedder(native_dim=1024, degraded_dim=512),
        )
        silent_failure.reset()

        assert prewarm_mod.prewarm_once() is False
        assert silent_failure.snapshot()["counts"].get("memory.prewarm.degraded") == 1

    def test_embed_exception_recorded_and_swallowed(self, monkeypatch):
        def boom(text):
            raise RuntimeError("ollama down")

        monkeypatch.setattr(prewarm_mod, "embed_text", boom)
        silent_failure.reset()

        assert prewarm_mod.prewarm_once() is False  # 不抛
        assert silent_failure.snapshot()["counts"].get("memory.prewarm.embed_failed") == 1


# ─────────────────────────────────────────────────────────────────────
# 循环：首轮立即预热、间隔生效、异常后继续
# ─────────────────────────────────────────────────────────────────────

class TestWorkerLoop:
    def test_loop_prewarms_immediately_then_honours_interval(self, monkeypatch):
        stop_event = threading.Event()
        stamps = []

        def fake_prewarm():
            stamps.append(time.monotonic())
            if len(stamps) >= 3:
                stop_event.set()
            return True

        monkeypatch.setattr(prewarm_mod, "prewarm_once", fake_prewarm)

        started = time.monotonic()
        prewarm_mod._worker_loop(0.05, stop_event=stop_event)
        elapsed = time.monotonic() - started

        assert len(stamps) == 3, "3 次预热后才收到停止信号"
        # 首轮零等待 ⇒ 总耗时 ≈ 2 个间隔；留一半余量抗抖动
        assert elapsed >= 0.05, f"间隔参数未生效（总耗时 {elapsed:.3f}s）"
        assert (stamps[1] - stamps[0]) >= 0.04, "两次预热之间必须等满间隔"

    def test_loop_survives_exceptions(self, monkeypatch):
        """prewarm_once 意外抛错 → 循环记录后继续，不死。"""
        stop_event = threading.Event()
        calls = []

        def boom():
            calls.append(1)
            if len(calls) >= 2:
                stop_event.set()
            raise RuntimeError("unexpected")

        monkeypatch.setattr(prewarm_mod, "prewarm_once", boom)
        silent_failure.reset()

        prewarm_mod._worker_loop(0.01, stop_event=stop_event)

        assert len(calls) == 2, "第一次异常后循环必须继续跑到第二次"
        assert silent_failure.snapshot()["counts"].get("memory.prewarm.cycle_failed") == 2


# ─────────────────────────────────────────────────────────────────────
# 开关 / 启动 / 停止
# ─────────────────────────────────────────────────────────────────────

class TestWorkerSwitch:
    def _forbid_embed(self, monkeypatch):
        monkeypatch.setattr(
            prewarm_mod, "prewarm_once",
            lambda: pytest.fail("开关关闭时不得预热"),
        )

    def test_disabled_does_not_start_nor_call(self, fresh_worker, monkeypatch):
        monkeypatch.setattr(settings, "OLLAMA_PREWARM_ENABLED", False)
        self._forbid_embed(monkeypatch)

        threads = []
        monkeypatch.setattr(
            prewarm_mod.threading, "Thread",
            lambda **kw: threads.append(kw) or type(
                "T", (), {"start": lambda s: None, "join": lambda s, t=None: None,
                          "is_alive": lambda s: False})(),
        )

        assert prewarm_mod.start_prewarm_worker() is False
        assert threads == [], "开关关闭时不允许拉起任何线程"

    def test_nonpositive_interval_does_not_start(self, fresh_worker, monkeypatch):
        monkeypatch.setattr(settings, "OLLAMA_PREWARM_INTERVAL_HOURS", 0)
        self._forbid_embed(monkeypatch)

        threads = []
        monkeypatch.setattr(
            prewarm_mod.threading, "Thread",
            lambda **kw: threads.append(kw) or type(
                "T", (), {"start": lambda s: None, "join": lambda s, t=None: None,
                          "is_alive": lambda s: False})(),
        )

        assert prewarm_mod.start_prewarm_worker() is False
        assert threads == []

    def test_non_ollama_provider_does_not_start(self, fresh_worker, monkeypatch):
        """provider 不是 ollama 时没有 bge-m3 可保，不该白拉线程。"""
        monkeypatch.setattr(memory_config, "EMBEDDING_PROVIDER", "fastembed")
        self._forbid_embed(monkeypatch)

        assert prewarm_mod.start_prewarm_worker() is False

    def test_start_prewarms_once_immediately_and_is_idempotent(self, fresh_worker,
                                                              monkeypatch):
        called = threading.Event()
        calls = []

        def fake_prewarm():
            calls.append(1)
            called.set()
            return True

        monkeypatch.setattr(prewarm_mod, "prewarm_once", fake_prewarm)

        assert prewarm_mod.start_prewarm_worker() is True
        assert called.wait(3.0), "启动后必须立即预热一次"
        assert prewarm_mod.start_prewarm_worker() is True, "二次调用必须幂等"
        assert len(calls) == 1, "同一进程只允许一条预热线程 / 只做一次启动预热"

        assert prewarm_mod.stop_prewarm_worker(timeout=2.0) is True
        assert prewarm_mod.stop_prewarm_worker() is False, "未启动时停止应返回 False"

    def test_stop_interrupts_waiting_thread(self, fresh_worker, monkeypatch):
        """关闭信号能打断 Event.wait（否则要等满 6 小时）。"""

        def fake_loop(interval_seconds, stop_event=None):
            (stop_event or prewarm_mod._stop_event).wait(30)

        monkeypatch.setattr(prewarm_mod, "_worker_loop", fake_loop)

        assert prewarm_mod.start_prewarm_worker() is True
        thread = prewarm_mod._worker_thread
        assert thread is not None and thread.is_alive()

        started = time.monotonic()
        assert prewarm_mod.stop_prewarm_worker(timeout=3.0) is True
        assert (time.monotonic() - started) < 3.0
        assert not thread.is_alive(), "停止信号后线程必须退出"
