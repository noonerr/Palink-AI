"""预设模板库 API（Palink 原生，四类预设统一清单 + 导入/导出/删除）。

## 为什么有这一层

用户 2026-10-25 拍板做"预设库"，并认可"学 ST、把 ST 的预设置引进来"。本模块
把散在四条链路里的预设收成一个库：

| kind       | 存储                                   | 读模型                          |
|------------|----------------------------------------|---------------------------------|
| context    | ``context_templates``                  | ContextTemplate（builtin + 本人）|
| instruct   | ``instruct_templates``                 | InstructTemplate（系统预置 + 本人）|
| sysprompt  | ``silly_tavern_settings.sysprompt_presets``（数组） | 按用户 |
| reasoning  | ``silly_tavern_settings.reasoning_presets``（数组） | 按用户 |

sysprompt / reasoning 没有专表：``st_power_user_defaults.py`` 的 ``sysprompt`` /
``reasoning`` 是 ST 设置对象里的**当前选中值**（单选），不是可选集合。所以本库
另起两个数组键存集合，**不动那两个选中值**，也不发明装配接线（本期只做库）。

## ST 原生 JSON 导入

判定顺序照 ST 1.18.0 ``public/scripts/preset-manager.js:209-260``：
  · instruct = name + input_sequence + output_sequence
  · context  = name + story_string
  · sysprompt = name + content
  · reasoning = name + prefix + suffix + separator

单条、``{"items": [...]}``、裸数组 ``[...]`` 三种输入都接受。字段映射见
``_ST_INSTRUCT_FIELD_MAP``（**instruct 必须全字段透传**——旧
``api/instruct_templates.py`` 的 Create/Update 模型与 ``_template_to_dict``
漏了 system_sequence 等 ST 1.18 列，转录一遍就会静默丢字段；本模块直接写 ORM，
并在导出时反向映射）。

无列可落的字段（context 的 ``story_string_position`` / ``story_string_role`` /
``story_string_depth`` / ``example_separator`` / ``use_stop_strings`` /
``names_as_stop_strings`` 等）**显式丢弃并在 warnings 里点名**，不静默吞。

## 版权边界

自带默认在 ``app/core/preset_library_seeds.py``，全为自写中文。本模块不含任何
ST 预设正文。

## 鉴权

与同目录 ``context_templates.py`` / ``instruct_templates.py`` 一致用
``get_current_user``（Palink 原生面）。归属一律取自 token，不接受请求体传 user_id。

运行测试: cd backend && py -3 -m pytest tests/test_preset_library_api.py -q
"""
from __future__ import annotations

import json
import logging
import uuid
from typing import Any, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy import or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..core import get_db
from ..core.preset_library_seeds import (
    BUILTIN_REASONING_PRESETS,
    BUILTIN_SYSPROMPT_PRESETS,
    REASONING_PRESETS_KEY,
    SYSPROMPT_PRESETS_KEY,
    ensure_preset_library_seeds,
)
from ..core.silent_failure import record
from ..models import ContextTemplate, InstructTemplate, User, UserSetting
from .dependencies import get_current_user

router = APIRouter(prefix="/api/preset-library", tags=["preset-library"])

logger = logging.getLogger(__name__)

KIND_CONTEXT = "context"
KIND_INSTRUCT = "instruct"
KIND_SYSPROMPT = "sysprompt"
KIND_REASONING = "reasoning"
VALID_KINDS = (KIND_CONTEXT, KIND_INSTRUCT, KIND_SYSPROMPT, KIND_REASONING)

MAX_IMPORT_BYTES = 5 * 1024 * 1024

PALINK_LIBRARY_VERSION = "1"
PALINK_SOURCE = "palink-ai"

# ST 原生 instruct 字段 → 本仓 InstructTemplate 列名。
# 反向（导出）用 dict 反查，两边只有这一份账本。
_ST_INSTRUCT_FIELD_MAP: dict[str, str] = {
    "system_prompt": "system_prompt",
    "input_sequence": "input_prefix",
    "input_suffix": "input_suffix",
    "output_sequence": "output_prefix",
    "output_suffix": "output_suffix",
    "system_sequence": "system_sequence",
    "system_suffix": "system_suffix",
    "last_system_sequence": "last_system_sequence",
    "first_input_sequence": "first_input_sequence",
    "last_input_sequence": "last_input_sequence",
    "first_output_sequence": "first_output_prefix",
    "last_output_sequence": "last_output_prefix",
    "user_alignment_message": "user_alignment_message",
    "story_string_prefix": "story_string_prefix",
    "story_string_suffix": "story_string_suffix",
    "stop_sequence": "stop_sequence",
    "separator_sequence": "separator_sequence",
    "wrap": "wrap_sequences",
    "macro": "macro",
    "names_behavior": "names_behavior",
    "system_same_as_user": "system_same_as_user",
    "sequences_as_stop_strings": "sequences_as_stop_strings",
    "skip_examples": "skip_examples",
}

_INSTRUCT_BOOL_FIELDS = {
    "wrap_sequences",
    "macro",
    "system_same_as_user",
    "sequences_as_stop_strings",
    "skip_examples",
}

# context 在 ST 里存在、但本仓 context_templates 没有对应列 ⇒ 导入时显式丢弃。
_ST_CONTEXT_UNMAPPABLE = {
    "example_separator",
    "use_stop_strings",
    "names_as_stop_strings",
    "story_string_position",
    "story_string_role",
    "story_string_depth",
    "preset",
}
_ST_CONTEXT_MAPPABLE = {"name", "display_name", "story_string", "chat_start"}
_ST_CONTEXT_EXTRA_MAPPABLE = {"system_prompt", "jailbreak", "normal_prompt", "group_prompt"}

# sysprompt/reasoning 走数组，没有列；导出/导入只认这几个键。
_ST_SYSPROMPT_FIELDS = ("name", "content")
_ST_REASONING_FIELDS = ("name", "prefix", "suffix", "separator")
_ST_SYSPROMPT_UNMAPPABLE = {"post_history"}

# 清单/导出/导入三处共用的元数据键：不进入"未知字段"告警。
_META_KEYS = {
    "kind",
    "type",
    "id",
    "user_id",
    "is_builtin",
    "builtin",
    "is_system",
    "is_default",
    "created_at",
    "updated_at",
}


# ---------------------------------------------------------------------------
# 通用小工具
# ---------------------------------------------------------------------------
def _is_admin(user: User) -> bool:
    return getattr(user, "role", "") == "admin"


def _load_settings_dict(raw: Optional[str], *, user_id: int) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except (TypeError, ValueError) as exc:
        record("preset_library.settings_json", exc, user_id=user_id)
        return {}
    return data if isinstance(data, dict) else {}


def _get_or_create_setting(db: Session, user_id: int) -> UserSetting:
    setting = db.query(UserSetting).filter(UserSetting.user_id == user_id).first()
    if setting is None:
        setting = UserSetting(user_id=user_id, silly_tavern_settings="{}")
        db.add(setting)
        db.flush()
    return setting


def _stored_preset_entries(
    setting: Optional[UserSetting], key: str, user_id: int
) -> list[dict[str, Any]]:
    if setting is None:
        return []
    stored = _load_settings_dict(setting.silly_tavern_settings, user_id=user_id)
    bucket = stored.get(key)
    if not isinstance(bucket, list):
        return []
    return [dict(item) for item in bucket if isinstance(item, dict)]


def _write_stored_preset_entries(setting: UserSetting, key: str, entries: list[dict], user_id: int) -> None:
    stored = _load_settings_dict(setting.silly_tavern_settings, user_id=user_id)
    stored[key] = entries
    setting.silly_tavern_settings = json.dumps(stored, ensure_ascii=False)


def _unknown_keys(item: dict, allowed: set[str]) -> list[str]:
    return sorted(
        str(k)
        for k in item
        if k not in allowed
        and k not in _META_KEYS
        and not str(k).startswith("_palink")
    )


# ---------------------------------------------------------------------------
# 可见性查询
# ---------------------------------------------------------------------------
def _visible_context_query(db: Session, user: User):
    """builtin + 历史共享行（user_id NULL）+ 本人。

    历史共享行必须可见：2026-10-25 之前 admin 建的模板不带 user_id，若只放
    "builtin + 本人"，这些仍在被装配引用的行会从所有人视野里消失。
    """
    return db.query(ContextTemplate).filter(
        or_(
            ContextTemplate.is_builtin.is_(True),
            ContextTemplate.user_id.is_(None),
            ContextTemplate.user_id == user.id,
        )
    )


def _visible_instruct_query(db: Session, user: User):
    return db.query(InstructTemplate).filter(
        or_(
            InstructTemplate.user_id.is_(None),
            InstructTemplate.user_id == user.id,
        )
    )


def _context_to_dict(t: ContextTemplate) -> dict[str, Any]:
    return {
        "id": t.id,
        "user_id": t.user_id,
        "name": t.name,
        "display_name": t.display_name,
        "story_string": t.story_string or "",
        "chat_start": t.chat_start or "",
        "system_prompt": t.system_prompt or "",
        "jailbreak": t.jailbreak or "",
        "normal_prompt": t.normal_prompt or "",
        "group_prompt": t.group_prompt or "",
        "is_builtin": bool(t.is_builtin),
        "created_at": t.created_at.isoformat() if t.created_at else None,
        "updated_at": t.updated_at.isoformat() if t.updated_at else None,
    }


def _instruct_to_dict(t: InstructTemplate) -> dict[str, Any]:
    data: dict[str, Any] = {
        "id": t.id,
        "user_id": t.user_id,
        "name": t.name,
        "is_builtin": t.user_id is None,
        "is_default": bool(t.is_default),
        "created_at": t.created_at.isoformat() if t.created_at else None,
    }
    for attr in set(_ST_INSTRUCT_FIELD_MAP.values()):
        value = getattr(t, attr, None)
        data[attr] = bool(value) if attr in _INSTRUCT_BOOL_FIELDS else (value or "")
    return data


def _sysprompt_builtin_entries() -> list[dict[str, Any]]:
    return [{"name": s["name"], "content": s["content"], "builtin": True} for s in BUILTIN_SYSPROMPT_PRESETS]


def _reasoning_builtin_entries() -> list[dict[str, Any]]:
    return [
        {
            "name": s["name"],
            "prefix": s["prefix"],
            "suffix": s["suffix"],
            "separator": s["separator"],
            "builtin": True,
        }
        for s in BUILTIN_REASONING_PRESETS
    ]


def _merge_array_presets(
    builtin_entries: list[dict[str, Any]], stored_entries: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """builtin 优先（名字唯一），其余按存储顺序追加。"""
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entry in builtin_entries:
        resource_name = str(entry.get("name") or "").strip()
        if not resource_name:
            continue
        merged.append(entry)
        seen.add(resource_name)
    for entry in stored_entries:
        resource_name = str(entry.get("name") or "").strip()
        if not resource_name or resource_name in seen:
            continue
        item = dict(entry)
        item.setdefault("builtin", False)
        merged.append(item)
        seen.add(resource_name)
    return merged


def _ensure_seeded(db: Session, user: User) -> dict[str, int]:
    """幂等补齐自带条目；失败降级为"只读清单"，绝不让读取路径 500。"""
    try:
        counts = ensure_preset_library_seeds(db, user_id=user.id)
        if any(counts.values()):
            db.commit()
        return counts
    except Exception as exc:  # noqa: BLE001 - 播种是增强，读取必须继续
        record("preset_library.lazy_seed", exc, user_id=user.id)
        db.rollback()
        return {}


def _library_payload(db: Session, user: User) -> dict[str, list[dict[str, Any]]]:
    context = (
        _visible_context_query(db, user)
        .order_by(ContextTemplate.is_builtin.desc(), ContextTemplate.name)
        .all()
    )
    instruct = (
        _visible_instruct_query(db, user)
        .order_by(InstructTemplate.user_id.isnot(None), InstructTemplate.name)
        .all()
    )
    setting = db.query(UserSetting).filter(UserSetting.user_id == user.id).first()
    return {
        KIND_CONTEXT: [_context_to_dict(t) for t in context],
        KIND_INSTRUCT: [_instruct_to_dict(t) for t in instruct],
        KIND_SYSPROMPT: _merge_array_presets(
            _sysprompt_builtin_entries(),
            _stored_preset_entries(setting, SYSPROMPT_PRESETS_KEY, user.id),
        ),
        KIND_REASONING: _merge_array_presets(
            _reasoning_builtin_entries(),
            _stored_preset_entries(setting, REASONING_PRESETS_KEY, user.id),
        ),
    }


# ---------------------------------------------------------------------------
# 导入：命名去重
# ---------------------------------------------------------------------------
def _context_name_taken(db: Session, name: str) -> bool:
    return db.query(ContextTemplate.id).filter(ContextTemplate.name == name).first() is not None


def _unique_context_name(db: Session, base: str) -> str:
    """context_templates.name 是**全局唯一**（装配按 name 查），必须真去重。"""
    base = (base or "").strip() or "未命名预设"
    if not _context_name_taken(db, base):
        return base
    for idx in range(1, 51):
        candidate = f"{base} (imported)" if idx == 1 else f"{base} (imported {idx})"
        if not _context_name_taken(db, candidate):
            return candidate
    return f"{base} (imported {uuid.uuid4().hex[:8]})"


def _unique_instruct_name(db: Session, user: User, base: str) -> str:
    base = (base or "").strip() or "未命名预设"
    existing = {
        name
        for (name,) in db.query(InstructTemplate.name)
        .filter(
            or_(
                InstructTemplate.user_id.is_(None),
                InstructTemplate.user_id == user.id,
            )
        )
        .all()
    }
    if base not in existing:
        return base
    for idx in range(1, 51):
        candidate = f"{base} (imported)" if idx == 1 else f"{base} (imported {idx})"
        if candidate not in existing:
            return candidate
    return f"{base} (imported {uuid.uuid4().hex[:8]})"


def _unique_array_name(existing_names: set[str], base: str) -> str:
    base = (base or "").strip() or "未命名预设"
    if base not in existing_names:
        return base
    for idx in range(1, 51):
        candidate = f"{base} (imported)" if idx == 1 else f"{base} (imported {idx})"
        if candidate not in existing_names:
            return candidate
    return f"{base} (imported {uuid.uuid4().hex[:8]})"


# ---------------------------------------------------------------------------
# 导入：类型判定
# ---------------------------------------------------------------------------
def _detect_kind(item: dict[str, Any], hint: Optional[str]) -> Optional[str]:
    explicit = str(item.get("kind") or item.get("type") or item.get("_palink_kind") or "").strip().lower()
    if explicit in VALID_KINDS:
        return explicit
    # 结构性判定（顺序与 ST preset-manager.js 一致；sysprompt 的 content 判定
    # 放在 context 之后、reasoning 之前，避免包错类型）。
    if "name" in item and "input_sequence" in item and "output_sequence" in item:
        return KIND_INSTRUCT
    if "name" in item and "story_string" in item:
        return KIND_CONTEXT
    if "name" in item and "content" in item:
        return KIND_SYSPROMPT
    if all(key in item for key in ("name", "prefix", "suffix", "separator")):
        return KIND_REASONING
    hint_value = str(hint or "").strip().lower()
    if hint_value in VALID_KINDS:
        return hint_value
    return None


def _normalize_payload(data: Any) -> list[Any]:
    """单条 / ``{items: [...]}`` / 裸数组 → 条目列表。"""
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        items = data.get("items")
        if isinstance(items, list):
            return items
        return [data]
    return []


# ---------------------------------------------------------------------------
# 导入：四类写入
# ---------------------------------------------------------------------------
def _import_context(
    db: Session, user: User, item: dict[str, Any], result: dict[str, list]
) -> None:
    original_name = str(item.get("name") or "").strip()
    if not original_name:
        result["skipped"].append({"kind": KIND_CONTEXT, "reason": "missing name"})
        return
    target_name = _unique_context_name(db, original_name)
    template = ContextTemplate(
        user_id=user.id,
        name=target_name,
        display_name=str(item.get("display_name") or original_name)[:200],
        story_string=item.get("story_string") or "",
        chat_start=item.get("chat_start") or "",
        system_prompt=item.get("system_prompt") or "",
        jailbreak=item.get("jailbreak") or "",
        normal_prompt=item.get("normal_prompt") or "",
        group_prompt=item.get("group_prompt") or "",
        # 列默认值是 True（内置），用户导入行必须显式 False。
        is_builtin=False,
    )
    db.add(template)
    db.flush()

    dropped = sorted(set(item.keys()) & _ST_CONTEXT_UNMAPPABLE)
    allowed = _ST_CONTEXT_MAPPABLE | _ST_CONTEXT_EXTRA_MAPPABLE
    dropped.extend(_unknown_keys(item, allowed))
    if dropped:
        result["warnings"].append(
            f"context '{original_name}': 字段 {', '.join(sorted(set(dropped)))} "
            "在 Palink 无对应存储列，已丢弃"
        )
    result["created"].append(
        {
            "kind": KIND_CONTEXT,
            "id": template.id,
            "name": target_name,
            "renamed_from": original_name if target_name != original_name else None,
        }
    )


def _import_instruct(
    db: Session, user: User, item: dict[str, Any], result: dict[str, list]
) -> None:
    original_name = str(item.get("name") or "").strip()
    if not original_name:
        result["skipped"].append({"kind": KIND_INSTRUCT, "reason": "missing name"})
        return
    target_name = _unique_instruct_name(db, user, original_name)

    values: dict[str, Any] = {}
    for st_key, attr in _ST_INSTRUCT_FIELD_MAP.items():
        if st_key not in item:
            continue
        value = item.get(st_key)
        if attr in _INSTRUCT_BOOL_FIELDS:
            values[attr] = bool(value)
        else:
            values[attr] = "" if value is None else str(value)

    template = InstructTemplate(
        user_id=user.id,
        name=target_name,
        **values,
    )
    db.add(template)
    db.flush()

    dropped = _unknown_keys(item, set(_ST_INSTRUCT_FIELD_MAP) | {"name"})
    if dropped:
        result["warnings"].append(
            f"instruct '{original_name}': 字段 {', '.join(dropped)} "
            "在 Palink 无对应存储列，已丢弃"
        )
    result["created"].append(
        {
            "kind": KIND_INSTRUCT,
            "id": template.id,
            "name": target_name,
            "renamed_from": original_name if target_name != original_name else None,
        }
    )


def _import_array_preset(
    db: Session,
    setting: UserSetting,
    user: User,
    kind: str,
    item: dict[str, Any],
    result: dict[str, list],
) -> None:
    key = SYSPROMPT_PRESETS_KEY if kind == KIND_SYSPROMPT else REASONING_PRESETS_KEY
    fields = _ST_SYSPROMPT_FIELDS if kind == KIND_SYSPROMPT else _ST_REASONING_FIELDS
    original_name = str(item.get("name") or "").strip()
    if not original_name:
        result["skipped"].append({"kind": kind, "reason": "missing name"})
        return

    entries = _stored_preset_entries(setting, key, user.id)
    # 去重范围必须包含 builtin：导入一个与自带同名的预设时若直接落地，
    # 合并展示时 builtin 会按名字先占位，导入项将永远不可见。
    builtin_names = (
        {s["name"] for s in BUILTIN_SYSPROMPT_PRESETS}
        if kind == KIND_SYSPROMPT
        else {s["name"] for s in BUILTIN_REASONING_PRESETS}
    )
    existing_names = {str(e.get("name") or "").strip() for e in entries} | builtin_names
    target_name = _unique_array_name(existing_names, original_name)

    entry: dict[str, Any] = {"name": target_name, "builtin": False}
    for field in fields[1:]:
        entry[field] = item.get(field) or ""
    entries.append(entry)
    _write_stored_preset_entries(setting, key, entries, user.id)

    unmappable = _ST_SYSPROMPT_UNMAPPABLE if kind == KIND_SYSPROMPT else set()
    dropped = sorted(set(item.keys()) & unmappable)
    dropped.extend(_unknown_keys(item, set(fields)))
    if dropped:
        result["warnings"].append(
            f"{kind} '{original_name}': 字段 {', '.join(sorted(set(dropped)))} "
            "在 Palink 无对应存储列，已丢弃"
        )
    result["created"].append(
        {
            "kind": kind,
            "id": None,
            "name": target_name,
            "renamed_from": original_name if target_name != original_name else None,
        }
    )


# ---------------------------------------------------------------------------
# 路由
# ---------------------------------------------------------------------------
@router.get("")
def list_preset_library(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """四类预设清单：builtin/系统预置 + 本人。

    顺带幂等补齐自带条目（老库没有 done_file 重跑机会）；补齐失败不阻塞读取。
    """
    _ensure_seeded(db, user)
    return _library_payload(db, user)


@router.post("/ensure-defaults")
def ensure_defaults(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """幂等补齐四类自带条目（对齐 context/instruct 的 ``/ensure-builtin``）。"""
    try:
        counts = ensure_preset_library_seeds(db, user_id=user.id)
        db.commit()
    except Exception as exc:  # noqa: BLE001
        record("preset_library.ensure_defaults", exc, user_id=user.id)
        db.rollback()
        raise HTTPException(500, "Failed to seed preset library") from exc
    return {"ok": True, "counts": counts}


@router.post("/import")
async def import_presets(
    file: UploadFile = File(...),
    kind: Optional[str] = Form(None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """导入预设（单条 / 打包 / ST 原生 JSON），5MB 上限，重名加 ``(imported)``。

    返回 ``created`` / ``skipped`` / ``warnings``。
    """
    content = await file.read(MAX_IMPORT_BYTES)
    if await file.read(1):
        raise HTTPException(413, "File too large (max 5MB)")

    try:
        data = json.loads(content)
    except (json.JSONDecodeError, UnicodeDecodeError, TypeError) as exc:
        record("preset_library.import_json", exc, user_id=user.id)
        raise HTTPException(400, "Invalid JSON file") from exc

    entries = _normalize_payload(data)
    if not entries:
        raise HTTPException(400, "No preset entries found in file")

    hint = kind if kind in VALID_KINDS else None
    result: dict[str, list] = {"created": [], "skipped": [], "warnings": []}
    setting = _get_or_create_setting(db, user.id)

    for item in entries:
        if not isinstance(item, dict):
            result["skipped"].append({"kind": None, "reason": "not an object"})
            continue
        detected = _detect_kind(item, hint)
        if detected is None:
            result["skipped"].append(
                {
                    "kind": None,
                    "name": str(item.get("name") or "") or None,
                    "reason": "unrecognized preset type",
                }
            )
            continue
        if detected == KIND_CONTEXT:
            _import_context(db, user, item, result)
        elif detected == KIND_INSTRUCT:
            _import_instruct(db, user, item, result)
        else:
            _import_array_preset(db, setting, user, detected, item, result)

    try:
        db.commit()
    except IntegrityError as exc:
        # context_templates.name 全局唯一：并发导入可能撞名。
        db.rollback()
        record("preset_library.import_commit", exc, user_id=user.id)
        raise HTTPException(409, "Name conflict while importing, please retry") from exc

    return result


def _find_export_item(db: Session, user: User, kind: str, name_or_id: str) -> Optional[dict[str, Any]]:
    library = _library_payload(db, user)
    candidates = library.get(kind) or []
    value = (name_or_id or "").strip()
    if not value:
        return None
    if value.isdigit():
        target_id = int(value)
        for item in candidates:
            if item.get("id") == target_id:
                return item
    for item in candidates:
        if str(item.get("name") or "") == value:
            return item
    return None


def _context_export_dict(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": item["name"],
        "display_name": item.get("display_name"),
        "story_string": item.get("story_string") or "",
        "chat_start": item.get("chat_start") or "",
        "system_prompt": item.get("system_prompt") or "",
        "jailbreak": item.get("jailbreak") or "",
        "normal_prompt": item.get("normal_prompt") or "",
        "group_prompt": item.get("group_prompt") or "",
        "_palink_kind": KIND_CONTEXT,
        "_palink_version": PALINK_LIBRARY_VERSION,
        "_source": PALINK_SOURCE,
    }


def _instruct_export_dict(item: dict[str, Any]) -> dict[str, Any]:
    """导出成 **ST 原生字段名**，可被 ST 直接导入，也能被本模块原样再导入。"""
    data: dict[str, Any] = {"name": item["name"]}
    for st_key, attr in _ST_INSTRUCT_FIELD_MAP.items():
        data[st_key] = item.get(attr, False if attr in _INSTRUCT_BOOL_FIELDS else "")
    data["_palink_kind"] = KIND_INSTRUCT
    data["_palink_version"] = PALINK_LIBRARY_VERSION
    data["_source"] = PALINK_SOURCE
    return data


def _array_export_dict(kind: str, item: dict[str, Any]) -> dict[str, Any]:
    fields = _ST_SYSPROMPT_FIELDS if kind == KIND_SYSPROMPT else _ST_REASONING_FIELDS
    data: dict[str, Any] = {field: item.get(field) or "" for field in fields}
    data["_palink_kind"] = kind
    data["_palink_version"] = PALINK_LIBRARY_VERSION
    data["_source"] = PALINK_SOURCE
    return data


@router.get("/export")
def export_preset(
    kind: str,
    name: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """导出单条（ST 兼容字段名；``name`` 也可传数字 id）。"""
    if kind not in VALID_KINDS:
        raise HTTPException(400, f"Unknown preset kind: {kind}")
    _ensure_seeded(db, user)
    item = _find_export_item(db, user, kind, name)
    if item is None:
        raise HTTPException(404, "Preset not found")
    if kind == KIND_CONTEXT:
        return _context_export_dict(item)
    if kind == KIND_INSTRUCT:
        return _instruct_export_dict(item)
    return _array_export_dict(kind, item)


@router.get("/export-all")
def export_all_presets(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """导出整库（ST 的 master import 可一次吃下 ``items`` 打包）。"""
    _ensure_seeded(db, user)
    library = _library_payload(db, user)
    items: list[dict[str, Any]] = []
    for item in library[KIND_CONTEXT]:
        items.append(_context_export_dict(item))
    for item in library[KIND_INSTRUCT]:
        items.append(_instruct_export_dict(item))
    for kind in (KIND_SYSPROMPT, KIND_REASONING):
        for item in library[kind]:
            items.append(_array_export_dict(kind, item))
    return {
        "_palink_version": PALINK_LIBRARY_VERSION,
        "_source": PALINK_SOURCE,
        "count": len(items),
        "items": items,
    }


@router.delete("/{kind}/{name_or_id}")
def delete_preset(
    kind: str,
    name_or_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """删除本人/非内置预设。他人的行一律 404（不泄露存在性），内置一律 400。"""
    if kind not in VALID_KINDS:
        raise HTTPException(400, f"Unknown preset kind: {kind}")
    if kind == KIND_CONTEXT:
        return _delete_context(db, user, name_or_id)
    if kind == KIND_INSTRUCT:
        return _delete_instruct(db, user, name_or_id)
    return _delete_array_preset(db, user, kind, name_or_id)


def _delete_context(db: Session, user: User, name_or_id: str) -> dict[str, Any]:
    query = db.query(ContextTemplate)
    row: Optional[ContextTemplate] = None
    value = (name_or_id or "").strip()
    if value.isdigit():
        row = query.filter(ContextTemplate.id == int(value)).first()
    if row is None:
        row = query.filter(ContextTemplate.name == value).first()
    if row is None:
        raise HTTPException(404, "Preset not found")
    if row.is_builtin:
        raise HTTPException(400, "Built-in presets cannot be deleted")
    if row.user_id is None:
        # 历史共享行（无主）只有 admin 能动，普通用户视为不可见。
        if not _is_admin(user):
            raise HTTPException(404, "Preset not found")
    elif row.user_id != user.id:
        raise HTTPException(404, "Preset not found")
    deleted_name = row.name
    db.delete(row)
    db.commit()
    return {"ok": True, "kind": KIND_CONTEXT, "name": deleted_name}


def _delete_instruct(db: Session, user: User, name_or_id: str) -> dict[str, Any]:
    query = db.query(InstructTemplate)
    row: Optional[InstructTemplate] = None
    value = (name_or_id or "").strip()
    if value.isdigit():
        row = query.filter(InstructTemplate.id == int(value)).first()
    if row is None:
        row = (
            query.filter(InstructTemplate.name == value)
            .order_by(InstructTemplate.user_id.is_(None).asc())
            .first()
        )
    if row is None:
        raise HTTPException(404, "Preset not found")
    if row.user_id is None:
        raise HTTPException(400, "System presets cannot be deleted")
    if row.user_id != user.id:
        raise HTTPException(404, "Preset not found")
    deleted_name = row.name
    db.delete(row)
    db.commit()
    return {"ok": True, "kind": KIND_INSTRUCT, "name": deleted_name}


def _delete_array_preset(db: Session, user: User, kind: str, name_or_id: str) -> dict[str, Any]:
    key = SYSPROMPT_PRESETS_KEY if kind == KIND_SYSPROMPT else REASONING_PRESETS_KEY
    target_name = (name_or_id or "").strip()
    builtin_names = (
        {s["name"] for s in BUILTIN_SYSPROMPT_PRESETS}
        if kind == KIND_SYSPROMPT
        else {s["name"] for s in BUILTIN_REASONING_PRESETS}
    )
    # 自带条目即便还没落进用户数组，也属"内置不可删"（删了下次 GET 又播种回来）。
    if target_name in builtin_names:
        raise HTTPException(400, "Built-in presets cannot be deleted")

    setting = db.query(UserSetting).filter(UserSetting.user_id == user.id).first()
    entries = _stored_preset_entries(setting, key, user.id)

    match_index: Optional[int] = None
    for idx, entry in enumerate(entries):
        if str(entry.get("name") or "").strip() == target_name:
            match_index = idx
            break
    if match_index is None:
        raise HTTPException(404, "Preset not found")
    if bool(entries[match_index].get("builtin")):
        raise HTTPException(400, "Built-in presets cannot be deleted")

    entries.pop(match_index)
    _write_stored_preset_entries(setting, key, entries, user.id)
    db.commit()
    return {"ok": True, "kind": kind, "name": target_name}
