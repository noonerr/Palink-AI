"""预设模板库自带默认条目（中文自写，**不含 SillyTavern 版权文本**）。

## 为什么单独一份

用户 2026-10-25 拍板："做一个预设库，学 ST、把 ST 的预设引进来更好"。因此本库
支持 ST 原生 JSON 导入（见 ``app/api/preset_library.py``），但**自带默认必须是
我们自己写的中文**——ST 仓库里的 preset 正文（story_string / sysprompt 等）有
版权，不许打进本仓。本文件里的每一条文本均为自写，与 ST 原文无逐句对应关系。

## 四类落点

| kind       | 落点                                | 归属                          |
|------------|-------------------------------------|-------------------------------|
| context    | ``context_templates`` 表            | ``user_id IS NULL`` + builtin |
| instruct   | ``instruct_templates`` 表           | ``user_id IS NULL``（系统预置）|
| sysprompt  | ``user_settings.silly_tavern_settings[SYSPROMPT_PRESETS_KEY]`` | 按用户 |
| reasoning  | ``user_settings.silly_tavern_settings[REASONING_PRESETS_KEY]`` | 按用户 |

sysprompt / reasoning 没有专表（见 ``services/st_power_user_defaults.py`` 的
``sysprompt`` / ``reasoning`` 默认块：那是 ST 设置对象的**当前选中值**，不是
预设集合）。本库另起两个**数组键**存"可选集合"，与 ST 的选中值互不影响。

## 幂等与"不覆盖用户值"

``ensure_preset_library_seeds(db, user_id=...)``：
  · context / instruct：按 name 查；不存在则插入；已存在且是 builtin/系统预置
    则刷新字段（种子改错字能生效）；**绝不改用户自建行**。
  · sysprompt / reasoning：只在用户数组里**追加缺失的同名条目**，已有同名条目
    一律原样保留（用户改过的内容不会被种子回滚）。
  · 重复调用返回的 created 计数为 0（测试 ``test_seed_idempotent`` 钉这条）。

⚠️ 本模块只提供数据 + 播种函数；**不要在 import 期碰 DB / 模型**（main.py 与
API 层在不同时机调用，import 期副作用会拖慢启动并制造循环导入）。
"""
from __future__ import annotations

import json
import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)

# sysprompt / reasoning 在 UserSetting.silly_tavern_settings 里的数组键。
# 命名与 ST 的 `power_user.sysprompt` / `power_user.reasoning`（单选对象）区分开：
# 那是"当前选中值"，这里是"可选集合"。
SYSPROMPT_PRESETS_KEY = "sysprompt_presets"
REASONING_PRESETS_KEY = "reasoning_presets"

# 本库写入的数组条目都用 builtin 标记区分"自带"与"导入/自建"（删除时只认后者）。
BUILTIN_FLAG = "builtin"


# ---------------------------------------------------------------------------
# context（2 条）—— 落 context_templates
# ---------------------------------------------------------------------------
BUILTIN_CONTEXT_PRESETS: list[dict[str, Any]] = [
    {
        "name": "Palink·沉浸叙事",
        "display_name": "沉浸叙事（中文）",
        "is_builtin": True,
        # story_string 目前不被 palink-native 装配消费（chat completion 模式），
        # 保留它是为 ST 侧/插件侧的形状完整性；真正生效的是 system_prompt。
        "story_string": (
            "【角色档案】\n{{description}}\n\n"
            "【性格与表达】\n{{personality}}\n\n"
            "【场景设定】\n{{scenario}}"
        ),
        "chat_start": "",
        "system_prompt": (
            "以上是本轮对话的设定背景。请始终以 {{char}} 的身份说话和行动，"
            "语气、习惯与设定保持一致；不要替 {{user}} 决定言行或内心想法，"
            "也不要跳出角色做旁白式总结。"
        ),
        "jailbreak": "",
        "normal_prompt": "",
        "group_prompt": "",
    },
    {
        "name": "Palink·极简",
        "display_name": "极简（中文）",
        "is_builtin": True,
        "story_string": "{{description}}\n{{personality}}\n{{scenario}}",
        "chat_start": "",
        # 极简 = 只加一句身份约束，不额外注入设定块。
        "system_prompt": "以 {{char}} 的身份继续对话。",
        "jailbreak": "",
        "normal_prompt": "",
        "group_prompt": "",
    },
]

# ---------------------------------------------------------------------------
# instruct（2 条）—— 落 instruct_templates（user_id NULL = 系统预置）
#
# ⚠️ 序列里**不要写 {{user}} / {{char}} 宏**：装配层是在宏求值之后才套
# InstructTemplate 序列的（roleplay_prompt_assembly.py:4863-4864），宏不会被替换，
# 会原样发给模型。system_prompt 同理是原样注入（同文件 :4887-4901）。
# ---------------------------------------------------------------------------
BUILTIN_INSTRUCT_PRESETS: list[dict[str, Any]] = [
    {
        "name": "Palink·对话体",
        "user_id": None,
        "system_prompt": (
            "请以角色的身份与用户对话：只输出角色本人的话语和必要的神态动作，"
            "不要写旁白式总结，也不要替用户说话。"
        ),
        "input_prefix": "用户：",
        "input_suffix": "\n",
        "output_prefix": "角色：",
        "output_suffix": "\n",
        "first_output_prefix": "",
        "last_output_prefix": "",
        # 旧字段留空，统一走 ST 1.18 的 system_sequence/system_suffix。
        "system_sequence_prefix": "",
        "system_sequence_suffix": "",
        "system_sequence": "设定：",
        "system_suffix": "\n",
        "last_system_sequence": "",
        "first_input_sequence": "",
        "last_input_sequence": "",
        "user_alignment_message": "",
        "story_string_prefix": "",
        "story_string_suffix": "",
        "stop_sequence": "\n用户：",
        "separator_sequence": "\n",
        "wrap_sequences": True,
        "skip_examples": False,
        # 前缀里已经带了说话人标签，不再额外注入名字。
        "names_behavior": "none",
        "macro": False,
        "system_same_as_user": False,
        "sequences_as_stop_strings": True,
        "is_default": False,
    },
    {
        "name": "Palink·小说正文体",
        "user_id": None,
        "system_prompt": (
            "请以小说正文的方式叙述故事：动作、神态与环境描写自然融入段落，"
            "对话用引号。始终保持角色设定，不要替用户决定行动或感受。"
        ),
        "input_prefix": "【用户】\n",
        "input_suffix": "\n\n",
        "output_prefix": "【角色】\n",
        "output_suffix": "\n\n",
        "first_output_prefix": "",
        "last_output_prefix": "",
        "system_sequence_prefix": "",
        "system_sequence_suffix": "",
        "system_sequence": "【设定】\n",
        "system_suffix": "\n\n",
        "last_system_sequence": "",
        "first_input_sequence": "",
        "last_input_sequence": "",
        "user_alignment_message": "",
        "story_string_prefix": "",
        "story_string_suffix": "",
        "stop_sequence": "\n\n【用户】",
        "separator_sequence": "\n\n",
        "wrap_sequences": True,
        "skip_examples": False,
        "names_behavior": "none",
        "macro": False,
        "system_same_as_user": False,
        "sequences_as_stop_strings": True,
        "is_default": False,
    },
]

# ---------------------------------------------------------------------------
# sysprompt（4 条）—— 落 silly_tavern_settings.sysprompt_presets
# ---------------------------------------------------------------------------
BUILTIN_SYSPROMPT_PRESETS: list[dict[str, Any]] = [
    {
        "name": "沉浸第一人称",
        "content": (
            "你是{{char}}。请始终以第一人称说话和思考，用当下的感官细节（所见、"
            "所闻、触感、身体反应）推进场景，让读者有身临其境之感。只描写你能"
            "感知到的内容，不写全知视角的旁白。"
        ),
    },
    {
        "name": "旁白叙事",
        "content": (
            "你是一名冷静的旁白，用第三人称叙述{{char}}与{{user}}之间发生的事。"
            "可以描写环境、动作与{{char}}的状态，但不替{{user}}做决定，也不写"
            "{{user}}的内心独白。"
        ),
    },
    {
        "name": "轻松休闲",
        "content": (
            "保持轻松、口语化的语调，节奏明快，多用日常细节和小幽默。避免沉重"
            "话题与过长段落，让对话像朋友闲聊一样自然。"
        ),
    },
    {
        "name": "严谨考据",
        "content": (
            "叙述与回答都要保持考据严谨：涉及事实、术语、年代与既有设定时优先"
            "准确，不确定处直接说明，不编造细节。描写保持克制、精确。"
        ),
    },
]

# ---------------------------------------------------------------------------
# reasoning（2 条）—— 落 silly_tavern_settings.reasoning_presets
# ---------------------------------------------------------------------------
BUILTIN_REASONING_PRESETS: list[dict[str, Any]] = [
    {
        "name": "标准思考",
        "prefix": "<think>",
        "suffix": "</think>",
        "separator": "\n",
    },
    {
        "name": "显式分步",
        "prefix": "【推理】\n",
        "suffix": "\n【回应】\n",
        "separator": "\n---\n",
    },
]


def _seed_sysprompt_entry(seed: dict[str, Any]) -> dict[str, Any]:
    entry = dict(seed)
    entry[BUILTIN_FLAG] = True
    return entry


def _seed_reasoning_entry(seed: dict[str, Any]) -> dict[str, Any]:
    entry = dict(seed)
    entry[BUILTIN_FLAG] = True
    return entry


def _load_settings_dict(raw: Optional[str]) -> dict[str, Any]:
    """容错解析 silly_tavern_settings；坏 JSON 落一条静默失败记录后按空对象处理。"""
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except (TypeError, ValueError) as exc:
        from .silent_failure import record

        record("preset_library.seed_settings_json", exc)
        return {}
    return data if isinstance(data, dict) else {}


def _ensure_global_builtin_templates(db) -> dict[str, int]:
    """context / instruct 内置行：插入缺失项，刷新 builtin 行，绝不动用户行。"""
    from ..models import ContextTemplate, InstructTemplate

    counts = {"context_created": 0, "context_updated": 0, "instruct_created": 0, "instruct_updated": 0}

    for seed in BUILTIN_CONTEXT_PRESETS:
        existing = (
            db.query(ContextTemplate)
            .filter(ContextTemplate.name == seed["name"])
            .first()
        )
        if existing is None:
            db.add(ContextTemplate(**seed))
            counts["context_created"] += 1
            continue
        # 同名用户行抢注了种子名（历史数据）——不覆盖，交给导入侧改名逻辑。
        if not bool(existing.is_builtin):
            continue
        changed = False
        for key, value in seed.items():
            if getattr(existing, key, None) != value:
                setattr(existing, key, value)
                changed = True
        if changed:
            counts["context_updated"] += 1

    for seed in BUILTIN_INSTRUCT_PRESETS:
        existing = (
            db.query(InstructTemplate)
            .filter(
                InstructTemplate.user_id.is_(None),
                InstructTemplate.name == seed["name"],
            )
            .first()
        )
        if existing is None:
            db.add(InstructTemplate(**seed))
            counts["instruct_created"] += 1
            continue
        changed = False
        for key, value in seed.items():
            if getattr(existing, key, None) != value:
                setattr(existing, key, value)
                changed = True
        if changed:
            counts["instruct_updated"] += 1

    return counts


def _ensure_user_preset_arrays(db, user_id: int) -> dict[str, int]:
    """sysprompt / reasoning 数组：只追加缺失同名条目，不覆盖已有值。"""
    from ..models import UserSetting

    counts = {"sysprompt_created": 0, "reasoning_created": 0}

    setting = db.query(UserSetting).filter(UserSetting.user_id == user_id).first()
    if setting is None:
        setting = UserSetting(user_id=user_id, silly_tavern_settings="{}")
        db.add(setting)
        db.flush()

    stored = _load_settings_dict(setting.silly_tavern_settings)
    changed = False

    for key, seeds, builder in (
        (SYSPROMPT_PRESETS_KEY, BUILTIN_SYSPROMPT_PRESETS, _seed_sysprompt_entry),
        (REASONING_PRESETS_KEY, BUILTIN_REASONING_PRESETS, _seed_reasoning_entry),
    ):
        original = stored.get(key)
        bucket = list(original) if isinstance(original, list) else []
        original_was_list = isinstance(original, list)
        names = {
            str(item.get("name") or "").strip()
            for item in bucket
            if isinstance(item, dict)
        }
        for seed in seeds:
            if seed["name"] in names:
                continue
            bucket.append(builder(seed))
            names.add(seed["name"])
            counts[f"{key.split('_')[0]}_created"] += 1
            changed = True
        # 原值不是数组（历史脏数据）或本轮有新增时才回写；否则原样不动。
        if changed or not original_was_list:
            stored[key] = bucket

    if changed or setting.silly_tavern_settings is None:
        setting.silly_tavern_settings = json.dumps(stored, ensure_ascii=False)

    return counts


def ensure_preset_library_seeds(db, user_id: Optional[int] = None) -> dict[str, int]:
    """幂等播种预设库自带条目。

    Args:
        db: SQLAlchemy Session（**不在此 commit**，由调用方决定提交时机）。
        user_id: 非空时同时补齐该用户的 sysprompt / reasoning 数组。

    Returns:
        计数字典（*_created / *_updated），全零表示库里已经齐了。
    """
    counts = _ensure_global_builtin_templates(db)
    if user_id is not None:
        counts.update(_ensure_user_preset_arrays(db, int(user_id)))
    return counts


def builtin_sysprompt_names() -> set[str]:
    return {seed["name"] for seed in BUILTIN_SYSPROMPT_PRESETS}


def builtin_reasoning_names() -> set[str]:
    return {seed["name"] for seed in BUILTIN_REASONING_PRESETS}
