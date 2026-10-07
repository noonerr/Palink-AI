"""[VEC-PG] + [MEM-QUERY] 记忆向量检索改造的回归测试（2026-10-07）。

覆盖三件事，其中第 3 条是这次改造的真正目的：

1. ``_parse_vector_cell`` —— 同一份 embedding 在 pgvector 文本输出 / JSON 文本 /
   已解析列表三种形态下都要能读出来（迁移期与 SQLite 回退期都会碰到）。
2. ``_build_scope_filter`` —— 召回作用域条件抽成一份后，四种作用域的 WHERE/参数
   必须与迁移前三条 if/elif 各写一遍的语义逐条对应（隔离条件写错=跨分支串味，
   这条比性能重要）。
3. **召回不再被"最近 200 行"时间窗口截断** —— 旧实现是
   ``ORDER BY created_at DESC LIMIT 200`` 再算余弦，第 201 条往前的记忆永远
   召不回。本文件用 250 行、把最优匹配放在**最旧**那条上，把这个缺陷钉死：
   旧实现必然取不到它（连扫都扫不到），新实现必须取到。

⚠️ 本文件跑在 SQLite 回退路径上。pgvector 那条 ``<=>`` SQL 的真库验证不在 pytest
   能力范围内，走容器内实测（见报告 §向量迁移验收）。
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
    from app.memory_module.storage import MemoryStorage, _parse_vector_cell
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")

SESSION_ID = "vec-pg-session"


@pytest.fixture()
def mem_env(db_session, monkeypatch):
    """在当前测试引擎上初始化 memory 表（复用 test_memory_exclude_recent 的接管模式）。"""
    monkeypatch.setattr(mem_storage_mod, "_tables_initialized", False)
    monkeypatch.setattr(mem_storage_mod, "_is_postgres_cached", None)
    monkeypatch.setattr(mem_storage_mod, "_migration_done", False)
    # SQLite 上探测函数应恒 False —— 这条也顺手钉住（判真会让回退路径走不通）
    monkeypatch.setattr(mem_storage_mod, "_vector_column_cached", None)
    monkeypatch.setattr(memory_config, "ENABLED", True)
    return MemoryStorage(db_session), db_session


class TestParseVectorCell:
    """embedding 单元格的三种历史形态都要能读出来。"""

    def test_json_text(self):
        assert _parse_vector_cell("[0.5, -0.25, 1e-05]") == [0.5, -0.25, 1e-05]

    def test_already_list(self):
        assert _parse_vector_cell([0.5, 0.25]) == [0.5, 0.25]

    def test_pgvector_nonjson_fraction_and_nan(self):
        # pgvector 可能输出前导小数点 `.5`（非法 JSON）与 `nan` —— 走 float() 兜底
        parsed = _parse_vector_cell("[.5,-.25]")
        assert parsed == [0.5, -0.25]

    def test_garbage_returns_none_not_raise(self):
        assert _parse_vector_cell(None) is None
        assert _parse_vector_cell("") is None
        assert _parse_vector_cell("{not an array") is None
        assert _parse_vector_cell("[a,b,c]") is None


class TestBuildScopeFilter:
    """四种作用域的 WHERE 必须与迁移前逐条对应。"""

    def _f(self, storage, **kw):
        base = dict(
            user_id=7, session_id=None, branch_ids=None,
            character_id=None, branch_scopes=None,
        )
        base.update(kw)
        return storage._build_scope_filter(**base)

    def test_user_level_no_character(self):
        where, params = self._f(MemoryStorage.__new__(MemoryStorage))
        assert where == "user_id = :user_id"
        assert params == {"user_id": 7}

    def test_user_level_with_character(self):
        where, params = self._f(
            MemoryStorage.__new__(MemoryStorage), character_id="char-1"
        )
        assert "character_id = :character_id" in where
        assert params["character_id"] == "char-1"

    def test_session_only_has_no_branch_filter(self):
        """旧 ``elif session_id`` 分支：不给 branch 条件 ⇒ 整会话可见。"""
        where, params = self._f(
            MemoryStorage.__new__(MemoryStorage), session_id=SESSION_ID
        )
        assert where == "user_id = :user_id AND session_id = :session_id"
        assert params["session_id"] == SESSION_ID

    def test_main_chat_empty_scopes_is_trunk_only(self):
        """[MEM-MIRROR] 空 scopes = 主聊天 ⇒ 只认 trunk，不退化成全会话。"""
        where, _ = self._f(
            MemoryStorage.__new__(MemoryStorage),
            session_id=SESSION_ID, branch_scopes=[],
        )
        assert where.endswith("branch_id IS NULL")
        assert "1 = 0" not in where

    def test_branch_scopes_truncate_at_fork_point(self):
        """祖先分支按分叉点截断；当前分支 up_to=None 不截断。"""
        where, params = self._f(
            MemoryStorage.__new__(MemoryStorage),
            session_id=SESSION_ID,
            branch_scopes=[("root-br", 101), ("self-br", None)],
        )
        assert "(branch_id = :bs0 AND message_id <= :bsm0)" in where
        assert "branch_id = :bs1" in where
        assert params["bs0"] == "root-br" and params["bsm0"] == 101
        assert params["bs1"] == "self-br"

    def test_branch_ids_in_list_keeps_trunk_visible(self):
        where, params = self._f(
            MemoryStorage.__new__(MemoryStorage),
            session_id=SESSION_ID, branch_ids=["a", "b"],
        )
        assert "branch_id IN (:br0, :br1)" in where
        assert "OR branch_id IS NULL" in where
        assert params["br0"] == "a" and params["br1"] == "b"


class TestRecallIsNotCappedByRecencyWindow:
    """★ 核心：旧实现的 ``LIMIT 200`` 时间预筛会吞掉最旧的候选，本用例把它钉死。

    构造 250 行记忆：只有**最旧**那一行与查询同向（余弦=1.0），其余全部正交
    （余弦=0，低于 min_similarity）。旧实现按 created_at DESC 取前 200 行 ⇒
    最旧那 50 行根本没进扫描 ⇒ 召回 0 条；改造后必须召回到它。
    """

    DIM = 8

    def _vec(self, idx: int):
        v = [0.0] * self.DIM
        v[idx] = 1.0
        return v

    def test_oldest_best_match_is_recalled(self, mem_env):
        storage, db = mem_env
        base = datetime(2026, 10, 1, 0, 0, 0)
        # 250 行：越新的行下标越大；最旧那行用 0 号轴，查询也用 0 号轴
        for i in range(250):
            axis = 1 + (i % (self.DIM - 1))  # 1..7，全部与查询轴正交
            if i == 0:
                axis = 0
            db.execute(
                text(
                    "INSERT INTO conversation_memories "
                    "(user_id, session_id, role, content, importance_score, topics, "
                    " tokens_count, created_at, embedding) "
                    "VALUES (:u, :s, 'assistant', :c, 0.5, '[]', 10, :t, :e)"
                ),
                {
                    "u": 42, "s": SESSION_ID,
                    "c": f"chunk-{i}" + ("（受伤的是她）" if i == 0 else ""),
                    "t": base + timedelta(seconds=i),
                    "e": str(self._vec(axis)),
                },
            )
        db.flush()

        hits = storage.semantic_search(
            user_id=42,
            query_embedding=self._vec(0),
            limit=50,
            min_similarity=0.5,
            session_id=SESSION_ID,
            branch_scopes=[],
        )
        contents = [m.content for m, _ in hits]
        assert any(c.startswith("chunk-0") for c in contents), (
            f"最旧的满分匹配没被召回 —— 说明时间预筛窗口又回来了。命中 {len(hits)} 条："
            f"{contents[:5]}"
        )
        # 正交向量不该过阈值
        assert all(s >= 0.5 for _, s in hits)

    def test_sqlite_is_treated_as_non_vector(self, mem_env):
        """探测函数在 SQLite 上必须判 False，否则会拿 vector SQL 去打 TEXT 列。"""
        storage, db = mem_env
        assert mem_storage_mod._detect_vector_column(db) is False
        assert storage._embedding_column_is_vector() is False


class _BoomSession:
    """让查询直接抛错，验证降级路径不改行为。"""

    def query(self, *a, **kw):
        raise RuntimeError("db down")


class TestBuildMemoryQuery:
    """[MEM-QUERY] 检索查询由"本轮一句话"改为"最近几条拼接"。

    实测依据：用户消息平均 29 字，单句查询的 top8 里出现 1.0000 的自镜像命中；
    换成窗口查询后召回集 6/8 变化、相似度区间收窄（1.0000~0.6208 → 0.8869~0.7668）。
    """

    @staticmethod
    def _import():
        from app.services.roleplay_prompt_assembly import (
            _MEM_QUERY_MAX_CHARS,
            _build_memory_query,
        )

        return _build_memory_query, _MEM_QUERY_MAX_CHARS

    @staticmethod
    def _seed(db, test_user, branch_name="br-main"):
        """角色 → 会话 → 分支 → 三条消息，返回 (session_id, branch_id)。

        分支行必须真实存在：``character_chat_messages.branch_id`` 有外键，而测试
        引擎开了 ``PRAGMA foreign_keys=ON``（tests/conftest.py:94），
        随手编一个分支 id 会 IntegrityError。
        """
        from app.models.character import (
            Character,
            CharacterChatMessage,
            CharacterChatSession,
            CharacterChatSessionBranch,
        )

        char = Character(user_id=test_user.id, name="Alice")
        db.add(char)
        db.flush()
        sess = CharacterChatSession(character_id=char.id, user_id=test_user.id)
        db.add(sess)
        db.flush()
        br = CharacterChatSessionBranch(
            id=branch_name, session_id=sess.id, branch_name=branch_name
        )
        db.add(br)
        db.flush()
        for role, content in [
            ("user", "她受伤了"),
            ("assistant", "把她扶到窗边，血渗透了袖子。"),
            ("user", "别说话，先包扎"),
        ]:
            db.add(CharacterChatMessage(
                session_id=sess.id, role=role, content=content,
                is_user=(role == "user"), is_system=False, branch_id=br.id,
            ))
        db.flush()
        return sess.id, br.id

    def test_window_concatenates_recent_messages_in_order(self, db_session, test_user):
        build, _ = self._import()
        sess_id, br_id = self._seed(db_session, test_user)
        q = build(db_session, sess_id, br_id, "现在去哪找药")
        assert q.index("她受伤了") < q.index("别说话，先包扎") < q.index("现在去哪找药"), (
            f"查询窗口必须按时间正序、本轮消息在最后：{q!r}"
        )

    def test_current_message_already_persisted_is_not_duplicated(self, db_session, test_user):
        """消息已落库时不能把同一句话拼两遍（白占嵌入输入）。"""
        from app.models.character import CharacterChatMessage

        build, _ = self._import()
        sess_id, br_id = self._seed(db_session, test_user)
        current = "现在去哪找药"
        db_session.add(CharacterChatMessage(
            session_id=sess_id, role="user", content=current,
            is_user=True, is_system=False, branch_id=br_id,
        ))
        db_session.flush()
        q = build(db_session, sess_id, br_id, current)
        assert q.count(current) == 1, f"本轮消息重复出现在查询里：{q!r}"

    def test_other_branch_messages_are_excluded(self, db_session, test_user):
        """分支隔离：另一条剧情线的原文不能进查询（与召回作用域同口径）。"""
        from app.models.character import (
            Character,
            CharacterChatMessage,
            CharacterChatSession,
            CharacterChatSessionBranch,
        )

        build, _ = self._import()
        char = Character(user_id=test_user.id, name="Bob")
        db_session.add(char)
        db_session.flush()
        sess = CharacterChatSession(character_id=char.id, user_id=test_user.id)
        db_session.add(sess)
        db_session.flush()
        for bid in ("br-other", "br-self"):
            db_session.add(CharacterChatSessionBranch(
                id=bid, session_id=sess.id, branch_name=bid
            ))
        db_session.flush()
        db_session.add(CharacterChatMessage(
            session_id=sess.id, role="user", content="隔壁分支的秘密",
            is_user=True, is_system=False, branch_id="br-other",
        ))
        db_session.add(CharacterChatMessage(
            session_id=sess.id, role="user", content="本分支的话",
            is_user=True, is_system=False, branch_id="br-self",
        ))
        db_session.flush()
        q = build(db_session, sess.id, "br-self", "继续")
        assert "隔壁分支的秘密" not in q
        assert "本分支的话" in q

    def test_query_is_tail_truncated(self, db_session, test_user):
        """超长时保留最新内容（尾部），不是从头截。"""
        from app.models.character import CharacterChatMessage

        build, max_chars = self._import()
        sess_id, br_id = self._seed(db_session, test_user)
        db_session.add(CharacterChatMessage(
            session_id=sess_id, role="assistant", content="血" * (max_chars + 200),
            is_user=False, is_system=False, branch_id=br_id,
        ))
        db_session.flush()
        q = build(db_session, sess_id, br_id, "收尾")
        assert len(q) <= max_chars
        assert q.endswith("收尾"), f"截断必须保尾：{q[-20:]!r}"

    def test_db_failure_falls_back_to_current_message(self):
        """查不到历史时不改行为——宁可用单句，不可把查询清空。"""
        build, _ = self._import()
        assert build(_BoomSession(), "s", "b", "本轮消息") == "本轮消息"
