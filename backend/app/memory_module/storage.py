"""
存储层封装
支持 SQLite + 本地向量计算 或 PostgreSQL + pgvector
"""

from typing import List, Optional, Tuple, Dict, Any
from sqlalchemy.orm import Session
from sqlalchemy import text, desc
from datetime import datetime, timedelta
import numpy as np
import logging
import json

from .models import MemoryEntry, UserProfile
from .embedder import get_embedder, embed_text
from .config import memory_config

logger = logging.getLogger("MemoryModule")


_tables_initialized = False

class MemoryStorage:
    """记忆存储类 - 操作数据库"""
    
    def __init__(self, db_session: Session):
        global _tables_initialized
        self.db = db_session
        self.is_postgres = self._detect_postgres()
        if not _tables_initialized:
            self._init_tables()
            _tables_initialized = True
    
    def _detect_postgres(self) -> bool:
        """检测是否使用PostgreSQL数据库"""
        try:
            result = self.db.execute(text("SELECT version()"))
            row = result.first()
            if row and 'PostgreSQL' in str(row[0]):
                return True
        except:
            pass
        return False
    
    def _init_tables(self):
        """初始化数据库表（兼容SQLite和PostgreSQL）"""
        try:
            if self.is_postgres:
                self._init_postgres_tables()
            else:
                self._init_sqlite_tables()
            
            self._create_indexes()
            self._migrate_tables()
            
            self.db.commit()
            logger.info(f"记忆表初始化完成 (数据库类型: {'PostgreSQL' if self.is_postgres else 'SQLite'})")
            
        except Exception as e:
            logger.error(f"初始化表失败: {e}")
            self.db.rollback()
    
    def _init_sqlite_tables(self):
        """初始化SQLite表"""
        self.db.execute(text("""
            CREATE TABLE IF NOT EXISTS conversation_memories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                session_id TEXT,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                content_summary TEXT,
                embedding TEXT,
                importance_score REAL DEFAULT 0.5,
                topics TEXT DEFAULT '[]',
                tokens_count INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id),
                FOREIGN KEY (session_id) REFERENCES sessions(id)
            )
        """))
        
        self.db.execute(text("""
            CREATE TABLE IF NOT EXISTS user_profiles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER UNIQUE,
                preferences TEXT DEFAULT '{}',
                goals TEXT DEFAULT '[]',
                common_topics TEXT DEFAULT '[]',
                communication_style TEXT,
                summary TEXT,
                total_conversations INTEGER DEFAULT 0,
                total_messages INTEGER DEFAULT 0,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        """))
    
    def _init_postgres_tables(self):
        """初始化PostgreSQL表"""
        self.db.execute(text("""
            CREATE TABLE IF NOT EXISTS conversation_memories (
                id SERIAL PRIMARY KEY,
                user_id INTEGER,
                session_id TEXT,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                content_summary TEXT,
                embedding TEXT,
                importance_score REAL DEFAULT 0.5,
                topics TEXT DEFAULT '[]',
                tokens_count INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id),
                FOREIGN KEY (session_id) REFERENCES sessions(id)
            )
        """))
        
        self.db.execute(text("""
            CREATE TABLE IF NOT EXISTS user_profiles (
                id SERIAL PRIMARY KEY,
                user_id INTEGER UNIQUE,
                preferences TEXT DEFAULT '{}',
                goals TEXT DEFAULT '[]',
                common_topics TEXT DEFAULT '[]',
                communication_style TEXT,
                summary TEXT,
                total_conversations INTEGER DEFAULT 0,
                total_messages INTEGER DEFAULT 0,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        """))
    
    def _migrate_tables(self):
        """在现有表上安全添加新列（幂等）"""
        try:
            self.db.execute(text("""
                ALTER TABLE conversation_memories ADD COLUMN branch_id TEXT
            """))
            self.db.commit()
            logger.info("迁移: 添加 branch_id 列")
        except Exception:
            # 列已存在，忽略
            self.db.rollback()

    def _create_indexes(self):
        """创建索引"""
        self.db.execute(text("""
            CREATE INDEX IF NOT EXISTS idx_memory_user_id ON conversation_memories(user_id)
        """))
        self.db.execute(text("""
            CREATE INDEX IF NOT EXISTS idx_memory_session_id ON conversation_memories(session_id)
        """))
        self.db.execute(text("""
            CREATE INDEX IF NOT EXISTS idx_memory_created_at ON conversation_memories(created_at)
        """))
        self.db.execute(text("""
            CREATE INDEX IF NOT EXISTS idx_profile_user_id ON user_profiles(user_id)
        """))
    
    def store(
        self,
        user_id: int,
        session_id: str,
        role: str,
        content: str,
        importance_score: float = 0.5,
        topics: List[str] = None,
        branch_id: Optional[str] = None
    ) -> Optional[int]:
        """
        存储单条记忆
        
        Returns:
            memory_id: 记忆ID，失败返回 None
        """
        try:
            embedding = embed_text(content)
            embedding_list = embedding.tolist()[0] if len(embedding.shape) > 1 else embedding.tolist()
            embedding_json = json.dumps(embedding_list)
            
            tokens_count = len(content) // 2
            topics_json = json.dumps(topics or [])
            
            sql = text("""
                INSERT INTO conversation_memories 
                (user_id, session_id, branch_id, role, content, embedding, 
                 importance_score, topics, tokens_count, created_at)
                VALUES (:user_id, :session_id, :branch_id, :role, :content, :embedding,
                        :importance_score, :topics, :tokens_count, CURRENT_TIMESTAMP)
                RETURNING id
            """)
            
            result = self.db.execute(sql, {
                "user_id": user_id,
                "session_id": session_id,
                "branch_id": branch_id,
                "role": role,
                "content": content,
                "embedding": embedding_json,
                "importance_score": importance_score,
                "topics": topics_json,
                "tokens_count": tokens_count
            })
            
            memory_id = result.scalar()
            self.db.commit()
            
            logger.debug(f"记忆存储成功: id={memory_id}")
            return memory_id
            
        except Exception as e:
            logger.error(f"存储记忆失败: {e}")
            self.db.rollback()
            return None
    
    def semantic_search(
        self,
        user_id: int,
        query_embedding: List[float],
        limit: int = None,
        min_similarity: float = None,
        session_id: Optional[str] = None
    ) -> List[Tuple[MemoryEntry, float]]:
        """
        语义相似度搜索（SQLite版本，在Python中计算相似度）
        
        Returns:
            [(记忆条目, 相似度分数), ...]
        """
        limit = limit or memory_config.MAX_MEMORIES_PER_QUERY
        min_similarity = min_similarity or memory_config.MIN_SIMILARITY
        
        try:
            if session_id:
                sql = text("""
                    SELECT 
                        id, user_id, session_id, role, content,
                        importance_score, topics, tokens_count, created_at, embedding
                    FROM conversation_memories
                    WHERE user_id = :user_id AND session_id = :session_id
                    ORDER BY created_at DESC
                    LIMIT 500
                """)
                params = {"user_id": user_id, "session_id": session_id}
            else:
                sql = text("""
                    SELECT 
                        id, user_id, session_id, role, content,
                        importance_score, topics, tokens_count, created_at, embedding
                    FROM conversation_memories
                    WHERE user_id = :user_id
                    ORDER BY created_at DESC
                    LIMIT 500
                """)
                params = {"user_id": user_id}
            
            result = self.db.execute(sql, params)
            
            memories_with_similarity = []
            query_vec = np.array(query_embedding, dtype=np.float32)
            
            for row in result:
                try:
                    embedding_list = json.loads(row.embedding) if row.embedding else None
                    if embedding_list is None:
                        continue
                        
                    memory_vec = np.array(embedding_list, dtype=np.float32)
                    
                    norm_query = np.linalg.norm(query_vec)
                    norm_memory = np.linalg.norm(memory_vec)
                    
                    if norm_query > 0 and norm_memory > 0:
                        similarity = float(np.dot(query_vec, memory_vec) / (norm_query * norm_memory))
                    else:
                        similarity = 0.0
                    
                    if similarity >= min_similarity:
                        memory = MemoryEntry(
                            id=row.id,
                            user_id=row.user_id,
                            session_id=row.session_id,
                            role=row.role,
                            content=row.content,
                            importance_score=row.importance_score,
                            topics=json.loads(row.topics) if row.topics else [],
                            tokens_count=row.tokens_count or 0,
                            created_at=row.created_at
                        )
                        memories_with_similarity.append((memory, similarity))
                        
                except Exception as e:
                    logger.warning(f"解析嵌入向量失败: {e}")
                    continue
            
            memories_with_similarity.sort(key=lambda x: x[1], reverse=True)
            memories_with_similarity = memories_with_similarity[:limit]
            
            logger.info(f"语义检索完成: 找到 {len(memories_with_similarity)} 条记忆，最低相似度: {memories_with_similarity[-1][1] if memories_with_similarity else 'N/A'}")
            return memories_with_similarity
            
        except Exception as e:
            logger.error(f"语义检索失败: {e}")
            return []
    
    def get_recent(
        self,
        user_id: int,
        session_id: Optional[str] = None,
        limit: int = 10,
        branch_id: Optional[str] = None
    ) -> List[MemoryEntry]:
        """获取最近记忆（时间倒序）"""
        try:
            if session_id:
                if branch_id:
                    sql = text("""
                        SELECT
                            id, user_id, session_id, role, content,
                            importance_score, topics, tokens_count, created_at
                        FROM conversation_memories
                        WHERE user_id = :user_id AND session_id = :session_id AND branch_id = :branch_id
                        ORDER BY created_at DESC
                        LIMIT :limit
                    """)
                    params = {
                        "user_id": user_id,
                        "session_id": session_id,
                        "branch_id": branch_id,
                        "limit": limit,
                    }
                else:
                    sql = text("""
                        SELECT
                            id, user_id, session_id, role, content,
                            importance_score, topics, tokens_count, created_at
                        FROM conversation_memories
                        WHERE user_id = :user_id AND session_id = :session_id
                        ORDER BY created_at DESC
                        LIMIT :limit
                    """)
                    params = {
                        "user_id": user_id,
                        "session_id": session_id,
                        "limit": limit,
                    }
            else:
                sql = text("""
                    SELECT 
                        id, user_id, session_id, role, content,
                        importance_score, topics, tokens_count, created_at
                    FROM conversation_memories
                    WHERE user_id = :user_id
                    ORDER BY created_at DESC
                    LIMIT :limit
                """)
                params = {"user_id": user_id, "limit": limit}
            
            result = self.db.execute(sql, params)
            
            memories = []
            for row in result:
                memory = MemoryEntry(
                    id=row.id,
                    user_id=row.user_id,
                    session_id=row.session_id,
                    role=row.role,
                    content=row.content,
                    importance_score=row.importance_score,
                    topics=json.loads(row.topics) if row.topics else [],
                    tokens_count=row.tokens_count or 0,
                    created_at=row.created_at
                )
                memories.append(memory)
            
            return memories
            
        except Exception as e:
            logger.error(f"获取最近记忆失败: {e}")
            return []
    
    def get_user_profile(self, user_id: int) -> Optional[UserProfile]:
        """获取用户画像"""
        try:
            sql = text("""
                SELECT 
                    user_id, preferences, goals, common_topics,
                    communication_style, summary, total_conversations, total_messages
                FROM user_profiles
                WHERE user_id = :user_id
            """)
            
            result = self.db.execute(sql, {"user_id": user_id})
            row = result.fetchone()
            
            if row:
                return UserProfile(
                    user_id=row.user_id,
                    preferences=json.loads(row.preferences) if row.preferences else {},
                    goals=json.loads(row.goals) if row.goals else [],
                    common_topics=json.loads(row.common_topics) if row.common_topics else [],
                    communication_style=row.communication_style,
                    summary=row.summary,
                    total_conversations=row.total_conversations or 0,
                    total_messages=row.total_messages or 0
                )
            return None
            
        except Exception as e:
            logger.error(f"获取用户画像失败: {e}")
            return None
    
    def update_user_profile(self, profile: UserProfile) -> bool:
        """更新用户画像"""
        try:
            preferences_json = json.dumps(profile.preferences)
            goals_json = json.dumps(profile.goals)
            common_topics_json = json.dumps(profile.common_topics)
            
            sql = text("""
                INSERT INTO user_profiles 
                (user_id, preferences, goals, common_topics, 
                 communication_style, summary, total_conversations, total_messages, updated_at)
                VALUES (:user_id, :preferences, :goals, :common_topics,
                        :communication_style, :summary, :total_conversations, :total_messages, CURRENT_TIMESTAMP)
            """)
            
            try:
                self.db.execute(sql, {
                    "user_id": profile.user_id,
                    "preferences": preferences_json,
                    "goals": goals_json,
                    "common_topics": common_topics_json,
                    "communication_style": profile.communication_style,
                    "summary": profile.summary,
                    "total_conversations": profile.total_conversations,
                    "total_messages": profile.total_messages
                })
            except:
                sql = text("""
                    UPDATE user_profiles 
                    SET preferences = :preferences,
                        goals = :goals,
                        common_topics = :common_topics,
                        communication_style = :communication_style,
                        summary = :summary,
                        total_conversations = :total_conversations,
                        total_messages = :total_messages,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE user_id = :user_id
                """)
                self.db.execute(sql, {
                    "user_id": profile.user_id,
                    "preferences": preferences_json,
                    "goals": goals_json,
                    "common_topics": common_topics_json,
                    "communication_style": profile.communication_style,
                    "summary": profile.summary,
                    "total_conversations": profile.total_conversations,
                    "total_messages": profile.total_messages
                })
            
            self.db.commit()
            return True
            
        except Exception as e:
            logger.error(f"更新用户画像失败: {e}")
            self.db.rollback()
            return False
