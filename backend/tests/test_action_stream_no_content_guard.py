"""动作流 reasoning-only 防护契约测试。

spec: docs/SPEC_动作流reasoning_only防护_2026-08-24.md §4
事故: 消息 2248 —— swipe 重roll reasoning-only 时 _run_action_stream finally 的
`result.has_content` 判定把 reasoning 计入"有内容"，放行 persist_fn 落库
空正文 + 思考链（websocket 主路径有 [NO-CONTENT-FINAL] 守卫，SSE 动作流是唯一漏网出口）。

守卫语义（finally 块）:
1. 正文 strip 后非空且非 "Error:" 开头 → 持久化（不变）
2. 正文为空但 full_reasoning 非空 → 不持久化，发 N12 格式 error SSE 事件
3. CancelledError 注入的 "Error: ..." 文本 → 不持久化、无 error 事件（旧行为不变）
"""

import asyncio
import json
import logging
import os
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from app.api import character_ext
    from app.api.character_ext import _ActionRequest, _run_action_stream  # noqa: E402
    from app.services import unified_model_registry  # noqa: E402
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")

_ERROR_MESSAGE = "模型未输出正文，仅返回思考链，已丢弃本次生成。请重试或切换模型。"


def _make_deltas(*items):
    def _factory(**kwargs):
        async def _gen():
            for item in items:
                yield item
        return _gen()
    return _factory


def _cancelled_factory(**kwargs):
    async def _gen():
        raise asyncio.CancelledError()
        yield {}
    return _gen()


def _parse_sse(raw_events):
    parsed = []
    for raw in raw_events:
        for line in raw.split("\n"):
            if not line.startswith("data: "):
                continue
            body = line[len("data: "):].strip()
            if not body or body == "[DONE]":
                continue
            try:
                parsed.append(json.loads(body))
            except json.JSONDecodeError:
                pass
    return parsed


def _run_scenario(stream_factory):
    persist_results = []
    raw_events = []

    async def _scenario():
        origins = {
            "rate": character_ext.enforce_rate_limit,
            "avail": character_ext.ensure_model_available,
            "db": character_ext.SessionLocal,
            "stream": character_ext.stream_text_completion,
            "find": unified_model_registry.find_model,
        }
        character_ext.enforce_rate_limit = lambda *a, **k: None
        character_ext.ensure_model_available = lambda *a, **k: None
        character_ext.SessionLocal = lambda: MagicMock(name="save_db")
        character_ext.stream_text_completion = stream_factory

        def _fake_find_model(model_id, *a, **k):
            return (None, None)

        unified_model_registry.find_model = _fake_find_model

        def _persist(save_db, result):
            persist_results.append(result)
            return 4321, result.full_content

        try:
            gen = _run_action_stream(
                request=MagicMock(),
                user=SimpleNamespace(id=1),
                char=SimpleNamespace(id="c1"),
                session_id="s1",
                branch_id=None,
                messages=[{"role": "user", "content": "hi"}],
                model="test-model",
                req=_ActionRequest(),
                user_nickname="tester",
                effective_max_tokens=128,
                initial_events=[],
                persist_fn=_persist,
            )
            async for evt in gen:
                raw_events.append(evt)
        finally:
            character_ext.enforce_rate_limit = origins["rate"]
            character_ext.ensure_model_available = origins["avail"]
            character_ext.SessionLocal = origins["db"]
            character_ext.stream_text_completion = origins["stream"]
            unified_model_registry.find_model = origins["find"]

    asyncio.run(_scenario())
    return _parse_sse(raw_events), persist_results


def test_reasoning_only_not_persisted_and_emits_error_event(caplog):
    with caplog.at_level(logging.ERROR):
        events, persisted = _run_scenario(_make_deltas({"reasoning": "x"}))

    assert persisted == []
    assert [e for e in events if e.get("type") == "final_content"] == []
    errors = [e for e in events if e.get("type") == "error"]
    assert len(errors) == 1
    assert errors[0].get("error") is True
    assert errors[0].get("message") == _ERROR_MESSAGE
    assert any("[NO-CONTENT-FINAL-ACTION]" in r.getMessage() for r in caplog.records)


def test_normal_content_still_persisted():
    events, persisted = _run_scenario(_make_deltas({"content": "hi"}))

    assert len(persisted) == 1
    assert persisted[0].full_content == "hi"
    finals = [e for e in events if e.get("type") == "final_content"]
    assert len(finals) == 1
    assert finals[0]["content"] == "hi"
    assert finals[0]["message_id"] == 4321
    assert [e for e in events if e.get("type") == "error"] == []


def test_cancelled_error_injection_keeps_old_behavior(caplog):
    with caplog.at_level(logging.ERROR):
        events, persisted = _run_scenario(_cancelled_factory)

    assert persisted == []
    assert [e for e in events if e.get("type") == "error"] == []
    assert [e for e in events if e.get("type") == "final_content"] == []
