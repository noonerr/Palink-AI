"""会话级提示词预设覆盖层（写时复制 / copy-on-write）。

用户 2026-10-20 裁定（覆盖"与 ST 冲突以 ST 为准"总则）：
预设改成**每对话一份分身** —— 进卡时默认取全局那份；卡片改的是"本对话这份"；
改了**不回写全局**；卡片只能读写自己这份。

ST 侧语义（一手核对，`_reference/sillytavern-1.18.0`）：
- 内容：全局对象表 `openai_settings[openai_setting_names[name]]`（`public/scripts/openai.js:4750`）
- 选中：全局字段 `oai_settings.preset_settings_openai`（`:404` 默认 'Default'、`:4509`/`:4728` 写入）
⇒ ST 是"全局内容 + 全局选择"，**没有** per-chat 维度。本模块是**有意偏离**，别被后人当 bug 修回去。

落点（**不动表结构**）：
复用既有 `chat_variables`（`session_id` + `key` 唯一，`models/chat_variable.py`）存一行覆盖层 JSON。
- 未改动 ⇒ 无行 ⇒ 读全局（不产生副本，这就是"写时复制"的"写时才复制"）
- 改一次 ⇒ 生成本对话私有行（`base_*` 记"我在哪份之上改的"）
- 删除覆盖层 ⇒ 回到全局

覆盖层行的 key 带 `__palink_internal_` 前缀，ST 兼容层把 ChatVariable 合进
`chat_metadata.variables` 时会跳过该前缀（`api/silly_tavern.py` 的合并循环），
避免内部簿记出现在卡可见的变量表里。
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from ..models import CharacterChatSession, ChatSession, ChatVariable, GenerationPreset, UserSetting

# [批次P3 P3-B 2026-10-21] 数据源**改指** `generation_presets`。
#
# 主脑实机取证（`docs/_active/report/REPORT_上线实测_包P与批次Q1与批次P2_2026-10-21.md` §2.2）：
#   `select count(*) from prompt_presets` = **0**（全库，不是只有当前用户空）；
#   `select count(*) from generation_presets` = **27**；
#   用户看得见的预设界面（`PresetManager.tsx` / `PresetSelector.tsx`）走
#   `/api/roleplay/presets` → `backend/app/api/presets.py:14` 的 `GenerationPreset`。
# ⇒ 包P 的覆盖层 / P2-2 的选中名 / P2-3 的三键整条链原先建在一张**没有一行数据、
#   也没有第一方界面**的表上，用户 2026-10-20 的裁定（"默认刚进卡是设置里自己的那份"）
#   指向的是 `generation_presets` ⇒ **不改指就违反裁定**，这是纠错不是优化。
#
# ⚠️ **共享行红线**（同报告 §2.6 新增）：`api/presets.py:114-115` 的列表条件含
# `GenerationPreset.user_id == None` ⇒ 库里可能存在**跨用户共享**的预设行。
# 卡片侧派生数据**只读**当前用户自己那份；任何写/删通道**严禁**落到
# `user_id IS NULL` 的共享行上（改了会影响别人的账号）。
# 实现上靠"所有查询一律 `user_id == :user_id`"这一条兜住 —— SQL 里
# `user_id = :x` 天然排除 NULL 行，不需要额外的 IS NOT NULL 条件。
PRESET_STORE = "generation_presets"

# 覆盖层行在 chat_variables 里的 key（前缀是内部簿记约定，见模块 docstring）
OVERLAY_KEY = "__palink_internal_preset_overlay_v1"
INTERNAL_KEY_PREFIX = "__palink_internal_"

# ---------------------------------------------------------------------------
# [批次P2 P2-2 2026-10-21] "用户选中哪份全局预设"的落点 —— **零迁移**。
#
# ST 侧把选中名记在全局 settings（`openai.js:404` 默认 'Default'、`:4509`/`:4728`
# 写 `oai_settings.preset_settings_openai`），本仓对应层就是 `UserSetting` 的 JSON 列。
# 落点选 `silly_tavern_settings`（不是 `power_user`）的理由：
#   · 它是本仓**唯一**被 ST 设置链路整体读写的那一坨（`silly_tavern.py` 的
#     `/api/settings/get` / `/api/settings/save`），ST 自己的 `oai_settings` 就住在这里；
#   · `power_user` 的语义是 ST 的 UI 偏好对象（字号/主题/人名行为），把"选中哪份预设"
#     塞进去会让 `_sync_personas_from_power_user` 之类的语义搬运逻辑误读它。
# 命名空间用 Palink 自己的键名，**不伪装成 ST 的 `preset_settings_openai`**：
# 那个字段指向 ST 的 openai_settings 对象表，而我们的预设是 `prompt_presets` 行，
# 名字空间不同 ⇒ 借用 ST 键名只会让后人对错表。
# ⚠️ 这是**有意偏离**（ST 无 per-chat 维度，见模块 docstring），别当 bug 修回去。
SELECTION_NAMESPACE = "palink_prompt_preset"
SELECTION_FIELD = "selected_name"


# ---------------------------------------------------------------------------
# [批次P3 P3-B 2026-10-21] `GenerationPreset` 的**归属查询**唯一入口。
#
# 谁都不许绕过这两个函数直接 `db.query(GenerationPreset)`：绕过一次就可能把
# `user_id IS NULL` 的共享行算进来（读是数据污染，写是动到别人的账号）。
# id 统一按字符串对外（`base_preset_id` 走 JSON 进覆盖层行），内部解析成 int。
# ---------------------------------------------------------------------------
def _coerce_generation_preset_id(raw: Any) -> Optional[int]:
    """`base_preset_id` 对外是字符串（JSON 友好），库里 `GenerationPreset.id` 是 Integer。"""
    if raw is None or isinstance(raw, bool):
        return None
    if isinstance(raw, int):
        return raw
    text = str(raw).strip()
    if not text:
        return None
    try:
        return int(text)
    except (TypeError, ValueError):
        return None


def owned_generation_presets(db: Session, user_id: int):
    """当前用户**自己**的预设查询（永不含 `user_id IS NULL` 的共享行）。"""
    return db.query(GenerationPreset).filter(GenerationPreset.user_id == user_id)


def resolve_owned_generation_preset_by_id(
    db: Session, user_id: int, preset_id: Any
) -> Optional[GenerationPreset]:
    """按 id 取**本人**那份；id 不是 `generation_presets` 的行（含共享行）⇒ None。"""
    pid = _coerce_generation_preset_id(preset_id)
    if pid is None:
        return None
    return owned_generation_presets(db, user_id).filter(GenerationPreset.id == pid).first()


class PresetOverlayError(Exception):
    """覆盖层操作的业务错误（路由层翻成 HTTP 状态码）。"""

    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code
        self.message = message or code


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _loads(raw: Optional[str]) -> Any:
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None


def require_owned_session(db: Session, session_id: str, user_id: int):
    """只认当前登录用户自己的会话；他人会话一律 404（不泄露存在性）。

    [批次P2 P2-2 2026-10-21 修正] 两张会话表都要认：
      · `CharacterChatSession`（`character_chat_sessions`）—— **卡片真正用的那张**
        （`Message.tsx:2038` 传的 `selectedSession.id`，`useCharacterChat.ts:38`
        的类型就是 `CharacterChatSession`）；`_chat_header` 与
        `/api/variables/local/{sid}` 也都按这张表校验。
      · `ChatSession`（`sessions`）—— 通用聊天会话表，P-1 首版只认这张
        ⇒ 真卡片的 session_id 进来一律 404，覆盖层路由对卡**不可达**（见批次P2 报告
        「否证主脑」段）。保留它是为了不打断 P-1 已入库的调用方与测试。
    两张表都按 `user_id` 过滤 ⇒ 不存在"用别人的 id 命中另一张表"的越权面。
    """
    sid = str(session_id or "").strip()
    if sid:
        session = (
            db.query(CharacterChatSession)
            .filter(CharacterChatSession.id == sid, CharacterChatSession.user_id == user_id)
            .first()
        )
        if session is not None:
            return session
        session = (
            db.query(ChatSession)
            .filter(ChatSession.id == sid, ChatSession.user_id == user_id)
            .first()
        )
        if session is not None:
            return session
    raise PresetOverlayError("session_not_found", "Session not found")


def get_overlay_row(db: Session, session_id: str) -> Optional[ChatVariable]:
    return (
        db.query(ChatVariable)
        .filter(ChatVariable.session_id == session_id, ChatVariable.key == OVERLAY_KEY)
        .first()
    )


def get_overlay(db: Session, session_id: str) -> Optional[Dict[str, Any]]:
    row = get_overlay_row(db, session_id)
    if row is None:
        return None
    data = _loads(row.value)
    return data if isinstance(data, dict) else None


def _get_or_create_user_setting(db: Session, user_id: int) -> UserSetting:
    setting = db.query(UserSetting).filter(UserSetting.user_id == user_id).first()
    if setting is None:
        setting = UserSetting(user_id=user_id)
        db.add(setting)
        db.commit()
        db.refresh(setting)
    return setting


def _selection_namespace(db: Session, user_id: int) -> Dict[str, Any]:
    setting = db.query(UserSetting).filter(UserSetting.user_id == user_id).first()
    if setting is None:
        return {}
    blob = _loads(setting.silly_tavern_settings)
    if not isinstance(blob, dict):
        return {}
    namespace = blob.get(SELECTION_NAMESPACE)
    return namespace if isinstance(namespace, dict) else {}


def get_selected_preset_name(db: Session, user_id: int) -> Optional[str]:
    """用户选中的全局预设名；从未选过 ⇒ None（由调用方回落）。"""
    raw = _selection_namespace(db, user_id).get(SELECTION_FIELD)
    if isinstance(raw, str) and raw.strip():
        return raw.strip()
    return None


def set_selected_preset_name(db: Session, user_id: int, name: Optional[str]) -> Optional[str]:
    """记住/清除"选中的预设名"。**只写 UserSetting 的既有 JSON 列，不建表不加列。**

    `name=None` 或空串 ⇒ 清除选择（回到"从未选过"的回落口径）。
    选中一份**不属于自己**或**不存在**的预设 ⇒ `PresetOverlayError("preset_not_found")`，
    绝不静默接受一个永远解析不到的名字。

    [批次P3 P3-B 2026-10-21] 名字的校验表随数据源一起改指 `generation_presets`
    —— 键位（`UserSetting.silly_tavern_settings` 的 `palink_prompt_preset.selected_name`）
    不变、零迁移；变的是"这个名字要能在 `generation_presets` 里解析到本人那份"。
    ⛔ 共享行不算候选：选中一份 `user_id IS NULL` 的共享预设同样 404。
    """
    wanted = (name or "").strip() or None
    if wanted is not None:
        exists = owned_generation_presets(db, user_id).filter(
            GenerationPreset.name == wanted
        ).first()
        if exists is None:
            raise PresetOverlayError("preset_not_found", "Preset not found")

    setting = _get_or_create_user_setting(db, user_id)
    blob = _loads(setting.silly_tavern_settings)
    if not isinstance(blob, dict):
        blob = {}
    namespace = blob.get(SELECTION_NAMESPACE)
    if not isinstance(namespace, dict):
        namespace = {}
    if wanted is None:
        namespace.pop(SELECTION_FIELD, None)
    else:
        namespace[SELECTION_FIELD] = wanted
    if namespace:
        blob[SELECTION_NAMESPACE] = namespace
    else:
        blob.pop(SELECTION_NAMESPACE, None)
    setting.silly_tavern_settings = json.dumps(blob, ensure_ascii=False)
    db.commit()
    return wanted


def resolve_global_preset(db: Session, user_id: int) -> Optional[GenerationPreset]:
    """"全局默认那份" = **用户选中的那份**。

    [批次P2 P2-2 2026-10-21] P-1 首版这里取"`updated_at` 最新那份"并在 docstring 里
    自认是已知偏差（"等'全局选中名'有落点时只改这一处"）—— 本函数就是那个落点。
    [批次P3 P3-B 2026-10-21] 解析表由 `prompt_presets` 改指 `generation_presets`
    （理由见文件头 PRESET_STORE 那段）；**三层回落语义一字未改**，只换表。

    回落口径（三层，写进批次P2 报告）：
      1. 选中的名字能解析到本人的预设 ⇒ 用它（同名多行时取 `updated_at` 最新那行；
         本表无 (user_id,name) 唯一约束）；
      2. 选中名解析不到（预设被删/改名，或从未选过）⇒ 回落"最近更新的那份"，
         即 P-1 的旧口径 —— 这是**兼容回落**，不是新语义；
      3. 本人一份预设都没有 ⇒ None（与旧口径一致，不造默认预设）。

    ⛔ 三层全部只认 `user_id == user_id` 的行 ⇒ `user_id IS NULL` 的共享行
    **永不参与**回落（共享行不属任何人，拿它当"全局默认"等于把别人的配置当默认）。
    """
    selected = get_selected_preset_name(db, user_id)
    if selected:
        chosen = owned_generation_presets(db, user_id).filter(
            GenerationPreset.name == selected
        ).order_by(GenerationPreset.updated_at.desc()).first()
        if chosen is not None:
            return chosen
    return owned_generation_presets(db, user_id).order_by(
        GenerationPreset.updated_at.desc()
    ).first()


def resolve_global_preset_source(db: Session, user_id: int) -> str:
    """`resolve_global_preset` 的结果来自哪一层：`selected` / `fallback` / `none`。

    只读，供 `/api/prompt-manager/presets/selection` 与报告对账用；卡片不需要它。
    取值含义随 P3-B 同步：仍是"命中选中名 / 回落最近更新 / 一份都没有"三层，
    只是"有没有"现在按 `generation_presets` 判。
    """
    selected = get_selected_preset_name(db, user_id)
    if selected:
        chosen = owned_generation_presets(db, user_id).filter(
            GenerationPreset.name == selected
        ).order_by(GenerationPreset.updated_at.desc()).first()
        if chosen is not None:
            return "selected"
    if (
        owned_generation_presets(db, user_id)
        .order_by(GenerationPreset.updated_at.desc())
        .first()
        is not None
    ):
        return "fallback"
    return "none"


def _preset_view(preset: Optional[GenerationPreset]) -> Optional[Dict[str, Any]]:
    """`GenerationPreset` 行 → 卡片桥的内部视图。

    `entries` ← `prompts_data`（ST 的 prompts 数组，真数据）；
    `config`  ← 生成参数那一坨（ST 的 settings，真数据）。
    `id` 一律字符串化：它要进覆盖层行的 JSON，也进 API 响应。
    """
    if preset is None:
        return None
    return {
        "id": str(preset.id),
        "name": preset.name,
        "entries": _loads(preset.prompts_data) or [],
        "config": {
            "temperature": preset.temperature,
            "top_p": preset.top_p,
            "max_tokens": preset.max_tokens,
            "frequency_penalty": preset.frequency_penalty,
            "presence_penalty": preset.presence_penalty,
            "min_p": preset.min_p,
            "top_k": preset.top_k,
            "repetition_penalty": preset.repetition_penalty,
            "system_prompt_override": preset.system_prompt_override,
            "post_history_instructions": preset.post_history_instructions,
            "ban_sequences": _loads(preset.ban_sequences) or [],
            "logit_bias": _loads(preset.logit_bias) or {},
            "context_template_name": preset.context_template_name,
        },
    }


def effective_preset(db: Session, user_id: int, session_id: str) -> Dict[str, Any]:
    """本对话当前生效的预设（读路径，永不写库）。

    返回     `source`：`session`（本对话有覆盖层）或 `global`（未改动，读全局默认）。
    `base` 是覆盖层所基于的全局预设名（`source=global` 时为 null）。
    `base_store` 是 `base_preset_id` 属于哪张表（**[批次P3]** 固定 `generation_presets`）
    —— 不加这个字段，下一个人看到一串数字 id 只能去猜是哪张表。
    """
    overlay = get_overlay(db, session_id)
    if overlay is not None:
        return {
            "source": "session",
            "name": overlay.get("name"),
            "base_preset_id": overlay.get("base_preset_id"),
            "base_name": overlay.get("base_name"),
            "base_store": PRESET_STORE,
            "entries": overlay.get("entries") or [],
            "config": overlay.get("config"),
            "updated_at": overlay.get("updated_at"),
            # 可见性（P-3）：卡片设置里据此显示"本对话副本"
            "is_session_copy": True,
        }
    global_preset = resolve_global_preset(db, user_id)
    view = _preset_view(global_preset)
    return {
        "source": "global",
        "name": view["name"] if view else None,
        "base_preset_id": view["id"] if view else None,
        "base_name": view["name"] if view else None,
        "base_store": PRESET_STORE,
        "entries": view["entries"] if view else [],
        "config": view["config"] if view else None,
        "updated_at": None,
        "is_session_copy": False,
    }


def _st_preset_shape(view: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """内部视图 → ST `Preset` 形状（`{settings, prompts, prompts_unused, extensions}`）。

    **只做形状搬运，不造字段**：prompts ← entries、settings ← config 两格是真数据；
    `prompts_unused` / `extensions` 本仓没有对应概念 ⇒ 是空容器而不是假默认
    （批次P2 已立的口径，P3 保持不变；因此 `isPreset*` 三键继续留 D）。
    """
    if not view:
        return {"settings": {}, "prompts": [], "prompts_unused": [], "extensions": {}}
    config = view.get("config")
    entries = view.get("entries")
    return {
        "settings": config if isinstance(config, dict) else {},
        "prompts": entries if isinstance(entries, list) else [],
        "prompts_unused": [],
        "extensions": {},
    }


def build_preset_snapshot(
    db: Session, user_id: int, session_id: Optional[str] = None
) -> Dict[str, Any]:
    """帧内预设三键的**快照**（批次P3 / P3-A，只读）。

    ST 的三键契约是**同步**的（`preset.d.ts:150` `getPresetNames(): string[]`），
    而帧内唯一的数据通道（requestParent）是异步的 ⇒ 帧拿不到同步值。
    解法（主脑定的路线）：宿主把快照带进帧内 ctx，三键**同步读快照**。
    服务器在这里一次算好整份快照（名单 + 当前生效份 + 按名索引），
    省掉帧内多次往返，也保证"名单"与"按名解析"同源。

    ⛔ 只列**本人**的预设（`user_id IS NULL` 的共享行不进名单、也不进按名索引）：
    卡片侧只读当前用户自己那份的派生数据（共享行红线，见文件头）。

    `session_id` 给了就按"本对话当前生效那份"算 `in_use`（他人会话 ⇒ 404，
    由 `require_owned_session` 抛）；没给就按全局选中份算。
    """
    rows = owned_generation_presets(db, user_id).order_by(
        GenerationPreset.is_default.desc(), GenerationPreset.name
    ).all()
    names: list = []
    presets: Dict[str, Any] = {}
    for row in rows:
        view = _preset_view(row)
        if not view or not view.get("name"):
            continue
        name = str(view["name"])
        if name in presets:
            continue  # 同名多行：只留第一条（与列表顺序同源）
        presets[name] = _st_preset_shape(view)
        names.append(name)

    if session_id:
        require_owned_session(db, session_id, user_id)
        effective = effective_preset(db, user_id, session_id)
    else:
        global_view = _preset_view(resolve_global_preset(db, user_id))
        effective = {
            "source": "global",
            "name": global_view["name"] if global_view else None,
            "base_name": global_view["name"] if global_view else None,
            "entries": global_view["entries"] if global_view else [],
            "config": global_view["config"] if global_view else None,
        }

    loaded_name = effective.get("base_name") or effective.get("name") or None
    has_effective = effective.get("name") is not None or bool(effective.get("entries"))
    return {
        "store": PRESET_STORE,
        "names": names,
        "loaded_name": loaded_name if loaded_name else None,
        # 一份预设都没有 ⇒ in_use 是 null（帧内据此返回 null + 留痕，不造 'Default'）
        "in_use": _st_preset_shape(effective) if has_effective else None,
        "presets": presets,
        "source": effective.get("source") or "global",
    }


def _write_overlay(db: Session, session_id: str, overlay: Dict[str, Any]) -> Dict[str, Any]:
    row = get_overlay_row(db, session_id)
    payload = json.dumps(overlay, ensure_ascii=False)
    if row is None:
        row = ChatVariable(session_id=session_id, key=OVERLAY_KEY, value=payload)
        db.add(row)
    else:
        row.value = payload
    db.commit()
    return overlay


def write_overlay(
    db: Session,
    user_id: int,
    session_id: str,
    *,
    name: Optional[str] = None,
    entries: Optional[list] = None,
    config: Optional[dict] = None,
    base_preset_id: Optional[str] = None,
    base_name: Optional[str] = None,
) -> Dict[str, Any]:
    """写时复制：**首次写**才把全局那份复制成本对话私有份。

    之后的写只落在本对话这一行上；`generation_presets` 表一行都不动（越权面与
    "回写全局"面都由这一点兜住，测试 `test_preset_overlay_no_global_writeback` 钉死）。

    [批次P3 P3-B 2026-10-21] 换基的底座改解析 `GenerationPreset`。
    ⛔ **共享行红线**：`base_preset_id` 指向 `user_id IS NULL` 的共享行 ⇒ 一律
    `preset_not_found`（路由层翻 404）。共享行是跨用户共用的，允许卡片把它复制成
    "本对话副本"虽不直接改到那一行，但会让"改预设"这个动作在别人的账号上产生
    派生数据 ⇒ 本批按"不许静默生效"处理，直接拒。
    """
    overlay = get_overlay(db, session_id)
    if overlay is None:
        # —— 写时复制发生在这里 ——
        if base_preset_id is not None or base_name is not None:
            base = None
            if base_preset_id:
                base = resolve_owned_generation_preset_by_id(db, user_id, base_preset_id)
                if base is None:
                    raise PresetOverlayError("preset_not_found", "Preset not found")
            elif base_name:
                base = owned_generation_presets(db, user_id).filter(
                    GenerationPreset.name == base_name
                ).order_by(GenerationPreset.updated_at.desc()).first()
                if base is None:
                    raise PresetOverlayError("preset_not_found", "Preset not found")
            base_view = _preset_view(base)
        else:
            base_view = _preset_view(resolve_global_preset(db, user_id))
        overlay = {
            "name": name or (base_view["name"] if base_view else None),
            "base_preset_id": base_view["id"] if base_view else None,
            "base_name": base_view["name"] if base_view else None,
            "entries": (base_view["entries"] if base_view else []) if entries is None else entries,
            "config": (base_view["config"] if base_view else None) if config is None else config,
            "created_at": _utc_now_iso(),
        }
    else:
        if name is not None:
            overlay["name"] = name
        if entries is not None:
            overlay["entries"] = entries
        if config is not None:
            overlay["config"] = config
        if base_preset_id is not None or base_name is not None:
            # 显式换基：把另一份全局预设复制进本对话（仍是复制，不是引用）
            base = None
            if base_preset_id:
                base = resolve_owned_generation_preset_by_id(db, user_id, base_preset_id)
            elif base_name:
                base = owned_generation_presets(db, user_id).filter(
                    GenerationPreset.name == base_name
                ).order_by(GenerationPreset.updated_at.desc()).first()
            if base is None:
                raise PresetOverlayError("preset_not_found", "Preset not found")
            base_view = _preset_view(base)
            overlay["base_preset_id"] = base_view["id"]
            overlay["base_name"] = base_view["name"]
            overlay["name"] = base_view["name"]
            overlay["entries"] = base_view["entries"]
            overlay["config"] = base_view["config"]
    overlay["updated_at"] = _utc_now_iso()
    _write_overlay(db, session_id, overlay)
    return effective_preset(db, user_id, session_id)


def drop_overlay(db: Session, session_id: str) -> Dict[str, Any]:
    """丢弃本对话副本 ⇒ 回到全局默认（"未改动"状态）。"""
    row = get_overlay_row(db, session_id)
    if row is not None:
        db.delete(row)
        db.commit()
    return {"ok": True, "dropped": row is not None}
