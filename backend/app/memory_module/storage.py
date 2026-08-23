"""
存储层封装
支持 SQLite + 本地向量计算 或 PostgreSQL + pgvector
"""

from typing import List, Optional, Tuple, Dict, Any
from sqlalchemy.orm import Session
from sqlalchemy import text, desc, bindparam
from datetime import datetime, timedelta
import numpy as np
import asyncio
import hashlib
import logging
import json
import threading

from .models import MemoryEntry, UserProfile
from .embedder import get_embedder, embed_text
from .config import memory_config

logger = logging.getLogger("MemoryModule")


def _chunk_topics(turn_hash: str, idx: int, total: int) -> List[str]:
    """语义块元数据编码（写入 topics JSON 列，免 schema 迁移）。"""
    return ["#chunk", f"#turn:{turn_hash}", f"#idx:{idx}", f"#total:{total}"]


def _parse_chunk_meta(topics) -> Optional[Tuple[str, int, int]]:
    """从 topics 解析块元数据。返回 (turn_hash, idx, total)；非块返回 None。"""
    try:
        items = json.loads(topics) if isinstance(topics, str) else (topics or [])
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(items, list) or "#chunk" not in items:
        return None
    turn_hash = None
    idx = -1
    total = 0
    for item in items:
        if not isinstance(item, str):
            continue
        if item.startswith("#turn:"):
            turn_hash = item[len("#turn:"):]
        elif item.startswith("#idx:"):
            idx = int(item[len("#idx:"):])
        elif item.startswith("#total:"):
            total = int(item[len("#total:"):])
    if not turn_hash or idx < 0:
        return None
    return turn_hash, idx, total


_tables_initialized = False
_is_postgres_cached = None
_migration_done = False
_storage_lock = threading.Lock()

class MemoryStorage:
    """记忆存储类 - 操作数据库"""
    
    def __init__(self, db_session: Session):
        global _tables_initialized, _is_postgres_cached, _migration_done
        self.db = db_session
        with _storage_lock:
            if _is_postgres_cached is not None:
                self.is_postgres = _is_postgres_cached
            else:
                self.is_postgres = self._detect_postgres()
                _is_postgres_cached = self.is_postgres
            if not _tables_initialized:
                self._init_tables()
    
    def _detect_postgres(self) -> bool:
        """检测是否使用PostgreSQL数据库"""
        try:
            result = self.db.execute(text("SELECT version()"))
            row = result.first()
            if row and 'PostgreSQL' in str(row[0]):
                return True
        except Exception:
            try:
                self.db.rollback()
            except Exception:
                pass
        return False
    
    def _init_tables(self):
        """初始化数据库表（兼容SQLite和PostgreSQL）"""
        global _tables_initialized, _migration_done
        try:
            if self.is_postgres:
                self._init_postgres_tables()
            else:
                self._init_sqlite_tables()
            
            self._create_indexes()
            if not _migration_done:
                self._migrate_tables()
                _migration_done = True
            
            self.db.commit()
            _tables_initialized = True
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
                branch_id TEXT,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                content_summary TEXT,
                embedding TEXT,
                importance_score REAL DEFAULT 0.5,
                topics TEXT DEFAULT '[]',
                tokens_count INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """))
    
    def _init_postgres_tables(self):
        """初始化PostgreSQL表"""
        self.db.execute(text("""
            CREATE TABLE IF NOT EXISTS conversation_memories (
                id SERIAL PRIMARY KEY,
                user_id INTEGER,
                session_id TEXT,
                branch_id TEXT,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                content_summary TEXT,
                embedding TEXT,
                importance_score REAL DEFAULT 0.5,
                topics TEXT DEFAULT '[]',
                tokens_count INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """))
    
    def _migrate_tables(self):
        """在现有表上安全添加新列（幂等）- 使用 SAVEPOINT 隔离"""
        if self.is_postgres:
            try:
                nested = self.db.begin_nested()
                self.db.execute(text("""
                    ALTER TABLE conversation_memories ADD COLUMN branch_id TEXT
                """))
                nested.commit()
                logger.info("迁移: 添加 branch_id 列")
            except Exception:
                nested.rollback()
        else:
            try:
                self.db.execute(text("""
                    ALTER TABLE conversation_memories ADD COLUMN branch_id TEXT
                """))
                logger.info("迁移: 添加 branch_id 列")
            except Exception:
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
            CREATE INDEX IF NOT EXISTS idx_memory_branch_id ON conversation_memories(branch_id)
        """))
        self.db.execute(text("""
            CREATE INDEX IF NOT EXISTS idx_profile_user_id ON user_profiles(user_id)
        """))
        self.db.execute(text("""
            CREATE INDEX IF NOT EXISTS idx_memory_user_session ON conversation_memories(user_id, session_id)
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
        存储单条记忆（先存储 content，embedding 置 NULL，后台异步计算）
        
        Returns:
            memory_id: 记忆ID，失败返回 None
        """
        if len(content) > 10000:
            raise ValueError("Content too long")
        try:
            tokens_count = len(content) // 2
            topics_json = json.dumps(topics or [])
            
            if self.is_postgres:
                sql = text("""
                    INSERT INTO conversation_memories 
                    (user_id, session_id, branch_id, role, content, embedding, 
                     importance_score, topics, tokens_count, created_at)
                    VALUES (:user_id, :session_id, :branch_id, :role, :content, NULL,
                            :importance_score, :topics, :tokens_count, CURRENT_TIMESTAMP)
                    RETURNING id
                """)
                
                result = self.db.execute(sql, {
                    "user_id": user_id,
                    "session_id": session_id,
                    "branch_id": branch_id,
                    "role": role,
                    "content": content,
                    "importance_score": importance_score,
                    "topics": topics_json,
                    "tokens_count": tokens_count
                })
                
                memory_id = result.scalar()
            else:
                sql = text("""
                    INSERT INTO conversation_memories 
                    (user_id, session_id, branch_id, role, content, embedding, 
                     importance_score, topics, tokens_count, created_at)
                    VALUES (:user_id, :session_id, :branch_id, :role, :content, NULL,
                            :importance_score, :topics, :tokens_count, CURRENT_TIMESTAMP)
                """)
                
                result = self.db.execute(sql, {
                    "user_id": user_id,
                    "session_id": session_id,
                    "branch_id": branch_id,
                    "role": role,
                    "content": content,
                    "importance_score": importance_score,
                    "topics": topics_json,
                    "tokens_count": tokens_count
                })
                
                memory_id = result.lastrowid
            self.db.commit()
            
            try:
                loop = asyncio.get_running_loop()
                loop.create_task(self._async_update_embedding(memory_id, content))
            except RuntimeError:
                self._sync_update_embedding(memory_id, content)
            
            logger.debug(f"记忆存储成功: id={memory_id}")
            return memory_id
            
        except Exception as e:
            logger.error(f"存储记忆失败: {e}")
            self.db.rollback()
            return None

    def store_chunks(
        self,
        user_id: int,
        session_id: str,
        role: str,
        chunks: List[str],
        branch_id: Optional[str] = None,
        importance_score: float = 0.5,
    ) -> List[int]:
        """批量存储语义块（方案 B）：一次批量嵌入 + 单事务插入，embedding 直写。

        Returns:
            各块 memory_id 列表（顺序与 chunks 一致）；整体失败返回 []
        """
        if not chunks:
            return []
        turn_hash = hashlib.blake2b(
            (chunks[0][:64] + datetime.utcnow().isoformat()).encode("utf-8"),
            digest_size=8,
        ).hexdigest()[:12]
        total = len(chunks)
        try:
            embeddings = embed_text(chunks)  # 批量：单次调用出全部向量
        except Exception as e:
            # 嵌入失败 → 逐条走现有 store()（NULL embedding + 后台重试），行不丢
            logger.warning(f"store_chunks 批量嵌入失败，降级逐条存储: {e}")
            ids = []
            for i, chunk in enumerate(chunks):
                mid = self.store(
                    user_id=user_id,
                    session_id=session_id,
                    role=role,
                    content=chunk,
                    importance_score=importance_score,
                    topics=_chunk_topics(turn_hash, i, total),
                    branch_id=branch_id,
                )
                if mid is not None:
                    ids.append(mid)
            return ids

        try:
            ids: List[int] = []
            for i, chunk in enumerate(chunks):
                emb_list = embeddings[i].tolist()
                topics_json = json.dumps(_chunk_topics(turn_hash, i, total))
                sql = text("""
                    INSERT INTO conversation_memories
                    (user_id, session_id, branch_id, role, content, embedding,
                     importance_score, topics, tokens_count, created_at)
                    VALUES (:user_id, :session_id, :branch_id, :role, :content, :embedding,
                            :importance_score, :topics, :tokens_count, CURRENT_TIMESTAMP)
                """)
                params = {
                    "user_id": user_id,
                    "session_id": session_id,
                    "branch_id": branch_id,
                    "role": role,
                    "content": chunk,
                    "embedding": json.dumps(emb_list),
                    "importance_score": importance_score,
                    "topics": topics_json,
                    "tokens_count": len(chunk) // 2,
                }
                if self.is_postgres:
                    sql = text("""
                        INSERT INTO conversation_memories
                        (user_id, session_id, branch_id, role, content, embedding,
                         importance_score, topics, tokens_count, created_at)
                        VALUES (:user_id, :session_id, :branch_id, :role, :content, :embedding,
                                :importance_score, :topics, :tokens_count, CURRENT_TIMESTAMP)
                        RETURNING id
                    """)
                    result = self.db.execute(sql, params)
                    ids.append(result.scalar())
                else:
                    result = self.db.execute(sql, params)
                    ids.append(result.lastrowid)
            self.db.commit()
            logger.debug(f"语义块批量存储成功: turn={turn_hash} blocks={len(ids)}")
            return ids
        except Exception as e:
            logger.error(f"store_chunks 批量插入失败: {e}")
            self.db.rollback()
            return []

    def get_adjacent_chunks(self, mem: MemoryEntry) -> List[MemoryEntry]:
        """取同轮(turn_hash)中 idx±1 的相邻块（缺失侧静默跳过）。"""
        meta = _parse_chunk_meta(mem.topics)
        if meta is None:
            return []
        turn_hash, idx, _total = meta
        target_idxs = {idx - 1, idx + 1}
        like_pat = f'%"#turn:{turn_hash}"%'
        try:
            if self.is_postgres:
                sql = text("""
                    SELECT id, user_id, session_id, branch_id, role, content,
                           importance_score, topics, tokens_count, created_at, embedding
                    FROM conversation_memories
                    WHERE user_id = :user_id AND session_id = :session_id
                      AND topics::text LIKE :pat AND id != :id
                    ORDER BY id
                """)
            else:
                sql = text("""
                    SELECT id, user_id, session_id, branch_id, role, content,
                           importance_score, topics, tokens_count, created_at, embedding
                    FROM conversation_memories
                    WHERE user_id = :user_id AND session_id = :session_id
                      AND topics LIKE :pat AND id != :id
                    ORDER BY id
                """)
            result = self.db.execute(sql, {
                "user_id": mem.user_id,
                "session_id": mem.session_id,
                "pat": like_pat,
                "id": mem.id,
            })
            out: List[MemoryEntry] = []
            for row in result:
                row_meta = _parse_chunk_meta(row.topics)
                if row_meta is None or row_meta[1] not in target_idxs:
                    continue
                emb_list = json.loads(row.embedding) if row.embedding else None
                out.append(MemoryEntry(
                    id=row.id,
                    user_id=row.user_id,
                    session_id=row.session_id,
                    branch_id=row.branch_id,
                    role=row.role,
                    content=row.content,
                    importance_score=row.importance_score,
                    topics=json.loads(row.topics) if row.topics else [],
                    tokens_count=row.tokens_count or 0,
                    created_at=row.created_at,
                    embedding=emb_list,
                ))
            return out
        except Exception as e:
            logger.warning(f"查询相邻块失败: {e}")
            return []

    async def _async_update_embedding(self, memory_id: int, content: str):
        """后台异步计算并更新 embedding，带重试"""
        max_retries = 3
        for attempt in range(1, max_retries + 1):
            try:
                embedding = await asyncio.to_thread(embed_text, content)
                embedding_list = embedding.tolist()[0] if len(embedding.shape) > 1 else embedding.tolist()
                embedding_json = json.dumps(embedding_list)
                await asyncio.to_thread(self._update_embedding_in_db, memory_id, embedding_json)
                return
            except Exception as e:
                logger.warning(f"异步更新 embedding 失败 (id={memory_id}, attempt={attempt}/{max_retries}): {e}")
                if attempt < max_retries:
                    await asyncio.sleep(2.0 * attempt)
        logger.error(f"异步更新 embedding 最终失败 (id={memory_id})，将在下次语义搜索时重试")
    
    def _sync_update_embedding(self, memory_id: int, content: str):
        """同步计算并更新 embedding（无事件循环时的回退方案）"""
        try:
            embedding = embed_text(content)
            embedding_list = embedding.tolist()[0] if len(embedding.shape) > 1 else embedding.tolist()
            embedding_json = json.dumps(embedding_list)
            self._update_embedding_in_db(memory_id, embedding_json)
        except Exception as e:
            logger.warning(f"同步更新 embedding 失败 (id={memory_id}): {e}")
    
    def _update_embedding_in_db(self, memory_id: int, embedding_json: str):
        """将计算好的 embedding 写入数据库（使用独立会话，避免异步任务中请求会话已关闭的问题）"""
        from ..core.database import SessionLocal
        db = SessionLocal()
        try:
            sql = text("""
                UPDATE conversation_memories SET embedding = :embedding WHERE id = :id
            """)
            db.execute(sql, {"embedding": embedding_json, "id": memory_id})
            db.commit()
        except Exception as e:
            db.rollback()
            logger.error(f"更新 embedding 到数据库失败 (id={memory_id}): {e}")
        finally:
            db.close()
    
    def semantic_search(
        self,
        user_id: int,
        query_embedding: List[float],
        limit: int = None,
        min_similarity: float = None,
        session_id: Optional[str] = None,
        branch_ids: Optional[List[str]] = None
    ) -> List[Tuple[MemoryEntry, float]]:
        """
        语义相似度搜索（SQLite版本，在Python中计算相似度）
        
        Returns:
            [(记忆条目, 相似度分数), ...]
        """
        limit = limit or memory_config.MAX_MEMORIES_PER_QUERY
        min_similarity = min_similarity or memory_config.MIN_SIMILARITY
        
        try:
            if session_id and branch_ids:
                sql = text("""
                    SELECT 
                        id, user_id, session_id, branch_id, role, content,
                        importance_score, topics, tokens_count, created_at, embedding
                    FROM conversation_memories
                    WHERE user_id = :user_id AND session_id = :session_id
                        AND (branch_id IN :branch_ids OR branch_id IS NULL)
                        AND embedding IS NOT NULL
                    ORDER BY created_at DESC
                    LIMIT 200
                """).bindparams(bindparam('branch_ids', expanding=True))
                params = {"user_id": user_id, "session_id": session_id, "branch_ids": branch_ids}
            elif session_id:
                sql = text("""
                    SELECT 
                        id, user_id, session_id, branch_id, role, content,
                        importance_score, topics, tokens_count, created_at, embedding
                    FROM conversation_memories
                    WHERE user_id = :user_id AND session_id = :session_id AND embedding IS NOT NULL
                    ORDER BY created_at DESC
                    LIMIT 200
                """)
                params = {"user_id": user_id, "session_id": session_id}
            else:
                sql = text("""
                    SELECT 
                        id, user_id, session_id, branch_id, role, content,
                        importance_score, topics, tokens_count, created_at, embedding
                    FROM conversation_memories
                    WHERE user_id = :user_id AND embedding IS NOT NULL
                    ORDER BY created_at DESC
                    LIMIT 200
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
                            branch_id=row.branch_id,
                            role=row.role,
                            content=row.content,
                            importance_score=row.importance_score,
                            topics=json.loads(row.topics) if row.topics else [],
                            tokens_count=row.tokens_count or 0,
                            created_at=row.created_at,
                            embedding=embedding_list,
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
            self.db.rollback()
            return []
    
    def get_recent(
        self,
        user_id: int,
        session_id: Optional[str] = None,
        limit: int = 10,
        branch_id: Optional[str] = None,
        branch_ids: Optional[List[str]] = None
    ) -> List[MemoryEntry]:
        """获取最近记忆（时间倒序）"""
        try:
            if session_id and branch_ids:
                sql = text("""
                    SELECT
                        id, user_id, session_id, branch_id, role, content,
                        importance_score, topics, tokens_count, created_at
                    FROM conversation_memories
                    WHERE user_id = :user_id AND session_id = :session_id
                        AND (branch_id IN :branch_ids OR branch_id IS NULL)
                    ORDER BY created_at DESC
                    LIMIT :limit
                """).bindparams(bindparam('branch_ids', expanding=True))
                params = {
                    "user_id": user_id,
                    "session_id": session_id,
                    "branch_ids": branch_ids,
                    "limit": limit,
                }
            elif session_id and branch_id:
                sql = text("""
                    SELECT
                        id, user_id, session_id, branch_id, role, content,
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
            elif session_id:
                sql = text("""
                    SELECT
                        id, user_id, session_id, branch_id, role, content,
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
                        id, user_id, session_id, branch_id, role, content,
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
                    branch_id=row.branch_id,
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
            self.db.rollback()
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
            self.db.rollback()
            return None
    
    def update_user_profile(self, profile: UserProfile) -> bool:
        """更新用户画像"""
        try:
            preferences_json = json.dumps(profile.preferences)
            goals_json = json.dumps(profile.goals)
            common_topics_json = json.dumps(profile.common_topics)
            
            params = {
                "user_id": profile.user_id,
                "preferences": preferences_json,
                "goals": goals_json,
                "common_topics": common_topics_json,
                "communication_style": profile.communication_style,
                "summary": profile.summary,
                "total_conversations": profile.total_conversations,
                "total_messages": profile.total_messages
            }

            if self.is_postgres:
                sql = text("""
                    INSERT INTO user_profiles 
                    (user_id, preferences, goals, common_topics, 
                     communication_style, summary, total_conversations, total_messages, updated_at)
                    VALUES (:user_id, :preferences, :goals, :common_topics,
                            :communication_style, :summary, :total_conversations, :total_messages, CURRENT_TIMESTAMP)
                    ON CONFLICT (user_id) DO UPDATE SET
                        preferences = EXCLUDED.preferences,
                        goals = EXCLUDED.goals,
                        common_topics = EXCLUDED.common_topics,
                        communication_style = EXCLUDED.communication_style,
                        summary = EXCLUDED.summary,
                        total_conversations = EXCLUDED.total_conversations,
                        total_messages = EXCLUDED.total_messages,
                        updated_at = CURRENT_TIMESTAMP
                """)
                self.db.execute(sql, params)
            else:
                self.db.execute(text("""
                    INSERT OR IGNORE INTO user_profiles 
                    (user_id, preferences, goals, common_topics, 
                     communication_style, summary, total_conversations, total_messages, updated_at)
                    VALUES (:user_id, :preferences, :goals, :common_topics,
                            :communication_style, :summary, :total_conversations, :total_messages, CURRENT_TIMESTAMP)
                """), params)
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
                self.db.execute(sql, params)
            
            self.db.commit()
            return True
            
        except Exception as e:
            logger.error(f"更新用户画像失败: {e}")
            self.db.rollback()
            return False
