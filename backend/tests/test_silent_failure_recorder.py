"""`app.core.silent_failure` 的行为契约。

为什么单独立这份测试：这个模块的**唯一价值**是「被吞掉的异常一定留下记录」。
一旦它自己会抛异常、或者记了但不进 logger、或者账本被写坏，那 562 个改造点
就全都白改，而且**没有任何测试会变红** —— 所以它必须自己先被钉住。
"""

from __future__ import annotations

import logging

import pytest

from app.core import silent_failure as sf


@pytest.fixture(autouse=True)
def _clean():
    sf.reset()
    token = sf.bind_request_id("")
    yield
    sf.reset_request_id(token)
    sf.reset()


def test_swallow_records_and_does_not_propagate(caplog):
    caplog.set_level(logging.ERROR, logger="PalinkAI.silent_failure")
    with sf.swallow("audit.demo"):
        raise ValueError("boom")

    assert sf.snapshot()["total"] == 1
    assert sf.snapshot()["counts"] == {"audit.demo": 1}
    assert any("[SILENT-FAIL]" in r.getMessage() for r in caplog.records)
    assert any("exc=ValueError" in r.getMessage() for r in caplog.records)


def test_swallow_lets_normal_flow_through():
    reached = False
    with sf.swallow("audit.demo"):
        reached = True
    assert reached is True
    assert sf.snapshot()["total"] == 0, "没抛异常就不该记"


def test_swallow_does_not_catch_base_exception():
    """KeyboardInterrupt / SystemExit 必须继续上抛，不能被当成静默失败吞掉。"""
    with pytest.raises(KeyboardInterrupt):
        with sf.swallow("audit.demo"):
            raise KeyboardInterrupt()
    assert sf.snapshot()["total"] == 0


def test_record_carries_request_id(caplog):
    caplog.set_level(logging.ERROR, logger="PalinkAI.silent_failure")
    token = sf.bind_request_id("req-abc123")
    try:
        sf.record("worldbook.bind_probe", ValueError("x"), book_id="wb-1")
    finally:
        sf.reset_request_id(token)

    text = "\n".join(r.getMessage() for r in caplog.records)
    assert "request_id=req-abc123" in text
    assert "scope=worldbook.bind_probe" in text
    assert "book_id='wb-1'" in text

    last = sf.snapshot()["last_seen"]["worldbook.bind_probe"]
    assert last["last_request_id"] == "req-abc123"
    assert last["last_exc_type"] == "ValueError"


def test_record_never_raises_even_with_hostile_context():
    """上下文里有会炸的对象时，record 也必须安静返回。"""

    class Hostile:
        def __repr__(self):
            raise RuntimeError("repr blew up")

    sf.record("audit.hostile", None, payload=Hostile())  # 不抛即通过
    assert sf.snapshot()["total"] == 1


def test_record_without_exception_is_counted():
    sf.record("regex.invalid_pattern", None, pattern_id="p1")
    snap = sf.snapshot()
    assert snap["total"] == 1
    assert snap["last_seen"]["regex.invalid_pattern"]["last_exc_type"] == ""


def test_snapshot_is_json_serializable():
    import json

    with sf.swallow("audit.json"):
        raise RuntimeError("x")
    json.dumps(sf.snapshot())  # 不抛即通过


def test_counts_are_per_scope_and_ordered():
    for _ in range(3):
        with sf.swallow("a.heavy"):
            raise ValueError()
    with sf.swallow("b.light"):
        raise ValueError()

    snap = sf.snapshot()
    assert snap["total"] == 4
    assert snap["counts"]["a.heavy"] == 3
    assert snap["counts"]["b.light"] == 1
    assert list(snap["counts"])[0] == "a.heavy", "高频 scope 应排在前"


def test_format_exc_brief_points_at_the_raise_site():
    try:
        raise KeyError("k")
    except KeyError as exc:
        line = sf.format_exc_brief(exc)
    assert line.startswith("KeyError")
    assert ".py:" in line


def test_once_logs_only_first_but_still_counts(caplog):
    """热路径用 once=True：日志只写一次，计数照涨（否则会刷屏）。"""
    caplog.set_level(logging.ERROR, logger="PalinkAI.silent_failure")
    for _ in range(5):
        sf.record("hot.path", ValueError("x"), once=True)

    snap = sf.snapshot()
    assert snap["counts"]["hot.path"] == 5, "计数必须每次都涨"
    hits = [r for r in caplog.records if "hot.path" in r.getMessage()]
    assert len(hits) == 1, "日志只应写一次，实际 %d 次" % len(hits)


def test_once_is_per_scope_not_global(caplog):
    caplog.set_level(logging.ERROR, logger="PalinkAI.silent_failure")
    sf.record("hot.a", ValueError(), once=True)
    sf.record("hot.b", ValueError(), once=True)
    scopes = [r.getMessage() for r in caplog.records]
    assert any("hot.a" in s for s in scopes)
    assert any("hot.b" in s for s in scopes)
