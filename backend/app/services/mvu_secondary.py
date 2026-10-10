"""MVU 副 AI 变量更新服务（2026-08-19）。

背景：deepseek-v4-flash 等主模型对"每条回复末尾输出 <UpdateVariable> 变量块"
的遵循率不稳定（实测约 50%），导致 stat_data 中时间/天气/地点/服饰/内心想法等
字段长期为空、角色面板空白。MagVarUpdate 生态的推荐做法是配置"副 AI"：主模型
只写剧情，用独立副模型解析剧情并输出变量更新指令。

本模块实现副 AI 兜底：
  - 主模型未输出 <UpdateVariable> 块时，用副模型解析剧情 + 当前 stat_data，
    生成 <UpdateVariable> 块，再走 mvu_engine 应用。
  - 适配所有带变量系统的角色卡（schema 从角色卡 tavern_helper 自动提取，
    不特调任何卡）。
  - 副模型未配置 / 开关关闭 / 调用失败时静默跳过，不影响主流程。
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)

# [MVU-SECONDARY-PARAMS 2026-10-05] 副模型采样参数与重试的**唯一真源**。
# 此前 temperature=0.2 / max_tokens=2048 在本文件里写死、且无重试。
# 现在可由 UserSetting 覆盖（api/users.py 读写、api/character_ext.py 注入），
# 但默认值与夹紧区间定义在这里 —— 任何地方要用都必须 import，不要另抄一份。
DEFAULT_SECONDARY_TEMPERATURE: float = 0.2
DEFAULT_SECONDARY_MAX_TOKENS: int = 2048
DEFAULT_SECONDARY_RETRIES: int = 1  # 「额外」重试次数（总尝试 = retries + 1）

TEMPERATURE_RANGE: tuple[float, float] = (0.0, 2.0)
MAX_TOKENS_RANGE: tuple[int, int] = (256, 8192)
RETRIES_RANGE: tuple[int, int] = (0, 3)


def clamp_secondary_temperature(value: Any) -> float:
    """夹到 [0, 2]；不可解析 → 默认值。"""
    try:
        num = float(value)
    except (TypeError, ValueError):
        return DEFAULT_SECONDARY_TEMPERATURE
    if num != num:  # NaN
        return DEFAULT_SECONDARY_TEMPERATURE
    lo, hi = TEMPERATURE_RANGE
    return max(lo, min(hi, num))


def clamp_secondary_max_tokens(value: Any) -> int:
    """夹到 [256, 8192]；不可解析 → 默认值。"""
    try:
        num = int(value)
    except (TypeError, ValueError):
        return DEFAULT_SECONDARY_MAX_TOKENS
    lo, hi = MAX_TOKENS_RANGE
    return max(lo, min(hi, num))


def clamp_secondary_retries(value: Any) -> int:
    """夹到 [0, 3]；不可解析 → 默认值。"""
    try:
        num = int(value)
    except (TypeError, ValueError):
        return DEFAULT_SECONDARY_RETRIES
    lo, hi = RETRIES_RANGE
    return max(lo, min(hi, num))

# 副 AI 系统指令：要求副模型只输出 <UpdateVariable> 块，不写剧情。
_SECONDARY_SYSTEM_PROMPT = """你是一个角色扮演变量状态更新器。你的唯一任务：根据给定的【当前变量状态】和【最新剧情】，判断哪些变量发生了变化，并输出一个 <UpdateVariable> 块。

要求：
1. 只输出 <UpdateVariable> 块，不要输出任何剧情、解释或多余文字。
2. <UpdateVariable> 块格式：
<UpdateVariable>
<Analysis>（英文，80 词以内：时间流逝计算、是否允许戏剧性更新、逐字段对照变化分析）</Analysis>
<JSONPatch>
[{"op":"replace","path":"/组名/字段名","value":"新值"},{"op":"delta","path":"/组名/数值字段","value":增量}]
</JSONPatch>
</UpdateVariable>
3. 支持操作：replace（赋值）/ delta（数值增减）/ insert / remove / move。
4. path 格式：/组名/字段名（如 /世界信息/日期时间、/桃汐/好感度）。
5. 以 _ 开头的字段为只读，禁止更新；未变化的字段不要输出。
6. 时间流逝：根据剧情推进合理更新"世界信息.日期时间"（若剧情有时间跳跃则相应调整）。
7. 地点变化：剧情中角色移动到新地点时，更新"世界信息.地点"。
8. 天气/风力：剧情明确描述天气变化时更新，否则保持原样。
9. 角色字段（好感度/关系/性欲值/服饰/内心想法/发情期等）：根据剧情中角色的言行、情绪、互动合理推断更新。
10. 若剧情没有引起任何变量变化，也必须输出一个只更新时间流逝的 <UpdateVariable> 块（至少推进日期时间）。
"""


def _build_secondary_messages(
    stat_data: dict,
    story_text: str,
    schema_defaults: dict,
) -> list[dict[str, str]]:
    """构造副 AI 的 messages。

    stat_data: 当前会话变量（含 stat_data 键）。
    story_text: 主模型刚生成的剧情正文（final_raw，含 <UpdateVariable> 块则先剥离）。
    schema_defaults: 角色卡 schema 默认值（用于副模型了解字段结构）。
    """
    current = stat_data.get("stat_data") if isinstance(stat_data, dict) else None
    if not isinstance(current, dict):
        current = {}

    # 当前变量状态（JSON 序列化，供副模型参考）
    try:
        current_json = json.dumps(current, ensure_ascii=False, indent=2)
    except (TypeError, ValueError):
        current_json = "{}"

    # schema 字段结构（供副模型了解有哪些字段可更新）
    schema_hint = ""
    if isinstance(schema_defaults, dict) and schema_defaults:
        try:
            schema_hint = json.dumps(schema_defaults, ensure_ascii=False, indent=2)
        except (TypeError, ValueError):
            schema_hint = ""

    # 剥离剧情文本中的 <UpdateVariable> 块（避免副模型重复解析）
    from app.services.mvu_engine import strip_update_variable_blocks
    clean_story = strip_update_variable_blocks(story_text)

    user_content = (
        "【当前变量状态】\n"
        f"{current_json}\n\n"
        "【变量字段结构（schema 默认值，供参考）】\n"
        f"{schema_hint or '(无 schema，仅依据当前变量状态更新)'}\n\n"
        "【最新剧情】\n"
        f"{clean_story}\n\n"
        "请根据以上剧情，输出 <UpdateVariable> 块更新变量。"
    )

    return [
        {"role": "system", "content": _SECONDARY_SYSTEM_PROMPT},
        {"role": "user", "content": user_content},
    ]


async def run_secondary_mvu(
    secondary_model: str,
    stat_data: dict,
    story_text: str,
    schema_defaults: dict,
    timeout: float = 60.0,
    temperature: float = DEFAULT_SECONDARY_TEMPERATURE,
    max_tokens: int = DEFAULT_SECONDARY_MAX_TOKENS,
    retries: int = DEFAULT_SECONDARY_RETRIES,
) -> tuple[dict, list[str]]:
    """调用副模型生成 <UpdateVariable> 块并解析。

    返回 (patches, logs)。patches 为解析出的 JSON Patch 数组（可能为空）。
    任何失败都返回 ([], [])，不抛异常（静默兜底）。

    [MVU-SECONDARY-PARAMS 2026-10-05] 新增三个可选参数，**默认值与原写死值一致**
    （0.2 / 2048 / 1 次额外重试），故存量调用方行为不变、无需改动：
      - temperature / max_tokens：透传给 complete_text_completion（已做夹紧）。
      - retries：「额外」重试次数。**只对"调用抛异常"重试**（网络抖动 / 超时 /
        上游 5xx）；模型正常返回但内容为空、或没有可解析块时**不重试** ——
        那两种情况重试大概率还是同样结果，白烧额度。

    返回值形状保持 ``tuple[dict, list[str]]`` 不变（未改成三态），
    以免破坏现有调用方的解包；"失败 vs 无变化"的区分留给后续批次（见 SPEC 批次 C）。
    """
    # [MVU-SECONDARY-GUARD] 无 schema 且无 stat_data 结构 = 角色卡没有变量系统，
    # 副 AI 不介入，避免对无变量系统的卡乱生成变量（特调/乱输出防护）。
    _has_schema = bool(schema_defaults)
    _has_stat = bool(
        isinstance(stat_data, dict)
        and isinstance(stat_data.get("stat_data"), dict)
        and stat_data["stat_data"]
    )
    if not _has_schema and not _has_stat:
        return [], []

    from app.services.inference_dispatcher import complete_text_completion
    from app.services.mvu_engine import extract_update_variable_blocks

    _temperature = clamp_secondary_temperature(temperature)
    _max_tokens = clamp_secondary_max_tokens(max_tokens)
    _retries = clamp_secondary_retries(retries)
    _attempts = _retries + 1

    messages = _build_secondary_messages(stat_data, story_text, schema_defaults)

    # ── 调用（仅对异常重试） ──────────────────────────────────────────────
    resp: Optional[dict] = None
    for _attempt in range(_attempts):
        try:
            resp = await complete_text_completion(
                model_id=secondary_model,
                messages=messages,
                temperature=_temperature,  # 变量解析用低温度，保证稳定
                max_tokens=_max_tokens,
                timeout=timeout,
            )
            break
        except Exception as exc:
            if _attempt + 1 < _attempts:
                _backoff = min(2.0 * (2 ** _attempt), 8.0)
                logger.warning(
                    "MVU secondary AI call failed (attempt %d/%d), retrying in %.1fs: %s",
                    _attempt + 1, _attempts, _backoff, exc,
                )
                await asyncio.sleep(_backoff)
                continue
            logger.warning(
                "MVU secondary AI call failed after %d attempt(s): %s", _attempts, exc,
            )
            return [], []

    if resp is None:  # 理论不可达（循环里必 break 或 return），防御性兜底
        return [], []

    content = resp.get("content") or ""
    if not content.strip():
        # 模型正常返回但内容为空 —— 不重试（重试大概率同样结果）
        logger.warning("MVU secondary AI returned empty content")
        return [], []

    blocks = extract_update_variable_blocks(content)
    if not blocks:
        # 有输出但无块 —— 不重试（模型确实认为没有变化）
        logger.warning("MVU secondary AI output has no parseable UpdateVariable block")
        return [], []

    # 取第一个可解析的块
    patches = blocks[0]
    logger.info("MVU secondary AI produced %d patches", len(patches))
    return patches, [f"[secondary] {p}" for p in patches]
