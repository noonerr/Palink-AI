"""消息编辑 × 向量记忆同步：message_id 关联体系测试。

spec: docs/SPEC_消息编辑与向量记忆同步_2026-08-24.md §6
核心不变式: conversation_memories 中 message_id = M.id 的行集合 ≈
clean_memory_content(M 当前显示内容) 的语义嵌入——记忆永远是消息当前内容的镜像。

覆盖面：
1. schema 迁移幂等（二次初始化不报错，列/索引存在）
2. store_memory 带/不带 message_id → 列值正确/NULL 兼容（嵌入不可用走降级）
3. upsert 幂等：同 message_id 先删后写 → 旧行消失只剩新内容
4. 语义切分多块共享同一 message_id（批量路径 + 降级路径）
5. 编辑钩子集成：编辑后旧行删/新行入且 branch_id 正确；内容未变零操作；
   重嵌失败宁缺勿错；锁定消息 403 记忆不动
6. delete_character_message 单条删除级联（存量 NULL 行保留）
7. 写入侧源码契约标签（[MEM-UPSERT]/[MEM-SYNC-ON-EDIT]）
"""

import logging
import os
import sys
import threading
import time
from unittest.mock import MagicMock

import pytest
from sqlalchemy import text

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from app.api import character_ext as ce_mod
    from app.api import sessions as sessions_mod
    from app.memory_module import storage as mem_storage_mod
    from app.memory_module.config import memory_config
    from app.memory_module.service import MemoryService
    from app.memory_module.storage import MemoryStorage
    from app.models import (
        ChatMessage,
        ChatSession,
        CharacterChatMessage,
        CharacterChatSession,
    )
    from app.utils import clean_memory_content
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")


# ─────────────────────────────────────────────────────────────────────
# Fixtures 与工具
# ─────────────────────────────────────────────────────────────────────

@pytest.fixture()
def mem_env(db_session, _engine, monkeypatch):
    """在当前测试引擎上初始化 memory 表，并接管后台线程的 SessionLocal。

    - 复位 memory_module 全局初始化标志，强制 MemoryStorage 在本引擎建表；
    - 默认让 embed_text 抛异常（嵌入不可用环境），验证 NULL embedding 降级路径；
    - character_ext/sessions 的后台重嵌线程改用绑定测试引擎的 session 工厂，
      保证断言与后台写入落在同一个内存库上。
    """
    monkeypatch.setattr(mem_storage_mod, "_tables_initialized", False)
    monkeypatch.setattr(mem_storage_mod, "_is_postgres_cached", None)
    monkeypatch.setattr(mem_storage_mod, "_migration_done", False)
    monkeypatch.setattr(memory_config, "ENABLED", True)
    monkeypatch.setattr(memory_config, "CHUNK_TRIGGER_CHARS", 10 ** 9)

    def _embed_unavailable(*args, **kwargs):
        raise RuntimeError("embedder unavailable in tests")

    monkeypatch.setattr(mem_storage_mod, "embed_text", _embed_unavailable)

    from sqlalchemy.orm import sessionmaker
    test_session_factory = sessionmaker(
        bind=_engine, autoflush=False, autocommit=False, expire_on_commit=False
    )
    monkeypatch.setattr(ce_mod, "SessionLocal", test_session_factory)
    monkeypatch.setattr(sessions_mod, "SessionLocal", test_session_factory)

    MemoryStorage(db_session)
    return db_session


_UNFILTERED = "__unset__"


def _mem_rows(db, session_id, message_id=_UNFILTERED):
    """查询会话记忆行；message_id 传 None 过滤 NULL 行，缺省不过滤。"""
    sql = (
        "SELECT id, role, content, branch_id, message_id, embedding "
        "FROM conversation_memories WHERE session_id = :s"
    )
    params = {"s": session_id}
    if message_id != _UNFILTERED:
        if message_id is None:
            sql += " AND message_id IS NULL"
        else:
            sql += " AND message_id = :m"
            params["m"] = message_id
    sql += " ORDER BY id"
    return db.execute(text(sql), params).fetchall()


def _seed_char_message(db, user, *, role="assistant", content="旧剧情正文",
                       branch_id="br-1", locked=False):
    from app.models import CharacterChatSessionBranch
    sess = CharacterChatSession(user_id=user.id, title="t")
    db.add(sess)
    db.flush()
    db.add(CharacterChatSessionBranch(
        id=branch_id, session_id=sess.id, branch_name=branch_id, is_active=True,
    ))
    msg = CharacterChatMessage(
        session_id=sess.id,
        branch_id=branch_id,
        role=role,
        content=content,
        is_user=(role == "user"),
        is_system=False,
        is_locked=locked,
        swipe_id=0,
    )
    db.add(msg)
    db.commit()
    db.refresh(msg)
    return sess, msg


def _seed_memory(db, user, session_id, message_id, *, content="旧记忆文本",
                 role="assistant", branch_id="br-1"):
    db.execute(text(
        "INSERT INTO conversation_memories "
        "(user_id, session_id, branch_id, role, content, embedding, "
        " importance_score, topics, tokens_count, created_at, message_id) "
        "VALUES (:u, :s, :b, :r, :c, NULL, 0.5, '[]', 0, CURRENT_TIMESTAMP, :m)"
    ), {"u": user.id, "s": session_id, "b": branch_id, "r": role,
        "c": content, "m": message_id})
    db.commit()


def _patch_embed_signal(monkeypatch):
    """embed 被调用即置位 Event（store() 是先 commit 再算嵌入 → 置位即落库完成）。"""
    ev = threading.Event()

    def _fake_embed(*args, **kwargs):
        ev.set()
        raise RuntimeError("embed signal raised (degradation path)")

    monkeypatch.setattr(mem_storage_mod, "embed_text", _fake_embed)
    return ev


def _wait_for_log(caplog, needle, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if any(needle in r.getMessage() for r in caplog.records):
            return True
        time.sleep(0.05)
    return False


def _make_mock_service():
    svc = object.__new__(MemoryService)
    svc.db = None
    svc.storage = MagicMock()
    svc.retriever = MagicMock()
    svc.enable_cache = False
    return svc


# ─────────────────────────────────────────────────────────────────────
# 1. Schema 迁移幂等
# ─────────────────────────────────────────────────────────────────────

def test_schema_migration_idempotent(tmp_path, monkeypatch):
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    engine = create_engine(f"sqlite:///{tmp_path / 'mem.db'}")
    try:
        for _round in (1, 2):
            monkeypatch.setattr(mem_storage_mod, "_tables_initialized", False)
            monkeypatch.setattr(mem_storage_mod, "_is_postgres_cached", None)
            monkeypatch.setattr(mem_storage_mod, "_migration_done", False)
            session = sessionmaker(bind=engine)()
            MemoryStorage(session)
            cols = [r[1] for r in session.execute(
                text("PRAGMA table_info(conversation_memories)"))]
            assert "message_id" in cols
            idx = session.execute(text(
                "SELECT name FROM sqlite_master WHERE type='index' "
                "AND name='idx_memory_message_id'")).fetchall()
            assert idx, "idx_memory_message_id 索引应存在"
            session.close()
    finally:
        engine.dispose()


# ─────────────────────────────────────────────────────────────────────
# 2. store_memory 带/不带 message_id
# ─────────────────────────────────────────────────────────────────────

def test_store_memory_with_message_id_persists_column(mem_env):
    db = mem_env
    svc = MemoryService(db)

    rid = svc.store_memory(user_id=1, session_id="s-link", role="assistant",
                           content="带关联的正文", branch_id="br-9", message_id=42)

    assert rid is not None
    rows = _mem_rows(db, "s-link", 42)
    assert len(rows) == 1
    assert rows[0].message_id == 42
    assert rows[0].branch_id == "br-9"
    assert rows[0].content == "带关联的正文"
    # 嵌入不可用降级：行存在且 embedding 为 NULL
    assert rows[0].embedding is None


def test_store_memory_without_message_id_null_compatible(mem_env):
    db = mem_env
    svc = MemoryService(db)

    rid = svc.store_memory(user_id=1, session_id="s-null", role="user",
                           content="存量兼容的用户消息")

    assert rid is not None
    rows = _mem_rows(db, "s-null")
    assert len(rows) == 1
    assert rows[0].message_id is None
    assert rows[0].embedding is None


def test_service_passes_message_id_to_storage(monkeypatch):
    monkeypatch.setattr(memory_config, "ENABLED", True)
    svc = _make_mock_service()
    svc.storage.store.return_value = 7

    rid = svc.store_memory(1, "s", "assistant", "短文本", message_id=42)

    assert rid == 7
    assert svc.storage.store.call_args.kwargs["message_id"] == 42


def test_service_defaults_message_id_none(monkeypatch):
    monkeypatch.setattr(memory_config, "ENABLED", True)
    svc = _make_mock_service()
    svc.storage.store.return_value = 7

    svc.store_memory(1, "s", "assistant", "短文本")

    assert svc.storage.store.call_args.kwargs["message_id"] is None


def test_service_long_assistant_chunks_share_message_id(monkeypatch):
    from app.memory_module import semantic_chunker as sc_mod

    monkeypatch.setattr(memory_config, "ENABLED", True)
    monkeypatch.setattr(memory_config, "SEMANTIC_CHUNKING", True)
    monkeypatch.setattr(memory_config, "CHUNK_TRIGGER_CHARS", 10)
    svc = _make_mock_service()
    chunks = ["块甲" * 30, "块乙" * 30, "块丙" * 30]
    monkeypatch.setattr(sc_mod, "semantic_split", lambda t: chunks)
    svc.storage.store_chunks.return_value = [11, 12, 13]

    rid = svc.store_memory(1, "s", "assistant", "长回复" * 100, message_id=9)

    assert rid == 11
    assert svc.storage.store_chunks.call_args.kwargs["message_id"] == 9
    svc.storage.store.assert_not_called()


# ─────────────────────────────────────────────────────────────────────
# 3. upsert 幂等（先删后写收敛不变式）
# ─────────────────────────────────────────────────────────────────────

def test_upsert_by_message_id_idempotent(mem_env):
    db = mem_env
    storage = MemoryStorage(db)
    storage.store(user_id=1, session_id="s-up", role="assistant",
                  content="版本A旧内容", message_id=101)

    # 写入侧 [MEM-UPSERT] 的先删半步（与四处调用点同一助手函数）
    mem_storage_mod.delete_by_message_id(db, "s-up", 101)
    storage.store(user_id=1, session_id="s-up", role="assistant",
                  content="版本B新内容", message_id=101)

    rows = _mem_rows(db, "s-up", 101)
    assert len(rows) == 1
    assert rows[0].content == "版本B新内容"


def test_delete_by_message_id_scopes_to_session(mem_env):
    db = mem_env
    storage = MemoryStorage(db)
    storage.store(user_id=1, session_id="s-a", role="assistant",
                  content="A 会话内容", message_id=200)
    storage.store(user_id=1, session_id="s-b", role="assistant",
                  content="B 会话内容", message_id=200)

    mem_storage_mod.delete_by_message_id(db, "s-a", 200)

    assert _mem_rows(db, "s-a", 200) == []
    assert len(_mem_rows(db, "s-b", 200)) == 1


# ─────────────────────────────────────────────────────────────────────
# 4. 语义切分多块共享同一 message_id
# ─────────────────────────────────────────────────────────────────────

def test_store_chunks_batch_share_message_id(mem_env, monkeypatch):
    import numpy as np

    def _fake_embed(texts):
        return np.array([[0.1, 0.2, 0.3] for _ in texts], dtype=np.float32)

    monkeypatch.setattr(mem_storage_mod, "embed_text", _fake_embed)
    db = mem_env
    storage = MemoryStorage(db)

    ids = storage.store_chunks(
        user_id=1, session_id="s-chunk", role="assistant",
        chunks=["甲块内容" * 20, "乙块内容" * 20, "丙块内容" * 20],
        branch_id="br-x", message_id=77,
    )

    assert len(ids) == 3
    rows = _mem_rows(db, "s-chunk", 77)
    assert len(rows) == 3
    assert {r.content[:1] for r in rows} == {"甲", "乙", "丙"}
    assert all(r.branch_id == "br-x" for r in rows)
    assert all(r.embedding is not None for r in rows)


def test_store_chunks_degraded_fallback_keeps_message_id(mem_env):
    db = mem_env
    storage = MemoryStorage(db)

    ids = storage.store_chunks(
        user_id=1, session_id="s-degrade", role="assistant",
        chunks=["降级甲块" * 15, "降级乙块" * 15],
        branch_id=None, message_id=88,
    )

    assert len(ids) == 2
    rows = _mem_rows(db, "s-degrade", 88)
    assert len(rows) == 2
    assert all(r.message_id == 88 for r in rows)
    assert all(r.embedding is None for r in rows)


# ─────────────────────────────────────────────────────────────────────
# 5. 编辑钩子集成（character_ext.edit_character_message）
# ─────────────────────────────────────────────────────────────────────

def test_edit_assistant_message_resyncs_memory(client, mem_env, test_user, monkeypatch):
    db = mem_env
    sess, msg = _seed_char_message(db, test_user, role="assistant",
                                   content="旧剧情正文", branch_id="br-1")
    _seed_memory(db, test_user, sess.id, msg.id, content="旧剧情正文",
                 branch_id="br-1")
    ev = _patch_embed_signal(monkeypatch)

    resp = client.put(
        f"/api/character-sessions/{sess.id}/messages/{msg.id}",
        json={"content": "新剧情正文 <think>不应入库</think>"},
    )

    assert resp.status_code == 200
    assert ev.wait(5), "后台重嵌未执行"
    rows = _mem_rows(db, sess.id, msg.id)
    assert len(rows) == 1
    row = rows[0]
    assert row.content == clean_memory_content("新剧情正文 <think>不应入库</think>")
    assert "不应入库" not in row.content
    assert row.message_id == msg.id
    assert row.branch_id == "br-1"
    assert row.role == "assistant"


def test_edit_user_message_resyncs_memory_raw_text(client, mem_env, test_user, monkeypatch):
    db = mem_env
    sess, msg = _seed_char_message(db, test_user, role="user",
                                   content="用户的旧发言", branch_id="br-2")
    _seed_memory(db, test_user, sess.id, msg.id, content="用户的旧发言",
                 role="user", branch_id="br-2")
    ev = _patch_embed_signal(monkeypatch)

    resp = client.put(
        f"/api/character-sessions/{sess.id}/messages/{msg.id}",
        json={"content": "用户的新发言"},
    )

    assert resp.status_code == 200
    assert ev.wait(5)
    rows = _mem_rows(db, sess.id, msg.id)
    assert len(rows) == 1
    assert rows[0].content == "用户的新发言"
    assert rows[0].role == "user"
    assert rows[0].message_id == msg.id
    assert rows[0].branch_id == "br-2"


def test_edit_empty_content_only_deletes(client, mem_env, test_user, monkeypatch):
    db = mem_env
    sess, msg = _seed_char_message(db, test_user, role="assistant",
                                   content="将被清空的正文", branch_id="br-3")
    _seed_memory(db, test_user, sess.id, msg.id, content="将被清空的正文")

    def _fail_if_called(*a, **k):
        raise AssertionError("空正文编辑不应触发后台重嵌")

    monkeypatch.setattr(MemoryService, "store_memory", _fail_if_called)

    resp = client.put(
        f"/api/character-sessions/{sess.id}/messages/{msg.id}",
        json={"content": "   "},
    )

    assert resp.status_code == 200
    time.sleep(0.2)
    assert _mem_rows(db, sess.id, msg.id) == []


def test_edit_same_content_zero_op(client, mem_env, test_user, monkeypatch):
    db = mem_env
    sess, msg = _seed_char_message(db, test_user, role="assistant",
                                   content="保持不变的正文", branch_id="br-4")
    _seed_memory(db, test_user, sess.id, msg.id, content="保持不变的正文")

    def _fail_if_called(*a, **k):
        raise AssertionError("内容未变不应触发任何记忆操作")

    monkeypatch.setattr(MemoryService, "store_memory", _fail_if_called)

    resp = client.put(
        f"/api/character-sessions/{sess.id}/messages/{msg.id}",
        json={"content": "保持不变的正文"},
    )

    assert resp.status_code == 200
    time.sleep(0.2)

    rows = _mem_rows(db, sess.id, msg.id)
    assert len(rows) == 1
    assert rows[0].content == "保持不变的正文"


def test_edit_reembed_failure_ningque_wucuo(client, mem_env, test_user, monkeypatch, caplog):
    db = mem_env
    sess, msg = _seed_char_message(db, test_user, role="assistant",
                                   content="待编辑旧文", branch_id="br-5")
    _seed_memory(db, test_user, sess.id, msg.id, content="待编辑旧文")

    def _boom(*a, **k):
        raise RuntimeError("embed layer exploded")

    monkeypatch.setattr(MemoryService, "store_memory", _boom)

    with caplog.at_level(logging.WARNING):
        resp = client.put(
            f"/api/character-sessions/{sess.id}/messages/{msg.id}",
            json={"content": "重嵌必失败的正文"},
        )

    assert resp.status_code == 200
    assert _wait_for_log(caplog, "re-embed after edit failed")
    rows = _mem_rows(db, sess.id, msg.id)
    assert rows == [], "宁缺勿错：旧记忆删除后重嵌失败不得残留任何行"


def test_edit_locked_message_403_memory_untouched(client, mem_env, test_user):
    db = mem_env
    sess, msg = _seed_char_message(db, test_user, role="assistant",
                                   content="锁定消息正文", branch_id="br-6", locked=True)
    _seed_memory(db, test_user, sess.id, msg.id, content="锁定消息正文")

    resp = client.put(
        f"/api/character-sessions/{sess.id}/messages/{msg.id}",
        json={"content": "试图修改锁定消息"},
    )

    assert resp.status_code == 403
    rows = _mem_rows(db, sess.id, msg.id)
    assert len(rows) == 1
    assert rows[0].content == "锁定消息正文"


# ─────────────────────────────────────────────────────────────────────
# 5b. 普通聊天对齐（sessions.update_message）
# ─────────────────────────────────────────────────────────────────────

def test_update_message_sessions_sync_memory(client, mem_env, test_user, monkeypatch):
    db = mem_env
    cs = ChatSession(id="sess-normal", user_id=test_user.id, title="普通聊天",
                     type="chat")
    cm = ChatMessage(session_id="sess-normal", role="assistant",
                     content="普通聊天旧回复", model="m1")
    db.add_all([cs, cm])
    db.commit()
    db.refresh(cm)
    _seed_memory(db, test_user, cs.id, cm.id, content="普通聊天旧回复",
                 branch_id=None)
    ev = _patch_embed_signal(monkeypatch)

    resp = client.put(
        f"/api/sessions/{cs.id}/messages/{cm.id}",
        json={"content": "普通聊天新回复"},
    )

    assert resp.status_code == 200
    assert ev.wait(5)
    rows = _mem_rows(db, cs.id, cm.id)
    assert len(rows) == 1
    assert rows[0].content == "普通聊天新回复"
    assert rows[0].message_id == cm.id
    assert rows[0].branch_id is None
    assert rows[0].role == "assistant"


def test_update_message_sessions_same_content_zero_op(client, mem_env, test_user):
    db = mem_env
    cs = ChatSession(id="sess-noop", user_id=test_user.id, title="普通聊天",
                     type="chat")
    cm = ChatMessage(session_id="sess-noop", role="assistant",
                     content="不变内容", model="m1")
    db.add_all([cs, cm])
    db.commit()
    db.refresh(cm)
    _seed_memory(db, test_user, cs.id, cm.id, content="不变内容",
                 branch_id=None)

    resp = client.put(
        f"/api/sessions/{cs.id}/messages/{cm.id}",
        json={"content": "不变内容"},
    )

    assert resp.status_code == 200
    rows = _mem_rows(db, cs.id, cm.id)
    assert len(rows) == 1
    assert rows[0].content == "不变内容"


# ─────────────────────────────────────────────────────────────────────
# 6. 单条消息删除级联
# ─────────────────────────────────────────────────────────────────────

def test_delete_character_message_cascades_memory(client, mem_env, test_user):
    db = mem_env
    sess, msg = _seed_char_message(db, test_user, role="assistant",
                                   content="将被删除的消息", branch_id="br-7")
    _seed_memory(db, test_user, sess.id, msg.id, content="将被删除的消息")
    # 存量 NULL 行必须保留（红线：不删任何既有数据行）
    db.execute(text(
        "INSERT INTO conversation_memories "
        "(user_id, session_id, branch_id, role, content, embedding, "
        " importance_score, topics, tokens_count, created_at, message_id) "
        "VALUES (:u, :s, :b, 'assistant', '存量无主记忆', NULL, 0.5, '[]', 0, "
        "CURRENT_TIMESTAMP, NULL)"
    ), {"u": test_user.id, "s": sess.id, "b": "br-7"})
    db.commit()

    resp = client.delete(
        f"/api/character-sessions/{sess.id}/messages/{msg.id}"
    )

    assert resp.status_code == 200
    assert _mem_rows(db, sess.id, msg.id) == []
    orphan_keep = _mem_rows(db, sess.id, None)
    assert len(orphan_keep) == 1
    assert orphan_keep[0].content == "存量无主记忆"


# ─────────────────────────────────────────────────────────────────────
# 7. 写入侧源码契约（防止接线回退）
# ─────────────────────────────────────────────────────────────────────

def test_source_contract_upsert_and_edit_hook_tags():
    def _read(rel):
        with open(os.path.join(_BACKEND_DIR, rel), "r", encoding="utf-8") as fh:
            return fh.read()

    ws_src = _read(os.path.join("app", "api", "websocket.py"))
    ce_src = _read(os.path.join("app", "api", "character_ext.py"))
    ss_src = _read(os.path.join("app", "api", "sessions.py"))

    # 四处写入点统一 [MEM-UPSERT]：websocket 两处 + character_ext SSE 两处
    assert ws_src.count("[MEM-UPSERT]") >= 2, "websocket.py 缺少 [MEM-UPSERT] 写入点"
    assert ce_src.count("[MEM-UPSERT]") >= 2, "character_ext.py 缺少 [MEM-UPSERT] 写入点"
    # 编辑钩子两处对齐
    assert "[MEM-SYNC-ON-EDIT]" in ce_src, "character_ext.py 缺少编辑钩子"
    assert "[MEM-SYNC-ON-EDIT]" in ss_src, "sessions.py 缺少编辑钩子"
    # 删除级联使用统一的按 message_id 删除入口
    assert "delete_by_message_id" in ce_src, "delete_character_message 应级联删除记忆"
