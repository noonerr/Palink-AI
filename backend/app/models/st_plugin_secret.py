import uuid

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint

from .base import Base, utc_now


class StPluginSecret(Base):
    """ST 插件 secrets 存储（2026-10-24 API-1，取代 Task 37 的 /api/secrets/* stub）。

    SillyTavern 插件（Secret Manager 等）经 /api/secrets/* 存取 API key。
    每行 = 某用户在某个 ST secret key（如 ``api_key_custom``）下的**当前值**，
    ``unique(user_id, key)`` 单槽位 —— ST 原生是"每 key 一条历史数组 + active
    标记"，Palink 只保当前值（write 覆盖、rotate 恒确认、read 的 state 数组
    每 key 至多一条），语义映射见 silly_tavern.py 的端点 docstring。

    安全属性：
    * ``value_encrypted`` 永不明文落库：Fernet（密钥由 SECRET_KEY 确定性派生，
      见 silly_tavern.py::_secrets_fernet 的轮换权衡注释）。
    * 全部按 user 隔离：所有读写必须带 ``user_id == 当前用户`` 过滤。

    注：``label`` 列不在最初钉死的列清单里 —— 它是支撑 ST /rename 语义与
    /read state 形状（SecretState.label）的最小增量，未带 label 时为 NULL、
    读取侧显示 ST 默认值 'Unlabeled'。
    """

    __tablename__ = "st_plugin_secrets"
    __table_args__ = (
        UniqueConstraint("user_id", "key", name="uq_st_plugin_secrets_user_key"),
    )

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    # ondelete 只是声明：SQLite 默认不强制外键；user 注销的兜底同其它 user 表。
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    # ST secret key 名（SECRET_KEYS 值域内的约定键，也接受插件自定义键）。
    # 与 character_plugin_storage 同名先例：SQLite/PG 均接受未加引号的 key 列名。
    key = Column(String, nullable=False)
    value_encrypted = Column(Text, nullable=False)
    label = Column(String, nullable=True)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)
