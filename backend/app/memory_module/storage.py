"""
存储层封装
支持 SQLite + 本地向量计算 或 PostgreSQL + pgvector
"""

from typing import List, Optional, Tuple, Dict, Any, Set
from sqlalchemy.orm import Session
from sqlalchemy import text, desc, bindparam
from datetime import datetime, timedelta
import numpy as np
import asyncio
import hashlib
import logging
import json
import re
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


# ── [HYBRID-KW 2026-10-09] 关键词路 ─────────────────────────────────────────
# 为什么需要第二条路：向量路对"专有名词/数字/动作细节"这类**字面锚点**不敏感。
# 实测（p46/p47，同一会话 227 条记忆、48 道题 + 48 道同义改写题）：
#   纯向量 top1 22.9%（改写题 20.8%）；加关键词路后 41.7%（改写题 33.3%）。
# 实现分两级：SQL 侧用 pg_trgm 的 similarity() 做**粗筛**（实测 8.9ms/次，取
# top-50 时 gold 有 86% 落在粗筛集内），Python 侧再用字符二元组覆盖率**精排**。
# 不做全库 Python 扫描：那在生产行数上不可接受；粗筛漏掉的极端个案由向量路兜底。

_RE_NONWORD = re.compile(r"[\s\W_]+", re.UNICODE)
# 粗筛 SQL 会全表算 trigram 距离；超过此行数直接放弃关键词路（退化为纯向量，
# 与本模块一贯的"宁缺勿错、降级要留痕"一致）
_KW_SCAN_CAP = 20000
# 送进 similarity() 的查询文本上限（超长查询只会拖慢，不会更准）
_KW_QUERY_MAX_CHARS = 500


def _bigram_set(text: str) -> Set[str]:
    """字符二元组集合（剔除空白/标点）。

    CJK 无空格分词边界，二元组是最小的可用字面单元：既能匹配"翅膀/尾巴"这类
    实词，也不会像单词匹配那样被一个标点打断。单字查询退化为一元组，空串返回
    空集（调用方据此跳过整条路）。
    """
    t = _RE_NONWORD.sub("", str(text or ""))
    if not t:
        return set()
    if len(t) == 1:
        return {t}
    return {t[i:i + 2] for i in range(len(t) - 1)}


def _detect_pg_trgm(db) -> bool:
    """[HYBRID-KW] 探测 pg_trgm 扩展是否可用（只读 pg_extension，进程级缓存一次）。

    判假时关键词路整条关闭 —— 不是报错，而是**静默退回纯向量**并在日志留一行。
    理由同 _detect_vector_column：探测失败让检索变成 500 是最差结果。
    """
    try:
        if getattr(getattr(db.get_bind(), "dialect", None), "name", "") != "postgresql":
            return False
        row = db.execute(
            text("SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'")
        ).fetchone()
    except Exception:
        return False
    return bool(row)


def _dim_mismatch_reason(emb_list) -> Optional[str]:
    """[DIM-CONTRACT] 校验向量维度是否符合语料契约。

    契约维度取 ``memory_config.VECTOR_DIMENSION``（bge-m3 = 1024）。嵌入器降级到
    fastembed(512) / SimpleHash(384) 时产出维度与存量语料不同空间，写入后
    ``np.dot`` 必然抛 ValueError 并在检索时被逐行静默丢弃——历史上正是这样产出
    "存得进召不回"的死向量。此处拦截，宁缺勿错。
    """
    try:
        baseline = int(memory_config.VECTOR_DIMENSION)
        actual = len(emb_list) if emb_list is not None else -1
    except (TypeError, ValueError):
        return None
    if baseline <= 0 or actual < 0 or actual == baseline:
        return None
    return f"维度 {actual} ≠ 契约 {baseline}"


_VECTOR_COLUMN_SQL = """
    SELECT format_type(a.atttypid, a.atttypmod) AS type_text
    FROM pg_attribute a
    JOIN pg_class r ON r.oid = a.attrelid
    WHERE r.relname = 'conversation_memories'
      AND a.attname = 'embedding' AND a.attnum > 0
"""


def _detect_vector_column(db) -> bool:
    """[VEC-PG] embedding 列当前是否真是 pgvector ``vector(N)``。

    只读探测（pg_attribute），任何异常都按 False 处理 —— 判假时调用方退回
    Python 余弦路径，行为与迁移前一致；判真才允许走 ``<=>``。
    反过来（列还是 TEXT 却按 vector 写 SQL）会让 ``<=>`` 抛错、被 except 吞掉
    ⇒ 返回空 ⇒ 复现"明明有记忆却召回 0"这种最难查的静默失效。
    """
    try:
        # 先看方言再看列：SQLite 上没有 pg_attribute，让异常当控制流会把会话
        # 推进"需要回滚"的状态，探测函数不该有这种副作用。
        if getattr(getattr(db.get_bind(), "dialect", None), "name", "") != "postgresql":
            return False
        row = db.execute(text(_VECTOR_COLUMN_SQL)).fetchone()
    except Exception:
        # 探测语句无副作用；同连接可能有在途事务，此处不 rollback
        return False
    return bool(row and str(row[0] or "").startswith("vector("))


def _parse_vector_cell(raw) -> Optional[List[float]]:
    """[VEC-PG] 解析 embedding 单元格为浮点列表，兼容三种历史形态。

    - pgvector ``vector`` 列经 psycopg2 取回的是**文本** ``"[0.1,0.2]"``，
      这个形态恰好是合法 JSON ⇒ ``json.loads`` 直接可用（迁移后主路径）。
    - SQLite / 迁移前的 TEXT 列存的是 ``json.dumps`` 结果，同上。
    - 兜底分支处理 pgvector 可能输出的 ``.1`` / ``nan`` 这类非法 JSON 写法。

    解析失败返回 None，由调用方按"宁缺勿错"跳过该行——与旧实现的
    per-row try/except 语义一致：一条脏向量不得炸掉整批检索。
    """
    if raw is None:
        return None
    if isinstance(raw, (list, tuple)):
        return [float(x) for x in raw]
    s = str(raw).strip()
    if not s:
        return None
    try:
        parsed = json.loads(s)
    except Exception:
        try:
            return [float(x) for x in s.strip("()[]{}").split(",") if x.strip()]
        except Exception:
            return None
    if not isinstance(parsed, list):
        return None
    try:
        return [float(x) for x in parsed]
    except (TypeError, ValueError):
        return None


def _vector_to_pgstr(emb_list) -> str:
    """列表 → pgvector 字面量 ``[v1,v2,...]``（与 worldbook_vector_service 同配方）。"""
    return "[" + ",".join(repr(float(v)) for v in emb_list) + "]"


def _resolve_search_scope(
    session_id: Optional[str], character_id: Optional[str]
) -> str:
    """[T-跨卡串味修复 2026-10-03] 判定本次召回的实际作用域。

    返回 "session" / "character" / "user"：
    - ``session``   有 session_id → 现有行为，最窄，零风险。
    - ``character`` 无 session_id 但有 character_id → 按 user+character 过滤，
      这正是修复前退化成用户级全量召回（跨角色串味）的场景。
    - ``user``      两者都无 → **降级**，用户级全量召回，串味风险面。
      调用方须能从 ContextResponse.scope 看出自己落在这一档。
    """
    if session_id:
        return "session"
    if character_id:
        return "character"
    return "user"


def _warn_if_unscoped_write(
    session_id: Optional[str], character_id: Optional[str], role: str
) -> None:
    """[T-跨卡串味修复 2026-10-03] 写入侧防御：两个维度都空的记忆行告警。

    session_id 与 character_id 同空的行，在 session_id 传空的检索分支里
    与任何用户级召回都不可区分——存量脏数据正是这样悄悄积累的。
    写入不阻断（普通聊天 / ST 向量集合本就没有角色维度，属合法形态），
    但必须留痕，否则出问题无从排查。
    """
    if session_id or character_id:
        return
    logger.warning(
        "[MEM-SCOPE] 写入的记忆缺少 session_id 与 character_id，"
        "该行在用户级召回（scope=user）中与所有角色互通（role=%s）",
        role,
    )


def _delete_memories_in(db_session: Session, column: str, values) -> int:
    """[ORPHAN-MEM-FIX] 按列批量删除向量记忆。

    ``conversation_memories.session_id/branch_id`` 都是裸 TEXT 无外键，
    会话/分支/角色被删时不会级联——不手动清就成为孤儿：永不召回、
    持续占存储、且是隐私残留（2026-09-22 实测 102 条里 93 条是孤儿）。
    """
    ids = [str(v) for v in (values or []) if v]
    if not ids:
        return 0
    placeholders = ", ".join(f":v{i}" for i in range(len(ids)))
    params = {f"v{i}": v for i, v in enumerate(ids)}
    try:
        res = db_session.execute(
            text(f"DELETE FROM conversation_memories WHERE {column} IN ({placeholders})"),
            params,
        )
        return int(res.rowcount or 0)
    except Exception as e:
        logger.error("清理孤儿记忆失败 (%s): %s", column, e)
        return 0


def delete_memories_by_session(db_session: Session, session_ids) -> int:
    """删除指定会话的全部向量记忆。返回删除行数。"""
    return _delete_memories_in(db_session, "session_id", session_ids)


def delete_memories_by_branch(db_session: Session, branch_ids) -> int:
    """删除指定分支的全部向量记忆。返回删除行数。"""
    return _delete_memories_in(db_session, "branch_id", branch_ids)


def delete_by_message_id(db_session: Session, session_id: str, message_id: int) -> None:
    """[MEM-UPSERT] 删除指定消息的全部记忆行（记忆 = 消息当前内容的镜像）。

    统一先删半步：写入侧 upsert、编辑钩子 [MEM-SYNC-ON-EDIT]、单条消息
    删除级联共用；仅在 message_id 非 None 时由调用方触发，与本路径后续
    写入/提交共享同一连接同一事务。
    """
    db_session.execute(
        text("DELETE FROM conversation_memories WHERE session_id = :s AND message_id = :m"),
        {"s": session_id, "m": message_id},
    )


_tables_initialized = False
_is_postgres_cached = None
# [VEC-PG] embedding 列是否已是 pgvector vector(N)（None=未探测）。
# 与 is_postgres 同为进程级缓存：列类型只在迁移/运维手里变，不会每次查询都变。
_vector_column_cached: Optional[bool] = None
# [HYBRID-KW] pg_trgm 扩展是否可用（None=未探测）。同列类型，进程级缓存一次。
_trgm_cached: Optional[bool] = None
_migration_done = False
_storage_lock = threading.Lock()

class MemoryStorage:
    """记忆存储类 - 操作数据库"""
    
    def __init__(self, db_session: Session):
        global _tables_initialized, _is_postgres_cached, _migration_done
        self.db = db_session
        # [T-跨卡串味修复] 本次 semantic_search 实际生效的召回作用域
        # （"session"/"character"/"user"），供 retriever 回填
        # ContextResponse.scope。默认 "session" = 既有最窄行为。
        self.last_search_scope: str = "session"
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
            # 探测查询是本会话第一条语句、无副作用，静默视为 SQLite；
            # 此处不可 rollback——同连接上可能承载其他会话的在途数据。
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
            
            self._migrate_tables()
            _migration_done = True
            # 索引必须在迁移之后创建：idx_memory_message_id 依赖迁移新增的列
            self._create_indexes()

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
                character_id TEXT,
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
        # [VEC-PG] embedding 建为 pgvector 的 vector(dim) 列，维度取运行时契约值
        # （memory_config.VECTOR_DIMENSION，docker-compose 口径 = 1024/bge-m3）。
        # 列级维度约束顺带堵死 DIM-CONTRACT 那类"存得进召不回"的死向量：
        # 维度不符的行在 INSERT 阶段就被 PG 拒绝，而不是等到检索时静默丢弃。
        _dim = int(memory_config.VECTOR_DIMENSION)
        self.db.execute(text(f"""
            CREATE EXTENSION IF NOT EXISTS vector
        """))
        self.db.execute(text(f"""
            CREATE TABLE IF NOT EXISTS conversation_memories (
                id SERIAL PRIMARY KEY,
                user_id INTEGER,
                session_id TEXT,
                branch_id TEXT,
                character_id TEXT,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                content_summary TEXT,
                embedding vector({_dim}),
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
    
    def _embedding_column_is_vector(self) -> bool:
        """[VEC-PG] 实例侧包装：非 PostgreSQL 恒 False，PostgreSQL 走进程级缓存探测。"""
        global _vector_column_cached
        if not self.is_postgres:
            return False
        with _storage_lock:
            if _vector_column_cached is None:
                _vector_column_cached = _detect_vector_column(self.db)
            return _vector_column_cached

    def _pg_trgm_available(self) -> bool:
        """[HYBRID-KW] 实例侧包装：非 PostgreSQL 恒 False，PostgreSQL 走进程级缓存探测。"""
        global _trgm_cached
        if not self.is_postgres:
            return False
        with _storage_lock:
            if _trgm_cached is None:
                _trgm_cached = _detect_pg_trgm(self.db)
                if not _trgm_cached:
                    logger.warning(
                        "[HYBRID-KW] 未检测到 pg_trgm 扩展，关键词路永久关闭，"
                        "记忆检索退化为纯向量（CREATE EXTENSION pg_trgm 可恢复）"
                    )
            return _trgm_cached

    def _migrate_embedding_column(self) -> None:
        """[VEC-PG] 把历史 TEXT / float[] 形态的 embedding 列转成 vector(dim)，幂等。

        **为什么必须走运行时通道，而不只写 alembic 修订**：生产 compose 里
        ``RUN_MIGRATIONS_ON_STARTUP=false``（``docker-compose.yml:169`` +
        ``app/core/config.py:48``），启动时 alembic **不执行**；0067 那批列能落库，
        靠的就是本文件 ``_migrate_tables`` 这条运行时通道。alembic 0069 只负责
        把变更记进 schema 历史。

        转换前先清理：元素个数 ≠ dim 的行置 NULL。一条降级期写入的 512 维向量
        不该阻塞全库 ALTER（CAST 失败会让整条迁移回滚），按宁缺勿错丢向量不丢正文。
        逗号计数对 ``json.dumps`` 产出的纯数字数组成立（浮点字面量里不含逗号）。
        """
        global _vector_column_cached
        dim = int(memory_config.VECTOR_DIMENSION)
        if dim <= 0:
            logger.warning("[VEC-PG] MEMORY_VECTOR_DIMENSION=%s 非法，跳过列迁移", dim)
            return
        try:
            nested = self.db.begin_nested()
            row = self.db.execute(text(_VECTOR_COLUMN_SQL)).fetchone()
            if row is None:
                nested.commit()
                return
            type_text = str(row[0] or "")
            if type_text.startswith("vector("):
                if type_text != f"vector({dim})":
                    # 列维度与当前契约不符 = 换了嵌入模型。这里**绝不自动重打字**：
                    # 那会把整列存量向量作废。回填是
                    # scripts/reembed_all_to_bge_m3.py 的活，显式告警而不是静默跑偏。
                    logger.warning(
                        "[VEC-PG] embedding 列维度 %s ≠ 配置 %s：存量向量与当前嵌入器"
                        "不在同一空间，检索结果不可信。请跑 "
                        "scripts/reembed_all_to_bge_m3.py 重嵌后再用。",
                        type_text, dim,
                    )
                nested.commit()
                _vector_column_cached = True
                return

            cleaned = self.db.execute(text(
                f"""
                UPDATE conversation_memories
                SET embedding = NULL
                WHERE embedding IS NOT NULL
                  AND (length(embedding) - length(replace(embedding, ',', ''))) + 1 <> {dim}
                """
            )).rowcount
            self.db.execute(text(
                f"ALTER TABLE conversation_memories "
                f"ALTER COLUMN embedding TYPE vector({dim}) "
                f"USING embedding::vector({dim})"
            ))
            nested.commit()
            _vector_column_cached = True
            logger.info(
                "[VEC-PG] embedding 列 %s → vector(%d) 完成（维度不符已置 NULL %d 行）",
                type_text or "?", dim, int(cleaned or 0),
            )
        except Exception as exc:
            try:
                nested.rollback()
            except Exception:
                pass
            _vector_column_cached = False
            logger.error(
                "[VEC-PG] embedding 列转 vector 失败（本轮检索自动退回 Python 余弦路径）: %s",
                exc,
            )

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
            try:
                nested = self.db.begin_nested()
                # [MEM-UPSERT] 消息主键关联列：记忆 = 消息当前内容的镜像
                self.db.execute(text("""
                    ALTER TABLE conversation_memories ADD COLUMN IF NOT EXISTS message_id INTEGER
                """))
                nested.commit()
                logger.info("迁移: 添加 message_id 列")
            except Exception:
                nested.rollback()
            try:
                nested = self.db.begin_nested()
                # [T-跨卡串味修复 2026-10-03] 角色维度列（alembic 0067）。
                # 记忆表原先不记角色，session_id 传空即退化成用户级全量召回。
                self.db.execute(text("""
                    ALTER TABLE conversation_memories ADD COLUMN IF NOT EXISTS character_id TEXT
                """))
                nested.commit()
                logger.info("迁移: 添加 character_id 列")
            except Exception:
                nested.rollback()
            # [VEC-PG] TEXT → vector(dim)。放在列添加之后：新列走的是建表即 vector 的路径
            self._migrate_embedding_column()
        else:
            # SQLite 无 ADD COLUMN IF NOT EXISTS：先查 table_info 判列存在，
            # 仅缺列时执行 ALTER（避免异常吞咽路径上的 rollback 波及同连接在途数据）
            try:
                cols = [r[1] for r in self.db.execute(text(
                    "PRAGMA table_info(conversation_memories)"))]
                if "branch_id" not in cols:
                    self.db.execute(text(
                        "ALTER TABLE conversation_memories ADD COLUMN branch_id TEXT"))
                    logger.info("迁移: 添加 branch_id 列")
                if "message_id" not in cols:
                    # [MEM-UPSERT] 消息主键关联列：记忆 = 消息当前内容的镜像
                    self.db.execute(text(
                        "ALTER TABLE conversation_memories ADD COLUMN message_id INTEGER"))
                    logger.info("迁移: 添加 message_id 列")
                if "character_id" not in cols:
                    # [T-跨卡串味修复 2026-10-03] 角色维度列（alembic 0067）
                    self.db.execute(text(
                        "ALTER TABLE conversation_memories ADD COLUMN character_id TEXT"))
                    logger.info("迁移: 添加 character_id 列")
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
            CREATE INDEX IF NOT EXISTS idx_memory_message_id ON conversation_memories(message_id)
        """))
        self.db.execute(text("""
            CREATE INDEX IF NOT EXISTS idx_profile_user_id ON user_profiles(user_id)
        """))
        self.db.execute(text("""
            CREATE INDEX IF NOT EXISTS idx_memory_user_session ON conversation_memories(user_id, session_id)
        """))
        # [T-跨卡串味修复 2026-10-03] 角色维度复合索引，与会话表
        # idx_ccs_character_user 同序同构 (character_id, user_id)：
        # 覆盖检索侧分支3 的 user_id + character_id 过滤。
        self.db.execute(text("""
            CREATE INDEX IF NOT EXISTS idx_memory_character_user
            ON conversation_memories(character_id, user_id)
        """))
    
    def store(
        self,
        user_id: int,
        session_id: str,
        role: str,
        content: str,
        importance_score: float = 0.5,
        topics: List[str] = None,
        branch_id: Optional[str] = None,
        message_id: Optional[int] = None,
        character_id: Optional[str] = None,
    ) -> Optional[int]:
        """
        存储单条记忆（先存储 content，embedding 置 NULL，后台异步计算）

        Args:
            character_id: [T-跨卡串味修复] 角色维度；None = 无角色归属
                （普通聊天 / ST 向量集合 / 存量兼容路径），行为不变。

        Returns:
            memory_id: 记忆ID，失败返回 None
        """
        if len(content) > 10000:
            raise ValueError("Content too long")
        _warn_if_unscoped_write(session_id, character_id, role)
        try:
            tokens_count = len(content) // 2
            topics_json = json.dumps(topics or [])

            if self.is_postgres:
                sql = text("""
                    INSERT INTO conversation_memories
                    (user_id, session_id, branch_id, character_id, role, content, embedding,
                     importance_score, topics, tokens_count, created_at, message_id)
                    VALUES (:user_id, :session_id, :branch_id, :character_id, :role, :content, NULL,
                            :importance_score, :topics, :tokens_count, CURRENT_TIMESTAMP, :message_id)
                    RETURNING id
                """)

                result = self.db.execute(sql, {
                    "user_id": user_id,
                    "session_id": session_id,
                    "branch_id": branch_id,
                    "character_id": character_id,
                    "role": role,
                    "content": content,
                    "importance_score": importance_score,
                    "topics": topics_json,
                    "tokens_count": tokens_count,
                    "message_id": message_id
                })

                memory_id = result.scalar()
            else:
                sql = text("""
                    INSERT INTO conversation_memories
                    (user_id, session_id, branch_id, character_id, role, content, embedding,
                     importance_score, topics, tokens_count, created_at, message_id)
                    VALUES (:user_id, :session_id, :branch_id, :character_id, :role, :content, NULL,
                            :importance_score, :topics, :tokens_count, CURRENT_TIMESTAMP, :message_id)
                """)

                result = self.db.execute(sql, {
                    "user_id": user_id,
                    "session_id": session_id,
                    "branch_id": branch_id,
                    "character_id": character_id,
                    "role": role,
                    "content": content,
                    "importance_score": importance_score,
                    "topics": topics_json,
                    "tokens_count": tokens_count,
                    "message_id": message_id
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
        message_id: Optional[int] = None,
        character_id: Optional[str] = None,
    ) -> List[int]:
        """批量存储语义块（方案 B）：一次批量嵌入 + 单事务插入，embedding 直写。

        同一 turn 的多块共享同一 message_id（[MEM-UPSERT] 编辑时一删全删）。

        Args:
            character_id: [T-跨卡串味修复] 角色维度，随每块一起写入。

        Returns:
            各块 memory_id 列表（顺序与 chunks 一致）；整体失败返回 []
        """
        if not chunks:
            return []
        _warn_if_unscoped_write(session_id, character_id, role)
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
                    message_id=message_id,
                    character_id=character_id,
                )
                if mid is not None:
                    ids.append(mid)
            return ids

        try:
            ids: List[int] = []
            # [VEC-PG] 列是 vector(N) 时显式 CAST：SQLAlchemy 会把 str 参数按 text
            # 送过去，而 "text 不能隐式转 vector"，不 CAST 直接 DatatypeMismatch。
            # 配方与 worldbook_vector_service 一致。
            _emb_ph = (
                "CAST(:embedding AS vector)"
                if self._embedding_column_is_vector() else ":embedding"
            )
            for i, chunk in enumerate(chunks):
                emb_list = embeddings[i].tolist()
                # [DIM-CONTRACT] 维度不符契约 → 宁缺勿错：embedding 留 NULL，
                # 正文行照常入库（不丢内容），后续用
                # scripts/reembed_all_to_bge_m3.py 回填。降级期不写坏向量。
                _mm = _dim_mismatch_reason(emb_list)
                if _mm:
                    logger.warning("store_chunks 跳过向量写入（%s，%s）", _mm, session_id)
                    emb_json = None
                else:
                    emb_json = json.dumps(emb_list)
                topics_json = json.dumps(_chunk_topics(turn_hash, i, total))
                sql = text(f"""
                    INSERT INTO conversation_memories
                    (user_id, session_id, branch_id, character_id, role, content, embedding,
                     importance_score, topics, tokens_count, created_at, message_id)
                    VALUES (:user_id, :session_id, :branch_id, :character_id, :role, :content, {_emb_ph},
                            :importance_score, :topics, :tokens_count, CURRENT_TIMESTAMP, :message_id)
                """)
                params = {
                    "user_id": user_id,
                    "session_id": session_id,
                    "branch_id": branch_id,
                    "character_id": character_id,
                    "role": role,
                    "content": chunk,
                    "embedding": emb_json,
                    "importance_score": importance_score,
                    "topics": topics_json,
                    "tokens_count": len(chunk) // 2,
                    "message_id": message_id,
                }
                if self.is_postgres:
                    sql = text(f"""
                        INSERT INTO conversation_memories
                        (user_id, session_id, branch_id, character_id, role, content, embedding,
                         importance_score, topics, tokens_count, created_at, message_id)
                        VALUES (:user_id, :session_id, :branch_id, :character_id, :role, :content, {_emb_ph},
                                :importance_score, :topics, :tokens_count, CURRENT_TIMESTAMP, :message_id)
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
                emb_list = _parse_vector_cell(row.embedding)
                out.append(MemoryEntry(
                    id=row.id,
                    user_id=row.user_id,
                    session_id=row.session_id,
                    branch_id=row.branch_id,
                    message_id=getattr(row, "message_id", None),
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
                # [DIM-CONTRACT] 降级期维度不符 → 不写坏向量，保留 NULL 待回填
                _mm = _dim_mismatch_reason(embedding_list)
                if _mm:
                    logger.warning("异步 embedding 跳过写入 id=%s（%s）", memory_id, _mm)
                    return
                embedding_json = json.dumps(embedding_list)
                await asyncio.to_thread(self._update_embedding_in_db, memory_id, embedding_json)
                return
            except Exception as e:
                logger.warning(f"异步更新 embedding 失败 (id={memory_id}, attempt={attempt}/{max_retries}): {e}")
                if attempt < max_retries:
                    await asyncio.sleep(2.0 * attempt)
        logger.error(f"异步更新 embedding 最终失败 (id={memory_id})，行留 NULL，"
                     f"由 [EMB-BACKFILL] 回填线程（memory_module/backfill.py）按轮补算")
    
    def _sync_update_embedding(self, memory_id: int, content: str):
        """同步计算并更新 embedding（无事件循环时的回退方案）"""
        try:
            embedding = embed_text(content)
            embedding_list = embedding.tolist()[0] if len(embedding.shape) > 1 else embedding.tolist()
            # [DIM-CONTRACT] 同上：降级期不写坏向量
            _mm = _dim_mismatch_reason(embedding_list)
            if _mm:
                logger.warning("同步 embedding 跳过写入 id=%s（%s）", memory_id, _mm)
                return
            embedding_json = json.dumps(embedding_list)
            self._update_embedding_in_db(memory_id, embedding_json)
        except Exception as e:
            logger.warning(f"同步更新 embedding 失败 (id={memory_id}): {e}")
    
    def _update_embedding_in_db(self, memory_id: int, embedding_json: str):
        """将计算好的 embedding 写入数据库（使用独立会话，避免异步任务中请求会话已关闭的问题）"""
        from ..core.database import SessionLocal
        db = SessionLocal()
        try:
            # [VEC-PG] 独立会话拿不到实例的 is_postgres 缓存，直接探列类型；
            # vector 列必须 CAST（str 参数按 text 送出，text 不能隐式转 vector）。
            global _vector_column_cached
            _is_vec = _detect_vector_column(db)
            _vector_column_cached = _is_vec
            _emb_ph = "CAST(:embedding AS vector)" if _is_vec else ":embedding"
            sql = text(f"UPDATE conversation_memories SET embedding = {_emb_ph} WHERE id = :id")
            db.execute(sql, {"embedding": embedding_json, "id": memory_id})
            db.commit()
        except Exception as e:
            db.rollback()
            logger.error(f"更新 embedding 到数据库失败 (id={memory_id}): {e}")
        finally:
            db.close()
    
    def resolve_search_scope(
        self,
        session_id: Optional[str] = None,
        character_id: Optional[str] = None,
    ) -> str:
        """[T-跨卡串味修复] 公开版作用域判定，供调用方/可观测性复用。"""
        return _resolve_search_scope(session_id, character_id)

    _MEMORY_SELECT_COLS = (
        "id, user_id, session_id, branch_id, character_id, role, content, "
        "importance_score, topics, tokens_count, created_at, message_id, embedding"
    )

    def _build_scope_filter(
        self,
        user_id: int,
        session_id: Optional[str],
        branch_ids: Optional[List[str]],
        character_id: Optional[str],
        branch_scopes: Optional[List[Tuple[str, Optional[int]]]],
    ) -> Tuple[str, Dict[str, Any]]:
        """[VEC-PG] 组装召回作用域 WHERE 子句 + 参数字典（不含 embedding IS NOT NULL）。

        pgvector 路与 Python 余弦路**共用这一份**：隔离条件历史上在三条 if/elif 里
        各抄一遍，改一处漏两处的风险比检索算法本身更大。

        语义与迁移前逐条对应，一分不改：
        - 有 session_id + branch_scopes → 按分叉点截断（[MEM-MIRROR 2026-10-05]）；
          空列表 = 主聊天 → 只认 trunk（``branch_id IS NULL``）
        - 有 session_id + branch_ids    → ``branch_id IN (...) OR branch_id IS NULL``
        - 有 session_id 且两者都没传     → 不做分支过滤（旧 ``elif session_id`` 分支）
        - 无 session_id                 → 用户级；仅当传了 character_id 才追加角色过滤
          （有 session_id 时不加：会话已唯一归属角色，再加会滤掉存量 NULL 行）
        """
        parts = ["user_id = :user_id"]
        params: Dict[str, Any] = {"user_id": user_id}

        if session_id:
            parts.append("session_id = :session_id")
            params["session_id"] = session_id
            if branch_scopes is not None:
                clauses = []
                for i, (bid, up_to) in enumerate(branch_scopes):
                    if up_to is None:
                        clauses.append(f"branch_id = :bs{i}")
                        params[f"bs{i}"] = bid
                    else:
                        clauses.append(f"(branch_id = :bs{i} AND message_id <= :bsm{i})")
                        params[f"bs{i}"] = bid
                        params[f"bsm{i}"] = up_to
                if clauses:
                    parts.append(f"(branch_id IS NULL OR ({' OR '.join(clauses)}))")
                else:
                    parts.append("branch_id IS NULL")
            elif branch_ids:
                keys = []
                for i, bid in enumerate(branch_ids):
                    keys.append(f":br{i}")
                    params[f"br{i}"] = bid
                parts.append(f"(branch_id IN ({', '.join(keys)}) OR branch_id IS NULL)")
        elif character_id:
            parts.append("character_id = :character_id")
            params["character_id"] = character_id

        return " AND ".join(parts), params

    def _semantic_search_pgvector(
        self,
        query_embedding: List[float],
        limit: int,
        min_similarity: float,
        where_sql: str,
        params: Dict[str, Any],
        scope: str,
    ) -> List[Tuple[MemoryEntry, float]]:
        """[VEC-PG] 库内 cosine 取 top-K：不再按时间预筛，也不建向量索引。

        为什么**故意不建 HNSW/IVFFlat**：pgvector 的索引扫描是"先按向量取近邻、
        再套 WHERE"，在 user_id/session_id 这种高选择性过滤下会少返甚至返 0 条
        （官方文档明确的已知限制）。那正是本项目最坑的"明明有记忆却召回 0"，
        而且它会伪装成"用户没什么历史"。本项目单用户语料是千行量级，实测暴力算
        192 行 2.6ms、放大到 1.2 万行仍是毫秒级，精确算更快也更准。
        真要上索引，得连带把过滤条件下推（partial index / iterative scan）一起设计。

        与旧 Python 路径的行为差异（都是修复）：
        - 旧实现先 ``ORDER BY created_at DESC LIMIT 200`` 再算相似度 ⇒ 第 201 条
          往前的记忆**永远召不回**（实测用户级 614 行里 151 条过阈值，窗口只覆盖
          79 条）。这里改为在整个作用域内按相似度取 top-K。
        - 维度契约由列类型 ``vector(N)`` 在写入侧硬拦，读侧不再有"跳过 N 条维度
          不兼容"这条静默路径。
        """
        dim = int(memory_config.VECTOR_DIMENSION)
        if len(query_embedding) != dim:
            # 与列维度不符的查询向量必然让 <=> 报错；显式告警而不是让 except 吞掉
            logger.warning(
                "[VEC-DIM] 查询向量维度 %d ≠ 列维度 %d，本轮召回跳过（嵌入器疑似降级）",
                len(query_embedding), dim,
            )
            return []

        q = dict(params)
        q["qv"] = _vector_to_pgstr(query_embedding)
        q["min_sim"] = float(min_similarity)
        q["lim"] = int(limit)
        rows = self.db.execute(text(f"""
            SELECT {self._MEMORY_SELECT_COLS},
                   1 - (embedding <=> CAST(:qv AS vector)) AS similarity
            FROM conversation_memories
            WHERE {where_sql}
              AND embedding IS NOT NULL
              AND 1 - (embedding <=> CAST(:qv AS vector)) >= :min_sim
            ORDER BY embedding <=> CAST(:qv AS vector)
            LIMIT :lim
        """), q).fetchall()

        out: List[Tuple[MemoryEntry, float]] = []
        for row in rows:
            emb_list = _parse_vector_cell(row.embedding)
            out.append((
                MemoryEntry(
                    id=row.id,
                    user_id=row.user_id,
                    session_id=row.session_id,
                    branch_id=row.branch_id,
                    message_id=getattr(row, "message_id", None),
                    role=row.role,
                    content=row.content,
                    importance_score=row.importance_score,
                    topics=json.loads(row.topics) if row.topics else [],
                    tokens_count=row.tokens_count or 0,
                    created_at=row.created_at,
                    embedding=emb_list,
                ),
                float(row.similarity),
            ))

        logger.info(
            "语义检索完成: 找到 %d 条记忆，最低相似度: %s, 作用域: %s",
            len(out),
            f"{out[-1][1]}" if out else "N/A",
            scope,
        )
        return out

    def semantic_search(
        self,
        user_id: int,
        query_embedding: List[float],
        limit: int = None,
        min_similarity: float = None,
        session_id: Optional[str] = None,
        branch_ids: Optional[List[str]] = None,
        character_id: Optional[str] = None,
        branch_scopes: Optional[List[Tuple[str, Optional[int]]]] = None,
    ) -> List[Tuple[MemoryEntry, float]]:
        """
        语义相似度搜索。两条路径由 embedding 列的真实类型决定（见 _detect_vector_column）：

        - PostgreSQL + ``vector(N)`` 列 → 库内 cosine 取 top-K（_semantic_search_pgvector），
          **不再有"最近 200 行"的时间预筛**
        - SQLite / 列仍是 TEXT        → 捞进 Python 逐行算余弦（回退路径）

        Args:
            character_id: [T-跨卡串味修复] 角色维度过滤。
                - session_id 与 character_id 都传 → 三个条件一起生效（最窄）
                - 只传 session_id          → 行为与修复前完全一致（不改变）
                - session_id 为空、传 character_id → 按 user_id + character_id
                  过滤（这是修复前的串味源头：原先退化成用户级全量召回）
                - 两者都为空                → 仍退回用户级，但**显式告警**，
                  见 ``last_search_scope``（静默降级是本项目既往教训）
            branch_scopes: [MEM-MIRROR 2026-10-05] 分支作用域 [(branch_id, up_to_message_id)]，
                root→self 顺序，up_to 为该分支的分叉点（子分支的 parent_message_id，
                根分支/主聊天为 None）。提供时按分叉点截断——与消息历史
                ``_get_full_branch_history_paged`` 的 fork_limits 同语义：某祖先分支
                在分叉点之后写入的记忆，对子分支不可见（否则新分支会召回到父分支
                "已放弃的剧情"）。message_id 为 NULL 的记忆行在「被截断的祖先分支」
                下因无法定位楼层而排除（宁缺勿错）；branch_id IS NULL 的主聊天行保留可见。

        返回:
            [(记忆条目, 相似度分数), ...]
        """
        limit = limit or memory_config.MAX_MEMORIES_PER_QUERY
        min_similarity = min_similarity or memory_config.MIN_SIMILARITY
        scope = _resolve_search_scope(session_id, character_id)
        self.last_search_scope = scope
        if scope == "user":
            # [T-跨卡串味修复] 降级留痕：没有 session_id 也没有 character_id，
            # 本次召回跨该用户下所有角色。必须显式告警而不是静默跑宽查询。
            logger.warning(
                "[MEM-SCOPE] 语义检索降级为用户级（scope=user，无 session_id 且无 "
                "character_id，user_id=%s）：结果可能包含其他角色的记忆",
                user_id,
            )

        try:
            # [VEC-PG] 作用域条件抽到 _build_scope_filter，pgvector 路与回退路共用一份。
            where_sql, params = self._build_scope_filter(
                user_id=user_id, session_id=session_id, branch_ids=branch_ids,
                character_id=character_id, branch_scopes=branch_scopes,
            )
            if self._embedding_column_is_vector():
                return self._semantic_search_pgvector(
                    query_embedding=query_embedding, limit=limit,
                    min_similarity=min_similarity, where_sql=where_sql,
                    params=params, scope=scope,
                )

            # 回退路径（SQLite，或列还没转成 vector）：把作用域内的行捞进 Python
            # 逐行算余弦。迁移前这里写死 ``ORDER BY created_at DESC LIMIT 200``，
            # 等于"只在最近 200 条里做语义检索"——实测用户级 614 行里 151 条过阈值，
            # 窗口只覆盖到 79 条，第 201 条往前的记忆**永远召不回**。现改为 5000 行
            # 的防 OOM 上限，且触顶即告警，不再静默少召回。
            _scan_cap = 5000
            _cap_row = self.db.execute(text(
                f"SELECT count(*) AS n FROM conversation_memories "
                f"WHERE {where_sql} AND embedding IS NOT NULL"
            ), params).fetchone()
            if _cap_row and int(_cap_row[0] or 0) > _scan_cap:
                logger.warning(
                    "[VEC-PG] 回退路径命中 %s 行 > 扫描上限 %s：本次召回被截断，"
                    "embedding 列应转 pgvector（见 _migrate_embedding_column）",
                    _cap_row[0], _scan_cap,
                )
            sql = text(f"""
                SELECT {self._MEMORY_SELECT_COLS}
                FROM conversation_memories
                WHERE {where_sql} AND embedding IS NOT NULL
                ORDER BY created_at DESC
                LIMIT {_scan_cap}
            """)
            result = self.db.execute(sql, params)
            
            memories_with_similarity = []
            query_vec = np.array(query_embedding, dtype=np.float32)
            # [DIM-CONTRACT] 维度不兼容的行：旧实现下 np.dot 抛 ValueError 后
            # 走 except→continue 静默丢弃（日志还误报"解析嵌入向量失败"）。
            # 这里显式识别并计数，避免"明明有记忆却召回 0"无从排查。
            dim_skipped = 0

            for row in result:
                try:
                    embedding_list = _parse_vector_cell(row.embedding)
                    if embedding_list is None:
                        continue
                        
                    memory_vec = np.array(embedding_list, dtype=np.float32)

                    if memory_vec.shape[0] != query_vec.shape[0]:
                        dim_skipped += 1
                        continue
                    
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
                            message_id=getattr(row, "message_id", None),
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
                    logger.warning(f"解析嵌入向量失败 (id={getattr(row, 'id', '?')}): {e}")
                    continue
            
            memories_with_similarity.sort(key=lambda x: x[1], reverse=True)
            memories_with_similarity = memories_with_similarity[:limit]

            if dim_skipped:
                # 明确告警而非静默：出现即说明存在与当前嵌入器不同维度的存量向量，
                # 需用 scripts/reembed_all_to_bge_m3.py 统一回填。
                logger.warning(
                    "语义检索跳过 %d 条维度不兼容的记忆（查询 %d 维），请回填后重试",
                    dim_skipped, int(query_vec.shape[0]),
                )

            logger.info(
                "语义检索完成: 找到 %d 条记忆，最低相似度: %s, 作用域: %s",
                len(memories_with_similarity),
                f"{memories_with_similarity[-1][1]}" if memories_with_similarity else "N/A",
                scope,
            )
            return memories_with_similarity
            
        except Exception as e:
            logger.error(f"语义检索失败: {e}")
            self.db.rollback()
            return []
    
    def keyword_search(
        self,
        user_id: int,
        query_text: str,
        limit: int = None,
        min_coverage: float = None,
        session_id: Optional[str] = None,
        branch_ids: Optional[List[str]] = None,
        character_id: Optional[str] = None,
        branch_scopes: Optional[List[Tuple[str, Optional[int]]]] = None,
        candidates: int = None,
    ) -> List[Tuple[MemoryEntry, float]]:
        """[HYBRID-KW 2026-10-09] 关键词路：pg_trgm 粗筛 + 字符二元组覆盖率精排。

        只返回**字面锚点**命中的记忆，与 ``semantic_search`` 语义互补，由
        ``MemoryRetriever`` 用 RRF 融合。单看这一路的 top1 高于向量路（实测
        58% vs 22%），但它只认"用词相同"，问法一换就塌（同义改写题上 31%），
        所以**永远不会单独使用**，只作为融合的一项。

        两级实现的原因：
        - 一级 SQL 粗筛（pg_trgm ``similarity``）：避免把整库内容拉进 Python。
          实测单会话 227 行 8.9ms；top-50 粗筛集内 gold 命中率 86%，剩下的 14%
          由向量路兜底——粗筛只负责"别太贵"，不负责"别漏"。
        - 二级 Python 精排（二元组覆盖率）：trigram 相似度对 CJK 长文本区分度差，
          直接拿它排序会把"整段都很像"的块排到前面。覆盖率的分母是**查询**的
          二元组数，所以长记忆不会因为"字多"而虚高——这一点是关键词路能用的关键。

        返回:
            [(记忆条目, 覆盖率 0~1), ...] 按覆盖率降序；不可用时返回 []
            （无 pg_trgm / 查询无有效字面 / 作用域过大），调用方退化为纯向量。
        """
        limit = limit or memory_config.MAX_MEMORIES_PER_QUERY
        min_coverage = (
            min_coverage if min_coverage is not None
            else memory_config.HYBRID_KW_MIN_COVERAGE
        )
        candidates = candidates or memory_config.HYBRID_KW_CANDIDATES

        qt = str(query_text or "").strip()
        qb = _bigram_set(qt)
        if not qb:
            return []
        if not self._pg_trgm_available():
            return []

        try:
            where_sql, params = self._build_scope_filter(
                user_id=user_id, session_id=session_id, branch_ids=branch_ids,
                character_id=character_id, branch_scopes=branch_scopes,
            )
            # 粗筛要全表算 trigram 距离，行数过大时不划算：宁可整条路放弃。
            # （与回退路 _scan_cap 同一原则：能力不够时降级并留痕，不硬撑。）
            n_row = self.db.execute(text(
                f"SELECT count(*) FROM conversation_memories WHERE {where_sql}"
            ), params).fetchone()
            if n_row and int(n_row[0] or 0) > _KW_SCAN_CAP:
                logger.warning(
                    "[HYBRID-KW] 作用域内 %s 行 > 粗筛上限 %s：本次跳过关键词路，"
                    "退化为纯向量检索", n_row[0], _KW_SCAN_CAP,
                )
                return []

            q = dict(params)
            q["qtext"] = qt[:_KW_QUERY_MAX_CHARS]
            q["lim"] = int(candidates)
            rows = self.db.execute(text(f"""
                SELECT {self._MEMORY_SELECT_COLS}
                FROM conversation_memories
                WHERE {where_sql} AND content IS NOT NULL
                ORDER BY similarity(content, :qtext) DESC
                LIMIT :lim
            """), q).fetchall()

            out: List[Tuple[MemoryEntry, float]] = []
            for row in rows:
                coverage = len(qb & _bigram_set(row.content)) / len(qb)
                if coverage < min_coverage:
                    continue
                out.append((
                    MemoryEntry(
                        id=row.id,
                        user_id=row.user_id,
                        session_id=row.session_id,
                        branch_id=row.branch_id,
                        message_id=getattr(row, "message_id", None),
                        role=row.role,
                        content=row.content,
                        importance_score=row.importance_score,
                        topics=json.loads(row.topics) if row.topics else [],
                        tokens_count=row.tokens_count or 0,
                        created_at=row.created_at,
                        embedding=None,  # 关键词路不需要向量，省掉解析开销
                    ),
                    float(coverage),
                ))

            out.sort(key=lambda x: x[1], reverse=True)
            if out:
                logger.info(
                    "关键词检索完成: 粗筛 %d → 过阈值 %d 条，最高覆盖率 %.2f",
                    len(rows), len(out), out[0][1],
                )
            return out[:limit]

        except Exception as e:
            # 关键词路是**增益项**不是主路径：它挂了必须让向量路继续跑，
            # 绝不能像语义检索失败那样吞掉整次召回。故这里只警告、不回滚事务语义。
            logger.warning(f"[HYBRID-KW] 关键词检索失败（退化为纯向量）: {e}")
            return []

    def get_recent(
        self,
        user_id: int,
        session_id: Optional[str] = None,
        limit: int = 10,
        branch_id: Optional[str] = None,
        branch_ids: Optional[List[str]] = None,
        character_id: Optional[str] = None,
        branch_scopes: Optional[List[Tuple[str, Optional[int]]]] = None,
    ) -> List[MemoryEntry]:
        """获取最近记忆（时间倒序）

        Args:
            character_id: [T-跨卡串味修复] 与 semantic_search 同口径：仅在
                「无 session_id 且有 character_id」时作为过滤条件追加，避免
                STM（最近 N 条）路径同样退化成用户级跨角色召回。传了
                session_id 时行为完全不变。
        """
        try:
            char_clause = (
                " AND character_id = :character_id"
                if (character_id and not session_id) else ""
            )
            if session_id and (branch_scopes is not None or branch_ids):
                params = {
                    "user_id": user_id,
                    "session_id": session_id,
                    "limit": limit,
                }
                if branch_scopes is not None:
                    # [MEM-MIRROR 2026-10-05] 与 semantic_search 同口径的分叉点截断
                    # （空列表 = 主聊天 → 只认 trunk）
                    clauses = []
                    for i, (bid, up_to) in enumerate(branch_scopes):
                        if up_to is None:
                            clauses.append(f"branch_id = :bs{i}")
                            params[f"bs{i}"] = bid
                        else:
                            clauses.append(f"(branch_id = :bs{i} AND message_id <= :bsm{i})")
                            params[f"bs{i}"] = bid
                            params[f"bsm{i}"] = up_to
                    scope_where = (" OR ".join(clauses)) if clauses else "1 = 0"
                    sql = text(f"""
                        SELECT
                            id, user_id, session_id, branch_id, role, content,
                            importance_score, topics, tokens_count, created_at, message_id
                        FROM conversation_memories
                        WHERE user_id = :user_id AND session_id = :session_id
                            AND (branch_id IS NULL OR ({scope_where}))
                        ORDER BY created_at DESC
                        LIMIT :limit
                    """)
                else:
                    sql = text("""
                        SELECT
                            id, user_id, session_id, branch_id, role, content,
                            importance_score, topics, tokens_count, created_at, message_id
                        FROM conversation_memories
                        WHERE user_id = :user_id AND session_id = :session_id
                            AND (branch_id IN :branch_ids OR branch_id IS NULL)
                        ORDER BY created_at DESC
                        LIMIT :limit
                    """).bindparams(bindparam('branch_ids', expanding=True))
                    params["branch_ids"] = branch_ids
            elif session_id and branch_id:
                sql = text("""
                    SELECT
                        id, user_id, session_id, branch_id, role, content,
                        importance_score, topics, tokens_count, created_at, message_id
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
                        importance_score, topics, tokens_count, created_at, message_id
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
                sql = text(f"""
                    SELECT 
                        id, user_id, session_id, branch_id, role, content,
                        importance_score, topics, tokens_count, created_at, message_id
                    FROM conversation_memories
                    WHERE user_id = :user_id{char_clause}
                    ORDER BY created_at DESC
                    LIMIT :limit
                """)
                params = {"user_id": user_id, "limit": limit}
                if char_clause:
                    params["character_id"] = character_id
            
            result = self.db.execute(sql, params)
            
            memories = []
            for row in result:
                memory = MemoryEntry(
                    id=row.id,
                    user_id=row.user_id,
                    session_id=row.session_id,
                    branch_id=row.branch_id,
                    message_id=getattr(row, "message_id", None),
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
