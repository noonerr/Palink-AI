import uuid
from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Boolean, BigInteger, DateTime, ForeignKey, Text
from sqlalchemy.orm import relationship
from .base import Base

def utc_now():
    return datetime.now(timezone.utc)

class UserFolder(Base):
    __tablename__ = "user_folders"
    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(Integer, ForeignKey("users.id"))
    name = Column(String)
    parent_id = Column(String, nullable=True) 
    created_at = Column(DateTime, default=utc_now)
    user = relationship("User", back_populates="folders")
    files = relationship("UserFile", back_populates="folder", cascade="all, delete-orphan")

class UserFile(Base):
    __tablename__ = "user_files"
    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(Integer, ForeignKey("users.id"))
    folder_id = Column(String, ForeignKey("user_folders.id"), nullable=True, index=True) 
    filename = Column(String)
    file_path = Column(String) 
    file_size = Column(BigInteger)
    mime_type = Column(String)
    created_at = Column(DateTime, default=utc_now)
    summary = Column(Text, nullable=True)
    user = relationship("User", back_populates="files")
    folder = relationship("UserFolder", back_populates="files")
