from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker, Session
from typing import Generator
from .config import settings

if settings.DATABASE_URL.startswith("sqlite"):
    engine = create_engine(
        settings.DATABASE_URL, 
        connect_args={"check_same_thread": False},
        pool_pre_ping=True
    )

    @event.listens_for(engine, "connect")
    def set_sqlite_pragmas(dbapi_connection, connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA temp_store=MEMORY")
        # 写锁冲突时最多等待 30s，避免零超时导致的"全站冻结只能强杀"
        cursor.execute("PRAGMA busy_timeout=30000")
        cursor.close()
else:
    _pool_size = settings.DB_POOL_SIZE
    _max_overflow = settings.DB_MAX_OVERFLOW

    if settings.DB_POOL_AUTO_TUNE:
        import os
        try:
            cpu_count = os.cpu_count() or 1
            budget = settings.DB_CONNECTION_BUDGET
            _pool_size = max(2, min(cpu_count * 2, budget // 2))
            _max_overflow = max(2, budget - _pool_size)
        except Exception:
            pass

    engine = create_engine(
        settings.DATABASE_URL,
        pool_pre_ping=True,
        pool_size=_pool_size,
        max_overflow=_max_overflow,
        pool_recycle=settings.DB_POOL_RECYCLE_SECONDS,
    )

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine, expire_on_commit=False)

def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
