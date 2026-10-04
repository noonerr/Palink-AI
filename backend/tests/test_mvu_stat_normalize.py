"""stat_data 形状归一化回归（2026-10-05）。

复现真实故障（会话 40d9b7cc，10-04 20:11 起）：
schema 要 `露缇雅.状态.爱意`（三层），数据变成 `露缇雅.状态 = "一段文本"`
且 `爱意/魔力值/当前动作或体位` 被提到 `露缇雅` 下当兄弟键 ⇒ 卡的状态栏
`_.get(vars,'stat_data.露缇雅.状态.爱意', 0)` 穿不过字符串 → 显示 0。

运行: cd backend && py -3 -m pytest tests/test_mvu_stat_normalize.py -q
"""
import copy

from app.services.mvu_stat_normalize import (
    ARCHIVE_KEY,
    normalize_stat_data,
    normalize_variables,
)

# 卡 schema 解析出的骨架（与真实卡片 extensions.tavern_helper 的 z.object 同形）
SKELETON = {
    "环境": {
        "时间": {"年": 1, "季节": "春", "月": 1, "日": 1, "星期": "一", "小时": 12, "分钟": 0},
        "天气": "☀️",
        "温度": 20,
    },
    "露缇雅": {
        "状态": {
            "爱意": 0,
            "魔力值": 100,
            "饥饿度": 0,
            "当前位置": "未知",
            "当前动作或体位": "站立",
        },
        "穿着": {},
        "隐私部位": {"胸部": "正常", "乳首": "正常"},
        "魅魔特征": {
            "翅膀状态": "收起",
            "性经验": {"接吻": 0, "爱抚": 0},
        },
    },
}

# 真实坏数据（截自 40d9b7cc 的 chat_metadata，去掉无关字段）
BROKEN = {
    "环境": {
        "时间": {"年": 2026, "季节": "夏", "月": 7, "日": 8, "星期": "二", "小时": 7, "分钟": 0},
        "天气": "☀️",
        "温度": 24,
    },
    "露缇雅": {
        "状态": "依赖加深，对魔纹的指向性感到困惑与不安",
        "穿着": {"上身": "浅粉色纯棉无袖睡裙"},
        "隐私部位": {"胸部": "正常", "乳首": "正常"},
        "魅魔特征": {
            "翅膀状态": "从后腰两侧长出…",
            "性经验": {"接吻": 0, "爱抚": 0},
        },
        "爱意": 7,
        "魔力值": 56,
        "当前动作或体位": "跪坐或盘腿坐于床边地毯上",
    },
}


def test_broken_shape_is_repaired():
    """★ 主回归：被提升的兄弟键搬回 状态 里，卡的状态栏能重新读到。

    改坏方式：删掉 `_normalize_object` 里「搬回来」那一段，本用例变红。
    """
    fixed, log = normalize_stat_data(copy.deepcopy(BROKEN), SKELETON)
    st = fixed["露缇雅"]["状态"]
    assert isinstance(st, dict), f"状态 仍是 {type(st).__name__}，没修好"
    assert st["爱意"] == 7
    assert st["魔力值"] == 56
    assert st["当前动作或体位"] == "跪坐或盘腿坐于床边地毯上"
    # 原位置的裸键必须已被移走（否则压平输出仍会显示重复项）
    assert "爱意" not in fixed["露缇雅"]
    assert "魔力值" not in fixed["露缇雅"]
    assert any("moved" in l and "爱意" in l for l in log)


def test_displaced_text_is_archived_not_lost():
    """★ 非破坏性：原来那段文本必须被存档，不能丢。"""
    fixed, _ = normalize_stat_data(copy.deepcopy(BROKEN), SKELETON)
    assert fixed["露缇雅"]["状态"][ARCHIVE_KEY] == "依赖加深，对魔纹的指向性感到困惑与不安"


def test_missing_subkeys_filled_from_schema():
    """schema 有、数据没有的子键补 prefault（与 ST 的 zod 行为一致）。"""
    fixed, log = normalize_stat_data(copy.deepcopy(BROKEN), SKELETON)
    st = fixed["露缇雅"]["状态"]
    assert st["饥饿度"] == 0
    assert st["当前位置"] == "未知"
    assert any("filled" in l and "饥饿度" in l for l in log)


def test_already_correct_data_is_untouched():
    """★ 反向守卫：形状本来就对的数据，一个字节都不该变（不产生任何日志）。"""
    good = {
        "露缇雅": {
            "状态": {"爱意": 7, "魔力值": 56, "饥饿度": 30, "当前位置": "卧室", "当前动作或体位": "坐"},
            "穿着": {"上身": "睡裙"},
            "隐私部位": {"胸部": "正常", "乳首": "正常"},
            "魅魔特征": {"翅膀状态": "展开", "性经验": {"接吻": 1, "爱抚": 2}},
        }
    }
    out, log = normalize_stat_data(copy.deepcopy(good), SKELETON)
    # 只允许「环境」那一组因为 schema 有而数据没有被补，露缇雅这一支必须原样
    assert out["露缇雅"] == good["露缇雅"], f"改动了本已正确的数据：{out['露缇雅']}"
    assert not [l for l in log if l.startswith("moved")], f"不该有搬移：{log}"


def test_unrelated_extra_keys_survive():
    """schema 未定义的外来键不能因为归一化被删掉（只在漂移字段内部才收拢）。"""
    data = {
        "露缇雅": {
            "状态": "x",
            "爱意": 7,
            "_自定义": {"a": 1},
        }
    }
    out, _ = normalize_stat_data(copy.deepcopy(data), SKELETON)
    assert out["露缇雅"]["_自定义"] == {"a": 1}, "外来键被误删"


def test_empty_skeleton_leaves_data_alone():
    """★ 安全阀：解析不出 schema 时绝不动数据。"""
    out, log = normalize_stat_data(copy.deepcopy(BROKEN), {})
    assert out == BROKEN
    assert any("no" in l or "skip" in l for l in log)


def test_nested_object_field_is_recursed():
    """嵌套对象字段（环境.时间）也要递归对齐。"""
    data = {"环境": {"时间": "不是对象", "年": 2026, "月": 7}}
    out, log = normalize_stat_data(copy.deepcopy(data), SKELETON)
    t = out["环境"]["时间"]
    assert isinstance(t, dict)
    assert t["年"] == 2026 and t["月"] == 7
    assert any("moved" in l and "年" in l for l in log)


def test_normalize_variables_wrapper():
    """外层包一层 stat_data 的结构同样能修。"""
    v = {"stat_data": copy.deepcopy(BROKEN), "note_prompt": "保留我"}
    out, log = normalize_variables(v, SKELETON)
    assert isinstance(out["stat_data"]["露缇雅"]["状态"], dict)
    assert out["note_prompt"] == "保留我", "stat_data 之外的键必须原样保留"
    assert len(log) > 0


def test_normalize_variables_without_stat_data_is_noop():
    v = {"note_prompt": "x"}
    out, _ = normalize_variables(v, SKELETON)
    assert out == v
