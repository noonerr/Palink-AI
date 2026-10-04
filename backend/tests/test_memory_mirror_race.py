"""[MEM-MIRROR] 记忆镜像 CAS 竞态 + 分支作用域分叉截断 + 分支召回隔离。

spec: docs/SPEC_重新生成与分支记忆隔离修复_2026-10-05.md §7

背景
----
生产库实测（消息 2599）：切换候选走「请求内 DELETE + 后台线程 INSERT」，
INSERT 前隔着一次秒级 embed（store_chunks 先嵌入后插入），窗口内二次切换的
DELETE 空删，旧版本文本永久残留并被召回。根因是删写不原子。

修复两条：
- RC-1 mirror.sync_message_memory —— CAS on 正文：后台写前重读当前正文，
  与捕获值不符则放弃（更新者已接手），杜绝旧版本文本复活；删除独立提交，
  保住「宁缺勿错」（store 失败 → 缺失而非陈旧）。
- RC-2/RC-3 分支作用域 —— 召回按分叉点截断，与对话历史 fork_limits 对齐；
  祖先为空不再静默退化成全会话召回。

覆盖面：
T1 竞态：正文已被改写时过期重嵌必须放弃（不写旧文本）
T2 消息已删时放弃写入
T3 memory_mode=disabled 时不删不写（RC-4 统一守卫）
T4 正常路径：删旧 + 写新，按当前正文
T5 分叉截断 SQL：祖先分支分叉点之后的记忆对子分支不可见
T6 空作用域 = 主聊天：只认 trunk，不召回分支内记忆
T7 trunk 行（branch_id IS NULL）保留可见
"""

import json
import logging
import os
import sys

import pytest
from sqlalchemy import text

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from app.memory_module import mirror as mirror_mod
    from app.memory_module import storage as mem_storage_mod
    from app.memory_module.config import memory_config
    from app.memory_module.service import MemoryService
    from app.memory_module.storage import MemoryStorage
    from app.models import (
        CharacterChatMessage,
        CharacterChatSession,
        CharacterChatSessionBranch,
        User,
    )
    from app.utils import clean_memory_content
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")


# ─────────────────────────────────────────────────────────────────────
# Fixtures / helpers
# ─────────────────────────────────────────────────────────────────────

@pytest.fixture()
def mirror_env(db_session, _engine, monkeypatch):
    """memory 表建在测试引擎上，并把 mirror 后台线程的 SessionLocal 接管过来。"""
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
    monkeypatch.setattr(mirror_mod, "SessionLocal", test_session_factory)

    MemoryStorage(db_session)
    return db_session


def _seed_branched_message(db, user, *, content="第一版正文", swipe_id=0,
                           swipes=None, branch_id="br-a", session=None):
    """种一条带 swipes 的 assistant 消息 + 其所在分支。"""
    sess = session or CharacterChatSession(user_id=user.id, title="t")
    if session is None:
        db.add(sess)
        db.flush()
    db.add(CharacterChatSessionBranch(
        id=branch_id, session_id=sess.id, branch_name=branch_id, is_active=True,
    ))
    swipes = swipes or [content]
    msg = CharacterChatMessage(
        session_id=sess.id,
        branch_id=branch_id,
        role="assistant",
        content=content,
        is_user=False,
        is_system=False,
        is_locked=False,
        swipe_id=swipe_id,
        swipes=json.dumps(swipes, ensure_ascii=False),
    )
    db.add(msg)
    db.commit()
    db.refresh(msg)
    return sess, msg


def _mem_rows(db, session_id, message_id=None):
    if message_id is None:
        return db.execute(text(
            "SELECT id, role, content, branch_id, message_id FROM conversation_memories "
            "WHERE session_id = :s ORDER BY id"
        ), {"s": session_id}).fetchall()
    return db.execute(text(
        "SELECT id, role, content, branch_id, message_id FROM conversation_memories "
        "WHERE session_id = :s AND message_id = :m ORDER BY id"
    ), {"s": session_id, "m": message_id}).fetchall()


def _seed_mem(db, user, session_id, message_id, *, content, branch_id="br-a", role="assistant"):
    db.execute(text(
        "INSERT INTO conversation_memories "
        "(user_id, session_id, branch_id, role, content, embedding, "
        " importance_score, topics, tokens_count, created_at, message_id) "
        "VALUES (:u, :s, :b, :r, :c, NULL, 0.5, '[]', 0, CURRENT_TIMESTAMP, :m)"
    ), {"u": user.id, "s": session_id, "b": branch_id, "r": role,
        "c": content, "m": message_id})
    db.commit()


# ─────────────────────────────────────────────────────────────────────
# T1 竞态核心：过期后台任务必须放弃写入（这是本次 P0 的不变式）
# ─────────────────────────────────────────────────────────────────────

def test_T1_stale_task_does_not_resurrect_old_text(mirror_env, test_user):
    """后台任务捕获的是旧正文，但消息已被改写成新版 → 必须放弃，不写旧文本。

    复现生产 bug：切到 swipe0（后台任务 A 排队）→ 立刻切回 swipe1（任务 B 排队）
    → 任务 A 后到若无 CAS 就会把已放弃的 swipe0 文本写回记忆表。
    """
    db = mirror_env
    swipes = ["旧版剧情正文", "新版剧情正文"]
    sess, msg = _seed_branched_message(
        db, test_user, content=swipes[1], swipe_id=1, swipes=swipes,
    )  # 消息当前显示第 2 版
    # 记忆里此刻是第一版（用户切走前的旧记忆）
    _seed_mem(db, test_user, sess.id, msg.id, content=swipes[0], branch_id="br-a")

    # 任务 A 迟到：它捕获的是旧正文 swipes[0]，但当前正文是 swipes[1]
    mirror_mod.sync_message_memory(
        user_id=test_user.id,
        session_id=sess.id,
        message_id=msg.id,
        role="assistant",
        captured_raw=swipes[0],   # ← 过期值
        branch_id="br-a",
        character_id=None,
        memory_mode="vector",
    )

    rows = _mem_rows(db, sess.id, msg.id)
    # 过期任务不得把旧版写回；但也不能凭空删掉当前版。
    # 由于本测试只跑了过期任务（新版任务未跑），记忆应为空或为新版，不得是旧版。
    stale = [r for r in rows if r.content == swipes[0]]
    assert stale == [], "过期后台任务把已放弃的旧版本文本写回了记忆表"


def test_T1b_current_task_writes_current_text(mirror_env, test_user):
    """对照组：捕获值 = 当前正文 → 正常删旧写新。"""
    db = mirror_env
    swipes = ["旧版剧情正文", "新版剧情正文"]
    sess, msg = _seed_branched_message(
        db, test_user, content=swipes[1], swipe_id=1, swipes=swipes,
    )
    _seed_mem(db, test_user, sess.id, msg.id, content=swipes[0], branch_id="br-a")

    mirror_mod.sync_message_memory(
        user_id=test_user.id,
        session_id=sess.id,
        message_id=msg.id,
        role="assistant",
        captured_raw=swipes[1],   # 当前值
        branch_id="br-a",
        character_id=None,
        memory_mode="vector",
    )

    rows = _mem_rows(db, sess.id, msg.id)
    assert len(rows) == 1
    assert rows[0].content == clean_memory_content(swipes[1])


# ─────────────────────────────────────────────────────────────────────
# T2 消息已删 → 放弃写入
# ─────────────────────────────────────────────────────────────────────

def test_T2_deleted_message_skips(mirror_env, test_user):
    db = mirror_env
    sess = CharacterChatSession(user_id=test_user.id, title="t")
    db.add(sess)
    db.commit()
    db.refresh(sess)
    # 不种消息，模拟消息已被 delete_character_message 级联删除
    mirror_mod.sync_message_memory(
        user_id=test_user.id,
        session_id=sess.id,
        message_id=999999,       # 不存在的消息
        role="assistant",
        captured_raw="任意正文",
        branch_id="br-a",
        character_id=None,
        memory_mode="vector",
    )
    rows = _mem_rows(db, sess.id)
    assert rows == [], "消息不存在时不应写入任何记忆行"


# ─────────────────────────────────────────────────────────────────────
# T3 memory_mode=disabled → 不删不写（RC-4 统一守卫）
# ─────────────────────────────────────────────────────────────────────

def test_T3_disabled_memory_mode_noop(mirror_env, test_user):
    db = mirror_env
    swipes = ["旧版正文", "新版正文"]
    sess, msg = _seed_branched_message(
        db, test_user, content=swipes[1], swipe_id=1, swipes=swipes,
    )
    _seed_mem(db, test_user, sess.id, msg.id, content=swipes[0], branch_id="br-a")

    mirror_mod.sync_message_memory(
        user_id=test_user.id,
        session_id=sess.id,
        message_id=msg.id,
        role="assistant",
        captured_raw=swipes[1],
        branch_id="br-a",
        character_id=None,
        memory_mode="disabled",
    )
    rows = _mem_rows(db, sess.id, msg.id)
    assert len(rows) == 1 and rows[0].content == swipes[0], (
        "memory_mode=disabled 时不得删也不得写（与动作流路径语义统一）"
    )


# ─────────────────────────────────────────────────────────────────────
# T5/T6/T7 分支作用域分叉截断（召回侧）
# ─────────────────────────────────────────────────────────────────────

def _mk_branch(db, sess, branch_id, *, parent=None, parent_message_id=None):
    db.add(CharacterChatSessionBranch(
        id=branch_id, session_id=sess.id, branch_name=branch_id, is_active=True,
        parent_branch_id=parent, parent_message_id=parent_message_id,
    ))
    db.commit()


def _seed_mem_raw(db, user, session_id, *, content, branch_id, message_id):
    db.execute(text(
        "INSERT INTO conversation_memories "
        "(user_id, session_id, branch_id, role, content, embedding, "
        " importance_score, topics, tokens_count, created_at, message_id) "
        "VALUES (:u, :s, :b, 'assistant', :c, NULL, 0.5, '[]', 0, CURRENT_TIMESTAMP, :m)"
    ), {"u": user.id, "s": session_id, "b": branch_id, "c": content, "m": message_id})
    db.commit()


def _search_ids(db, user, session_id, branch_scopes):
    """直接跑 semantic_search 的 branch_scopes 分支，返回命中的 memory id 集合。"""
    storage = MemoryStorage(db)
    import numpy as np
    dim = memory_config.VECTOR_DIMENSION
    # 给每行一个**非零且各不相同**的向量，保证余弦相似度有定义且能通过门槛；
    # 查询向量与它们同向 → 相似度≈1，确保只有作用域过滤在起作用。
    rows = db.execute(text(
        "SELECT id FROM conversation_memories WHERE session_id = :s ORDER BY id"
    ), {"s": session_id}).fetchall()
    for i, r in enumerate(rows):
        vec = [0.0] * dim
        vec[i % dim] = 1.0          # 每行落在不同维度上
        vec[0] = 0.5                # 与查询向量共有分量，保证 cos>0
        db.execute(
            text("UPDATE conversation_memories SET embedding = :e WHERE id = :i"),
            {"e": json.dumps(vec), "i": r[0]},
        )
    db.commit()
    q = [0.0] * dim
    q[0] = 1.0
    hits = storage.semantic_search(
        user_id=user.id,
        query_embedding=q,
        limit=100,
        min_similarity=-1.0,          # 放开相似度门槛，只验作用域过滤
        session_id=session_id,
        branch_scopes=branch_scopes,
    )
    return {m.id for m, _score in hits}


def test_T5_fork_truncation_hides_post_fork_ancestor_memories(mirror_env, test_user):
    """祖先分支分叉点之后写入的记忆，对子分支不可见（RC-2 核心）。"""
    db = mirror_env
    sess = CharacterChatSession(user_id=test_user.id, title="t")
    db.add(sess)
    db.commit()
    db.refresh(sess)
    _mk_branch(db, sess, "root")
    # 子分支从 parent_message_id=100 处分叉
    _mk_branch(db, sess, "child", parent="root", parent_message_id=100)

    # root 分支消息：id 50（分叉点前，应可见）、id 150（分叉点后，应不可见）
    # （此处只造记忆行，message_id 直接指定，无需真实消息行）
    _seed_mem_raw(db, test_user, sess.id, content="分叉点前记忆", branch_id="root", message_id=50)
    _seed_mem_raw(db, test_user, sess.id, content="分叉点后记忆", branch_id="root", message_id=150)
    # 子分支自己的记忆
    _seed_mem_raw(db, test_user, sess.id, content="子分支记忆", branch_id="child", message_id=200)

    # 作用域 root→child：root 被截断在 100，child 不截断
    hits = _search_ids(db, test_user, sess.id, [("root", 100), ("child", None)])
    id2content = {r.id: r.content for r in _mem_rows(db, sess.id)}
    visible = {id2content[i] for i in hits}

    assert "分叉点前记忆" in visible, "分叉点前的祖先记忆应可见"
    assert "子分支记忆" in visible, "子分支自己的记忆应可见"
    assert "分叉点后记忆" not in visible, "祖先分支分叉点之后的记忆对子分支不可见（RC-2）"


def test_T6_empty_scopes_main_chat_trunk_only(mirror_env, test_user):
    """空作用域（主聊天）→ 只认 trunk（branch_id IS NULL），不召回分支内记忆。"""
    db = mirror_env
    sess = CharacterChatSession(user_id=test_user.id, title="t")
    db.add(sess)
    db.commit()
    db.refresh(sess)
    _mk_branch(db, sess, "b1")
    _seed_mem_raw(db, test_user, sess.id, content="trunk记忆", branch_id=None, message_id=None)
    _seed_mem_raw(db, test_user, sess.id, content="分支记忆", branch_id="b1", message_id=10)

    hits = _search_ids(db, test_user, sess.id, [])
    id2content = {r.id: r.content for r in _mem_rows(db, sess.id)}
    visible = {id2content[i] for i in hits}
    assert "trunk记忆" in visible, "trunk（branch_id IS NULL）记忆应保留可见"
    assert "分支记忆" not in visible, "主聊天不应召回分支内记忆（RC-3 修复）"


def test_T7_trunk_row_visible_from_branch(mirror_env, test_user):
    """带分支作用域时，trunk 行（branch_id IS NULL）仍保留可见（共同祖先）。"""
    db = mirror_env
    sess = CharacterChatSession(user_id=test_user.id, title="t")
    db.add(sess)
    db.commit()
    db.refresh(sess)
    _mk_branch(db, sess, "root")
    _seed_mem_raw(db, test_user, sess.id, content="trunk记忆", branch_id=None, message_id=None)
    _seed_mem_raw(db, test_user, sess.id, content="根分支记忆", branch_id="root", message_id=10)

    hits = _search_ids(db, test_user, sess.id, [("root", None)])
    id2content = {r.id: r.content for r in _mem_rows(db, sess.id)}
    visible = {id2content[i] for i in hits}
    assert "trunk记忆" in visible, "trunk 行保留可见"
    assert "根分支记忆" in visible, "根分支记忆可见"