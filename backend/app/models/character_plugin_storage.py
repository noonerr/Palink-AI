import uuid
from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import relationship

from .base import Base


def utc_now():
    return datetime.now(timezone.utc)


class CharacterPluginStorage(Base):
    """角色卡脚本的键值对存档（2026-10-02 P2）。

    角色卡自带脚本会往浏览器 localStorage 写解锁态之类的进度数据，原本完全不落库：
    换浏览器/换设备就丢，同一浏览器多个账号还能互相看见对方解锁的立绘（隐私问题）。

    本表按 ``(character_id, ns, key)`` 唯一，``user_id`` 冗余存归属用于越权校验。

    注意：这不是聊天状态时，不参与任何装配链路，**永远不是关键信息** ——
    同步失败前端必须静默降级为纯本地，不得因为写不进来让卡脚本崩掉。
    """

    __tablename__ = "character_plugin_storage"
    __table_args__ = (
        UniqueConstraint(
            "character_id",
            "ns",
            "key",
            name="uq_character_plugin_storage_character_ns_key",
        ),
    )

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    # ondelete 只是声明：SQLite 默认不强制外键，真正的兜底是
    # character_service.delete_character 里的显式删除。
    character_id = Column(String, ForeignKey("characters.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    # 命名空间：'local' | 'session'
    ns = Column(String, nullable=False)
    key = Column(String, nullable=False)
    value = Column(Text, nullable=True)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)

    character = relationship("Character")
