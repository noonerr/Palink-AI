"""[EMB-BACKFILL] NULL 向量自动回填的回归测试（2026-10-07）。

覆盖三件事：

1. 正常回填：行龄超过宽限期的 NULL 行被批量嵌入回写；宽限期内的新行
   （store() 的异步首算还没跑完的"正常短暂 NULL"）被跳过，不抢活、不双算。
2. [DIM-CONTRACT] 嵌入产出维度 ≠ 契约维度（嵌入器降级/配置漂移）→ 整批拒写，
   行留 NULL 等下轮——回填不得产出"存得进召不回"的死向量。
3. ``start_backfill_worker`` 的开关语义：interval<=0 不启动；启动路径幂等。

⚠️ 本文件跑在 SQLite 回退路径上（列是 TEXT，写 json 文本）；pgvector CAST
   那条路的真库验证走容器内实测，不在 pytest 能力范围内。
"""

import os
import sys
from datetime import datetime, timedelta

import numpy as np
import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from sqlalchemy import text

    from app.memory_module import backfill as backfill_mod
    from app.memory_module import storage as mem_storage_mod
    from app.memory_module.config import memory_config
    from app.memory_module.storage import MemoryStorage
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")


@pytest.fixture()
def mem_env(db_session, monkeypatch):
    """在当前测试引擎上初始化 memory 表（复用 test_memory_vector_search 的接管模式）。"""
    monkeypatch.setattr(mem_storage_mod, "_tables_initialized", False)
    monkeypatch.setattr(mem_storage_mod, "_is_postgres_cached", None)
    monkeypatch.setattr(mem_storage_mod, "_migration_done", False)
    monkeypatch.setattr(mem_storage_mod, "_vector_column_cached", None)
    monkeypatch.setattr(memory_config, "ENABLED", True)
    # [隔离] 前序文件（如 test_c/d_batch）把 mirror 后台线程的 SessionLocal
    # 接到共享引擎，其晚到写入会躲过 per-test 清表、留下新鲜的 NULL 残留行。
    # 本文件的计数断言要求已知干净起点，先清一次。
    from sqlalchemy import text as _text
    db_session.execute(_text("DELETE FROM conversation_memories"))
    db_session.commit()
    return MemoryStorage(db_session), db_session


def _insert_null_row(db, content: str, age_seconds: float, session_id: str = "bf-session") -> int:
    """直插一条 embedding=NULL 的记忆行（模拟写入链路留 NULL 的欠账）。"""
    created = datetime.utcnow() - timedelta(seconds=age_seconds)
    result = db.execute(text(
        "INSERT INTO conversation_memories "
        "(user_id, session_id, branch_id, character_id, role, content, embedding, "
        " importance_score, topics, tokens_count, created_at, message_id) "
        "VALUES (1, :sid, NULL, NULL, 'assistant', :content, NULL, "
        " 0.5, '[]', 0, :created, NULL)"
    ), {"sid": session_id, "content": content, "created": created})
    db.commit()
    return result.lastrowid


def _get_embedding(db, row_id: int):
    row = db.execute(text(
        "SELECT embedding FROM conversation_memories WHERE id = :id"
    ), {"id": row_id}).fetchone()
    return row[0] if row else None


class TestRunBackfillCycle:
    """run_backfill_cycle：宽限期、回填、维度契约。"""

    def test_old_null_rows_backfilled_fresh_rows_skipped(self, mem_env, monkeypatch):
        _storage, db = mem_env
        old_id = _insert_null_row(db, "一小时前欠账的旧记忆", age_seconds=3600)
        fresh_id = _insert_null_row(db, "刚写入还没补算的新记忆", age_seconds=1)

        dim = int(memory_config.VECTOR_DIMENSION)
        calls = []

        def fake_embed(texts):
            calls.append(list(texts))
            return np.array([[0.1] * dim for _ in texts], dtype=np.float32)

        monkeypatch.setattr(backfill_mod, "embed_text", fake_embed)
        stats = backfill_mod.run_backfill_cycle(db, grace_seconds=300)

        assert stats["backfilled"] == 1, f"应只回填超龄的 1 行: {stats}"
        assert stats["too_fresh"] == 1, "宽限期内的新行必须跳过（不与异步首算双算）"
        assert len(calls) == 1 and calls[0] == ["一小时前欠账的旧记忆"], \
            "批量嵌入只应包含超龄行"
        assert _get_embedding(db, old_id) is not None, "欠账行的向量应已回填"
        assert _get_embedding(db, fresh_id) is None, "新行应留 NULL 由异步首算补"

    def test_no_backlog_is_noop(self, mem_env, monkeypatch):
        _storage, db = mem_env
        monkeypatch.setattr(
            backfill_mod, "embed_text",
            lambda texts: pytest.fail("无欠账时不得调用嵌入"))
        stats = backfill_mod.run_backfill_cycle(db)
        assert stats == {"scanned": 0, "backfilled": 0, "dim_skipped": 0, "too_fresh": 0}

    def test_dim_mismatch_rejects_whole_batch(self, mem_env, monkeypatch):
        """[DIM-CONTRACT] 嵌入器降级（维度不符）→ 整批拒写，行留 NULL。"""
        _storage, db = mem_env
        row_id = _insert_null_row(db, "降级期的欠账行", age_seconds=3600)

        def degraded_embed(texts):
            # 模拟嵌入器降级产出与契约维度不同的向量（维度必然 ≠ 契约）
            dim = int(memory_config.VECTOR_DIMENSION)
            return np.array([[0.2] * (dim + 1) for _ in texts], dtype=np.float32)

        monkeypatch.setattr(backfill_mod, "embed_text", degraded_embed)
        stats = backfill_mod.run_backfill_cycle(db, grace_seconds=300)

        assert stats["backfilled"] == 0
        assert stats["dim_skipped"] == 1
        assert _get_embedding(db, row_id) is None, "维度不符的向量不得写入（宁缺勿错）"

    def test_embed_failure_leaves_rows_null(self, mem_env, monkeypatch):
        """嵌入调用抛错（如嵌入服务整体不可用）→ 本轮放弃，行留 NULL。"""
        _storage, db = mem_env
        row_id = _insert_null_row(db, "嵌入服务挂了", age_seconds=3600)

        def boom(texts):
            raise RuntimeError("embedding service down")

        monkeypatch.setattr(backfill_mod, "embed_text", boom)
        stats = backfill_mod.run_backfill_cycle(db)
        assert stats["backfilled"] == 0
        assert _get_embedding(db, row_id) is None


class TestStartBackfillWorker:
    """开关语义：interval<=0 不启动；启动幂等（线程本体用桩替换）。"""

    def test_disabled_when_interval_nonpositive(self, mem_env, monkeypatch):
        monkeypatch.setattr(backfill_mod, "_WORKER_STARTED", False)
        monkeypatch.setattr(memory_config, "EMBED_BACKFILL_INTERVAL", 0)
        assert backfill_mod.start_backfill_worker() is False

    def test_start_is_idempotent(self, mem_env, monkeypatch):
        monkeypatch.setattr(backfill_mod, "_WORKER_STARTED", False)
        monkeypatch.setattr(memory_config, "EMBED_BACKFILL_INTERVAL", 600)
        # 线程本体替换成空函数：验证拉起/幂等逻辑，不让测试真跑轮询循环
        monkeypatch.setattr(backfill_mod, "_worker_loop", lambda: None)
        threads = []
        monkeypatch.setattr(
            backfill_mod.threading, "Thread",
            lambda **kw: threads.append(kw) or type("T", (), {"start": lambda s: None, "daemon": True})(),
        )
        assert backfill_mod.start_backfill_worker() is True
        assert backfill_mod.start_backfill_worker() is True, "第二次调用必须直接返回（幂等）"
        assert len(threads) == 1, "只允许拉起一条回填线程"
