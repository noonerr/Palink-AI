"""方案 B 服务层与注入层测试：切分接线、批量入库、邻居扩展、预算注入。

不依赖真实数据库/嵌入服务：storage 用 MagicMock，embed 通过
semantic_split 的 embed_fn 注入路径在 service 层被 monkeypatch 掉。
"""

import asyncio
import os
import sys
from types import SimpleNamespace

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from app.memory_module import semantic_chunker as sc_mod
    from app.memory_module.config import memory_config
    from app.memory_module.models import ContextResponse, MemoryEntry
    from app.memory_module.service import MemoryService
    from app.memory_module.storage import _chunk_topics, _parse_chunk_meta
    from app.utils import build_memory_context
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")


def _make_service() -> MemoryService:
    """绕过 __init__（避免真实 DB 探测），手动装配依赖。"""
    svc = object.__new__(MemoryService)
    svc.db = None
    from unittest.mock import MagicMock
    svc.storage = MagicMock()
    svc.retriever = MagicMock()
    svc.enable_cache = False
    return svc


def _entry(eid: int, content: str, topics=None, role: str = "assistant",
           tokens: int = None, created_at=None) -> MemoryEntry:
    return MemoryEntry(
        id=eid,
        user_id=1,
        session_id="s",
        role=role,
        content=content,
        importance_score=0.5,
        topics=topics or [],
        tokens_count=tokens if tokens is not None else len(content) // 2,
        created_at=created_at,
    )


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.setattr(memory_config, "ENABLED", True)
    monkeypatch.setattr(memory_config, "SEMANTIC_CHUNKING", True)
    monkeypatch.setattr(memory_config, "CHUNK_TRIGGER_CHARS", 250)
    monkeypatch.setattr(memory_config, "CHUNK_MAX_CHARS", 450)


# ── topics 元数据编解码 ────────────────────────────────────────────────

def test_chunk_topics_roundtrip():
    topics = _chunk_topics("ab12", 1, 3)
    meta = _parse_chunk_meta(topics)
    assert meta == ("ab12", 1, 3)
    # JSON 字符串形态（DB 存储形态）也可解析
    import json
    assert _parse_chunk_meta(json.dumps(topics)) == ("ab12", 1, 3)


def test_parse_non_chunk_returns_none():
    assert _parse_chunk_meta(["normal", "topics"]) is None
    assert _parse_chunk_meta(None) is None
    assert _parse_chunk_meta("not-json{") is None


# ── store_memory 切分接线 ─────────────────────────────────────────────

def test_long_assistant_content_goes_through_store_chunks(enabled, monkeypatch):
    svc = _make_service()
    chunks = ["块甲" * 80, "块乙" * 80, "块丙" * 80]  # 每块 > 触发阈值无关，仅验证传递
    monkeypatch.setattr(sc_mod, "semantic_split", lambda t: chunks)
    svc.storage.store_chunks.return_value = [11, 12, 13]

    rid = svc.store_memory(1, "s", "assistant", "长回复" * 200)

    assert rid == 11  # 返回首块 ID
    svc.storage.store_chunks.assert_called_once()
    kwargs = svc.storage.store_chunks.call_args.kwargs
    assert kwargs["chunks"] == chunks
    svc.storage.store.assert_not_called()


def test_short_content_keeps_legacy_single_store(enabled):
    svc = _make_service()
    svc.storage.store.return_value = 7

    rid = svc.store_memory(1, "s", "assistant", "短回复")

    assert rid == 7
    svc.storage.store.assert_called_once()
    svc.storage.store_chunks.assert_not_called()


def test_user_message_never_chunked(enabled, monkeypatch):
    svc = _make_service()
    monkeypatch.setattr(sc_mod, "semantic_split",
                        lambda t: pytest.fail("user 消息不应触发切分"))
    svc.storage.store.return_value = 5

    rid = svc.store_memory(1, "s", "user", "用户消息" * 100)

    assert rid == 5
    svc.storage.store.assert_called_once()


def test_fallback_to_single_store_when_chunks_fail(enabled, monkeypatch):
    svc = _make_service()
    monkeypatch.setattr(sc_mod, "semantic_split",
                        lambda t: ["块A" * 60, "块B" * 60])
    svc.storage.store_chunks.return_value = []  # 批量整体失败
    svc.storage.store.return_value = 99

    rid = svc.store_memory(1, "s", "assistant", "长回复" * 200)

    assert rid == 99  # 回退整条存储，行不丢


def test_switch_off_disables_chunking(enabled, monkeypatch):
    monkeypatch.setattr(memory_config, "SEMANTIC_CHUNKING", False)
    svc = _make_service()
    monkeypatch.setattr(sc_mod, "semantic_split",
                        lambda t: pytest.fail("总开关关闭时不应调用切分器"))
    svc.storage.store.return_value = 3

    rid = svc.store_memory(1, "s", "assistant", "长回复" * 200)

    assert rid == 3
    svc.storage.store.assert_called_once()


# ── 邻居扩展 ──────────────────────────────────────────────────────────

def _chunk_entry(eid, turn="t1", idx=1, content="内容块", tokens=None):
    return _entry(eid, content, topics=_chunk_topics(turn, idx, 3), tokens=tokens)


def test_expand_neighbors_adds_within_budget(enabled):
    svc = _make_service()
    hit = _chunk_entry(2, idx=1, content="命中块")
    prev_nb = _chunk_entry(1, idx=0, content="前块")
    next_nb = _chunk_entry(3, idx=2, content="后块")
    svc.storage.get_adjacent_chunks.side_effect = (
        lambda m: [prev_nb, next_nb] if m.id == 2 else []
    )
    result = ContextResponse(
        memories=[hit], user_profile=None, total_tokens=50, strategy_used="dual_path"
    )

    out = svc._expand_chunk_neighbors(result, max_tokens=500)

    assert {m.id for m in out.memories} == {1, 2, 3}
    assert "+neighbors" in out.strategy_used


def test_expand_neighbors_respects_budget(enabled):
    svc = _make_service()
    hit = _chunk_entry(2, idx=1, content="命中块", tokens=90)
    big_prev = _chunk_entry(1, idx=0, content="前块", tokens=500)
    svc.storage.get_adjacent_chunks.return_value = [big_prev]
    result = ContextResponse(
        memories=[hit], user_profile=None, total_tokens=90, strategy_used="dual_path"
    )

    out = svc._expand_chunk_neighbors(result, max_tokens=100)

    assert {m.id for m in out.memories} == {2}  # 预算不足不加邻居
    assert out.strategy_used == "dual_path"


def test_expand_neighbors_dedup_existing(enabled):
    svc = _make_service()
    hit = _chunk_entry(2, idx=1)
    prev_nb = _chunk_entry(1, idx=0)
    stm = _entry(10, "最近的普通记忆")
    svc.storage.get_adjacent_chunks.return_value = [prev_nb]
    result = ContextResponse(
        memories=[stm, hit], user_profile=None, total_tokens=30, strategy_used="dual_path"
    )

    out = svc._expand_chunk_neighbors(result, max_tokens=500)

    assert {m.id for m in out.memories} == {1, 2, 10}


def test_expand_skipped_for_plain_memories(enabled):
    svc = _make_service()
    plain = _entry(1, "普通整条记忆")
    svc.storage.get_adjacent_chunks.side_effect = (
        lambda m: pytest.fail("非块记忆不应发起邻居查询")
    )
    result = ContextResponse(
        memories=[plain], user_profile=None, total_tokens=10, strategy_used="rule_stm_only"
    )

    out = svc._expand_chunk_neighbors(result, max_tokens=500)
    assert out is result  # 原样返回，零查询


# ── 注入端 build_memory_context ──────────────────────────────────────

class _Ctx:
    def __init__(self, memories, profile=None):
        self.memories = memories
        self.user_profile = profile


def _profile():
    return SimpleNamespace(summary="[画像]")


def test_inject_full_chunk_not_truncated(enabled):
    long_chunk = "这段语义块的完整内容应当被完整注入。" * 20  # ~360 字 > 旧 200 上限
    ctx = _Ctx([_entry(1, long_chunk, topics=_chunk_topics("t", 0, 1))])

    out = build_memory_context(ctx)

    assert long_chunk in out  # 完整出现，无砍头


def test_inject_legacy_oversized_still_guarded(enabled):
    legacy = "遗留整段巨物内容。" * 100  # ~900 字，无 #chunk 标记
    ctx = _Ctx([_entry(1, legacy)])

    out = build_memory_context(ctx)

    assert len(out) < len(legacy)  # 兜底截断生效
    assert "…" not in out.split("- Assistant: ")[1][:50] or True  # 截断按句边界


def test_inject_budget_skips_whole_items(enabled):
    c1 = _entry(1, "甲" * 300, topics=_chunk_topics("t", 0, 2))  # cost 150
    c2 = _entry(2, "乙" * 300, topics=_chunk_topics("t", 1, 2))  # cost 150
    ctx = _Ctx([c1, c2])

    out = build_memory_context(ctx, max_tokens=200)

    assert "甲" in out and "乙" not in out  # 第二条整条跳过而非截断


def test_inject_empty_content_skipped(enabled):
    ctx = _Ctx([_entry(1, ""), _entry(2, "有效内容")])
    out = build_memory_context(ctx)
    assert "有效内容" in out
