from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Boolean, BigInteger, DateTime, ForeignKey, Text, JSON
from sqlalchemy.orm import relationship
from .base import Base

def utc_now():
    return datetime.now(timezone.utc)

class ChatMessage(Base):
    __tablename__ = "messages"
    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(String, ForeignKey("sessions.id"), index=True)
    role = Column(String)
    content = Column(Text)
    model = Column(String)
    created_at = Column(DateTime, default=utc_now)
    tokens = Column(Integer, default=0)
    prompt_tokens = Column(Integer, default=0)
    reasoning_tokens = Column(Integer, default=0)
    web_search_results = Column(Text, nullable=True)
    session = relationship("ChatSession", back_populates="messages")
