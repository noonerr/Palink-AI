"""F-6 回归锁：重启后第一次装配的 "This transaction is closed" 误报（2026-10-25）。

病根（实测定位，非推测）：`memory_module/storage.py` 的 `MemoryStorage.__init__`
在进程内第一次命中时调 `_init_tables()`，而 `_init_tables()` 结尾
`self.db.commit()`——`self.db` 就是调用方（装配层）传进来的那条会话。
`_append_memory_context` 事先在同一条会话上 `begin_nested()` 开了 SAVEPOINT，
这次外层 commit 把 SAVEPOINT 连带释放 ⇒ 收尾 `nested.commit()` 必抛
ResourceClosedError。`_tables_initialized` 是进程级全局，所以只有
**进程内第一次**报错，第二三次静默正常——这就是"重启后第一次装配必丢记忆"。

实际危害分级（据实测读数）：记忆正文**并没有丢**（`memory included tok=7127`
在 error 之前），坏的是那条 `memory error` 读数会误导排查方向。

修法（本文件锁的就是这两条）：
1. 收尾不再裸调 `nested.commit()`，改走 `_release_memory_savepoint`：
   SAVEPOINT 已被冷启动建表的 commit 释放时**只留痕**（once，不刷屏），
   不再冒充"检索失败"。真·检索异常仍照旧报 memory error。
2. `_migrate_tables` 的 branch_id 那条补 `IF NOT EXISTS`——列早已在库，
   缺子句使**每次进程冷启动**都抛一次 DuplicateColumn 并白走一次 savepoint
   rollback（pg 日志实测每进程一条 ERROR）。同族两条迁移本来就带该子句。

⚠️ 两条已试过并**回退**的修法，别再走（实测都比误报更糟）：
① 给 `_init_tables()` 自建短会话——DDL 换到另一条会话会等本会话 SAVEPOINT
   持有的 memory 表锁，把本会话拖成 idle-in-transaction，最终被服务端按
   `idle_in_transaction_session_timeout`（本机=1min）杀连接。
② 把 `MemoryService(req.db)` 构造挪到 `begin_nested()` 之前——同类时序问题，
   实测冷启动直接 `server closed the connection unexpectedly`，整次装配炸掉。
根治应是把记忆建表/迁移移到应用启动期（或并入 alembic 链）；属动启动语义，
本批未授权，已记入交付报告遗留项。

运行: cd backend && py -3 -m pytest tests/test_f6_memory_first_assembly.py -q
"""

import os
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from sqlalchemy.exc import ResourceClosedError  # noqa: E402


# ---------------------------------------------------------------------------
# 1) 冷启动 DDL 幂等：branch_id 迁移曾漏 IF NOT EXISTS
# ---------------------------------------------------------------------------
class TestIdempotentColumnMigration:
    def _migration_statements(self):
        """离线取 _migrate_tables(pg 分支) 实际发给数据库的语句清单。

        测的是"发出去的 SQL 文本"而不是源码字符串——源码里有没有那句注释不重要，
        重要的是 Postgres 收到什么。
        """
        from app.memory_module import storage as st

        execed = []
        db = MagicMock(name="session")
        db.execute.side_effect = lambda stmt, *a, **kw: execed.append(stmt)
        db.begin_nested.return_value = MagicMock()
        svc = st.MemoryStorage.__new__(st.MemoryStorage)  # 绕开冷启动建表
        svc.db = db
        svc.is_postgres = True
        svc._migrate_tables()
        return [getattr(s, "text", str(s)) for s in execed]

    def test_every_add_column_is_if_not_exists(self):
        """每条 ADD COLUMN 必须幂等。

        branch_id 曾漏该子句：列 2026-09 就进了库（alembic 0067 同批），
        于是**每次进程冷启动**这条 ALTER 必抛 DuplicateColumn → 走一次无谓的
        savepoint rollback → pg 日志每进程留一条 ERROR（实测 16:16/16:22/
        16:32/16:35 四条，与探针进程一一对应）。同族两条迁移本来就带子句，
        这里只是跟齐。
        """
        stmts = self._migration_statements()
        add_column = [s for s in stmts if "ADD COLUMN" in s]
        assert add_column, "迁移语句清单为空——列迁移若已由 alembic 接管，请删掉本测试并同步删码"
        for s in add_column:
            assert "IF NOT EXISTS" in s, f"非幂等列迁移: {s.strip()[:90]}"

    def test_branch_id_clause_present(self):
        """点名钉住漏过的那一条，防止"顺手补回去"时又写成裸 ADD COLUMN。"""
        hit = [s for s in self._migration_statements() if "branch_id" in s]
        assert hit, "branch_id 迁移语句消失了（被删？先确认 alembic 已覆盖该列再动）"
        assert "IF NOT EXISTS" in hit[0]

    def test_migration_isolates_each_alter_in_a_savepoint(self):
        """每条 ALTER 各自一条 SAVEPOINT：一条失败不许连带回滚别人的工作。
        这是本批误报的同族机制（悬挂/被释放的 savepoint），锁住结构。"""
        from app.memory_module import storage as st

        opened = []
        db = MagicMock(name="session")

        def _begin_nested():
            sp = MagicMock()
            opened.append(sp)
            return sp

        db.begin_nested.side_effect = _begin_nested
        db.execute.side_effect = lambda *a, **kw: MagicMock()
        svc = st.MemoryStorage.__new__(st.MemoryStorage)
        svc.db = db
        svc.is_postgres = True
        svc._migrate_tables()
        assert len(opened) >= 3, "迁移未逐条用 SAVEPOINT 隔离"
        for sp in opened:
            assert sp.commit.called or sp.rollback.called, "有 SAVEPOINT 既没提交也没回滚 = 悬挂"


# ---------------------------------------------------------------------------
# 2) 收尾：SAVEPOINT 已释放 ≠ 检索失败
# ---------------------------------------------------------------------------
class TestSavepointRelease:
    def _req(self):
        return SimpleNamespace(session_id="sess-f6")

    def test_inactive_savepoint_is_not_an_error(self):
        from app.services.roleplay_prompt_assembly import _release_memory_savepoint
        nested = MagicMock()
        nested.is_active = False
        # 不该抛，也不该 commit
        _release_memory_savepoint(nested, self._req())
        nested.commit.assert_not_called()

    def test_resource_closed_error_is_swallowed_with_record(self):
        from app.services.roleplay_prompt_assembly import _release_memory_savepoint
        nested = MagicMock()
        nested.is_active = True
        nested.commit.side_effect = ResourceClosedError("stmt", None, Exception("boom"))
        with patch("app.services.roleplay_prompt_assembly._record_silent_failure") as rec:
            _release_memory_savepoint(nested, self._req())
        assert rec.called, "释放失败必须留痕，不许静默"
        assert rec.call_args.args[0] == "prompt_assembly.memory.savepoint_already_released"

    def test_genuine_commit_failure_still_propagates(self):
        """只放行 ResourceClosedError。其它异常是真失败，必须继续上抛给
        既有 except 分支 ⇒ 仍会报 memory error（不许顺手把真失败也咽掉）。"""
        from app.services.roleplay_prompt_assembly import _release_memory_savepoint
        nested = MagicMock()
        nested.is_active = True
        nested.commit.side_effect = RuntimeError("connection died")
        with pytest.raises(RuntimeError):
            _release_memory_savepoint(nested, self._req())

    def test_active_savepoint_commits_normally(self):
        from app.services.roleplay_prompt_assembly import _release_memory_savepoint
        nested = MagicMock()
        nested.is_active = True
        with patch("app.services.roleplay_prompt_assembly._record_silent_failure") as rec:
            _release_memory_savepoint(nested, self._req())
        nested.commit.assert_called_once()
        rec.assert_not_called()

    def test_none_savepoint_is_noop(self):
        from app.services.roleplay_prompt_assembly import _release_memory_savepoint
        _release_memory_savepoint(None, self._req())


# ---------------------------------------------------------------------------
# 3) 反证靶心的静态守卫：收尾不许再直接 nested.commit()
# ---------------------------------------------------------------------------
def test_memory_path_routes_release_through_guard():
    """`_append_memory_context` 的收尾必须走 _release_memory_savepoint。

    为什么锁这个而不是锁报错文本：报错文本没有测试钉着就会被"顺手改回去"，
    而这条路径一旦回到裸 nested.commit()，重启后第一次装配又会报 memory error
    ——一个只在冷启动复现、日常测试永远跑不到的分支。
    """
    import inspect
    from app.services import roleplay_prompt_assembly as rpa
    src = inspect.getsource(rpa._append_memory_context)
    assert "_release_memory_savepoint(nested, req)" in src
    assert "        nested.commit()" not in src, (
        "收尾又回到裸 nested.commit()：冷启动会复现 This transaction is closed 误报"
    )
