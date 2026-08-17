"""MED-3: 速率限制共享存储验证。

验证点：
- DB 原子计数（UPSERT + RETURNING）跨调用正确累加；
- enforce_rate_limit 超过阈值返回 429 + Retry-After；
- 窗口过期后计数重置为 1（新窗口）。

测试数据使用唯一前缀 key，结束后清理，不污染业务表。
"""
import time
import uuid

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.core.rate_limit import _db_increment, engine, enforce_rate_limit

_PREFIX = f"med3_{uuid.uuid4().hex[:8]}"
_SCOPE = f"{_PREFIX}_scope"


def _cleanup(pattern: str) -> None:
    with engine.begin() as conn:
        conn.execute(
            text("DELETE FROM rate_limit_entries WHERE key LIKE :p"),
            {"p": pattern},
        )


def test_db_increment_counts_atomically() -> None:
    key = f"{_PREFIX}_key1"
    t0 = time.time()
    try:
        for i in range(1, 4):
            ok, count, _ws = _db_increment(key, t0 + i * 0.01, 60)
            assert ok is True
            assert count == i
    finally:
        _cleanup(f"{_PREFIX}_%")


def test_window_expiry_resets_count() -> None:
    key = f"{_PREFIX}_key2"
    t0 = time.time()
    try:
        ok, count, _ws = _db_increment(key, t0, 10)
        assert ok is True
        assert count == 1
        # 窗口（10s）过后：新窗口计数重置为 1
        ok, count, _ws = _db_increment(key, t0 + 11, 10)
        assert ok is True
        assert count == 1
        # 新窗口内继续累加
        ok, count, _ws = _db_increment(key, t0 + 11.01, 10)
        assert ok is True
        assert count == 2
    finally:
        _cleanup(f"{_PREFIX}_%")


def test_enforce_rate_limit_returns_429() -> None:
    app = FastAPI()

    @app.get("/limited")
    def limited(request: Request):
        enforce_rate_limit(request, _SCOPE, 2, 60)
        return {"ok": True}

    try:
        with TestClient(app) as client:
            assert client.get("/limited").status_code == 200
            assert client.get("/limited").status_code == 200
            resp = client.get("/limited")
            assert resp.status_code == 429
            assert "Retry-After" in resp.headers
    finally:
        _cleanup(f"{_SCOPE}_%")
