"""[EMB-BACKFILL] NULL 向量自动回填（2026-10-07）。

背景：写入链路对 embedding 失败的记忆行一直按「宁缺勿错」留 NULL——
批量嵌入失败降级逐条 store()、``_async_update_embedding`` 重试 3 次放弃、
维度漂移拒写、TEXT→vector 迁移把维度不符行置 NULL。但所有检索 SQL 一律
``WHERE embedding IS NOT NULL``，这些行正文在库、语义检索却永远看不见。
此前唯一的补救是手工跑 scripts/reembed_all_to_bge_m3.py（那是换嵌入模型
用的，不管日常失败），storage.py 里「下次语义搜索时重试」的注释并无对应
实现——本模块补上这条兜底。

机制：进程启动（main.lifespan）拉起一个 daemon 线程，每
``MEMORY_EMBED_BACKFILL_INTERVAL`` 秒扫一批「行龄超过宽限期」的 NULL 行，
一次批量嵌入后回写。宽限期（默认 300s）是为了不与 store() 的异步首算
竞态——正常路径几秒内就会把新行的向量补上，回填不去抢活、避免双算。

维度契约照旧：回填产出维度 ≠ ``MEMORY_VECTOR_DIMENSION``（嵌入器降级或
配置漂移）→ 拒写，行留 NULL 下轮再试。EmbedderFactory 降级链自身会把
真实维度暴露出来，这里只做最后的写入侧拦截。
"""

import json
import logging
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Dict

import numpy as np
from sqlalchemy import text
from sqlalchemy.orm import Session

from . import storage as storage_mod
from .config import memory_config
from .embedder import embed_text

logger = logging.getLogger("MemoryModule")

_WORKER_STARTED = False
_WORKER_LOCK = threading.Lock()


def _as_utc_naive(dt) -> datetime:
    """统一成 naive UTC 便于比较。

    PG 的 TIMESTAMP 可能回 tz-aware datetime；SQLite 裸 SQL 取回的是**字符串**
    （``YYYY-MM-DD HH:MM:SS.ffffff``）。三种形态都要能算行龄。
    """
    if dt is None:
        return None
    if isinstance(dt, str):
        s = dt.strip().replace("T", " ")
        try:
            dt = datetime.fromisoformat(s)
        except ValueError:
            return None
    if dt.tzinfo is not None:
        return dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def run_backfill_cycle(db: Session, batch_size: int = None,
                       grace_seconds: float = None) -> Dict[str, int]:
    """执行一轮回填（独立可测；本函数自行按批 commit/rollback）。

    Returns:
        {"scanned": 捞到的候选行数, "backfilled": 成功回填行数,
         "dim_skipped": 维度不符拒写行数, "too_fresh": 宽限期内跳过行数}
    """
    stats = {"scanned": 0, "backfilled": 0, "dim_skipped": 0, "too_fresh": 0}
    batch_size = int(batch_size or memory_config.EMBED_BACKFILL_BATCH)
    grace_seconds = float(
        grace_seconds if grace_seconds is not None else memory_config.EMBED_BACKFILL_GRACE_SECONDS
    )

    try:
        # 单列便携 SQL（PG/SQLite 同形）。ORDER BY created_at ASC：最老的先行，
        # 若连最老的都还在宽限期内，说明没有历史欠账，直接收工。
        rows = db.execute(text(
            "SELECT id, content, created_at FROM conversation_memories "
            "WHERE embedding IS NULL ORDER BY created_at ASC LIMIT :lim"
        ), {"lim": int(batch_size)}).fetchall()
    except Exception as e:
        logger.warning("[EMB-BACKFILL] 候选查询失败（本轮放弃）: %s", e)
        db.rollback()
        return stats

    now = datetime.utcnow()
    pending = []  # [(id, content)]
    for row in rows:
        stats["scanned"] += 1
        created = _as_utc_naive(row.created_at)
        if created is not None and (now - created) < timedelta(seconds=grace_seconds):
            stats["too_fresh"] += 1
            continue
        if row.content:
            pending.append((row.id, row.content))

    if not pending:
        return stats

    try:
        embeddings = embed_text([content for _, content in pending])
        if isinstance(embeddings, np.ndarray) and embeddings.ndim == 1:
            embeddings = embeddings.reshape(1, -1)
        if not (isinstance(embeddings, np.ndarray) and embeddings.ndim == 2
                and embeddings.shape[0] >= 1):
            raise ValueError(f"嵌入产出形状异常: {getattr(embeddings, 'shape', type(embeddings))}")
        if embeddings.shape[0] < len(pending):
            # 理论不该发生；截齐防 zip 错位，少写的行留 NULL 下轮再试
            logger.warning(
                "[EMB-BACKFILL] 嵌入返回 %d 行 < 候选 %d 行，只回填前 %d 行",
                embeddings.shape[0], len(pending), embeddings.shape[0],
            )
            pending = pending[:embeddings.shape[0]]
    except Exception as e:
        logger.warning("[EMB-BACKFILL] 批量嵌入失败（本轮放弃，下轮重试）: %s", e)
        db.rollback()
        return stats

    # [DIM-CONTRACT] 嵌入器降级/配置漂移时整批维度都不对——拒写全部并告警，
    # 行留 NULL 等嵌入服务恢复后由下轮补齐。此时嵌入调用已经花了，但
    # 轮询间隔（默认 10 分钟）摊薄了这个浪费。
    first_reason = storage_mod._dim_mismatch_reason(embeddings[0].tolist())
    if first_reason:
        logger.warning(
            "[EMB-BACKFILL] 回填产出维度不符（%s），整批拒写 %d 行（嵌入器疑似降级，宁缺勿错）",
            first_reason, len(pending),
        )
        stats["dim_skipped"] = len(pending)
        db.rollback()
        return stats

    _is_vec = storage_mod._detect_vector_column(db)
    try:
        storage_mod._vector_column_cached = _is_vec
    except Exception:
        pass
    # 配方与 storage._update_embedding_in_db 一致：vector 列显式 CAST，
    # json 文本两种列型都能吃（_parse_vector_cell 读侧兼容）。
    _emb_ph = "CAST(:embedding AS vector)" if _is_vec else ":embedding"

    for (row_id, _content), emb in zip(pending, embeddings):
        emb_list = emb.tolist()
        reason = storage_mod._dim_mismatch_reason(emb_list)
        if reason:
            stats["dim_skipped"] += 1
            continue
        try:
            db.execute(text(
                f"UPDATE conversation_memories SET embedding = {_emb_ph} WHERE id = :id"
            ), {"embedding": json.dumps(emb_list), "id": row_id})
            stats["backfilled"] += 1
        except Exception as e:
            logger.warning("[EMB-BACKFILL] 回写失败 id=%s: %s", row_id, e)
            db.rollback()
            return stats

    try:
        db.commit()
        if stats["backfilled"]:
            logger.info(
                "[EMB-BACKFILL] 本轮回填 %d 行（扫描 %d，维度拒写 %d，宽限期跳过 %d）",
                stats["backfilled"], stats["scanned"], stats["dim_skipped"], stats["too_fresh"],
            )
    except Exception as e:
        logger.warning("[EMB-BACKFILL] 提交失败（本轮放弃）: %s", e)
        db.rollback()
    return stats


def _worker_loop() -> None:
    """回填线程主循环：立即跑一轮，之后按间隔轮询。任何异常不中断循环。"""
    from ..core.database import SessionLocal

    interval = max(float(memory_config.EMBED_BACKFILL_INTERVAL), 5.0)
    while True:
        try:
            db = SessionLocal()
            try:
                run_backfill_cycle(db)
            finally:
                db.close()
        except Exception as e:
            logger.warning("[EMB-BACKFILL] 回填轮异常（继续轮询）: %s", e)
        try:
            time.sleep(interval)
        except Exception:
            return


def start_backfill_worker() -> bool:
    """拉起回填 daemon 线程（幂等）。interval<=0 视为关闭，返回 False。"""
    global _WORKER_STARTED
    interval = float(memory_config.EMBED_BACKFILL_INTERVAL)
    if interval <= 0:
        logger.info("[EMB-BACKFILL] MEMORY_EMBED_BACKFILL_INTERVAL<=0，回填线程未启动")
        return False
    with _WORKER_LOCK:
        if _WORKER_STARTED:
            return True
        _WORKER_STARTED = True
    threading.Thread(
        target=_worker_loop, daemon=True, name="memory-embed-backfill"
    ).start()
    logger.info("[EMB-BACKFILL] NULL 向量回填线程已启动（间隔 %.0fs，批 %d，宽限 %.0fs）",
                interval, memory_config.EMBED_BACKFILL_BATCH,
                memory_config.EMBED_BACKFILL_GRACE_SECONDS)
    return True
