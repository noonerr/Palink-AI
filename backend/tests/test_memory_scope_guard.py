"""
[B1 守卫 2026-10-03] 记忆检索的角色作用域 —— 锁住「分支3 不可达」这个前提。

背景：`conversation_memories` 加了 `character_id` 后，`semantic_search` 的三个分支：

- 分支1（session_id + branch_ids）/ 分支2（仅 session_id）：**故意不加** character_id
  条件。会话唯一归属一个角色，再加会把存量 character_id=NULL 的行滤掉。
- 分支3（session_id 为空）：加了 `AND character_id = :character_id`。
  ⚠️ 这会让存量 NULL 行在角色作用域下失联 —— 是本文件要盯的风险。

为什么不直接加 `OR character_id IS NULL`：那等于退回「没绑角色的书对所有角色生效」，
正是跨卡串味的形态。所以选择**保证分支3 在生产主链路上不可达**，让存量行永远走
分支1/2（有 session_id、不按 character_id 过滤）。

于是本文件把这个前提写成测试：将来若有人给某个角色链路漏传 session_id，
这里会红，提示「存量 NULL 行将失联」，而不是等到线上召回不到记忆才发现。
"""
import inspect

from app.memory_module import storage as storage_mod
from app.services import roleplay_prompt_assembly as rpa


def test_branch3_filter_is_character_scoped():
    """分支3 的过滤条件确实是 character_id 精确等值（没有 OR IS NULL 兜底）。

    ⚠️ 2026-10-07 [VEC-PG]：作用域 WHERE 从 ``semantic_search`` 里的三条 if/elif
    抽到了 ``_build_scope_filter``（pgvector 路与 Python 回退路共用一份），
    所以本守卫的取材对象跟着换；断言意图一分未改。
    """
    src = inspect.getsource(storage_mod.MemoryStorage._build_scope_filter)
    assert "character_id = :character_id" in src, "分支3 应按 character_id 过滤"
    assert "OR character_id IS NULL" not in src, (
        "不得加 OR character_id IS NULL —— 那会让未绑角色的记忆对所有角色生效，"
        "正是跨卡串味的形态"
    )


def test_session_branches_do_not_filter_by_character():
    """分支1/2 不按 character_id 过滤 —— 否则存量 NULL 行会被滤掉。

    形状断言（``if (character_id and not session_id)``）在抽取后已不成立，
    这里改成**行为断言**：同时传 session_id 与 character_id 时，
    WHERE 里必须一个 character 条件都没有（等价于旧 char_clause 恒空）。
    """
    storage = storage_mod.MemoryStorage.__new__(storage_mod.MemoryStorage)
    where, params = storage._build_scope_filter(
        user_id=1, session_id="sess-1", branch_ids=None,
        character_id="char-1", branch_scopes=None,
    )
    assert "character_id" not in where, (
        f"有 session_id 的链路被加了角色过滤，存量 character_id=NULL 的行会失联：{where}"
    )
    assert "character_id" not in params

    # 反向对照：没有 session_id 时角色过滤必须出现（否则就是跨卡串味）
    where2, params2 = storage._build_scope_filter(
        user_id=1, session_id=None, branch_ids=None,
        character_id="char-1", branch_scopes=None,
    )
    assert "character_id = :character_id" in where2
    assert params2["character_id"] == "char-1"


def test_character_pathways_always_supply_session_id():
    """
    生产主链路必须同时传 session_id —— 这是分支3 不可达的根据。

    逐个调用点核对：任何一个角色链路漏传 session_id，都会让存量 NULL 行失联。
    """
    # 装配层：req.session_id 是必填 str
    assert rpa.PromptAssemblyRequest.__dataclass_fields__["session_id"].type in (
        "str",
        str,
    ), "PromptAssemblyRequest.session_id 应为必填 str"

    # assemble_roleplay_prompt 只是转发（contextmanager + 调 impl），真正注入记忆的
    # 是 _assemble_roleplay_prompt_impl，断言要落在它身上。
    src = inspect.getsource(rpa._assemble_roleplay_prompt_impl)
    assert "session_id=req.session_id" in src, "装配层必须传 session_id=req.session_id"
    # character_id 可空（测试替身没有 .id 时兜底 None），但 session_id 不能空
    call_idx = src.find("session_id=req.session_id")
    assert call_idx != -1


def test_unscoped_write_warns_instead_of_silent():
    """写入侧 session_id 与 character_id 同空时必须告警，不能静默。"""
    src = inspect.getsource(storage_mod)
    assert "[MEM-SCOPE]" in src, "缺少写入侧未作用域告警"
    assert "_warn_if_unscoped_write" in src