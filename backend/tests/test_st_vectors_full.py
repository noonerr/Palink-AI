"""ST vectors.js 全端点契约测试（T7）。

对照 SillyTavern 1.18.0 ``src/endpoints/vectors.js`` 验证 Palink 后端
8 个 /api/vector/* 端点的 ST 形状：

- insert（ST 格式：collectionId + items[].hash，客户端 cyrb53 计算 hash）
- list（返回裸 number[] hash 数组）
- query（{"metadata": [...], "hashes": [...]}）
- query-multi（Record<collectionId, {metadata, hashes}>）
- delete（按 collectionId + hashes）
- purge / purge-all（st-vec:: 前缀隔离，不误删正常记忆）
- Palink 自有格式向后兼容（不含 collectionId 的旧调用）

嵌入模型通过 monkeypatch 替换为固定向量，避免测试拉起 fastembed。
insert 的 embedding 由异步任务计算，测试中直接 UPDATE 补齐以保证时序确定。
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
import pytest
from sqlalchemy import text as sa_text

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)


FAKE_VEC = np.array([1.0, 0.0, 0.0], dtype=np.float32)


@pytest.fixture(autouse=True)
def _patch_embedder(monkeypatch):
    """替换 embed_text 为固定向量，隔离外部嵌入模型依赖。

    同时预置 MemoryStorage 模块级缓存，跳过构造函数中的
    _detect_postgres（SQLite 无 version() → rollback 副作用）与
    _init_tables（DDL + commit 副作用）。这两个副作用会破坏 conftest
    绑定 connection 的事务，导致 test_user 实例 DetachedInstanceError。
    表结构已由 conftest 的 Base.metadata.create_all 创建。
    """
    import app.memory_module.embedder as embedder_mod
    import app.memory_module.storage as storage_mod

    monkeypatch.setattr(embedder_mod, "embed_text", lambda _text: FAKE_VEC)
    monkeypatch.setattr(storage_mod, "embed_text", lambda _text: FAKE_VEC)
    monkeypatch.setattr(storage_mod, "_tables_initialized", True)
    monkeypatch.setattr(storage_mod, "_is_postgres_cached", False)
    monkeypatch.setattr(storage_mod, "_migration_done", True)
    yield


@pytest.fixture(autouse=True)
def _ensure_memory_tables(_engine):
    """建 conversation_memories 表（不在 Base.metadata 中，由 MemoryStorage
    原生 DDL 管理；测试跳过了 _init_tables，故此处手动建表）。

    conftest 的 _truncate_all_tables 只遍历 Base.metadata，不会清理本表，
    因此 teardown 时手动清空，保证测试间隔离。
    """
    ddl = (
        "CREATE TABLE IF NOT EXISTS conversation_memories ("
        " id INTEGER PRIMARY KEY AUTOINCREMENT,"
        " user_id INTEGER,"
        " session_id TEXT,"
        " branch_id TEXT,"
        " role TEXT NOT NULL,"
        " content TEXT NOT NULL,"
        " content_summary TEXT,"
        " embedding TEXT,"
        " importance_score REAL DEFAULT 0.5,"
        " topics TEXT DEFAULT '[]',"
        " tokens_count INTEGER DEFAULT 0,"
        " created_at DATETIME DEFAULT CURRENT_TIMESTAMP)"
    )
    with _engine.begin() as conn:
        conn.exec_driver_sql(ddl)
    yield
    with _engine.begin() as conn:
        conn.exec_driver_sql("DELETE FROM conversation_memories")


def _fill_embeddings(db_session):
    """insert 端点的 embedding 由后台异步计算；测试中直接补齐确保可查询。"""
    db_session.execute(
        sa_text(
            "UPDATE conversation_memories SET embedding = :emb WHERE embedding IS NULL"
        ),
        {"emb": json.dumps(FAKE_VEC.tolist())},
    )
    db_session.commit()


def _st_insert(client, auth_headers, collection_id, items):
    return client.post(
        "/api/vector/insert",
        headers=auth_headers,
        json={"collectionId": collection_id, "items": items, "source": "transformers"},
    )


class TestStVectorInsertAndList:
    def test_insert_returns_ok_and_list_returns_bare_hash_array(
        self, client, auth_headers, db_session
    ):
        resp = _st_insert(
            client,
            auth_headers,
            "chat-abc",
            [
                {"hash": 111, "text": "hello world", "index": 0},
                {"hash": 222, "text": "second message", "index": 1},
            ],
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data.get("ok") is True
        assert data.get("inserted") == 2

        # /list 返回裸数组（ST 客户端直接当 number[] 用，不能有信封）
        resp = client.post(
            "/api/vector/list",
            headers=auth_headers,
            json={"collectionId": "chat-abc"},
        )
        assert resp.status_code == 200
        hashes = resp.json()
        assert isinstance(hashes, list)
        assert sorted(hashes) == [111, 222]

    def test_insert_dedupes_by_hash(self, client, auth_headers, db_session):
        _st_insert(client, auth_headers, "chat-dedup", [{"hash": 7, "text": "a", "index": 0}])
        resp = _st_insert(
            client, auth_headers, "chat-dedup", [{"hash": 7, "text": "a", "index": 0}]
        )
        assert resp.json().get("inserted") == 0
        resp = client.post(
            "/api/vector/list", headers=auth_headers, json={"collectionId": "chat-dedup"}
        )
        assert resp.json() == [7]


class TestStVectorQuery:
    def test_query_st_shape(self, client, auth_headers, db_session):
        _st_insert(
            client,
            auth_headers,
            "chat-q",
            [{"hash": 333, "text": "quantum cats", "index": 2}],
        )
        _fill_embeddings(db_session)

        resp = client.post(
            "/api/vector/query",
            headers=auth_headers,
            json={
                "collectionId": "chat-q",
                "searchText": "quantum",
                "topK": 5,
                "threshold": 0.5,
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert set(data.keys()) == {"metadata", "hashes"}
        assert data["hashes"] == [333]
        assert data["metadata"][0]["hash"] == 333
        assert data["metadata"][0]["text"] == "quantum cats"
        assert data["metadata"][0]["index"] == 2

    def test_query_palink_format_still_works(self, client, auth_headers, db_session):
        """向后兼容：不含 collectionId 的旧格式返回 {"results": [...]}。"""
        resp = client.post(
            "/api/vector/query",
            headers=auth_headers,
            json={"query": "anything", "top_k": 3},
        )
        assert resp.status_code == 200
        assert "results" in resp.json()

    def test_query_multi_returns_record(self, client, auth_headers, db_session):
        _st_insert(client, auth_headers, "coll-a", [{"hash": 1, "text": "aa", "index": 0}])
        _st_insert(client, auth_headers, "coll-b", [{"hash": 2, "text": "bb", "index": 0}])
        _fill_embeddings(db_session)

        resp = client.post(
            "/api/vector/query-multi",
            headers=auth_headers,
            json={
                "collectionIds": ["coll-a", "coll-b"],
                "searchText": "x",
                "topK": 5,
                "threshold": 0.0,
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert set(data.keys()) == {"coll-a", "coll-b"}
        assert data["coll-a"]["hashes"] == [1]
        assert data["coll-b"]["hashes"] == [2]


class TestStVectorDeleteAndPurge:
    def test_delete_by_hashes(self, client, auth_headers, db_session):
        _st_insert(
            client,
            auth_headers,
            "chat-del",
            [
                {"hash": 10, "text": "keep", "index": 0},
                {"hash": 20, "text": "remove", "index": 1},
            ],
        )
        resp = client.post(
            "/api/vector/delete",
            headers=auth_headers,
            json={"collectionId": "chat-del", "hashes": [20]},
        )
        assert resp.status_code == 200
        assert resp.json().get("deleted") == 1
        resp = client.post(
            "/api/vector/list", headers=auth_headers, json={"collectionId": "chat-del"}
        )
        assert resp.json() == [10]

    def test_purge_only_target_collection(self, client, auth_headers, db_session):
        _st_insert(client, auth_headers, "purge-me", [{"hash": 1, "text": "x", "index": 0}])
        _st_insert(client, auth_headers, "keep-me", [{"hash": 2, "text": "y", "index": 0}])

        resp = client.post(
            "/api/vector/purge", headers=auth_headers, json={"collectionId": "purge-me"}
        )
        assert resp.status_code == 200
        assert resp.json().get("deleted") == 1

        assert client.post(
            "/api/vector/list", headers=auth_headers, json={"collectionId": "purge-me"}
        ).json() == []
        assert client.post(
            "/api/vector/list", headers=auth_headers, json={"collectionId": "keep-me"}
        ).json() == [2]

    def test_purge_all_spares_normal_memories(
        self, client, auth_headers, db_session, test_user
    ):
        # 正常会话记忆（非 st-vec:: 前缀）不能被 purge-all 误删
        db_session.execute(
            sa_text(
                "INSERT INTO conversation_memories "
                "(user_id, session_id, role, content, importance_score, topics, tokens_count, created_at) "
                "VALUES (:uid, 'normal-session', 'user', 'precious memory', 0.5, '[]', 5, CURRENT_TIMESTAMP)"
            ),
            {"uid": test_user.id},
        )
        db_session.commit()
        _st_insert(client, auth_headers, "c1", [{"hash": 1, "text": "a", "index": 0}])
        _st_insert(client, auth_headers, "c2", [{"hash": 2, "text": "b", "index": 0}])

        resp = client.post("/api/vector/purge-all", headers=auth_headers, json={})
        assert resp.status_code == 200
        assert resp.json().get("deleted") == 2

        remaining = db_session.execute(
            sa_text(
                "SELECT session_id FROM conversation_memories WHERE user_id = :uid"
            ),
            {"uid": test_user.id},
        ).fetchall()
        assert [row[0] for row in remaining] == ["normal-session"]


class TestEndpointRegistration:
    def test_new_vector_routes_registered(self, client, auth_headers):
        """路由懒挂载（app.routes 在 import 时仅 6 条），改用真实 HTTP 探测：
        已注册的路由不应返回 404/405。"""
        for path, payload in (
            ("/api/vector/list", {"collectionId": "probe"}),
            ("/api/vector/query-multi", {"collectionIds": ["probe"], "searchText": "x"}),
            ("/api/vector/purge", {"collectionId": "probe"}),
            ("/api/vector/purge-all", {}),
        ):
            resp = client.post(path, headers=auth_headers, json=payload)
            assert resp.status_code not in (404, 405), (
                f"route missing or method wrong: {path} -> {resp.status_code}"
            )
