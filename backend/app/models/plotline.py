import uuid
from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Boolean, DateTime, ForeignKey, Text, UniqueConstraint
from sqlalchemy.orm import relationship
from .base import Base


def utc_now():
    return datetime.now(timezone.utc)


class PlotLine(Base):
    __tablename__ = "plot_lines"
    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(Integer, ForeignKey("users.id"))
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    raw_content = Column(Text, nullable=True)
    is_parsed = Column(Boolean, default=False)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)

    user = relationship("User")
    stages = relationship("PlotStage", back_populates="plot_line", cascade="all, delete-orphan",
                          order_by="PlotStage.stage_index")


class PlotStage(Base):
    __tablename__ = "plot_stages"
    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    plot_line_id = Column(String, ForeignKey("plot_lines.id", ondelete="CASCADE"))
    stage_index = Column(Integer, nullable=False, default=0)
    title = Column(String, nullable=True)
    content = Column(Text, nullable=False)
    summary = Column(Text, nullable=True)
    transition_hint = Column(Text, nullable=True)
    priority = Column(Integer, default=5)
    token_count = Column(Integer, default=0)
    created_at = Column(DateTime, default=utc_now)

    plot_line = relationship("PlotLine", back_populates="stages")


class SessionPlotLine(Base):
    __tablename__ = "session_plot_lines"
    __table_args__ = (
        UniqueConstraint("session_id", name="uq_session_plotline"),
    )
    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    session_id = Column(String, ForeignKey("character_chat_sessions.id", ondelete="CASCADE"))
    plot_line_id = Column(String, ForeignKey("plot_lines.id", ondelete="CASCADE"))
    current_stage_index = Column(Integer, default=0)
    stage_transition_mode = Column(String, default="manual")  # "manual" | "auto"
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)

    session = relationship("CharacterChatSession")
    plot_line = relationship("PlotLine")
