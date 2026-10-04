"""[MEM-MIRROR] 记忆 = 消息当前内容的镜像 —— 统一的删写同步入口。

背景（本文件的存在理由）
----------------------
历史上「切换候选(swipe)」「编辑消息」的向量记忆同步是三份几乎重复的后台闭包
（character_ext 编辑/切换 + sessions 编辑），共同的结构性缺陷是：

    请求内: 立即 DELETE 记忆行 + commit
    后台线程: 先 embed_text(同步打 Ollama, 秒级) → INSERT

删与写之间隔着秒级窗口，窗口内任何二次操作（再切一次候选 / 再编辑一次 /
重新生成）发出的 DELETE 会「空删」（新的还没写进去），而第一次那批**旧版本
文本**随后才落库 —— 于是「用户已放弃的生成版本」永久残留在记忆表里并被召回。
生产库实测：消息 2599 有 7 条记忆行，其中 4 条来自已放弃的 swipe0、3 条来自
当前 swipe1，同 branch_id → 全部在召回范围。

本模块把写入改成 **CAS（compare-and-set）on 正文**：
后台任务执行时重新读一次消息当前正文，与调用方捕获的正文比对；若已被更新的
操作改写，则**放弃本次写入**（更新者会负责写）。这样无论后台任务如何交错，
记忆表都收敛到「当前选中的那一版」。

不变式（tests/test_memory_message_link.py 顶部声明）：
conversation_memories 中 message_id = M.id 的行集合 ≈ clean_memory_content(M 当前显示内容)。
"""

from __future__ import annotations

import logging
from typing import Optional

from sqlalchemy import text

from ..core.database import SessionLocal
from ..utils import clean_memory_content
from .service import MemoryService
from .storage import delete_by_message_id

logger = logging.getLogger(__name__)


def resolve_memory_mode(db, user_id: int) -> str:
    """解析用户记忆档位（与角色聊天主路径 :4519-4522 同源同默认值）。

    无设置行时按 "vector" 走，与 UserSetting.memory_mode 列默认值一致
    （2026-09-23 起不再是 "disabled"）。集中在此以免各写入路径各写一份、
    语义漂移（[MEM-MIRROR] 统一守卫）。
    """
    from ..models.system import UserSetting

    setting = db.query(UserSetting).filter(UserSetting.user_id == user_id).first()
    if setting and setting.memory_mode:
        return setting.memory_mode
    return "vector"


def _normalize_for_compare(role: str, raw: Optional[str]) -> str:
    """CAS 比对用的归一化：assistant 走 clean（与入库同源），user 走原文 strip。

    必须与 sync 时实际入库的文本同源，否则清洗差异会造成假失配 → 误放弃写入。
    """
    if raw is None:
        return ""
    return (clean_memory_content(raw) if role == "assistant" else raw).strip()


def sync_message_memory(
    *,
    user_id: int,
    session_id: str,
    message_id: int,
    role: str,
    captured_raw: str,
    branch_id: Optional[str] = None,
    character_id: Optional[str] = None,
    memory_mode: str = "vector",
    table: str = "character_chat_messages",
) -> None:
    """后台执行：CAS 校验正文新鲜度 → 删除该 message_id 的旧记忆行 → 按当前正文重嵌。

    必须在**独立 Session** 中调用（后台线程），自开自关。

    - memory_mode == 'disabled' → 直接返回（统一 RC-4：所有写入路径同一语义；
      关闭记忆期间编辑/切换不再删旧行，避免重新开启时旧文本浮现）。
    - CAS：重读消息当前正文，与 captured_raw（调用方捕获的当次操作对应正文）
      归一化比对；不一致 → 说明有更新的操作已接手，放弃本次写入并记 info。
    - 比对用「同源归一化」避免清洗差异造成假失配。
    - table：角色聊天走 character_chat_messages；普通聊天（sessions.py 编辑）
      走 messages —— 两者 id 序列独立，故 CAS 重读必须指对表。

    异常一律吞掉并 rollback（后台任务不可让请求失败），但记 warning 以便巡检。
    """
    if memory_mode == "disabled":
        return
    if table not in ("character_chat_messages", "messages"):
        raise ValueError(f"unexpected message table: {table}")

    db = SessionLocal()
    try:
        svc = MemoryService(db)
        if not svc.is_available():
            return

        # --- CAS：正文是否仍是调用方捕获的那一版？---
        row = db.execute(
            text(f"SELECT content FROM {table} WHERE id=:mid AND session_id=:sid"),
            {"mid": message_id, "sid": session_id},
        ).first()
        if row is None:
            # 消息已删（delete_character_message 走级联删记忆），无需写
            logger.info("[MEM-MIRROR] message gone, skip sync (message=%s)", message_id)
            return

        current_norm = _normalize_for_compare(role, row[0])
        captured_norm = _normalize_for_compare(role, captured_raw)
        if current_norm != captured_norm:
            # 有更新的操作已接手本消息的记忆，本任务放弃 —— 杜绝旧版本文本残留
            logger.info(
                "[MEM-MIRROR] 跳过过期重嵌 (message=%s)：正文已被更新的操作改写",
                message_id,
            )
            return

        text_for_mem = clean_memory_content(captured_raw) if role == "assistant" else captured_raw
        if not (text_for_mem or "").strip():
            return

        # --- ① 删除旧行并**独立提交** ---
        # 独立提交是「宁缺勿错」的关键：后续 store 失败时旧行不会被 rollback 恢复，
        # 该轮记忆表现为「缺失」而非「陈旧」（tests/test_memory_message_link.py::
        # test_edit_reembed_failure_ningque_wucuo 钉住此语义）。
        delete_by_message_id(db, session_id, message_id)
        db.commit()

        # --- ② 按当前正文写新行（独立事务；失败仅回滚本段，① 已生效）---
        svc.store_memory(
            user_id=user_id,
            session_id=session_id,
            role=role,
            content=text_for_mem,
            branch_id=branch_id,
            message_id=message_id,
            character_id=character_id,
        )
        db.commit()
    except Exception as e:
        try:
            db.rollback()
        except Exception:
            pass
        logger.warning("[MEM-MIRROR] sync failed (message=%s): %s", message_id, e)
    finally:
        db.close()