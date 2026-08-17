"""pytest 全局 fixtures：SQLite in-memory DB session + FastAPI TestClient。

为 ST 契约测试（``tests/test_st_contract.py``）和其他需要 DB session 的
测试提供隔离的 SQLite in-memory 数据库，避免依赖外部 PostgreSQL。

提供 fixtures：
- ``db_session`` —— 每个测试函数独立的 SQLAlchemy Session，测试后回滚并
  清理所有表，确保测试隔离。
- ``test_user`` —— 在 ``db_session`` 中创建的测试用户（role=user）。
- ``auth_headers`` —— 含 ``Authorization: Bearer <jwt>`` 的 dict，token
  通过 ``create_access_token({"sub": test_user.username})`` 生成。
- ``client`` —— FastAPI TestClient，依赖注入 ``get_db`` 为 ``db_session``
  fixture 返回的 session，使所有请求共享同一份内存数据。

实现说明：
- 使用 ``sqlite:///:memory:`` 单连接 engine + ``StaticPool``，保证同一
  Session 中的所有连接看到同一份内存数据（默认 :memory: 每连接独立）。
- ``Base.metadata.create_all`` 直接建表，跳过 alembic 迁移以加快测试启动。
- Palink models 使用 SQLAlchemy 通用类型（Integer/String/Text/Boolean/
  DateTime/ForeignKey），不依赖 PostgreSQL 特定类型（JSON 列均以 Text
  存储），因此在 SQLite 下可以正常建表。
"""
from __future__ import annotations

import os
import sys
from collections.abc import Iterator

import pytest

# 让 ``backend`` 目录可被导入（conftest.py 在 backend/tests/ 下）
_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool


# ---------------------------------------------------------------------------
# Engine / schema 创建（一次创建，多测试复用以节省时间）
# ---------------------------------------------------------------------------
@pytest.fixture(scope="session")
def _engine():
    """会话级 SQLite in-memory engine，所有测试共享同一份 schema。

    使用 ``StaticPool`` + ``check_same_thread=False`` 让多个连接映射到同一
    个底层 DBAPI 连接，从而共享同一份 :memory: 数据库。
    """
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    # 导入 Base 并创建所有表（必须在导入 app.models 之后）
    from app.models import Base
    Base.metadata.create_all(bind=engine)
    yield engine
    engine.dispose()


@pytest.fixture()
def db_session(_engine) -> Iterator[Session]:
    """函数级 DB session：每个测试独立，测试后清理所有表数据。

    实现策略：使用独立 connection + 事务回滚 + 末尾全表 DELETE。
    采用 ``DELETE FROM <table>`` 清理而不是 drop_all/create_all，避免反复
    建表的性能开销（schema 在 session 级 _engine fixture 中只创建一次）。
    """
    connection = _engine.connect()
    # 开启外键约束，模拟 PostgreSQL 行为
    connection.exec_driver_sql("PRAGMA foreign_keys=ON")
    SessionLocal = sessionmaker(bind=connection, autoflush=False, autocommit=False, expire_on_commit=False)
    session = SessionLocal()

    try:
        yield session
    finally:
        session.close()
        connection.close()
        # 清空所有表数据（按依赖倒序），保证下一个测试从干净状态开始
        _truncate_all_tables(_engine)


def _truncate_all_tables(engine) -> None:
    """清空 engine 上所有表的数据（不删除 schema）。"""
    from app.models import Base
    # 按依赖倒序（子表先于父表）删除，避免 FK 约束冲突
    with engine.begin() as conn:
        # 临时禁用 FK 以避免删除顺序问题
        conn.exec_driver_sql("PRAGMA foreign_keys=OFF")
        for table in reversed(Base.metadata.sorted_tables):
            conn.execute(table.delete())
        conn.exec_driver_sql("PRAGMA foreign_keys=ON")


# ---------------------------------------------------------------------------
# 测试用户与认证 headers
# ---------------------------------------------------------------------------
@pytest.fixture()
def test_user(db_session: Session):
    """创建测试用户（role=user, is_active=True）。"""
    from app.core.security import get_password_hash
    from app.models import User

    user = User(
        username="st_contract_user",
        hashed_password=get_password_hash("TestPassword1"),
        role="user",
        is_active=True,
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


@pytest.fixture()
def auth_headers(test_user) -> dict[str, str]:
    """构造 ``Authorization: Bearer <jwt>`` headers。"""
    from app.core.security import create_access_token

    token = create_access_token({"sub": test_user.username})
    return {"Authorization": f"Bearer {token}"}


# ---------------------------------------------------------------------------
# FastAPI TestClient（依赖注入 db_session）
# ---------------------------------------------------------------------------
@pytest.fixture()
def client(db_session: Session, test_user):
    """FastAPI TestClient，将 ``get_db`` 注入为返回 ``db_session``。

    ``test_user`` 作为前置依赖确保用户在 DB 中先创建，使后续认证请求能
    解析到用户。同时使用 ``app.main.app`` 入口而非重新构造 app，保持
    lifespan/middleware/exception handlers 与生产一致（lifespan 中的 DB
    初始化逻辑被 ``get_db`` override 跳过）。
    """
    from fastapi.testclient import TestClient

    from app.api.dependencies import get_current_user
    from app.core.database import get_db
    from app.main import app

    # 依赖注入：把 get_db 替换为返回当前测试 session 的函数
    def _override_get_db():
        try:
            yield db_session
        finally:
            pass

    # 依赖注入：把 get_current_user 替换为返回 test_user 的函数，
    # 这样不需要在每次请求时都解析 JWT（ST 端点使用 get_st_current_user
    # 内部自行解析 JWT，不依赖 get_current_user，但 Palink 原生端点会用）。
    async def _override_get_current_user():
        return test_user

    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[get_current_user] = _override_get_current_user

    # TestClient 触发 lifespan 会调用 _initialize_database_once，在 SQLite
    # in-memory 下会再次 create_all（幂等），但也会尝试 _init_default_data
    # 创建 admin 用户 —— 在开发模式下 ADMIN_PASSWORD 未配置会跳过。
    # 使用 context manager 以触发 lifespan 事件。
    with TestClient(app) as test_client:
        yield test_client

    # 清理 dependency overrides，避免污染其他测试
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
