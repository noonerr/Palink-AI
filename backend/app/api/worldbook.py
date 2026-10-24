"""World Book API routes — CRUD, import, session association, keyword-trigger."""
import asyncio
import json
import logging
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile, File
from pydantic import BaseModel
from sqlalchemy.orm import Session, selectinload

from ..core.silent_failure import record as _record_silent_failure

from ..core import get_db
from ..core.cache import cached, invalidate_user_cache
from ..core.input_validation import sanitize_name, sanitize_text, sanitize_tags
from ..api.dependencies import get_current_user
from ..models.base import utc_now as _utc_now
from ..models import User
from ..models.worldbook import WorldBook, WorldBookStage, SessionWorldBook
from ..services.worldbook_import_utils import (
    entry_is_disabled,
    entry_keys,
    entry_secondary_keys,
    normalize_worldbook_position,
)
from ..schemas.worldbook import (
    WorldBookCreate, WorldBookUpdate, WorldBookResponse,
    WorldBookDetailResponse, WorldBookStageResponse, WorldBookStageUpdate,
    SessionWorldBookCreate, SessionWorldBookResponse,
    WorldBookParseRequest,
)

router = APIRouter(prefix="/api/worldbooks", tags=["worldbooks"])
router_session_wb = APIRouter(prefix="/api/character-sessions", tags=["session-worldbook"])

logger = logging.getLogger(__name__)

# ──────────────────────────────────────────────
# V-1 (2026-08-25): 世界书向量库同步触发（fire-and-forget，失败仅 warning）
# ──────────────────────────────────────────────

_PENDING_VECTOR_SYNC_TASKS: set = set()


def _vector_sync_worker(world_book_id: str) -> None:
    """在独立线程/会话中执行向量同步（请求会话随后会被关闭，必须用新 SessionLocal）。"""
    from ..core.database import SessionLocal
    from ..services.worldbook_vector_service import WorldBookVectorService

    svc = WorldBookVectorService(SessionLocal())
    try:
        result = svc.sync_worldbook_vectors(world_book_id)
        if isinstance(result, dict) and result.get("error"):
            logger.warning(
                "worldbook vector sync degraded (book=%s): %s",
                world_book_id, result.get("error"),
            )
    finally:
        try:
            svc.db.close()
        except Exception as _close_exc:
            # [SILENT-FAIL 2026-10-22] 后台向量任务里关会话失败 = 连接可能没归还池，
            # 长跑会把连接池耗干。以前完全无声。
            _record_silent_failure("worldbook.vector_worker_db_close", _close_exc, once=True)


def _fire_vector_sync(world_book_id: str) -> None:
    """后台 fire-and-forget 调度 sync_worldbook_vectors；失败仅 warning。"""
    async def _run():
        try:
            await asyncio.to_thread(_vector_sync_worker, world_book_id)
        except Exception as exc:
            logger.warning("worldbook vector sync failed (book=%s): %s", world_book_id, exc)

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    task = loop.create_task(_run())
    _PENDING_VECTOR_SYNC_TASKS.add(task)
    task.add_done_callback(_PENDING_VECTOR_SYNC_TASKS.discard)


def _vector_delete_worker(world_book_id: str) -> None:
    from ..core.database import SessionLocal
    from ..services.worldbook_vector_service import WorldBookVectorService

    svc = WorldBookVectorService(SessionLocal())
    try:
        svc.delete_vectors(world_book_id)
    finally:
        try:
            svc.db.close()
        except Exception as _close_exc:
            # [SILENT-FAIL 2026-10-22] 后台向量任务里关会话失败 = 连接可能没归还池，
            # 长跑会把连接池耗干。以前完全无声。
            _record_silent_failure("worldbook.vector_worker_db_close", _close_exc, once=True)


def _fire_vector_delete(world_book_id: str) -> None:
    """世界书删除后清空其向量行（Postgres 侧另有 FK CASCADE 兜底）。"""
    async def _run():
        try:
            await asyncio.to_thread(_vector_delete_worker, world_book_id)
        except Exception as exc:
            logger.warning("worldbook vector cleanup failed (book=%s): %s", world_book_id, exc)

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    task = loop.create_task(_run())
    _PENDING_VECTOR_SYNC_TASKS.add(task)
    task.add_done_callback(_PENDING_VECTOR_SYNC_TASKS.discard)


def _worldbook_vector_recall_enabled(db: Session, user_id) -> bool:
    """F2 (2026-09-30): 该用户的「世界书语义召回」总开关是否打开。

    读 ``UserSetting.silly_tavern_settings`` → ``world_info_settings.vectorized_enabled``，
    与装配层消费点（roleplay_prompt_assembly.py:4196）**同一字典、同一键名**。

    读不到 / 解析异常一律视为**关**：功能关着时宁可不派活，也不要白烧算力
    （勾选一次 = 整本书重新嵌入一遍）。
    """
    try:
        from ..models import UserSetting

        us = db.query(UserSetting).filter(UserSetting.user_id == user_id).first()
        if us is None or not us.silly_tavern_settings:
            return False
        raw = (
            json.loads(us.silly_tavern_settings)
            if isinstance(us.silly_tavern_settings, str)
            else us.silly_tavern_settings
        )
        wis = raw.get("world_info_settings") if isinstance(raw, dict) else None
        if not isinstance(wis, dict):
            return False
        return bool(wis.get("vectorized_enabled", False))
    except Exception as exc:
        logger.debug(
            "worldbook vector recall switch probe failed (user=%s): %s", user_id, exc,
        )
        return False


def _schedule_worldbook_vector_sync(db: Session, world_book_id: str) -> None:
    """commit 后调用：**总开关开** 且 该书存在任一 vectorized=true 条目才触发后台同步。

    F2 (2026-09-30) 增加"用户总开关"这道前置。此前只判书内有无 vectorized 条目，
    结果是——功能默认关着，用户每勾一个词条就给整本书排一次嵌入（几百条 × bge-m3），
    而他什么都看不到。开关打开后的第一轮检索由 P2 的懒触发后台同步补齐
    （worldbook_service._collect_vector_hits 路径），行为自洽，无需在此预热。
    存量零突变：开关默认关 → 勾选/编辑都不派活。
    """
    try:
        owner = db.query(WorldBook.user_id).filter(WorldBook.id == world_book_id).first()
    except Exception as exc:
        logger.debug("worldbook owner probe failed (book=%s): %s", world_book_id, exc)
        return
    if owner is None or owner[0] is None:
        return
    if not _worldbook_vector_recall_enabled(db, owner[0]):
        return
    try:
        has_vectorized = (
            db.query(WorldBookStage.id)
            .filter(
                WorldBookStage.world_book_id == world_book_id,
                WorldBookStage.vectorized.is_(True),
            )
            .first()
            is not None
        )
    except Exception as exc:
        logger.debug("worldbook vectorized probe failed (book=%s): %s", world_book_id, exc)
        return
    if has_vectorized:
        _fire_vector_sync(world_book_id)

def _resolve_bindable_character_id(db: Session, user_id: int, character_id: Optional[str]) -> Optional[str]:
    """[WB-CHAR-BIND 2026-10-03] 校验世界书要绑的角色是否属于当前用户。

    绑定维度必须真实存在且同用户，否则这条书会绑到一个**别的用户**的角色上
    （FK 只校验 characters.id 存在性，不校验归属）→ 世界书内容跨用户注入。
    故此处显式校验归属，不做静默兜底。

    - ``None``/空串 → 解绑/全局书（返回 None）
    - 角色不存在或不属于该用户 → 400，错误信息点名（不掩盖）
    """
    if character_id is None:
        return None
    cid = str(character_id).strip()
    if not cid:
        return None
    from ..models.character import Character

    owner = (
        db.query(Character.id)
        .filter(Character.id == cid, Character.user_id == user_id)
        .first()
    )
    if owner is None:
        raise HTTPException(400, f"character_id={cid} 不存在或不属于当前用户")
    return cid


def _wb_to_response(wb: WorldBook, stage_count: int = 0) -> dict:
    tags = None
    if wb.tags:
        try:
            tags = json.loads(wb.tags)
        except (json.JSONDecodeError, TypeError):
            tags = []
    return {
        "id": wb.id,
        "name": wb.name,
        "description": wb.description,
        "source_type": wb.source_type,
        "format": wb.format,
        "type": wb.type or "world_book",
        "tags": tags,
        "is_parsed": wb.is_parsed,
        "stage_count": stage_count,
        "character_id": wb.character_id,
        "created_at": str(wb.created_at) if wb.created_at else "",
        "updated_at": str(wb.updated_at) if wb.updated_at else "",
    }


def _parse_keys(field) -> list:
    """Safely parse a JSON-encoded keys field."""
    if not field:
        return []
    try:
        return json.loads(field)
    except (json.JSONDecodeError, TypeError):
        return []


def _stage_to_response(s: WorldBookStage) -> dict:
    return {
        "id": s.id,
        "world_book_id": s.world_book_id,
        "stage_index": s.stage_index,
        "title": s.title,
        "content": s.content,
        "summary": s.summary,
        "transition_hint": s.transition_hint,
        "priority": s.priority,
        "token_count": s.token_count,
        "image_prompt": s.image_prompt,
        "keys": _parse_keys(s.keys),
        "secondary_keys": _parse_keys(s.secondary_keys),
        "scan_depth": s.scan_depth if s.scan_depth is not None else 4,
        "position": s.position if s.position is not None else 4,
        "selective": bool(s.selective),
        "probability": s.probability if s.probability is not None else 100,
        "use_probability": bool(s.use_probability) if s.use_probability is not None else True,
        "constant": bool(s.constant),
        # SPEC §11 A：这张逐字段手抄的 dict 才是真白名单，漏这行前端读不到勾选状态
        "vectorized": bool(s.vectorized),
        "group": s.group,
        "extensions_json": s.extensions_json,
    }


# ──────────────────────────────────────────────
# World Book CRUD
# ──────────────────────────────────────────────

@router.get("")
@cached(ttl_seconds=15, key_prefix="worldbook_list")
async def list_worldbooks(
    character_id: Optional[str] = None,
    type: Optional[str] = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """获取用户的所有世界书"""
    from sqlalchemy import func as sa_func

    entry_count_sub = db.query(
        WorldBookStage.world_book_id,
        sa_func.count(WorldBookStage.id).label("stage_count")
    ).group_by(WorldBookStage.world_book_id).subquery()

    query = db.query(WorldBook, sa_func.coalesce(entry_count_sub.c.stage_count, 0)).outerjoin(
        entry_count_sub, WorldBook.id == entry_count_sub.c.world_book_id
    ).filter(
        WorldBook.user_id == user.id,
    )
    if type == "character_book":
        if character_id:
            query = query.filter(WorldBook.character_id == character_id, WorldBook.type == "character_book")
        else:
            query = query.filter(WorldBook.character_id.isnot(None), WorldBook.type == "character_book")
    elif type == "world_book":
        query = query.filter(WorldBook.type == "world_book")
    else:
        if character_id:
            query = query.filter(
                (WorldBook.character_id.is_(None)) | (WorldBook.character_id == character_id)
            )
        else:
            pass
    rows = query.order_by(WorldBook.updated_at.desc()).all()
    return [_wb_to_response(wb, stage_count) for wb, stage_count in rows]


@router.post("")
async def create_worldbook(
    req: WorldBookCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """创建世界书（在线编写或标记为上传来源）

    [WB-CHAR-BIND 2026-10-03] 新增可选 ``character_id``：绑定角色后该书
    只对该角色的会话注入（对齐 ST ``world_info.charLore`` 语义）。不传 → 全局书。
    """
    character_id = _resolve_bindable_character_id(db, user.id, req.character_id)
    wb = WorldBook(
        id=str(uuid.uuid4()),
        user_id=user.id,
        character_id=character_id,
        name=req.name,
        description=req.description,
        source_type=req.source_type,
        raw_content=req.raw_content,
        format=req.format,
        tags=json.dumps(req.tags) if req.tags else None,
        is_parsed=False,
        type="world_book",
        created_at=_utc_now(),
        updated_at=_utc_now(),
    )
    db.add(wb)
    db.commit()
    db.refresh(wb)
    invalidate_user_cache("worldbook_list", user.id)

    # 触发 ST DATA_ROOT 同步（后台非阻塞）
    try:
        from ..services.st_sync_service import trigger_async_sync
        from ..core.database import SessionLocal
        await trigger_async_sync(SessionLocal, user.id, "worldbook", world_book_id=wb.id)
    except Exception:
        import logging
        logging.getLogger(__name__).debug(
            "ST sync trigger failed for worldbook create", exc_info=True,
        )

    return _wb_to_response(wb, 0)


@router.get("/{world_book_id}")
async def get_worldbook(
    world_book_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """获取世界书详情（含阶段列表）"""
    wb = db.query(WorldBook).options(selectinload(WorldBook.entries)).filter(WorldBook.id == world_book_id, WorldBook.user_id == user.id).first()
    if not wb:
        raise HTTPException(404, "World book not found")
    tags = None
    if wb.tags:
        try:
            tags = json.loads(wb.tags)
        except (json.JSONDecodeError, TypeError):
            tags = []
    return {
        "id": wb.id,
        "name": wb.name,
        "description": wb.description,
        "source_type": wb.source_type,
        "raw_content": wb.raw_content,
        "format": wb.format,
        "type": wb.type or "world_book",
        "tags": tags,
        "is_parsed": wb.is_parsed,
        # [WB-CHAR-BIND 2026-10-03] 详情也要带 character_id——前端"绑定角色"
        # 选择器靠它回填；缺失时前端永远显示"未绑定"，回填无从谈起。
        "character_id": wb.character_id,
        "stages": [_stage_to_response(s) for s in wb.entries],
        "created_at": str(wb.created_at) if wb.created_at else "",
        "updated_at": str(wb.updated_at) if wb.updated_at else "",
    }


@router.put("/{world_book_id}")
async def update_worldbook(
    world_book_id: str,
    req: WorldBookUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """编辑世界书"""
    wb = db.query(WorldBook).options(selectinload(WorldBook.entries)).filter(WorldBook.id == world_book_id, WorldBook.user_id == user.id).first()
    if not wb:
        raise HTTPException(404, "World book not found")
    if req.name is not None:
        wb.name = req.name
    if req.description is not None:
        wb.description = req.description
    if req.raw_content is not None:
        wb.raw_content = req.raw_content
        wb.is_parsed = False  # Content changed, need re-parse
    if req.tags is not None:
        wb.tags = json.dumps(req.tags)
    # [WB-CHAR-BIND 2026-10-03] 角色绑定可改可解绑。``model_fields_set`` 区分
    # "请求体没带该键"（不改）与"显式传 null"（解绑）——否则前端只想改名字
    # 就会把已有绑定悄悄抹掉。
    if "character_id" in req.model_fields_set:
        wb.character_id = _resolve_bindable_character_id(db, user.id, req.character_id)
    # [ST-BRIDGE-BOOKBIND 2026-10-20] type 可写（此前该列没有 API 写通道）。
    #   与 character_id 同一手法：只在**请求体显式带了 type** 时才落值。
    #   安全面：type 只收 'world_book' / 'character_book' 两枚举（见 WorldBookUpdate.type
    #   的 validator），且本端点前面已按 ``user_id == user.id`` 过滤 ⇒ 改不到别人的书。
    if "type" in req.model_fields_set and req.type is not None:
        wb.type = req.type
    wb.updated_at = _utc_now()
    db.commit()
    db.refresh(wb)
    # [ST-BRIDGE-BOOKBIND 2026-10-20] 这里原本写的是
    #   ``invalidate_cache(f"worldbook_list:user={user.id}")`` —— **无效失效**。
    # 根因：list_worldbooks 的缓存 key 由 _build_key 拼成
    #   ``worldbook_list:character_id=<hash>:type=<hash>:user=<id>``
    # （core/cache.py:93-110，按 kwargs 键名字典序拼接），而 invalidate_cache 走的是
    #   ``k.startswith(key_prefix)``（core/cache.py:75）。拿 ``worldbook_list:user=<id>``
    #   当**前缀**去匹配，永远命中不了 ⇒ 世界书列表缓存要等 TTL=15s 自然过期才刷新。
    # 后果直击本批次：卡调 rebindCharWorldbooks / setCurrentCharLorebooks 之后立刻按角色源
    #   重查，读回来的仍是改前的绑定（"重新加载仍在新绑定"这条验收直接不成立）。
    # 正解是走 character.py:379 那套用户级后缀匹配（本项目既有正解）：
    #   invalidate_user_cache("worldbook_list", user.id)  # 同文件另外 3 处一并修
    # 同时给 PUT /{id} 加下行注释以便日后 grep 到。
    invalidate_user_cache("worldbook_list", user.id)

    # V-1: 世界书保存后同步向量库（存在 vectorized 条目才触发，fire-and-forget）
    _schedule_worldbook_vector_sync(db, world_book_id)

    # 触发 ST DATA_ROOT 同步（后台非阻塞）
    try:
        from ..services.st_sync_service import trigger_async_sync
        from ..core.database import SessionLocal
        await trigger_async_sync(SessionLocal, user.id, "worldbook", world_book_id=wb.id)
    except Exception:
        import logging
        logging.getLogger(__name__).debug(
            "ST sync trigger failed for worldbook update", exc_info=True,
        )

    return _wb_to_response(wb, len(wb.entries) if wb.entries else 0)


@router.delete("/{world_book_id}")
async def delete_worldbook(
    world_book_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """删除世界书"""
    wb = db.query(WorldBook).filter(WorldBook.id == world_book_id, WorldBook.user_id == user.id).first()
    if not wb:
        raise HTTPException(404, "World book not found")
    # Also remove any session associations
    db.query(SessionWorldBook).filter(SessionWorldBook.world_book_id == world_book_id).delete()
    db.delete(wb)
    db.commit()
    invalidate_user_cache("worldbook_list", user.id)

    # V-1: 删除世界书时清空其向量行（fire-and-forget；Postgres 侧 FK CASCADE 兜底）
    _fire_vector_delete(world_book_id)

    # 级联清理 ST DATA_ROOT 中的 worlds 文件
    try:
        from pathlib import Path
        from ..services.st_sync_service import _st_data_root_for_user, _world_file_name
        data_root = _st_data_root_for_user(user)
        if data_root:
            world_path = Path(data_root) / "worlds" / _world_file_name(world_book_id)
            if world_path.exists():
                world_path.unlink(missing_ok=True)
    except Exception:
        import logging
        logging.getLogger(__name__).debug(
            "ST DATA_ROOT cleanup failed for worldbook delete", exc_info=True,
        )

    return {"status": "ok"}


# ──────────────────────────────────────────────
# Import SillyTavern V2 JSON
# ──────────────────────────────────────────────

@router.post("/import")
async def import_worldbook(
    file: UploadFile = File(...),
    character_id: Optional[str] = Form(None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """导入 SillyTavern V2 JSON 世界书文件

    [WB-CHAR-BIND-IMPORT 2026-10-03] 新增可选表单字段 ``character_id``：
    导入时就能指定这本书记到哪张卡名下（与建书接口 POST "" 的 ``character_id``
    语义完全一致，走同一个 ``_resolve_bindable_character_id`` 校验）。

    为什么必须补：此前 import handler 构造 ``WorldBook(...)`` 时**根本没有**
    character_id 参数 → 用户导入的每一本世界书都落成全局书（character_id=None）。
    卡内嵌路径（``character_import_service``:845）一直是绑角色的，于是出现了
    报告口径能标 ``source=global``（可见性做到了）但**隔离没做到**的矛盾状态：
    用户的串味投诉在世界书维度没被解决。

    解析方式说明：本 handler 全程用 ``Form``/``File``，所以可选文本字段也用
    ``Form(None)`` 而不是查询参数 —— FastAPI 在同时声明了 File 的 endpoint 里
    用 Query 会触发「Form 与 Body 不能混用」的断言错误。**不传 / 空串 → 全局书**，
    与修复前行为逐字相同（不破坏既有调用方）。
    """
    if not file.filename or not file.filename.endswith(".json"):
        raise HTTPException(400, "Only .json files are supported")

    content = await file.read(5 * 1024 * 1024)
    if await file.read(1):
        raise HTTPException(413, "File too large (max 5MB)")
    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        raise HTTPException(400, "Invalid JSON file")

    # SillyTavern lorebook format has "entries" key
    entries = data.get("entries", {})
    if not entries and isinstance(data, list):
        # Some formats use a list of entries directly
        entries = {str(i): e for i, e in enumerate(data)}

    if not entries:
        raise HTTPException(400, "No entries found in world book file")

    # Build raw content from entries for storage
    raw_parts = []
    for _key, entry in sorted(entries.items(), key=lambda x: x[1].get("order", 0)):
        if entry_is_disabled(entry):
            continue
        comment = entry.get("comment", "")
        entry_content = entry.get("content", "")
        if entry_content:
            raw_parts.append(f"## {comment}\n{entry_content}" if comment else entry_content)

    name = data.get("name") or file.filename.replace(".json", "")
    description = data.get("description", "")
    
    try:
        name = sanitize_name(name, max_length=200)
    except ValueError:
        name = file.filename.replace(".json", "")
        name = sanitize_name(name, max_length=200)
    try:
        description = sanitize_text(description, max_length=5000) or ""
    except ValueError:
        description = ""

    # [WB-CHAR-BIND-IMPORT 2026-10-03] 归属校验在建行之前，与建书接口 POST "" 共用
    # 同一个 ``_resolve_bindable_character_id``：绑到别的用户的角色 → 400 点名报错，
    # 不静默落成全局书（静默落全局 = 用户以为隔离了其实没隔离）。
    character_id = _resolve_bindable_character_id(db, user.id, character_id)

    wb = WorldBook(
        id=str(uuid.uuid4()),
        user_id=user.id,
        character_id=character_id,
        name=name,
        description=description,
        source_type="upload",
        raw_content="\n\n---\n\n".join(raw_parts),
        format="silly_tavern_v2",
        tags=json.dumps(data.get("tags", [])),
        is_parsed=False,
        type="world_book",
        created_at=_utc_now(),
        updated_at=_utc_now(),
    )
    db.add(wb)

    # Auto-create entries from lorebook: keyword-trigger mode
    MAX_IMPORT_ENTRIES = 500
    stage_index = 0
    for _key, entry in sorted(entries.items(), key=lambda x: x[1].get("order", 0)):
        if stage_index >= MAX_IMPORT_ENTRIES:
            break
        if entry_is_disabled(entry):
            continue
        entry_content = entry.get("content", "").strip()
        if not entry_content:
            continue
        if len(entry_content) > 50000:
            entry_content = entry_content[:50000]
        is_constant = entry.get("constant", False)
        extensions = entry.get("extensions") or {}
        # D-2 修复（2026-08-23）: 补齐条目级高级字段映射（此前仅映射 8 项，
        # order/sticky/cooldown/delay/depth/selectiveLogic/caseSensitive/
        # matchWholeWords/excludeRecursion/preventRecursion/group 系/scanDepth
        # 等十余字段静默丢失）。字段名与默认值语义对齐 ST 契约路径
        # （silly_tavern.py:1618-1670）与 character_import_service 路径。
        def _int(name: str, default: int) -> int:
            v = entry.get(name)
            return v if isinstance(v, int) and not isinstance(v, bool) else default

        stage = WorldBookStage(
            id=str(uuid.uuid4()),
            world_book_id=wb.id,
            stage_index=stage_index,
            title=entry.get("comment", f"Entry {stage_index}"),
            content=entry_content,
            summary=None,
            transition_hint=None,
            priority=10 if is_constant else 5,
            token_count=len(entry_content) // 4,
            keys=json.dumps(entry_keys(entry)),
            secondary_keys=json.dumps(entry_secondary_keys(entry)),
            # A4 修复: scanDepth 缺失时保留 NULL（ST entry.scanDepth ?? world_info_depth），
            # 使全局 world_info_depth 对未自定义扫描深度的条目生效。
            scan_depth=(
                entry["scanDepth"]
                if isinstance(entry.get("scanDepth"), int) and not isinstance(entry.get("scanDepth"), bool)
                else None
            ),
            position=normalize_worldbook_position(entry.get("position", 4)),
            selective=entry.get("selective", False),
            probability=entry.get("probability", 100),
            use_probability=(
                entry["useProbability"]
                if isinstance(entry.get("useProbability"), bool)
                else True
            ),
            constant=is_constant,
            group=entry.get("group", None),
            enabled=True,  # disabled 条目已在上方 entry_is_disabled 过滤
            case_sensitive=bool(entry.get("caseSensitive")),
            match_whole_words=bool(entry.get("matchWholeWords")),
            selective_logic=_int("selectiveLogic", 0),
            sticky=_int("sticky", 0),
            cooldown=_int("cooldown", 0),
            delay=_int("delay", 0),
            depth=_int("depth", 4),
            order=_int("order", stage_index),
            exclude_recursion=bool(entry.get("excludeRecursion")),
            prevent_recursion=bool(entry.get("preventRecursion")),
            group_override=bool(entry.get("groupOverride")),
            group_weight=_int("groupWeight", 0),
            vectorized=bool(entry.get("vectorized")),
            add_memo=bool(entry.get("addMemo")),
            decorators=json.dumps(entry.get("decorators") or [], ensure_ascii=False),
            character_filter=None,
            min_activations=_int("minActivations", 0),
            delay_until_recursion=(
                int(entry["delayUntilRecursion"])
                if isinstance(entry.get("delayUntilRecursion"), int) and not isinstance(entry.get("delayUntilRecursion"), bool)
                else 0
            ),
            triggers=json.dumps(entry.get("triggers") or [], ensure_ascii=False),
            outlet_name=(str(entry.get("outletName"))[:200] or None) if entry.get("outletName") else None,
            ignore_budget=bool(entry.get("ignoreBudget") or extensions.get("ignore_budget", False)),
            role=(
                _int("role", 0)
                if isinstance(entry.get("role"), int) and not isinstance(entry.get("role"), bool)
                else (extensions["role"] if isinstance(extensions.get("role"), int) and not isinstance(extensions.get("role"), bool) else 0)
            ),
            use_group_scoring=(
                entry["useGroupScoring"]
                if isinstance(entry.get("useGroupScoring"), bool)
                else (extensions.get("use_group_scoring") if isinstance(extensions.get("use_group_scoring"), bool) else None)
            ),
            automation_id=str(entry.get("automationId") or "") or None,
            created_at=_utc_now(),
        )
        if isinstance(entry.get("matchPersonaDescription"), bool):
            stage.match_persona_description = entry["matchPersonaDescription"]
        if isinstance(entry.get("matchCharacterDescription"), bool):
            stage.match_character_description = entry["matchCharacterDescription"]
        if isinstance(entry.get("matchCharacterPersonality"), bool):
            stage.match_character_personality = entry["matchCharacterPersonality"]
        if isinstance(entry.get("matchCharacterDepthPrompt"), bool):
            stage.match_character_depth_prompt = entry["matchCharacterDepthPrompt"]
        if isinstance(entry.get("matchScenario"), bool):
            stage.match_scenario = entry["matchScenario"]
        if isinstance(entry.get("matchCreatorNotes"), bool):
            stage.match_creator_notes = entry["matchCreatorNotes"]
        entry_extensions = entry.get("extensions", {})
        if entry_extensions and isinstance(entry_extensions, dict):
            stage.extensions_json = json.dumps(entry_extensions, ensure_ascii=False)
        db.add(stage)
        stage_index += 1

    if stage_index > 0:
        wb.is_parsed = True

    db.commit()
    db.refresh(wb)
    invalidate_user_cache("worldbook_list", user.id)

    # V-1: 导入含 vectorized 条目时同步向量库（ST 导入对齐，fire-and-forget）
    _schedule_worldbook_vector_sync(db, wb.id)

    return _wb_to_response(wb, stage_index)


# ──────────────────────────────────────────────
# Stage editing
# ──────────────────────────────────────────────

@router.put("/{world_book_id}/stages/{stage_id}")
async def update_stage(
    world_book_id: str,
    stage_id: str,
    req: WorldBookStageUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """编辑单个阶段"""
    wb = db.query(WorldBook).filter(WorldBook.id == world_book_id, WorldBook.user_id == user.id).first()
    if not wb:
        raise HTTPException(404, "World book not found")
    stage = db.query(WorldBookStage).filter(
        WorldBookStage.id == stage_id, WorldBookStage.world_book_id == world_book_id
    ).first()
    if not stage:
        raise HTTPException(404, "Stage not found")

    if req.title is not None:
        stage.title = req.title
    if req.content is not None:
        stage.content = req.content
        stage.token_count = len(req.content) // 4
    if req.summary is not None:
        stage.summary = req.summary
    if req.transition_hint is not None:
        stage.transition_hint = req.transition_hint
    if req.priority is not None:
        stage.priority = max(1, min(10, req.priority))
    if req.image_prompt is not None:
        stage.image_prompt = req.image_prompt
    if req.keys is not None:
        stage.keys = json.dumps(req.keys)
    if req.secondary_keys is not None:
        stage.secondary_keys = json.dumps(req.secondary_keys)
    if req.scan_depth is not None:
        stage.scan_depth = req.scan_depth
    if req.position is not None:
        stage.position = req.position
    if req.selective is not None:
        stage.selective = req.selective
    if req.probability is not None:
        stage.probability = req.probability
    if req.use_probability is not None:
        stage.use_probability = req.use_probability
    if req.constant is not None:
        stage.constant = req.constant
    # SPEC §11 A：词条级语义召回勾选（None = 不修改，避免只改内容时冲掉已勾选）
    if req.vectorized is not None:
        stage.vectorized = req.vectorized
    if req.group is not None:
        stage.group = req.group

    wb.updated_at = _utc_now()
    db.commit()
    # SPEC §11 R1：词条编辑后必须复用既有调度触发后台同步。
    # P2 的 _book_vectors_ready 只比行数、不做内容脏检查，不触发的话
    # 改了词条内容向量库仍留着旧内容的向量（界面看着勾上了、召回的却是旧设定）。
    _schedule_worldbook_vector_sync(db, world_book_id)
    return _stage_to_response(stage)


# ──────────────────────────────────────────────
# Session ↔ WorldBook association
# ──────────────────────────────────────────────

@router_session_wb.post("/{session_id}/worldbook")
async def associate_worldbook(
    session_id: str,
    req: SessionWorldBookCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """为对话关联世界书（一个对话仅能激活一个世界书）"""
    from ..models.character import CharacterChatSession
    session = db.query(CharacterChatSession).filter(
        CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id,
    ).first()
    if not session:
        raise HTTPException(404, "Session not found")

    wb = db.query(WorldBook).options(selectinload(WorldBook.entries)).filter(WorldBook.id == req.world_book_id, WorldBook.user_id == user.id).first()
    if not wb:
        raise HTTPException(404, "World book not found")

    # Remove existing association if any (replace)
    existing = db.query(SessionWorldBook).filter(SessionWorldBook.session_id == session_id).first()
    if existing:
        db.delete(existing)
        db.flush()

    swb = SessionWorldBook(
        id=str(uuid.uuid4()),
        session_id=session_id,
        world_book_id=req.world_book_id,
        created_at=_utc_now(),
        updated_at=_utc_now(),
    )
    db.add(swb)
    db.commit()
    db.refresh(swb)

    return {
        "id": swb.id,
        "session_id": swb.session_id,
        "world_book_id": swb.world_book_id,
        "world_book": _wb_to_response(wb, len(wb.entries) if wb.entries else 0),
        "stages": [_stage_to_response(s) for s in wb.entries],
        "created_at": str(swb.created_at),
        "updated_at": str(swb.updated_at),
    }


@router_session_wb.delete("/{session_id}/worldbook")
async def disassociate_worldbook(
    session_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """取消对话的世界书关联"""
    from ..models.character import CharacterChatSession
    session = db.query(CharacterChatSession).filter(
        CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id,
    ).first()
    if not session:
        raise HTTPException(404, "Session not found")

    deleted = db.query(SessionWorldBook).filter(SessionWorldBook.session_id == session_id).delete()
    db.commit()
    if not deleted:
        raise HTTPException(404, "No world book associated with this session")
    return {"status": "ok"}


@router_session_wb.get("/{session_id}/worldbook/status")
async def get_worldbook_status(
    session_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """获取对话的世界书状态（当前阶段等）"""
    from ..models.character import CharacterChatSession
    session = db.query(CharacterChatSession).filter(
        CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id,
    ).first()
    if not session:
        raise HTTPException(404, "Session not found")

    result = (
        db.query(SessionWorldBook, WorldBook)
        .join(WorldBook, SessionWorldBook.world_book_id == WorldBook.id)
        .filter(SessionWorldBook.session_id == session_id, WorldBook.user_id == user.id)
        .first()
    )

    if not result:
        return {"active": False}

    swb, wb = result

    entry_count = db.query(WorldBookStage).filter(
        WorldBookStage.world_book_id == swb.world_book_id
    ).count()
    entries_overview = [
        {
            "id": e.id,
            "title": e.title,
            "keys_preview": ", ".join(_parse_keys(e.keys)[:3]) if e.keys else ("[constant]" if e.constant else ""),
        }
        for e in db.query(WorldBookStage).filter(
            WorldBookStage.world_book_id == swb.world_book_id
        ).order_by(WorldBookStage.stage_index).limit(20).all()
    ]

    return {
        "active": True,
        "world_book_id": swb.world_book_id,
        "world_book_name": wb.name,
        "active_entries_count": entry_count,
        "entries_overview": entries_overview,
    }


# ───────────────────────────────────────────────────────────────
# [ASM-3 2026-10-24] 世界书扫描预览（只读端点）
#
# 目的：让插件经 getContext().getWorldInfoPrompt() 看到的激活列表/预算
# 与后端权威装配**同源**（唯一真相源 = build_worldbook_context）。
# 替换掉前端自算引擎路径（frontend/src/lib/worldbook 的 scanAndBuildContext）。
#
# ⚠️ 参数一致性纪律（2026-10-05 教训：离线探针漏传 max_context_tokens →
# 预算 16000 假阳性）：本端点的参数采集逻辑逐行复刻生产调用点
# ``roleplay_prompt_assembly.py::_append_worldbook_context``（约 :4745-4909，
# kwargs 见 :4879 的 build_worldbook_context 调用）。任何一处修改都必须
# 先对照生产调用点，并由 backend/tests/test_worldbook_scan_endpoint.py 的
# 参数一致性测试（monkeypatch 双向捕获 kwargs 对比）守卫。
#
# 只读性：build_worldbook_context(enable_timed_effects=True)（= 生产默认）
# 会在扫描前执行 TimedEffectsManager.update_after_message()（sticky/cooldown
# tick）并可能因 @@reset 删除状态行 —— 生产随后 commit（savepoint.commit()），
# 本端点在拿到结果后统一 db.rollback() 丢弃这些写入：
#   - 扫描结果本身在 rollback 前已算完（tick 发生在扫描判定之前，语义 =
#     "下一次生产装配会激活什么"），rollback 不影响已返回的列表；
#   - 状态不被预览消费，下一次真实生成的 tick 与没有这次预览时完全一致。
# ───────────────────────────────────────────────────────────────

class WorldbookScanRequest(BaseModel):
    """世界书扫描预览请求体。

    - ``message``：预览"带上这句新消息会激活什么"。空串 = 生产无新消息
      分支（continue 轮语义，见 _append_worldbook_context 的 recent_msgs
      构造：仅落库窗口，不 append）。
    - ``model``：max_context_tokens 解引用（用户 openai_max_context 覆盖
      优先，回退模型注册表 context_length）。前端传当前会话模型。
    - ``group_id``：群聊上下文（生产 req.group_id 同义）。普通角色会话不传。
    """

    message: str = ""
    model: Optional[str] = None
    group_id: Optional[str] = None


def _collect_worldbook_scan_params(
    db: Session,
    user: User,
    session: "CharacterChatSession",
    char,
    message: str,
    model: Optional[str],
    group_id: Optional[str],
) -> dict:
    """按生产口径采集 build_worldbook_context 实参。

    与 ``roleplay_prompt_assembly.py::_append_worldbook_context`` 的采集块
    逐项对齐（该函数内联在装配主链里无法直接复用，此处为受测试守卫的
    镜像副本）。返回 kwargs dict（不含 db/session_id/user_id/character，
    由调用方补齐）。
    """
    from ..models import UserSetting
    from ..models import Persona
    from ..services.roleplay_prompt_assembly import (
        _get_model_context_window,
        _get_openai_max_context_override,
        _load_members,
    )
    from ..models.group_chat import GroupChat

    user_nickname = user.username or "用户"

    # ── 生产块 ①：persona + world_info_settings（默认值与解析逐行同源） ──
    persona_desc_text: Optional[str] = None
    wi_min_activations = 0
    wi_min_activations_depth_max = 0
    wi_char_strategy = 1
    wi_world_info_depth = 2
    wi_recursive = False
    wi_vectorized_enabled = False
    wi_budget: Optional[float] = 25.0
    wi_budget_cap = 0
    wi_include_names = True
    wi_case_sensitive = False
    wi_match_whole_words = False
    user_setting = db.query(UserSetting).filter(UserSetting.user_id == user.id).first()
    if user_setting:
        if user_setting.active_persona_id:
            ap = db.query(Persona).filter(
                Persona.id == user_setting.active_persona_id,
                Persona.user_id == user.id,
            ).first()
            if ap and ap.description:
                persona_desc_text = ap.description
        if user_setting.silly_tavern_settings:
            try:
                _st_raw = (
                    json.loads(user_setting.silly_tavern_settings)
                    if isinstance(user_setting.silly_tavern_settings, str)
                    else user_setting.silly_tavern_settings
                )
                if isinstance(_st_raw, dict):
                    _wis = _st_raw.get("world_info_settings", {})
                    if isinstance(_wis, dict):
                        wi_min_activations = int(_wis.get("world_info_min_activations", 0) or 0)
                        wi_min_activations_depth_max = int(_wis.get("world_info_min_activations_depth_max", 0) or 0)
                        wi_char_strategy = int(_wis.get("world_info_character_strategy", 1) or 1)
                        wi_world_info_depth = int(_wis.get("world_info_depth", 2) or 2)
                        wi_recursive = bool(_wis.get("world_info_recursive", False))
                        wi_vectorized_enabled = bool(_wis.get("vectorized_enabled", False))
                        try:
                            wi_budget = float(_wis.get("world_info_budget", 25))
                        except (TypeError, ValueError) as _exc:
                            _record_silent_failure("worldbook.scan.wi_budget_fallback", _exc, once=True)
                            wi_budget = 25.0
                        wi_budget_cap = int(_wis.get("world_info_budget_cap", 0) or 0)
                        wi_include_names = bool(_wis.get("world_info_include_names", True))
                        wi_case_sensitive = bool(_wis.get("world_info_case_sensitive", False))
                        wi_match_whole_words = bool(_wis.get("world_info_match_whole_words", False))
            except (json.JSONDecodeError, TypeError, ValueError) as _exc:
                _record_silent_failure("worldbook.scan.settings_parse_fallback", _exc, once=True)

    # ── 生产块 ②：消息窗口（Phase E 深度扩展）+ D-1 chat_length 绝对计数 ──
    # 预览端点恒 is_init=False / smart_card_trigger=False / is_continue=False：
    # message 非空走生产"普通轮"分支（append + persisted_count+1），
    # message 为空走生产"continue 轮"分支（仅窗口 + max(count, len)）。
    from ..models.character import CharacterChatMessage

    _wb_msg_limit = 8
    if wi_min_activations > 0:
        if wi_min_activations_depth_max > 0:
            _wb_msg_limit = wi_min_activations_depth_max + 8
        else:
            _wb_msg_limit = 100
    recent_for_wb = (
        db.query(CharacterChatMessage)
        .filter(CharacterChatMessage.session_id == session.id)
        .filter(CharacterChatMessage.is_hidden == False)  # noqa: E712 — 生产同式
        .order_by(CharacterChatMessage.created_at.desc())
        .limit(_wb_msg_limit)
        .all()[::-1]
    )
    recent_msgs = [
        {"role": m.role, "content": m.content, "name": m.name or ""}
        for m in recent_for_wb
    ]
    if message:
        recent_msgs.append({"role": "user", "content": message, "name": user_nickname})

    try:
        from sqlalchemy import func as _sa_func

        _wb_persisted_count = (
            db.query(_sa_func.count(CharacterChatMessage.id))
            .filter(CharacterChatMessage.session_id == session.id)
            .scalar()
        ) or 0
    except Exception as _exc:
        _record_silent_failure("worldbook.scan.persisted_count_fallback", _exc, once=True)
        _wb_persisted_count = len(recent_for_wb)
    if message:
        _wb_chat_length = _wb_persisted_count + 1
    else:
        _wb_chat_length = max(_wb_persisted_count, len(recent_msgs))

    # ── 生产块 ③：群聊 per-member 世界书（E1/D 批） ──
    group_chars_arg = None
    if group_id:
        _group = db.query(GroupChat).filter(
            GroupChat.id == group_id, GroupChat.user_id == user.id
        ).first()
        if _group is not None:
            _meta_raw = getattr(_group, "chat_metadata", None)
            _meta: dict = {}
            if _meta_raw:
                try:
                    _meta = json.loads(_meta_raw) if isinstance(_meta_raw, str) else _meta_raw
                except (json.JSONDecodeError, TypeError) as _exc:
                    _record_silent_failure("worldbook.scan.group_meta_fallback", _exc, once=True)
                    _meta = {}
            group_wi_strategy = str(_meta.get("world_info_character_strategy") or "one") if isinstance(_meta, dict) else "one"
            if group_wi_strategy in ("all", "group"):
                try:
                    _enabled = _load_members(db, _group)
                    _main_id = str(char.id) if getattr(char, "id", None) else None
                    group_chars_arg = [c for c in _enabled if str(c.id) != _main_id]
                except Exception as _exc:
                    _record_silent_failure("worldbook.scan.group_members_fallback", _exc, once=True)
                    group_chars_arg = None

    # ── 生产块 ④：A5 修复 max_context_tokens（覆盖优先，回退注册表） ──
    _wb_ctx_override = _get_openai_max_context_override(user_setting, model, char.id if char else None)
    _wb_max_context_tokens = (
        _wb_ctx_override
        if isinstance(_wb_ctx_override, int) and _wb_ctx_override > 0
        else _get_model_context_window(model)
    )

    return {
        "recent_messages": recent_msgs,
        "persona_description": persona_desc_text,
        "group_chars": group_chars_arg,
        "min_activations": wi_min_activations,
        "min_activations_depth_max": wi_min_activations_depth_max,
        "world_info_character_strategy": wi_char_strategy,
        "chat_length": _wb_chat_length,
        "world_info_depth": wi_world_info_depth,
        "enable_recursive": wi_recursive,
        "vectorized_enabled": wi_vectorized_enabled,
        "world_info_budget": wi_budget,
        "world_info_budget_cap": wi_budget_cap,
        "include_names": wi_include_names,
        "world_info_case_sensitive": wi_case_sensitive,
        "world_info_match_whole_words": wi_match_whole_words,
        "max_context_tokens": _wb_max_context_tokens,
    }


@router_session_wb.post("/{session_id}/worldbook-scan")
async def scan_session_worldbook(
    session_id: str,
    req: WorldbookScanRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """[ASM-3] 只读世界书扫描预览 — 与生产装配同参同源。

    返回 ST getWorldInfoPrompt 契约形状（world-info.js:892 返回的
    WIPromptResult：worldInfoString/worldInfoBefore/worldInfoAfter/
    worldInfoExamples/worldInfoDepth/anBefore/anAfter/outletEntries，
    position→字段映射同 :5073-5145 的 checkWorldInfo 分类），外加 Palink
    扩展字段（entries=后端 debug_report 逐条明细、budget=预算读数），
    供插件显示"激活列表/预算"时与后端装配 report 逐项对账。
    """
    from ..models.character import Character, CharacterChatSession
    from ..services.worldbook_service import build_worldbook_context
    from ..services.worldbook_service import (
        WI_POS_AFTER_AN,
        WI_POS_AFTER_CHAR,
        WI_POS_BEFORE_AN,
        WI_POS_BEFORE_CHAR,
    )

    session = db.query(CharacterChatSession).filter(
        CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id,
    ).first()
    if not session:
        raise HTTPException(404, "Session not found")

    char = db.query(Character).filter(
        Character.id == session.character_id,
        Character.user_id == user.id,
    ).first()
    if not char:
        raise HTTPException(404, "Character not found")

    scan_kwargs = _collect_worldbook_scan_params(
        db, user, session, char, req.message, req.model, req.group_id
    )

    # 只读性实现：SAVEPOINT 包住扫描，随后回滚保存点——只丢弃扫描期写入
    # （timed-effects tick / record_activation / @@reset 删除），不影响本事务
    # 里更早的任何数据。结果对象在 rollback 前已构造完，不受影响。
    # ⚠️ 不用整事务 db.rollback()：在"session 绑定外部连接事务"的宿主形态
    # （tests/conftest.py 的 db_session 模式）下，整事务回滚会把该事务里
    # 更早的（未真正落盘的）提交一并卷走。SAVEPOINT 两种形态都只回滚本段。
    nested = None
    try:
        nested = db.begin_nested()
    except Exception as _exc:
        _record_silent_failure("worldbook.scan.savepoint_unavailable", _exc, once=True)
        nested = None
    try:
        result = build_worldbook_context(
            db=db,
            session_id=session_id,
            user_id=user.id,
            character=char,
            # enable_timed_effects 不传 = 生产默认 True（tick 后扫描，见端点头注释）
            **scan_kwargs,
        )
    finally:
        if nested is not None:
            try:
                nested.rollback()
            except Exception as _exc:
                _record_silent_failure("worldbook.scan.nested_rollback_failed", _exc, once=True)
                try:
                    db.rollback()
                except Exception as _exc2:
                    _record_silent_failure("worldbook.scan.db_rollback_failed", _exc2, once=True)
        else:
            try:
                db.rollback()
            except Exception as _exc:
                _record_silent_failure("worldbook.scan.db_rollback_failed", _exc, once=True)

    ebp = result.entries_by_position or {}

    def _join_pos(pos: int) -> str:
        return "\n".join(ebp.get(pos, []) or [])

    # ST world-info.js:5146-5147：before/after 各自 '\n' join（字符串）；
    # :5162 anBefore=ANTopEntries / anAfter=ANBottomEntries 是**内容数组**。
    world_info_before = _join_pos(WI_POS_BEFORE_CHAR)
    world_info_after = _join_pos(WI_POS_AFTER_CHAR)
    an_before = list(ebp.get(WI_POS_BEFORE_AN, []) or [])
    an_after = list(ebp.get(WI_POS_AFTER_AN, []) or [])

    # atDepth：生产 depth_entries 为 (depth, content, role) 三元组列表，
    # ST WIDepthEntries 按 (depth, role) 分组（world-info.js:5125-5136）。
    wi_depth: list[dict] = []
    for depth, content, role in result.depth_entries or []:
        role_int = role if isinstance(role, int) else 0
        existing = next(
            (d for d in wi_depth if d["depth"] == depth and d["role"] == role_int),
            None,
        )
        if existing is not None:
            existing["entries"].append(content)
        else:
            wi_depth.append({"depth": depth, "entries": [content], "role": role_int})

    # EMTop/EMBottom → ST EMEntries 形状 {position: wi_anchor_position.before/after}
    wi_examples = [
        {"position": "before", "content": c} for c in result.em_top_entries or []
    ] + [
        {"position": "after", "content": c} for c in result.em_bottom_entries or []
    ]

    entries_report = [
        {
            "entry_id": r.entry_id,
            "title": r.title,
            "status": r.status,
            "reason": r.reason,
            "matched_keywords": list(r.matched_keywords or []),
            "tokens_estimate": r.tokens_estimate,
            "position": r.position,
            "recursion_depth": r.recursion_depth,
            "world_book_id": r.world_book_id,
            "book_name": r.book_name,
            "lore_source": r.lore_source,
        }
        for r in result.debug_report or []
    ]

    return {
        "session_id": session_id,
        # ST 契约字段（world-info.js:892-920）
        "worldInfoString": result.text or "",
        "worldInfoBefore": world_info_before,
        "worldInfoAfter": world_info_after,
        "worldInfoExamples": wi_examples,
        "worldInfoDepth": wi_depth,
        "anBefore": an_before,
        "anAfter": an_after,
        "outletEntries": result.outlet_entries or {},
        # Palink 扩展：对账用逐条明细 + 预算读数（与后端装配 report 同源）
        "entries": entries_report,
        "activated_entry_ids": [
            r["entry_id"] for r in entries_report if r["status"] == "activated"
        ],
        "budget": {
            "budget_used": result.budget_used,
            "total_tokens": result.total_tokens,
            "world_info_budget": scan_kwargs["world_info_budget"],
            "world_info_budget_cap": scan_kwargs["world_info_budget_cap"],
            "max_context_tokens": scan_kwargs["max_context_tokens"],
        },
        "book_sources": result.book_sources or {},
        "chat_length": scan_kwargs["chat_length"],
        "read_only": True,
    }
