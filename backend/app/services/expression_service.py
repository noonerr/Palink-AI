"""表情分析服务 - 基于关键词匹配的表情识别。

参考 SillyTavern 1.18.0 默认表情集（15 种）：
admiration, amusement, anger, embarrassment, fear, joy, love, neutral,
pity, rage, relief, sadness, shame, surprise, disgust
"""

import logging
from typing import List, Tuple

logger = logging.getLogger(__name__)


# ST 1.18.0 默认 15 种表情名称
DEFAULT_EXPRESSIONS: Tuple[str, ...] = (
    "admiration",
    "amusement",
    "anger",
    "embarrassment",
    "fear",
    "joy",
    "love",
    "neutral",
    "pity",
    "rage",
    "relief",
    "sadness",
    "shame",
    "surprise",
    "disgust",
)

# 表情 -> 关键词映射（中英文）。
# 顺序很重要：更具体/强烈的情绪在前，避免被宽泛词抢先匹配。
# 例如 rage（暴怒）优先于 anger（愤怒），amusement（被逗乐）优先于 joy（开心）。
_EXPRESSION_KEYWORDS: List[Tuple[str, Tuple[str, ...]]] = [
    ("rage", (
        "暴怒", "狂怒", "盛怒", "勃然大怒", "气急败坏", "暴跳如雷",
        "rage", "furious", "outraged", "enraged", "infuriated",
    )),
    ("anger", (
        "愤怒", "生气", "气愤", "恼怒", "恼火", "动怒", "发怒", "发火",
        "气死", "来气", "不爽", "愤慨",
        "angry", "mad", "irritated", "annoyed", "pissed",
    )),
    ("disgust", (
        "厌恶", "厌烦", "讨厌", "反感", "恶心", "作呕", "嫌恶", "倒胃口",
        "disgust", "disgusted", "repulsed", "grossed", "gross", "revolting",
    )),
    ("fear", (
        "害怕", "恐惧", "惧怕", "畏惧", "惊恐", "惶恐", "胆怯", "怕", "吓死",
        "fear", "afraid", "scared", "frightened", "terrified", "horror", "dread",
    )),
    ("sadness", (
        "悲伤", "难过", "伤心", "哀伤", "哀愁", "凄凉", "凄惨", "悲痛",
        "心碎", "失落", "沮丧", "消沉", "忧愁", "郁闷", "黯然",
        "sad", "sadness", "sorrow", "sorrowful", "unhappy", "depressed",
        "depression", "down", "miserable", "heartbroken", "gloomy",
    )),
    ("shame", (
        "羞耻", "羞愧", "惭愧", "愧疚", "内疚", "无地自容", "自愧", "负罪",
        "shame", "ashamed", "guilty", "guilt-ridden", "humiliated",
    )),
    ("embarrassment", (
        "尴尬", "难堪", "局促", "局促不安", "不好意思", "窘迫", "出丑",
        "embarrassment", "embarrassed", "awkward", "flustered",
    )),
    ("pity", (
        "同情", "怜悯", "可怜", "惋惜", "恻隐",
        "pity", "sympathetic", "sympathy", "compassion", "compassionate",
    )),
    ("admiration", (
        "钦佩", "佩服", "赞赏", "崇拜", "敬佩", "敬仰", "仰慕", "赞叹",
        "admiration", "admire", "impressed", "respect", "respectful", "reverence",
    )),
    ("amusement", (
        "有趣", "好玩", "搞笑", "滑稽", "被逗乐", "逗乐", "乐子", "可乐",
        "amusement", "amused", "funny", "entertaining", "hilarious",
    )),
    ("love", (
        "爱", "喜爱", "钟爱", "爱慕", "心动", "倾心", "钟情", "深情", "挚爱",
        "love", "adore", "adoration", "affection", "affectionate", "romantic",
    )),
    ("surprise", (
        "惊讶", "吃惊", "诧异", "惊奇", "愕然", "骇然", "没想到", "想不到",
        "surprise", "surprised", "astonished", "astonishing", "startled",
        "shocked", "unexpected",
    )),
    ("relief", (
        "宽慰", "松了口气", "松了一口气", "如释重负", "安心", "放心", "宽心",
        "relief", "relieved", "reassured",
    )),
    ("joy", (
        "开心", "高兴", "快乐", "喜悦", "欢喜", "欢欣", "愉悦", "愉快", "雀跃",
        "欢快", "兴高采烈", "笑", "喜", "乐", "美滋滋",
        "joy", "happy", "joyful", "glad", "delighted", "cheerful", "cheer",
        "pleased", "thrilled", "elated",
    )),
    # neutral 兜底，不在此列表中匹配关键词
]

# 兜底表情
DEFAULT_EXPRESSION = "neutral"


class ExpressionService:
    """表情分析服务 - 基于关键词匹配返回表情名称。"""

    def analyze_expression(self, text: str) -> str:
        """根据文本内容分析并返回表情名称。

        匹配策略：将文本小写化后，按 _EXPRESSION_KEYWORDS 顺序检查是否包含
        任一关键词（子串匹配）。命中第一个即返回；全部未命中返回 "neutral"。
        """
        if not text:
            return DEFAULT_EXPRESSION

        normalized = text.lower()
        for expression, keywords in _EXPRESSION_KEYWORDS:
            for keyword in keywords:
                if keyword in normalized:
                    return expression
        return DEFAULT_EXPRESSION

    @staticmethod
    def get_default_expressions() -> Tuple[str, ...]:
        """返回 ST 1.18.0 默认表情列表。"""
        return DEFAULT_EXPRESSIONS
