"""WorldBook 向量搜索服务 - 基于 pgvector 的世界书条目向量检索。

复用 memory_module 的嵌入器，将世界书条目（WorldBookStage）内容向量化存入
world_book_entry_vectors 表，并提供 DB 内 cosine 相似度检索。
"""
import hashlib
import logging
from typing import List, Tuple

import numpy as np
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..memory_module.embedder import embed_text
from ..memory_module.config import memory_config
from ..models.worldbook import WorldBookStage, WorldBookEntryVector

logger = logging.getLogger(__name__)


def _content_hash(content: str) -> str:
    """计算内容的 blake2b 哈希（64 位十六进制）用于脏检查。"""
    return hashlib.blake2b(content.encode("utf-8"), digest_size=32).hexdigest()


def _vector_to_pgstr(vec) -> str:
    """将向量转换为 pgvector 接受的字符串格式 '[1.0,2.0,...]'。"""
    if isinstance(vec, np.ndarray):
        if vec.ndim > 1:
            vec = vec[0]
        vec = vec.tolist()
    return "[" + ",".join(str(float(x)) for x in vec) + "]"


def _flatten_embedding(emb) -> List[float]:
    """将 embed_text 返回的 ndarray 规整为一维 list。"""
    if isinstance(emb, np.ndarray):
        if emb.ndim > 1:
            emb = emb[0]
        return emb.tolist()
    # 兼容已经是 list 的情况
    if emb and isinstance(emb[0], (list, tuple)):
        return list(emb[0])
    return list(emb)


class WorldBookVectorService:
    """世界书条目向量同步与检索服务。"""

    def __init__(self, db: Session):
        self.db = db

    def ensure_table(self):
        """确保向量表和索引存在（幂等）。"""
        dim = memory_config.VECTOR_DIMENSION
        try:
            self.db.execute(text(f"""
                CREATE TABLE IF NOT EXISTS world_book_entry_vectors (
                    id SERIAL PRIMARY KEY,
                    entry_id TEXT NOT NULL REFERENCES world_book_stages(id) ON DELETE CASCADE,
                    content_hash VARCHAR(64) NOT NULL,
                    embedding vector({dim}),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """))
            self.db.execute(text("""
                CREATE INDEX IF NOT EXISTS idx_wbev_entry_id
                ON world_book_entry_vectors(entry_id)
            """))
            # ivfflat 索引：空表建索引仅告警不报错；表有数据后需 ANALYZE 才能命中。
            try:
                self.db.execute(text("""
                    CREATE INDEX IF NOT EXISTS idx_wbev_embedding
                    ON world_book_entry_vectors
                    USING ivfflat (embedding vector_cosine_ops)
                    WITH (lists=100)
                """))
            except Exception as e:
                logger.warning(f"创建 ivfflat 索引失败（可能为空表或已存在）: {e}")
            self.db.commit()
        except Exception as e:
            logger.error(f"初始化世界书向量表失败: {e}")
            self.db.rollback()
            raise

    def sync_worldbook_vectors(self, world_book_id: str) -> dict:
        """全量同步世界书的 vectorized 条目向量。

        Returns:
            {"synced": N, "skipped": M, "deleted": K}
        """
        synced = 0
        skipped = 0
        deleted = 0
        try:
            self.ensure_table()

            # 1. 查询该 world_book 下所有 vectorized=True 的 stages
            stages = self.db.query(WorldBookStage).filter(
                WorldBookStage.world_book_id == world_book_id,
                WorldBookStage.vectorized.is_(True),
            ).all()

            vectorized_entry_ids = {s.id for s in stages}

            # 2. 查询已存的向量记录，建立 entry_id -> record 映射
            existing_map = {}
            if vectorized_entry_ids:
                existing_vectors = self.db.query(WorldBookEntryVector).filter(
                    WorldBookEntryVector.entry_id.in_(vectorized_entry_ids)
                ).all()
                existing_map = {v.entry_id: v for v in existing_vectors}

            # 3. 计算每条内容的 blake2b 哈希，识别需要更新的条目
            to_embed = []  # [(entry_id, content, content_hash), ...]
            for stage in stages:
                content = stage.content or ""
                ch = _content_hash(content)
                existing = existing_map.get(stage.id)
                if existing and existing.content_hash == ch:
                    skipped += 1
                    continue
                to_embed.append((stage.id, content, ch))

            # 4. 对变更/新增的条目批量嵌入并 upsert
            if to_embed:
                texts = [item[1] for item in to_embed]
                try:
                    embeddings = embed_text(texts)
                    if isinstance(embeddings, np.ndarray) and embeddings.ndim == 1:
                        embeddings = embeddings.reshape(1, -1)
                    for i, (entry_id, _content, ch) in enumerate(to_embed):
                        try:
                            vec = _flatten_embedding(embeddings[i])
                            vec_str = _vector_to_pgstr(vec)
                            existing = existing_map.get(entry_id)
                            if existing:
                                existing.content_hash = ch
                                existing.embedding = vec_str
                            else:
                                self.db.add(WorldBookEntryVector(
                                    entry_id=entry_id,
                                    content_hash=ch,
                                    embedding=vec_str,
                                ))
                            synced += 1
                        except Exception as e:
                            logger.warning(f"处理条目 {entry_id} 向量失败: {e}")
                            continue
                except Exception as e:
                    logger.warning(f"批量嵌入失败，回退到单条嵌入: {e}")
                    for entry_id, content, ch in to_embed:
                        try:
                            vec = _flatten_embedding(embed_text(content))
                            vec_str = _vector_to_pgstr(vec)
                            existing = existing_map.get(entry_id)
                            if existing:
                                existing.content_hash = ch
                                existing.embedding = vec_str
                            else:
                                self.db.add(WorldBookEntryVector(
                                    entry_id=entry_id,
                                    content_hash=ch,
                                    embedding=vec_str,
                                ))
                            synced += 1
                        except Exception as e2:
                            logger.warning(f"单条嵌入条目 {entry_id} 失败: {e2}")
                            continue

            # 6. 删除不再 vectorized 的条目的向量记录
            all_stages = self.db.query(WorldBookStage).filter(
                WorldBookStage.world_book_id == world_book_id
            ).all()
            non_vectorized_ids = {s.id for s in all_stages if not s.vectorized}
            if non_vectorized_ids:
                deleted_count = self.db.query(WorldBookEntryVector).filter(
                    WorldBookEntryVector.entry_id.in_(non_vectorized_ids)
                ).delete(synchronize_session=False)
                deleted = deleted_count or 0

            self.db.commit()
            return {"synced": synced, "skipped": skipped, "deleted": deleted}
        except Exception as e:
            logger.error(f"同步世界书向量失败: {e}")
            self.db.rollback()
            return {"synced": synced, "skipped": skipped, "deleted": deleted, "error": str(e)}

    def query_entries(
        self,
        world_book_id: str,
        query_text: str,
        top_k: int = 5,
        threshold: float = 0.25,
    ) -> List[Tuple[str, float]]:
        """向量检索命中的 entry_id 列表。

        Args:
            world_book_id: 世界书 ID
            query_text: 查询文本
            top_k: 返回条数上限
            threshold: 相似度阈值（cosine similarity），低于此值的不返回

        Returns:
            [(entry_id, similarity_score), ...] 按 similarity 降序
        """
        try:
            self.ensure_table()

            # 1. 嵌入查询文本
            query_emb = embed_text(query_text)
            query_vec = _flatten_embedding(query_emb)
            query_vec_str = _vector_to_pgstr(query_vec)

            # 2. 用 pgvector 的 <=> 算子在 DB 内做 cosine 距离查询
            #    cosine_similarity = 1 - cosine_distance
            sql = text("""
                SELECT wev.entry_id,
                       1 - (wev.embedding <=> CAST(:query_vec AS vector)) AS similarity
                FROM world_book_entry_vectors wev
                JOIN world_book_stages ws ON ws.id = wev.entry_id
                WHERE ws.world_book_id = :world_book_id
                  AND wev.embedding IS NOT NULL
                  AND 1 - (wev.embedding <=> CAST(:query_vec AS vector)) >= :threshold
                ORDER BY wev.embedding <=> CAST(:query_vec AS vector)
                LIMIT :top_k
            """)
            result = self.db.execute(sql, {
                "query_vec": query_vec_str,
                "world_book_id": world_book_id,
                "threshold": threshold,
                "top_k": top_k,
            })
            return [(row.entry_id, float(row.similarity)) for row in result]
        except Exception as e:
            logger.error(f"世界书向量检索失败: {e}")
            self.db.rollback()
            return []

    def delete_vectors(self, world_book_id: str) -> int:
        """清空世界书的所有向量。"""
        try:
            self.ensure_table()
            sql = text("""
                DELETE FROM world_book_entry_vectors
                WHERE entry_id IN (
                    SELECT id FROM world_book_stages WHERE world_book_id = :world_book_id
                )
            """)
            result = self.db.execute(sql, {"world_book_id": world_book_id})
            self.db.commit()
            return result.rowcount or 0
        except Exception as e:
            logger.error(f"删除世界书向量失败: {e}")
            self.db.rollback()
            return 0
