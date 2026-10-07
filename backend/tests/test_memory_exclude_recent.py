"""D3 修复测试（2026-08-29）：记忆检索排除最近消息的记忆镜像（ST protect 语义）。

来源: docs/REPORT_ST兼容性深度调研_2026-08-29.md 第一档 ④
     + PLAN_ST兼容修复批次_2026-08-28.md 批次 D D3。

背景: 记忆 = 消息当前内容的镜像（message_id 关联）。对话历史窗口已含最近
消息原文，STM（最近 5 条记忆）与 LTM（语义检索）再次召回这些镜像 =
[Relevant Memories] 与历史必然重复注入，长对话 token 冗余。

修复: ContextRequest.exclude_message_ids（调用方传最近 N 条消息 id，N=5
对齐 ST vectors protect 默认）→ retriever 在 STM/LTM 两条路过滤 message_id
命中集的条目；NULL message_id 的存量行永不排除（既定边界不做回填）。
service.get_context 透传并把排除集纳入缓存键（防跨轮串味）。

覆盖面：
1. rule 模式: 排除后返回 5 条非镜像记忆（多取补位保证数量稳定）
2. 不传排除集 → 行为与修复前一致（最近 5 条）
3. 全部命中排除集 → 空结果
4. NULL message_id 行不受排除影响
5. vector 模式: STM 同样过滤（嵌入不可用降级路径下 LTM 为空属预期）
"""

import os
import sys
from datetime import datetime, timedelta

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from sqlalchemy import text

    from app.memory_module import storage as mem_storage_mod
    from app.memory_module.config import memory_config
    from app.memory_module.models import ContextRequest
    from app.memory_module.retriever import MemoryRetriever
    from app.memory_module.storage import MemoryStorage
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")

SESSION_ID = "mem-excl-session"


@pytest.fixture()
def mem_env(db_session, monkeypatch):
    """在当前测试引擎上初始化 memory 表（复用 test_memory_message_link 的接管模式）。"""
    monkeypatch.setattr(mem_storage_mod, "_tables_initialized", False)
    monkeypatch.setattr(mem_storage_mod, "_is_postgres_cached", None)
    monkeypatch.setattr(mem_storage_mod, "_migration_done", False)
    monkeypatch.setattr(memory_config, "ENABLED", True)
    # 存储构造即建表 + 迁移（补 message_id 列）
    storage = MemoryStorage(db_session)
    return storage, db_session


def _insert_memory(db, user_id, content, message_id=None, created_at=None, session_id=SESSION_ID):
    """直接按显示时间序插入记忆行（嵌入为 NULL = 降级路径），返回自增 id。"""
    result = db.execute(
        text(
            "INSERT INTO conversation_memories "
            "(user_id, session_id, role, content, importance_score, tokens_count, created_at, message_id) "
            "VALUES (:u, :s, 'assistant', :c, 0.5, 10, :t, :m)"
        ),
        {
            "u": user_id,
            "s": session_id,
            "c": content,
            "t": created_at or datetime.utcnow(),
            "m": message_id,
        },
    )
    db.flush()
    return result.lastrowid


def _insert_recent_set(db, user_id, count=7):
    """插入 count 条镜像记忆，message_id = 1..count，created_at 递增（越新越晚）。"""
    base = datetime(2026, 8, 29, 12, 0, 0)
    ids = {}
    for i in range(1, count + 1):
        ids[i] = _insert_memory(
            db, user_id, f"memory-mirror-{i}",
            message_id=i, created_at=base + timedelta(seconds=i),
        )
    return ids


def _retrieve(storage, user_id, mode="rule", exclude=None, query="memory"):
    retriever = MemoryRetriever(storage)
    request = ContextRequest(
        user_id=user_id,
        query=query,
        session_id=SESSION_ID,
        max_tokens=2000,
        include_profile=False,
        memory_mode=mode,
        exclude_message_ids=exclude,
    )
    return retriever.retrieve(request)


class TestExcludeRecentMirrors:
    def test_rule_mode_excludes_recent_mirrors(self, mem_env, test_user):
        """排除最近 2 条镜像 → 返回其余 5 条（recent_limit 数量稳定）。"""
        storage, db = mem_env
        _insert_recent_set(db, test_user.id, count=7)
        response = _retrieve(storage, test_user.id, mode="rule", exclude=[6, 7])
        returned_mids = {m.message_id for m in response.memories}
        assert returned_mids == {1, 2, 3, 4, 5}
        assert len(response.memories) == 5

    def test_no_exclude_keeps_recent_five(self, mem_env, test_user):
        """不传排除集 → 与修复前一致：最近 5 条（created_at 降序）。"""
        storage, db = mem_env
        _insert_recent_set(db, test_user.id, count=7)
        response = _retrieve(storage, test_user.id, mode="rule", exclude=None)
        returned_mids = {m.message_id for m in response.memories}
        assert returned_mids == {3, 4, 5, 6, 7}

    def test_exclude_all_returns_empty(self, mem_env, test_user):
        """全部命中排除集 → 空结果（全在历史窗口内，无需记忆注入）。"""
        storage, db = mem_env
        _insert_recent_set(db, test_user.id, count=7)
        response = _retrieve(storage, test_user.id, mode="rule", exclude=[1, 2, 3, 4, 5, 6, 7])
        assert response.memories == []

    def test_null_message_id_never_excluded(self, mem_env, test_user):
        """NULL message_id 的存量行永不排除（既定边界：不做回填）。"""
        storage, db = mem_env
        _insert_recent_set(db, test_user.id, count=5)
        legacy_id = _insert_memory(
            db, test_user.id, "legacy-no-mirror",
            message_id=None, created_at=datetime(2026, 8, 29, 11, 0, 0),
        )
        response = _retrieve(storage, test_user.id, mode="rule", exclude=[1, 2, 3, 4, 5])
        returned_ids = {m.id for m in response.memories}
        assert returned_ids == {legacy_id}

    def test_vector_mode_stm_exclusion(self, mem_env, test_user, monkeypatch):
        """vector 模式: STM 同样过滤；嵌入不可用（全 NULL）→ LTM 为空属预期。"""
        import numpy as np

        storage, db = mem_env

        def _fake_embed(text_input):
            return np.zeros((1, 1024), dtype=np.float32)

        monkeypatch.setattr(mem_storage_mod, "embed_text", _fake_embed)
        _insert_recent_set(db, test_user.id, count=7)
        response = _retrieve(storage, test_user.id, mode="vector", exclude=[6, 7])
        returned_mids = {m.message_id for m in response.memories}
        assert 6 not in returned_mids
        assert 7 not in returned_mids
        assert returned_mids <= {1, 2, 3, 4, 5}


class TestLtmExcludeWithRealEmbeddings:
    """[TUPLE-UNPACK-FIX 2026-10-07] 补上上一段测试**真正漏掉的那条路径**。

    为什么既有 5 条用例全绿却没拦住线上 P0：`_insert_recent_set` 插入的记忆
    **embedding 全为 NULL**，而 `semantic_search` 的 SQL 带 `AND embedding IS NOT NULL`
    ⇒ `semantic_candidates` 恒为空 ⇒ `if semantic_candidates:` 直接跳过 ⇒
    **出错的那一行从未被执行到**。上面那句注释「嵌入不可用（全 NULL）→ LTM 为空属预期」
    正是把它当成预期行为放过了。

    生产里 embedding 是有的（实测 665/723 条带向量），所以真正会走的路径是
    「候选非空 + exclude 非空」——本类把它钉住。

    判据（正反对照）：
      - 改成旧写法 `m for m in semantic_candidates` ⇒ 本类第 1 条立刻红；
      - 仅把 exclude 置空 ⇒ 旧写法也不红（说明错误确实由该分支引入）。
    """

    @staticmethod
    def _insert_with_embedding(db, user_id, content, message_id, created_at, vec):
        import json

        result = db.execute(
            text(
                "INSERT INTO conversation_memories "
                "(user_id, session_id, role, content, importance_score, topics, "
                " tokens_count, created_at, message_id, embedding) "
                "VALUES (:u, :s, 'assistant', :c, 0.5, '[]', 10, :t, :m, :e)"
            ),
            {
                "u": user_id,
                "s": SESSION_ID,
                "c": content,
                "t": created_at,
                "m": message_id,
                "e": json.dumps(vec),
            },
        )
        db.flush()
        return result.lastrowid

    def test_ltm_exclude_does_not_abort_retrieval(self, mem_env, test_user, monkeypatch):
        """★ 候选非空 + exclude 非空 ⇒ 检索不得整体失败（旧实现恒抛 AttributeError）。"""
        import numpy as np

        from app.memory_module import retriever as retriever_mod

        storage, db = mem_env
        # 单位向量：query 与全部记忆同向 ⇒ cosine = 1.0，稳过 MIN_SIMILARITY(0.5)
        unit = [1.0, 0.0, 0.0, 0.0]

        monkeypatch.setattr(
            retriever_mod, "embed_text",
            lambda t: np.array([unit], dtype=np.float32),
        )

        base = datetime(2026, 10, 7, 12, 0, 0)
        for i in range(1, 7):
            self._insert_with_embedding(
                db, test_user.id, f"vec-memory-{i}", i,
                base + timedelta(seconds=i), unit,
            )

        response = _retrieve(storage, test_user.id, mode="vector", exclude=[6])

        # 关键断言：不能是 error 兜底路径，也不能整体空
        assert response.strategy_used != "error", (
            "检索走了异常兜底 ⇒ LTM 排除分支仍会抛错（元组未解包）"
        )
        assert response.memories, "有候选且未被全排除 ⇒ 必须注入记忆"
        returned_mids = {m.message_id for m in response.memories}
        assert 6 not in returned_mids, "排除集内的镜像不得注入"
        assert returned_mids == {1, 2, 3, 4, 5}

    def test_ltm_exclude_all_still_empty(self, mem_env, test_user, monkeypatch):
        """排除集覆盖全部候选 ⇒ LTM 为空，STM 也不应有 ⇒ 整体为空（不报错）。"""
        import numpy as np

        from app.memory_module import retriever as retriever_mod

        storage, db = mem_env
        unit = [1.0, 0.0, 0.0, 0.0]
        monkeypatch.setattr(
            retriever_mod, "embed_text",
            lambda t: np.array([unit], dtype=np.float32),
        )
        base = datetime(2026, 10, 7, 12, 0, 0)
        for i in range(1, 4):
            self._insert_with_embedding(
                db, test_user.id, f"all-excluded-{i}", i,
                base + timedelta(seconds=i), unit,
            )

        response = _retrieve(storage, test_user.id, mode="vector", exclude=[1, 2, 3])
        assert response.strategy_used != "error"
        assert response.memories == []
