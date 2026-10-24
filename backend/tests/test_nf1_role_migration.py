"""P2-23/NF-1：alembic 0071 迁移用例——role 写侧硬不变量（本地 sqlite）。

真实链路验证（不走桩）：以"0071 之前"的旧形态建 character_chat_messages
（role 可空、无 CHECK），预置一条复刻取证 id=1297 形态的历史 NULL 行 →
`alembic stamp 0070` → `alembic upgrade head` → 断言：

1. role 列 NOT NULL 已落；
2. CHECK `ck_character_chat_messages_role` 已落；
3. 历史 NULL 行被迁移内兜底归一为 assistant；
4. **NULL 插入被拒**（NOT NULL 面本用例核心——注意 SQL 三值逻辑下
   `role IN (...)` 对 NULL 求值 UNKNOWN，拒 NULL 必须靠 NOT NULL）；
5. 非法值（'tool'）插入被拒（CHECK 面）；合法三值仍可插入；
6. `downgrade` 回 0070 后约束卸除、role 还原可空；再升级仍幂等重落。

旧形态构造方式：`Table.to_metadata` 拷出当前模型元数据副本，进程内退化
（role 置可空、摘 CheckConstraint）后 create_all——不改动仓库源码、不影响
同进程其他用例的共享元数据。DATABASE_URL 经 monkeypatch 指向 tmp_path 下的
临时 sqlite（alembic/env.py 无条件用 settings.DATABASE_URL 覆盖 Config，
故必须改 settings 本体）；tmp_path 由 pytest 管理在系统临时区，不入仓库。

运行: cd backend && py -3 -m pytest tests/test_nf1_role_migration.py -q
"""

import os
import sys

import pytest
from sqlalchemy import MetaData, create_engine, inspect
from sqlalchemy.exc import IntegrityError
from sqlalchemy import text

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402

from app.core.config import settings  # noqa: E402

_REVISION_0070 = "0070_add_st_plugin_secrets"
_CHECK_NAME = "ck_character_chat_messages_role"
_TABLE = "character_chat_messages"


def _alembic_config() -> Config:
    # 不加载 alembic.ini：env.py 对带文件名的 Config 会跑 fileConfig（默认
    # disable_existing_loggers=True），会在 pytest 进程内关掉既有 logger、
    # 污染其他用例的 caplog。裸 Config + set_main_option 等价且无副作用；
    # sqlalchemy.url 由 env.py 从 settings.DATABASE_URL 取（fixture 已 monkeypatch）。
    cfg = Config()
    cfg.set_main_option("script_location", os.path.join(_BACKEND_DIR, "alembic"))
    return cfg


def _make_legacy_engine(db_path):
    """旧形态（0071 之前）sqlite engine：role 可空、无 CHECK。

    全量拷贝 Base.metadata（按 sorted_tables 依赖序，FK 引用才能在副本内
    正确重挂），只对 character_chat_messages 副本做进程内退化——不动仓库
    源码里的共享元数据，同进程其他用例不受影响。
    """
    from app.models import Base

    engine = create_engine(f"sqlite:///{db_path.as_posix()}")
    meta = MetaData()
    for tbl in Base.metadata.sorted_tables:
        tbl.to_metadata(meta)
    legacy_table = meta.tables[_TABLE]
    legacy_table.columns.role.nullable = True
    for constraint in list(legacy_table.constraints):
        if getattr(constraint, "name", None) == _CHECK_NAME:
            legacy_table.constraints.remove(constraint)
    meta.create_all(bind=engine)
    return engine


def _seed_legacy_rows(engine):
    """复刻取证报告 §2.2 的案发形态：开场白 assistant 行 + NULL role 孤儿行。

    is_hidden/is_locked 置 0：模型声明 NOT NULL（生产旧行的 NULL 是模型演进
    早于存量列的历史状态），与本用例被测的 role 不变量无关。
    """
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO character_chat_messages "
                "(id, session_id, role, content, is_user, is_system, "
                "is_hidden, is_locked, swipe_id) "
                "VALUES (1296, 'sess-nf1', 'assistant', 'greeting', 0, 0, 0, 0, 0)"
            )
        )
        conn.execute(
            text(
                "INSERT INTO character_chat_messages "
                "(id, session_id, role, content, is_user, is_system, "
                "is_hidden, is_locked, swipe_id) "
                "VALUES (1297, 'sess-nf1', NULL, 'orphan', 0, 0, 0, 0, 0)"
            )
        )


def _role_nullable(engine) -> bool:
    cols = {c["name"]: c for c in inspect(engine).get_columns(_TABLE)}
    return bool(cols["role"]["nullable"])


def _check_names(engine) -> set:
    return {c["name"] for c in inspect(engine).get_check_constraints(_TABLE)}


_INSERT_SQL = text(
    "INSERT INTO character_chat_messages "
    "(id, session_id, role, content, is_user, is_system, "
    "is_hidden, is_locked, swipe_id) "
    "VALUES (:id, 'sess-nf1', :role, 'x', 0, 0, 0, 0, 0)"
)

_probe_ids = iter(range(9000, 9900))


def _try_insert(engine, role) -> bool:
    """参数化插一行（自增探针 id，避免 PK 冲突混入判定），返回是否成功。"""
    try:
        with engine.begin() as conn:
            conn.execute(_INSERT_SQL, {"id": next(_probe_ids), "role": role})
        return True
    except IntegrityError:
        return False


@pytest.fixture()
def migrated_db(tmp_path, monkeypatch):
    """旧形态库 + 已 stamp 0070 + 已 upgrade head。"""
    db_path = tmp_path / "nf1_migration_test.sqlite3"
    engine = _make_legacy_engine(db_path)
    _seed_legacy_rows(engine)
    db_url = f"sqlite:///{db_path.as_posix()}"
    monkeypatch.setattr(settings, "DATABASE_URL", db_url)
    cfg = _alembic_config()
    command.stamp(cfg, _REVISION_0070)
    command.upgrade(cfg, "head")
    return engine, cfg


def test_upgrade_enforces_role_invariant(migrated_db):
    """升级后：NOT NULL + CHECK 落库、NULL 行归一、NULL/非法值插入被拒。"""
    engine, _ = migrated_db

    # ① schema 面
    assert _role_nullable(engine) is False
    assert _CHECK_NAME in _check_names(engine)

    # ② 数据面：迁移内兜底归一化把历史 NULL 行收成 assistant
    with engine.connect() as conn:
        row = conn.execute(
            text(
                "SELECT role FROM character_chat_messages WHERE id = 1297"
            )
        ).scalar_one()
    assert row == "assistant"

    # ③ 写面：NULL 插入被拒（NOT NULL；CHECK 的 IN 对 NULL 是 UNKNOWN 不拒）
    assert _try_insert(engine, None) is False
    # ④ 写面：白名单外值被拒（CHECK）
    assert _try_insert(engine, "tool") is False
    # ⑤ 写面：合法三值全部放行
    for role in ("user", "assistant", "system"):
        assert _try_insert(engine, role) is True


def test_downgrade_removes_invariant_then_reupgrade(migrated_db):
    """降级回 0070：约束卸除、role 还原可空（NULL 又可插）；再升级幂等重落。"""
    engine, cfg = migrated_db
    command.downgrade(cfg, _REVISION_0070)

    assert _role_nullable(engine) is True
    assert _CHECK_NAME not in _check_names(engine)
    # 约束卸除后 NULL 插入恢复放行（回退语义完整；绑定为 SQL NULL 而非字符串）
    assert _try_insert(engine, None) is True

    # 再升级：幂等重落（含对刚才 NULL 行的二次归一化）
    command.upgrade(cfg, "head")
    assert _role_nullable(engine) is False
    assert _CHECK_NAME in _check_names(engine)
    with engine.connect() as conn:
        nulls = conn.execute(
            text(
                "SELECT COUNT(*) FROM character_chat_messages WHERE role IS NULL"
            )
        ).scalar_one()
    assert nulls == 0
