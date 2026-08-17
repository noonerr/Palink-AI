"""
角色状态栏探测器 — 首次对话静默探测卡内状态栏格式。

核心流程：
  1. 未检测的卡 → 首次对话注入探测指令 → 模型输出 <palink-status> 标记
  2. 后端剥离标记（流式层 + 落库层）+ 解析 → 写入 extensions.palink_status_bar_config
  3. 后续对话按配置分支注入「卡内原生格式指令」或「默认 emoji 状态表指令」
"""
import re
import json
import logging
from typing import Optional, Dict, Any, Tuple

logger = logging.getLogger(__name__)

# ── 常量 ──────────────────────────────────────────────

STATUS_DETECT_MARKER = "palink-status"

# 匹配完整的 <palink-status>...</palink-status> 标记
_STATUS_MARKER_RE = re.compile(
    r"<palink-status>\s*([\s\S]*?)\s*</palink-status>",
    re.IGNORECASE,
)

# 启发式检测的状态栏标签名（大小写不敏感）
_HEURISTIC_TAGS = ["NSFW", "status", "details", "state", "info", "panel"]


# ── 剥离 ──────────────────────────────────────────────

def strip_status_marker(text: str) -> str:
    """移除 <palink-status>...</palink-status> 标记，返回干净文本。"""
    if not text:
        return text
    cleaned = _STATUS_MARKER_RE.sub("", text)
    # 清理标记移除后可能留下的尾部空行
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


# ── 解析 ──────────────────────────────────────────────

def strip_and_parse_status_marker(text: str, char, force: bool = False) -> Tuple[str, Optional[Dict[str, Any]]]:
    """剥离标记并解析。

    返回 (clean_text, config_or_None)。
    - 标记存在且合法 → config dict
    - 标记存在但非法 → 启发式兜底
    - 标记缺失 → 启发式兜底
    - 都没有 + force=False → None（中间保存，不写 config，等标记完整）
    - 都没有 + force=True → {"checked": True, "has_status_bar": False}（最终保存，防止反复探测）
    """
    if not text:
        return text, None

    match = _STATUS_MARKER_RE.search(text)
    clean = strip_status_marker(text)

    if match:
        raw = match.group(1).strip()
        config = _parse_status_fields(raw)
        if config:
            return clean, config
        # 标记存在但解析失败 → 启发式兜底
        logger.warning("palink-status marker found but parse failed, raw=%r", raw[:200])
        heur = heuristic_detect(char)
        if heur:
            return clean, heur
        # 启发式也没命中 → 标记为已检测无状态栏
        return clean, {"checked": True, "has_status_bar": False}

    # 标记缺失 → 启发式兜底
    heur = heuristic_detect(char)
    if heur:
        return clean, heur

    # 没有标记也没有启发式命中
    if force:
        # 最终保存：标记为已检测无状态栏，防止反复探测
        return clean, {"checked": True, "has_status_bar": False}
    # 中间保存：不写 config，等标记完整
    return clean, None


def _normalize_format_hint(raw: str) -> str:
    """把探测到的 format_hint 归一化为可「复制并更新」的基线模板。

    设计取舍（关键）：
      早期版本把各字段值置为 ``X``，指令要求「把 X 替换为当前值」。实测发现
      模型能可靠**复制**一张已给出的状态栏（首条回复即如此输出带真实值的
      ``<NSFW>``），却几乎不会从 22 个空白 ``X`` 凭空生成整块状态栏，导致第 2
      轮起整段省略。因此这里**保留真实值作为基线**，仅把首段角色名置为
      ``{{name}}``、其余占位符（如 ``{{user}}``）原样保留，配合「沿用并更新变化
      字段」的指令，与模型首条回复的成功路径同构。

    保留真实值是否触发安全/ XML 抑制？不会：首条回复已天然输出这些真实值，
    且 OUTPUT_FORMAT 已对原生状态标签显式豁免，故可安全放入 system prompt。
    """
    if not raw:
        return raw
    m = re.match(
        r"^\s*<([A-Za-z_][\w-]*)\b[^>]*>(.*?)</\1>\s*$",
        raw,
        re.IGNORECASE | re.DOTALL,
    )
    if not m:
        # 无标准包裹标签，原样返回
        return raw
    tag = m.group(1)
    inner = m.group(2)
    parts = inner.split("|")
    out = []
    for i, p in enumerate(parts):
        seg = p.strip()
        if i == 0:
            out.append("{{name}}")
            continue
        # 保留真实值作为基线：模型据此「复制并更新」最可靠
        out.append(seg)
    return f"<{tag}>{'|'.join(out)}</{tag}>"


def _parse_status_fields(raw: str) -> Optional[Dict[str, Any]]:
    """解析管道分隔字段。

    格式: has_status_bar=true|format_hint=<NSFW>{{name}}|心情:X|地点:X</NSFW>|trigger_tag=NSFW

    format_hint 内部可能含 |，所以用正则先提取 format_hint，再提取其他字段。
    """
    result: Dict[str, Any] = {}

    # 提取 format_hint（值可能含 |，所以匹配到 |trigger_tag= 或行尾）
    fh_match = re.search(
        r"format_hint\s*=\s*(.*?)(?:\s*\|\s*trigger_tag\s*=|$)",
        raw,
        re.DOTALL,
    )
    if fh_match:
        raw_hint = fh_match.group(1).strip()
        # 归一化为安全 X 占位模板：避免把开场白真实值（含亲密字段）注入
        # system prompt，既让 "replace X" 指令自洽，又规避 XML 禁止规则/安全过滤。
        result["format_hint"] = _normalize_format_hint(raw_hint)

    # 提取 has_status_bar（用 [^|]+ 防止吞掉管道后的字段）
    hsb_match = re.search(r"has_status_bar\s*=\s*([^|]+)", raw, re.IGNORECASE)
    if hsb_match:
        val = hsb_match.group(1).strip().lower()
        result["has_status_bar"] = val in ("true", "1", "yes", "是")

    # 提取 trigger_tag
    tt_match = re.search(r"trigger_tag\s*=\s*([^|]+)", raw, re.IGNORECASE)
    if tt_match:
        tag = tt_match.group(1).strip()
        if tag:
            result["trigger_tag"] = tag

    if "has_status_bar" in result:
        result["checked"] = True
        # has_status_bar=false 时清理 format_hint
        if not result["has_status_bar"]:
            result.pop("format_hint", None)
            result.pop("trigger_tag", None)
        return result

    return None


# ── 启发式兜底 ────────────────────────────────────────

def heuristic_detect(char) -> Optional[Dict[str, Any]]:
    """从 first_mes / post_history_instructions / regex_scripts 推断状态栏格式。"""
    if char is None:
        return None

    # 1. 检查 first_mes 和 post_history_instructions 中的状态栏标签
    for attr in ("first_mes", "post_history_instructions"):
        text = getattr(char, attr, None) or ""
        if not text:
            continue
        for tag in _HEURISTIC_TAGS:
            # 尝试匹配完整的 <tag>...</tag> 骨架
            pattern = re.compile(
                rf"<{re.escape(tag)}\b[^>]*>([\s\S]*?)</{re.escape(tag)}\s*>",
                re.IGNORECASE,
            )
            m = pattern.search(text)
            if m:
                skeleton = m.group(0)  # 完整的 <tag attr>...</tag>
                return {
                    "checked": True,
                    "has_status_bar": True,
                    "format_hint": skeleton,
                    "trigger_tag": tag,
                }
            # 有开标签但没闭标签
            open_pattern = re.compile(rf"<{re.escape(tag)}\b", re.IGNORECASE)
            if open_pattern.search(text):
                return {
                    "checked": True,
                    "has_status_bar": True,
                    "format_hint": f"<{tag}>...</{tag}>",
                    "trigger_tag": tag,
                }

    # 2. 检查 regex_scripts
    extensions = _safe_parse_extensions(char)
    if extensions:
        regex_scripts = extensions.get("regex_scripts", [])
        if isinstance(regex_scripts, list):
            for script in regex_scripts:
                if not isinstance(script, dict):
                    continue
                find_regex = script.get("findRegex", "") or ""
                for tag in _HEURISTIC_TAGS:
                    if tag.lower() in find_regex.lower():
                        return {
                            "checked": True,
                            "has_status_bar": True,
                            "format_hint": f"<{tag}>...</{tag}>",
                            "trigger_tag": tag,
                        }

    return None


# ── 配置读写 ──────────────────────────────────────────

def get_status_config(char) -> Optional[Dict[str, Any]]:
    """安全解析 char.extensions 取 palink_status_bar_config。

    若 extensions 中无已探测的 config，则回退到启发式检测：当角色卡自带
    状态栏标签（<NSFW>/<status>/...）时，直接返回启发式结果，使「自带状态栏
    的卡」无需先经历一次首次对话探测即可生效（探测本质也是为了找出同样的
    标签与格式）。无状态栏标签时返回 None。
    """
    if char is None:
        return None
    extensions = _safe_parse_extensions(char)
    if extensions:
        config = extensions.get("palink_status_bar_config")
        if isinstance(config, dict):
            return config
    # 未探测（无 config）时回退启发式：自带状态栏的卡直接可用
    heur = heuristic_detect(char)
    if heur:
        return heur
    return None


def is_status_checked(char) -> bool:
    """快速判断卡是否已被探测过。"""
    config = get_status_config(char)
    return bool(config and config.get("checked"))


def save_status_config(char, db, config: Dict[str, Any]) -> None:
    """将 config 写入 char.extensions.palink_status_bar_config 并 commit。

    注意：传入的 char 可能来自另一个 DB session（例如 websocket 外层会话
    用 db=SessionLocal() 加载，而调用方传入的是独立的 save_db=SessionLocal()）。
    若直接修改 char.extensions 再调用 save_db.commit()，由于 char 不属于
    save_db 管理的对象，commit 会静默不落库（且不报错）。
    因此这里用 db.query(Character).filter(...).update(...) 直接在当前 db
    session 上执行 UPDATE，确保写入生效。
    """
    char_id = getattr(char, "id", None)
    if char_id is None:
        return
    extensions = _safe_parse_extensions(char) or {}
    extensions["palink_status_bar_config"] = config
    new_ext = json.dumps(extensions, ensure_ascii=False)
    from ..models import Character
    db.query(Character).filter(Character.id == char_id).update(
        {Character.extensions: new_ext},
        synchronize_session=False,
    )
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise
    # 同步内存对象，避免调用方后续读取到旧值
    char.extensions = new_ext
    logger.info("Saved palink_status_bar_config for char=%s: %s", char_id, config)


def _safe_parse_extensions(char) -> Optional[dict]:
    """安全解析 extensions JSON 字符串。"""
    raw = getattr(char, "extensions", None)
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else None
    except (json.JSONDecodeError, TypeError, ValueError):
        return None


# ── 指令构建 ──────────────────────────────────────────

def build_detect_instruction(lang: str) -> str:
    """构建探测指令（用于 final_reminder，路径 c）。

    要求模型在回复末尾输出 <palink-status> 标记。
    注意：不使用 f-string，因为模板含 {{name}} 宏示例。
    """
    if lang == "zh":
        return (
            "\n\n【系统探测 — 不可省略】\n"
            "请在回复的最末尾（正文之后，另起一行）输出以下隐藏标记，"
            "用于检测本角色卡是否自带状态栏格式：\n"
            "<palink-status>has_status_bar=true或false|"
            "format_hint=若有的话请原样输出状态栏完整骨架"
            "（如 <NSFW>{{name}}|心情:X|地点:X</NSFW>）|"
            "trigger_tag=若有的话填触发标签名如NSFW</palink-status>\n"
            "说明：\n"
            "- 如果本角色卡的开场白或设定中包含 <NSFW>、<status>、<details> "
            "等状态栏标签，则 has_status_bar=true，并在 format_hint 中原样输出"
            "该状态栏的完整格式骨架（包含所有字段名、分隔符和包裹标签），"
            "trigger_tag 填该标签名。\n"
            "- 如果不包含任何状态栏标签，则 has_status_bar=false，"
            "format_hint 和 trigger_tag 留空。\n"
            "- 此标记不会显示给用户，仅用于系统配置。"
        )
    else:
        return (
            "\n\n[System Probe — Cannot Be Omitted]\n"
            "At the very end of your response (after the main text, on a new line), "
            "output the following hidden marker to detect whether this character card "
            "has a built-in status bar format:\n"
            "<palink-status>has_status_bar=true or false|"
            "format_hint=If present, output the complete status bar skeleton as-is "
            "(e.g. <NSFW>{{name}}|Mood:X|Location:X</NSFW>)|"
            "trigger_tag=If present, fill the trigger tag name like NSFW</palink-status>\n"
            "Notes:\n"
            "- If this character card's first message or settings contain status bar tags "
            "like <NSFW>, <status>, <details>, set has_status_bar=true and output the "
            "complete format skeleton in format_hint (including all field names, separators, "
            "and wrapping tags), and fill trigger_tag with the tag name.\n"
            "- If no status bar tags are present, set has_status_bar=false, "
            "leave format_hint and trigger_tag empty.\n"
            "- This marker will not be displayed to the user; it is for system configuration only."
        )


def build_status_instruction(char, lang: str, show_status: bool) -> str:
    """构建状态表详细指令（用于 system_prompt，路径 a/b）。

    分支：
      - 未检测 → 空（探测指令在 final_reminder 中注入）
      - 已检测 has_status_bar=true → 卡内格式沿用指令
      - 已检测 has_status_bar=false + show_status=true → 默认 emoji 表指令
      - 已检测 has_status_bar=false + show_status=false → 空
    """
    config = get_status_config(char)
    if config is None:
        return ""  # 未检测，不注入状态表指令

    if config.get("has_status_bar") and config.get("format_hint"):
        # 防御性归一化：已落库的真实值 format_hint（探测早于本修复）也在此即时
        # 修正，无需额外迁移脚本。归一化幂等，已为 X 模板者保持不变。
        fmt_hint = _normalize_format_hint(config["format_hint"])
        return _build_card_native_instruction(
            fmt_hint,
            config.get("trigger_tag", ""),
            lang,
        )

    if show_status:
        # 卡无状态栏，用户开启开关 → 默认 emoji 表
        from ..core.default_prompts import (
            CHARACTER_STATUS_TABLE_INSTRUCTION_ZH,
            CHARACTER_STATUS_TABLE_INSTRUCTION_EN,
        )
        name = getattr(char, "name", None) or "Character"
        if lang == "zh":
            return CHARACTER_STATUS_TABLE_INSTRUCTION_ZH.format(name=name)
        else:
            return CHARACTER_STATUS_TABLE_INSTRUCTION_EN.format(name=name)

    return ""


def _build_fewshot(format_hint: str, tag: str, lang: str) -> str:
    """动态构造 few-shot 示例：展示「沿用基准格式 + 仅更新变化字段」。

    针对推理模型（如 R1）在 <think> 阶段把状态栏排除在任务外的问题——示例对
    模型的遵循度远高于纯文字指令。示例基于真实 format_hint 解析字段，将其中一个
    「表情/心情」类字段改为随剧情变化的值，演示「只更新变化字段」的正确做法。
    """
    m = re.match(r"<([A-Za-z_][\w-]*)>(.*?)</\1>", format_hint, re.IGNORECASE | re.DOTALL)
    if not m:
        return ""
    inner = m.group(2)
    parts = inner.split("|")
    if len(parts) < 3:
        return ""
    ex = list(parts)
    # 让第 3 个字段（索引 2，通常为表情/心情）展示一个随剧情变化的值
    if lang == "zh":
        ex[2] = "带着一点嗔怪的笑意，却掩不住眼底的开心"
    else:
        ex[2] = "slightly mock-pouting, yet clearly happy underneath"
    ex_panel = f"<{tag}>{'|'.join(ex)}</{tag}>"
    if lang == "zh":
        return (
            "\n\n【示范 — 你必须模仿此结构，每条回复末尾都输出更新后的状态栏】\n"
            "用户：「哥哥好慢～」\n"
            "你：（正文：洛茉停下脚步，回头嗔了哥哥一眼，蓝色眼睛里盛着细碎的光……）\n"
            + ex_panel
            + "\n（示范中仅「表情」字段随剧情变化，其余沿用基准值——你要做的正是：只更新变化的字段。）"
        )
    else:
        return (
            "\n\n[Demo — mimic this structure; output the updated status bar at the end of EVERY reply]\n"
            "User: \"哥哥好慢～\"\n"
            "You: (body: Luomo stops and glances back at her brother...)\n"
            + ex_panel
            + "\n(In the demo only the 'expression' field changed; keep others as baseline — update only what changed.)"
        )


def _build_card_native_instruction(format_hint: str, trigger_tag: str, lang: str) -> str:
    """构建卡内原生格式沿用指令。使用字符串拼接避免花括号转义问题。

    format_hint 为含真实值的基线模板（见 _normalize_format_hint）。指令要求
    模型「每条回复末尾沿用此格式、仅更新变化字段」，与其首条回复复制卡片状态栏
    的成功路径同构，避免从空白 X 凭空生成导致整段省略。

    强化（针对推理模型遵循度低）：
      - 明确状态栏是回复的【强制组成部分】，缺失=输出错误；
      - 要求模型在 <think> 阶段就逐字段规划状态栏的新值（直接打推理模型的痛点）；
      - 附 few-shot 示例（模型对示例遵循度远高于纯指令）。
    """
    tag = trigger_tag or "NSFW"
    fewshot = _build_fewshot(format_hint, tag, lang)
    if lang == "zh":
        return (
            "\n\n【状态栏要求 — 强制，不可省略】\n"
            "本角色卡自带状态栏，你必须在【每条回复的最末尾】用原生标签（如 <"
            + tag
            + "> 等）输出它；此标签不受「禁止 XML 标签」规则限制。\n"
            "请直接沿用以下基准格式，按当前剧情仅更新发生变化的字段值，未变化的字段保持原值；"
            "将 {{name}} 替换为你的名字、{{user}} 替换为用户名字。"
            "不要省略、不要合并、不要改成其他格式或表格：\n"
            + format_hint
            + "\n\n【思考阶段（<think>）必须规划状态栏】\n"
            "在撰写正文之前，你要在 <think> 里先逐字段核对状态栏：哪些字段因当前对话发生了变化"
            "（如心情、表情、动作、想法、身体状态等），并决定它们的新值。状态栏输出是回复的"
            "【强制组成部分】，缺少状态栏视为回复未完成、属于输出错误。\n"
            + fewshot
        )
    else:
        return (
            "\n\n[Status Bar Requirement — MANDATORY, cannot be omitted]\n"
            "This character card has a built-in status bar. You MUST output it at the very end "
            "of EVERY reply using its native tag (e.g. <"
            + tag
            + ">); this tag is exempt from the 'no XML tags' rule.\n"
            "Reproduce the baseline format below and update only the fields that changed given "
            "the current scene; keep unchanged fields as-is. Replace {{name}} with your name and "
            "{{user}} with the user's name. Do not omit, merge, or switch to any other format or table:\n"
            + format_hint
            + "\n\n[Plan the status bar during <think>]\n"
            "Before writing the body, in your <think> step review each status field: which ones "
            "changed due to the current dialogue (mood, expression, action, thoughts, physical "
            "state...), and decide their new values. The status bar is a MANDATORY part of the "
            "reply; omitting it means the reply is incomplete (an output error).\n"
            + fewshot
        )


def build_status_reminder(char, lang: str, show_status: bool) -> str:
    """构建状态表简短提醒（用于 final_reminder，路径 c）。

    分支：
      - 未检测 → 空（探测指令在外部追加）
      - 已检测 has_status_bar=true + show_status=true → 简短提醒沿用卡内格式
      - 已检测 has_status_bar=false + show_status=true → 简短提醒输出 emoji 表
      - 已检测 + show_status=false → 空
    """
    config = get_status_config(char)
    if config is None:
        return ""  # 未检测，不追加提醒

    if not show_status:
        return ""

    is_zh = lang == "zh"
    if config.get("has_status_bar"):
        if is_zh:
            return "\n3. 回复末尾必须包含角色卡自带的状态栏格式（不要使用其他状态表格）"
        else:
            return "\n3. Response must end with the character card's native status bar format (do not use other status table formats)"
    else:
        if is_zh:
            return "\n3. 回复末尾必须包含状态表格（🧥💖🎬💭🎯📍）\n4. 表格与正文用---分隔"
        else:
            return "\n3. Response must end with status table (🧥💖🎬💭🎯📍)\n4. Separate table from main text with ---"


def response_has_status_bar(text: str, char) -> bool:
    """判断模型回复文本中是否已包含角色卡的状态栏标签（避免兜底重复追加）。"""
    if not text:
        return False
    cfg = get_status_config(char)
    if not cfg or not cfg.get("has_status_bar"):
        return False
    tag = cfg.get("trigger_tag") or "NSFW"
    return ("<%s>" % tag) in text


def build_fallback_panel(char, user_nickname: str, name: str = None) -> str:
    """当模型回复未输出状态栏时，用缓存的真实值基线自动补全面板。

    仅对「已检测到自带状态栏」的卡生效（与 user-tail 注入的判定一致），
    用 palink_status_bar_config 中缓存的 format_hint 真实值（替换 {{name}} /
    {{user}}）拼出完整原生标签串。作为兜底，保证面板 100% 出现；若模型已自行
    输出面板（response_has_status_bar 为 True）则不应调用本函数。
    """
    cfg = get_status_config(char)
    if not cfg or not cfg.get("has_status_bar") or not cfg.get("format_hint"):
        return ""
    fmt = cfg["format_hint"]
    name = name or getattr(char, "name", None) or "Character"
    try:
        fmt = fmt.replace("{{name}}", name).replace("{{user}}", user_nickname or "User")
    except Exception:
        pass
    return fmt


# ── 裸状态栏兜底（缺包裹标签时自动补） ────────────────

def wrap_bare_status_bar(text: str, char) -> str:
    """防御性兜底：角色卡自带状态栏，但模型在某轮回复漏写原生包裹标签
    （如 <NSFW>），直接输出了裸的 ``|`` 分隔状态栏时，自动补上触发标签，
    避免前端把它当成纯文本显示（表现为"未渲染的面板内容"）。

    触发条件（全部满足才处理，避免误伤普通正文）：
      1. 已检测到 has_status_bar=true（卡内自带或探测成功）；
      2. 正文尚不含 <NSFW> / <luomo_nsfw> 包裹；
      3. 存在一整行以角色名（或 {{name}}）开头、且含 >= 20 个 ``|`` 分隔字段
         的状态栏文本。

    仅对最后匹配到的那一行进行包裹，正文其余部分不动。返回处理后的文本。
    """
    if not text or not char:
        return text
    cfg = get_status_config(char)
    if not cfg or not cfg.get("has_status_bar"):
        return text
    if re.search(r"<(nsfw|luomo_nsfw)\b", text, re.IGNORECASE):
        return text  # 已有包裹，无需处理

    name = (getattr(char, "name", None) or "").strip()
    if not name:
        return text
    tag = cfg.get("trigger_tag") or "NSFW"

    lines = text.split("\n")
    for i in range(len(lines) - 1, -1, -1):
        ln = lines[i].strip()
        if (ln.startswith(name + "|") or ln.startswith("{{name}}|")) and ln.count("|") >= 20:
            lines[i] = "<%s>%s</%s>" % (tag, ln, tag)
            return "\n".join(lines)
    return text


# ── 流式剥离器 ────────────────────────────────────────

class StreamingStatusStripper:
    """流式推送时缓冲并剥离跨 chunk 的 <palink-status> 标记。

    用法::

        stripper = StreamingStatusStripper()
        for chunk in stream:
            clean = stripper.feed(chunk)
            if clean:
                await send_chunk(clean)
        tail = stripper.flush()
        if tail:
            await send_chunk(tail)
    """

    _OPEN_TAG = "<palink-status>"
    _CLOSE_TAG = "</palink-status>"

    def __init__(self):
        self._buffer: str = ""
        self._in_marker: bool = False

    def feed(self, chunk: str) -> str:
        """输入一个 chunk，返回应推送给前端的干净内容。"""
        if not chunk:
            return chunk

        if self._in_marker:
            self._buffer += chunk
            if self._CLOSE_TAG in self._buffer.lower():
                # 标记完整了 → 剥离，返回剩余
                cleaned = _STATUS_MARKER_RE.sub("", self._buffer)
                self._buffer = ""
                self._in_marker = False
                return cleaned
            # 仍在标记内，不推送
            return ""

        # 不在标记内 → 检查标记是否开始
        lower = chunk.lower()
        open_idx = lower.find(self._OPEN_TAG)
        if open_idx >= 0:
            before = chunk[:open_idx]
            after = chunk[open_idx:]
            self._buffer = after
            self._in_marker = True
            # 标记可能同 chunk 内闭合
            if self._CLOSE_TAG in self._buffer.lower():
                cleaned = _STATUS_MARKER_RE.sub("", self._buffer)
                self._buffer = ""
                self._in_marker = False
                return before + cleaned
            return before

        return chunk

    def flush(self) -> str:
        """流结束时调用，返回缓冲区中剩余的非标记内容。"""
        if self._buffer and not self._in_marker:
            result = self._buffer
            self._buffer = ""
            return result
        # 如果还在标记内，标记不完整 → 丢弃
        self._buffer = ""
        self._in_marker = False
        return ""
