import uuid
from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Text, DateTime, Boolean, ForeignKey
from .base import Base


def utc_now():
    return datetime.now(timezone.utc)


class RegexScript(Base):
    """正则脚本持久化模型，兼容 SillyTavern extensions/regex/engine.js 的 RegexScript 结构。

    字段映射（后端 snake_case ↔ 前端 camelCase）：
      name             -> scriptName
      find_regex       -> findRegex
      replace_string   -> replaceString
      trim_strings     -> trimStrings (JSON 数组字符串)
      placement        -> placement   (JSON 数组字符串)
      disabled         -> disabled
      markdown_only    -> markdownOnly
      prompt_only      -> promptOnly
      run_on_edit      -> runOnEdit
      substitute_regex -> substituteRegex (0=NONE, 1=RAW, 2=ESCAPED)
      min_depth        -> minDepth
      max_depth        -> maxDepth
      order            -> order
      is_scope         -> 是否为 scoped 正则（关联角色卡/会话）
      scope_id         -> 关联的角色卡或会话 ID
    """

    __tablename__ = "regex_scripts"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    name = Column(String(255), nullable=False)
    find_regex = Column(Text, nullable=False)
    replace_string = Column(Text, nullable=False, default="")
    trim_strings = Column(Text, nullable=True)
    placement = Column(Text, nullable=True)
    disabled = Column(Boolean, default=False)
    markdown_only = Column(Boolean, default=False)
    prompt_only = Column(Boolean, default=False)
    run_on_edit = Column(Boolean, default=False)
    substitute_regex = Column(Integer, default=0)
    min_depth = Column(Integer, nullable=True)
    max_depth = Column(Integer, nullable=True)
    order = Column(Integer, default=0)
    is_scope = Column(Boolean, default=False)
    scope_id = Column(String(255), nullable=True, index=True)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)
