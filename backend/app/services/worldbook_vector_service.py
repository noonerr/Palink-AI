"""WorldBook 向量搜索服务 - 基于 pgvector 的世界书条目向量检索。

复用 memory_module 的嵌入器，将世界书条目（WorldBookStage）内容向量化存入
world_book_entry_vectors 表，并提供 DB 内 cosine 相似度检索。
"""
import hashlib
import logging
import re
from typing import List, Optional, Tuple

import numpy as np
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..memory_module.embedder import embed_text
from ..memory_module.config import memory_config
from ..models.worldbook import WorldBookStage, WorldBookEntryVector

logger = logging.getLogger(__name__)

# P4 (2026-09-29, SPEC §3): provider → 实际嵌入维度对照表（静态声明，不实例化嵌入器）。
# MEMORY_VECTOR_DIMENSION 与 provider 实际维度漂移时，写入/检索全部作废——
# 2026-09-22 实测过 vector(512) vs 配置 1024 的死表（DIM-CONTRACT）。
# 三方口径：ollama+bge-m3=1024（docker-compose）/ fastembed+bge-small-zh-v1.5=512
# （memory_module/config.py 默认）/ SimpleHash 兜底=384（embedder.py）。
# 换嵌入模型必须同步改 MEMORY_VECTOR_DIMENSION 并重测相似度阈值。
_PROVIDER_EXPECTED_DIMS: dict = {
    "ollama": 1024,
    "fastembed": 512,
    "openai": 1536,
}


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

    def _current_embedding_dim(self) -> Optional[int]:
        """读取表中 embedding 列当前声明的维度；表/列不存在返回 None。"""
        try:
            row = self.db.execute(text("""
                SELECT format_type(a.atttypid, a.atttypmod) AS coltype
                FROM pg_attribute a
                WHERE a.attrelid = 'world_book_entry_vectors'::regclass
                  AND a.attname = 'embedding'
                  AND a.attnum > 0 AND NOT a.attisdropped
            """)).first()
        except Exception:
            return None
        if not row or not row.coltype:
            return None
        m = re.search(r"\((\d+)\)", str(row.coltype))
        return int(m.group(1)) if m else None

    def _reconcile_vector_dimension(self, dim: int) -> None:
        """[DIM-CONTRACT] 表已存在但维度与配置不符时自愈。

        ``CREATE TABLE IF NOT EXISTS`` 在维度变更后永不重建，2026-09-22 实测：
        表停留在 ``vector(512)``、配置已 1024，任何写入都报
        ``expected 512 dimensions, not 1024``，而表又永远建不起来。

        本表是 ``world_book_stages`` 的派生缓存（可由条目内容重算），维度不一致
        时存量行本来也无法参与检索（不同维度无法比较），重建是安全的。
        """
        existing = self._current_embedding_dim()
        if existing is None or existing == dim:
            return
        try:
            rows = self.db.execute(
                text("SELECT count(*) FROM world_book_entry_vectors")).scalar() or 0
        except Exception:
            rows = -1
        logger.warning(
            "world_book_entry_vectors 维度 %s ≠ 配置 %s（现有 %s 行），自愈中",
            existing, dim, rows,
        )
        # 索引依赖被改列，先删（后面统一重建）
        self.db.execute(text("DROP INDEX IF EXISTS idx_wbev_embedding"))
        sp = self.db.begin_nested()
        try:
            self.db.execute(text(
                f"ALTER TABLE world_book_entry_vectors "
                f"ALTER COLUMN embedding TYPE vector({dim})"
            ))
            sp.commit()
            logger.warning("world_book_entry_vectors 维度已 ALTER 为 %s", dim)
            return
        except Exception as e:
            sp.rollback()
            logger.warning(
                "ALTER 维度失败（%s），改为整表重建（条目向量可由 stages 重算）",
                str(e).splitlines()[0],
            )
        self.db.execute(text("DROP TABLE IF EXISTS world_book_entry_vectors"))

    def _declared_dim_matches_provider(self) -> bool:
        """P4 (2026-09-29, SPEC §3): 声明维度与 provider 实际维度一致性门禁。

        不一致时拒绝建表/自愈——拒绝即自然降级为关键词召回，不污染、不自毁
        （原来的 ALTER 整表自愈会把已有向量作废重来）。未知 provider 不拦，
        运行时写入/查询侧另有逐向量维度校验兜底。
        """
        provider = memory_config.EMBEDDING_PROVIDER
        expected = _PROVIDER_EXPECTED_DIMS.get(provider)
        if expected is None or expected == memory_config.VECTOR_DIMENSION:
            return True
        logger.error(
            "MEMORY_VECTOR_DIMENSION=%s 与 provider=%s 实际维度 %s 不一致，"
            "拒绝为世界书向量建表/同步/检索（自然降级为关键词召回，不污染）。"
            "请修正 .env / docker-compose 的 MEMORY_VECTOR_DIMENSION 后重启。",
            memory_config.VECTOR_DIMENSION, provider, expected,
        )
        return False

    def ensure_table(self):
        """确保向量表和索引存在（幂等）。"""
        dim = memory_config.VECTOR_DIMENSION
        try:
            if not self._declared_dim_matches_provider():
                # P4: 维度门禁不过 → 拒建。调用方（sync/query）随后的 SQL 会因
                # 表缺失而失败，走各自降级路径（sync error / query degraded）。
                return
            self._reconcile_vector_dimension(dim)
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

    def _write_vector_sql(self, entry_id: str, ch: str, vec_str: str, is_new: bool) -> None:
        """写入/更新一行向量（PG 原生 SQL + 显式 CAST）。

        P5 实弹修正（2026-09-29 e2e 探针发现，SPEC 勘误③）：ORM 模型的
        embedding 列声明为 Text，而生产 PG 表列是 vector(dim)——ORM 语句把
        参数显式绑定成 ``::TEXT``，PG 拒绝 text→vector 隐式转换
        （DatatypeMismatch），sync_worldbook_vectors 在真 PG 上**从未成功
        写入过一行**（此前"写入链路已实测可用"是假象，0 行表佐证）。
        原生 SQL + ``CAST(:v AS vector)`` 与查询侧既有写法对齐；
        SQLite（单测）按方言回退为原样文本绑定——SQLite 会把 CAST 到未知
        类型名按数字亲和性解析，向量字符串会被吞成 0。
        """
        is_pg = self.db.get_bind().dialect.name == "postgresql"
        vec_expr = "CAST(:v AS vector)" if is_pg else ":v"
        if is_new:
            self.db.execute(text(
                f"INSERT INTO world_book_entry_vectors (entry_id, content_hash, embedding) "
                f"VALUES (:e, :c, {vec_expr})"
            ), {"e": entry_id, "c": ch, "v": vec_str})
        else:
            self.db.execute(text(
                f"UPDATE world_book_entry_vectors SET content_hash = :c, "
                f"embedding = {vec_expr}, updated_at = CURRENT_TIMESTAMP "
                f"WHERE entry_id = :e"
            ), {"e": entry_id, "c": ch, "v": vec_str})

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

            # 4. 对变更/新增的条目分块嵌入并 upsert
            #    P2 (2026-09-29, SPEC §3): 32/批——整书一次大批量在 30s
            #    httpx 超时（OLLAMA_TIMEOUT）下必失败；分块后单块失败只回退
            #    该块的单条嵌入，不影响其余块。
            if to_embed:
                _EMBED_BATCH = 32
                for _start in range(0, len(to_embed), _EMBED_BATCH):
                    _chunk = to_embed[_start:_start + _EMBED_BATCH]
                    texts = [item[1] for item in _chunk]
                    try:
                        embeddings = embed_text(texts)
                        if isinstance(embeddings, np.ndarray) and embeddings.ndim == 1:
                            embeddings = embeddings.reshape(1, -1)
                        # P4: 产出维度 ≠ 声明维度 → 整块拒绝（嵌入服务降级或配置漂移，
                        # 宁缺勿错，坏向量写进去就是"存得进召不回"的死数据）
                        if (
                            embeddings.ndim == 2
                            and embeddings.shape[-1] != memory_config.VECTOR_DIMENSION
                        ):
                            raise ValueError(
                                f"嵌入维度 {embeddings.shape[-1]} ≠ 声明维度 "
                                f"{memory_config.VECTOR_DIMENSION}（P4 门禁，整块拒绝）"
                            )
                        for i, (entry_id, _content, ch) in enumerate(_chunk):
                            try:
                                vec = _flatten_embedding(embeddings[i])
                                vec_str = _vector_to_pgstr(vec)
                                # P5: 原生 SQL + 显式 CAST（ORM Text 绑定在真 PG 上必炸）
                                self._write_vector_sql(
                                    entry_id, ch, vec_str,
                                    is_new=entry_id not in existing_map,
                                )
                                synced += 1
                            except Exception as e:
                                logger.warning(f"处理条目 {entry_id} 向量失败: {e}")
                                continue
                    except Exception as e:
                        logger.warning(
                            f"分块嵌入失败（第 {_start}~{_start + len(_chunk)} 条），回退单条: {e}"
                        )
                        for entry_id, content, ch in _chunk:
                            try:
                                vec = _flatten_embedding(embed_text(content))
                                # P4: 单条同样校验维度
                                if len(vec) != memory_config.VECTOR_DIMENSION:
                                    logger.warning(
                                        "条目 %s 嵌入维度 %s ≠ 声明 %s，拒绝写入（P4）",
                                        entry_id, len(vec), memory_config.VECTOR_DIMENSION,
                                    )
                                    continue
                                vec_str = _vector_to_pgstr(vec)
                                # P5: 原生 SQL + 显式 CAST（同上）
                                self._write_vector_sql(
                                    entry_id, ch, vec_str,
                                    is_new=entry_id not in existing_map,
                                )
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
        top_k: int = 3,
        threshold: float = 0.55,
    ) -> Tuple[List[Tuple[str, float]], bool]:
        """向量检索命中的 entry_id 列表。

        P3 (2026-09-29, SPEC §3): 返回 ``(hits, degraded)``。degraded=True 表示
        本轮结果**不可信**（检索异常），调用方应把该书 vectorized 条目回退
        关键词匹配（有关键词时），不得当"真未命中"静默吞掉——否则嵌入服务
        一挂，勾选了向量的设定就"既不关键词也不向量"地消失。空 hits 且
        degraded=False 才是可信的"无命中"。

        Args:
            world_book_id: 世界书 ID
            query_text: 查询文本
            top_k: 返回条数上限（默认对齐 P1 收紧值 3）
            threshold: 相似度阈值（cosine similarity，默认对齐 P1 收紧值 0.55），
                低于此值的不返回

        Returns:
            ([(entry_id, similarity_score), ...] 按 similarity 降序, degraded)
        """
        try:
            self.ensure_table()

            # 1. 嵌入查询文本
            query_emb = embed_text(query_text)
            query_vec = _flatten_embedding(query_emb)
            # P4: 查询向量维度 ≠ 声明维度（嵌入服务降级/配置漂移）→ 降级返回，
            # 调用方（_collect_vector_hits）会按 P3 对该书回退关键词匹配
            if len(query_vec) != memory_config.VECTOR_DIMENSION:
                logger.warning(
                    "worldbook query 嵌入维度 %s ≠ 声明 %s，本轮降级（P3 回退关键词）",
                    len(query_vec), memory_config.VECTOR_DIMENSION,
                )
                return [], True
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
            return [(row.entry_id, float(row.similarity)) for row in result], False
        except Exception as e:
            logger.error(f"世界书向量检索失败: {e}")
            self.db.rollback()
            # P3: 异常 = 降级，而非可信的"无命中"
            return [], True

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
