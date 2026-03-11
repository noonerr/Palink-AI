import logging
import os

from alembic.config import Config
from alembic import command

logger = logging.getLogger(__name__)


def run_migrations(engine):
    """使用 Alembic 运行数据库迁移"""
    try:
        # 定位 alembic.ini（backend 目录下）
        backend_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        alembic_cfg = Config(os.path.join(backend_dir, "alembic.ini"))
        alembic_cfg.set_main_option("script_location", os.path.join(backend_dir, "alembic"))
        alembic_cfg.set_main_option("sqlalchemy.url", str(engine.url))

        # 如果数据库已有表但没有 alembic_version，先 stamp 到 head
        # 这样对已有数据库不会重复执行迁移
        from sqlalchemy import inspect
        inspector = inspect(engine)
        tables = inspector.get_table_names()
        if tables and "alembic_version" not in tables:
            logger.info("Existing database detected without alembic_version, stamping to head")
            command.stamp(alembic_cfg, "head")
        else:
            # 正常升级到最新版本
            command.upgrade(alembic_cfg, "head")

        logger.info("Alembic migrations complete")
    except Exception as e:
        logger.error("Alembic migration failed: %s", e)
        raise
