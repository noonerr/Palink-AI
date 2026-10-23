import uuid
from sqlalchemy import Column, Integer, String, Boolean, DateTime, ForeignKey, Text, UniqueConstraint
from sqlalchemy.orm import relationship
from .base import Base, utc_now

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
    # [A-7 多租户插件隔离] 用户作用域：NULL = 全局插件（所有用户可见）；
    # 非 NULL = 仅该 user_id 可见。兼容列由 core/migrations.py 兜底添加。
    user_id = Column(Integer, nullable=True)


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


class CharacterPluginState(Base):
    """[PLUGIN-ON-DEMAND] 角色卡级插件开关覆盖（2026-09-26）。

    语义由 ``characters.plugin_scope_mode`` 决定：
    - ``inherit``（默认，也是所有存量角色的状态）：本表的行**不参与判定**，
      沿用 ``plugins.enabled`` 全局开关 —— 保证老卡行为零变化；
    - ``allowlist``：白名单模式，**只有**本表 ``enabled=True`` 的插件才下发。

    之所以把"模式位"和"覆盖行"分开，是为了能表达「用户明确确认过一张卡什么都不装」
    这种空白名单（只靠"有没有行"无法区分空名单与从未设置）。
    """
    __tablename__ = "character_plugin_state"
    __table_args__ = (
        UniqueConstraint("character_id", "plugin_id", name="uq_character_plugin"),
    )

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    character_id = Column(String, ForeignKey("characters.id", ondelete="CASCADE"), nullable=False, index=True)
    plugin_id = Column(String, ForeignKey("plugins.id", ondelete="CASCADE"), nullable=False)
    enabled = Column(Boolean, default=True, nullable=False)
    # 来源标记：declared=卡显式声明 / detected=识别器命中 / manual=用户手工勾选
    source = Column(String, nullable=True)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)
