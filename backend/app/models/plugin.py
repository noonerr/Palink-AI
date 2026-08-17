import uuid
from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Boolean, DateTime, ForeignKey, Text
from sqlalchemy.orm import relationship
from .base import Base

def utc_now():
    return datetime.now(timezone.utc)


class Plugin(Base):
    __tablename__ = "plugins"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    name = Column(String, nullable=False)
    plugin_type = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    version = Column(String, nullable=True)
    author = Column(String, nullable=True)
    enabled = Column(Boolean, default=True)
    source_type = Column(String, nullable=True)
    source_data = Column(Text, nullable=True)
    config = Column(Text, nullable=True)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)


class PluginScript(Base):
    __tablename__ = "plugin_scripts"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    plugin_id = Column(String, ForeignKey("plugins.id", ondelete="CASCADE"), nullable=False)
    script_name = Column(String, nullable=False)
    script_type = Column(String, nullable=False)
    enabled = Column(Boolean, default=True)
    content = Column(Text, nullable=True)
    find_regex = Column(Text, nullable=True)
    replace_string = Column(Text, nullable=True)
    trim_strings = Column(Text, nullable=True)
    placement = Column(Text, nullable=True)
    markdown_only = Column(Boolean, default=False)
    prompt_only = Column(Boolean, default=False)
    run_on_edit = Column(Boolean, default=False)
    substitute_regex = Column(Integer, default=0)
    min_depth = Column(Integer, nullable=True)
    max_depth = Column(Integer, nullable=True)
    order_no = Column(Integer, default=0)
    created_at = Column(DateTime, default=utc_now)

    plugin = relationship("Plugin", backref="scripts")
