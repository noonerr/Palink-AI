"""Shared helpers for importing SillyTavern world book entries."""

# ST 1.18.0 world-info.js 位置枚举（world-info.js:855-864）与 Palink 内部枚举
# （worldbook_service.py:69-76）逐位对应，整数映射透传（identity）：
# ST:    0=before  1=after  2=ANTop  3=ANBottom  4=atDepth  5=EMTop  6=EMBottom  7=outlet
# Palink:0=BEFORE_CHAR 1=AFTER_CHAR 2=BEFORE_AN 3=AFTER_AN 4=AT_DEPTH 5=EM_TOP 6=EM_BOTTOM 7=OUTLET
_ST_INT_TO_PALINK = {v: v for v in range(0, 8)}

_POSITION_MAP = {
    # ---- ST 1.18.0 规范名（导入兼容，补齐全枚举）----
    "after_prompt": 0,
    "before_char": 0,
    "before_character": 0,
    "after_char": 1,
    "after_character": 1,
    "before_annotation": 2,
    "before_an": 2,
    "before_author_note": 2,
    "after_annotation": 3,
    "after_an": 3,
    "after_author_note": 3,
    "at_depth": 4,
    "em_top": 5,
    "em_bottom": 6,
    "outlet": 7,
    # ---- Palink 自有命名（向后兼容既有导出/蓝图往返）----
    "before_example": 2,
    "after_example": 3,
    "at_top": 4,
    "at_bottom": 5,
}


def normalize_worldbook_position(value) -> int:
    """将 ST 1.18.0 世界书 position 规范化为 Palink 内部 position。

    - 整数（ST 导入常用 0..7）：与 Palink 枚举逐位对应，直接透传。
      例如 ``atDepth=4 -> WI_POS_AT_DEPTH(4)``。越界整数回退到 AT_DEPTH(4)。
    - 字符串：按 ``_POSITION_MAP`` 映射（覆盖 ST 规范名 + Palink 自有名）。
    - 未知/越界值回退到 AT_DEPTH(4)。
    """
    if isinstance(value, int):
        if 0 <= value <= 7:
            return _ST_INT_TO_PALINK[value]
        return 4
    if isinstance(value, str):
        s = value.strip().lower()
        if s in _POSITION_MAP:
            return _POSITION_MAP[s]
        # 兼容整数形式的字符串（如 "5"）
        try:
            iv = int(s)
            if 0 <= iv <= 7:
                return _ST_INT_TO_PALINK[iv]
        except ValueError:
            pass
        return 4
    return 4


def entry_keys(entry) -> list:
    """提取世界书条目关键词。

    ST 导出格式（角色卡 character_book / lorebook JSON）用 ``keys``，
    ST 前端内部格式（/api/worldinfo/edit）用 ``key``。兼容两者。
    """
    if not isinstance(entry, dict):
        return []
    v = entry.get("keys", entry.get("key"))
    if isinstance(v, list):
        return v
    return [] if v is None else [v]


def entry_secondary_keys(entry) -> list:
    """提取世界书条目次要关键词（兼容 ``secondary_keys`` / ``keysecondary``）。"""
    if not isinstance(entry, dict):
        return []
    v = entry.get("secondary_keys", entry.get("keysecondary"))
    if isinstance(v, list):
        return v
    return [] if v is None else [v]


def entry_is_disabled(entry) -> bool:
    """判断世界书条目是否禁用。

    ST 导出格式用 ``enabled``（False=禁用），ST 前端内部格式用 ``disable``
    （True=禁用）。``enabled`` 显式存在时优先。
    """
    if not isinstance(entry, dict):
        return False
    if "enabled" in entry:
        return not bool(entry["enabled"])
    return bool(entry.get("disable", False))
