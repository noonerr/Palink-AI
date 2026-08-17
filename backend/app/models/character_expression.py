import uuid
from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import relationship

from .base import Base


def utc_now():
    return datetime.now(timezone.utc)


class CharacterExpression(Base):
    """角色自定义表情资源记录。

    存储用户为角色上传的自定义表情图片元数据。默认 15 种 ST 表情
    不写入此表——仅在 API 层返回名称列表，图资源由前端静态目录提供。
    """

    __tablename__ = "character_expressions"
    __table_args__ = (
        UniqueConstraint(
            "character_id",
            "expression_name",
            name="uq_character_expressions_char_expr",
        ),
    )

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    character_id = Column(String, ForeignKey("characters.id"), nullable=False, index=True)
    expression_name = Column(String, nullable=False)
    # 相对路径，例如 characters/{character_id}/expressions/joy.png
    file_path = Column(String, nullable=False)
    created_at = Column(DateTime, default=utc_now)

    character = relationship("Character")
