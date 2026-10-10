"""build_initial_stat_data 多存储形态取证（T1 · 2026-09-30）。

背景（实测取证）：`palink_raw_card_data` 结构的角色卡（v3 PNG 导入）把
`first_mes` / `alternate_greetings` / `character_book` 放在
**`palink_raw_card_data.data.*` 嵌套层**，而 `build_initial_stat_data` 旧实现只读
`character_extensions` 顶层 → initvar 提取扑空 → 卡 schema 的 zod prefault 占位值
（年=1/月=1/魔力值=100/饥饿度=0/当前位置=未知）成了会话初始变量 → 注入提示词后与剧情
上下文矛盾 → 模型思考死循环（2026-09-30 实测 10606 reasoning tokens / 正文 1005 字符）。

本文件锁定修复后的取值优先级（后者覆盖前者）：
  1. extensions 顶层（legacy）
  2. palink_sillytavern.card_fields.*（导入保留的深水区副本）
  3. palink_raw_card_data.*（v2 快照顶层）
  4. palink_raw_card_data.data.*（v3 快照权威层）
  5. 调用点显式传入的数据库列值（最高）
"""

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.services.mvu_engine import (  # noqa: E402
    MvuEngine,
    build_initial_stat_data,
)


# 复刻真实卡「露缇雅1.2」的 schema 形状：状态字段全部是 prefault 占位值
_SCHEMA_SCRIPT = """
export const Schema = z.object({
  环境: z.object({
    时间: z.object({
      年: z.coerce.number().prefault(1),
      季节: z.string().prefault('春'),
      月: z.coerce.number().prefault(1),
    }).prefault({}),
    温度: z.coerce.number().prefault(20),
  }).prefault({}),
  露缇雅: z.object({
    状态: z.object({
      爱意: z.coerce.number().prefault(0),
      魔力值: z.coerce.number().prefault(100),
      饥饿度: z.coerce.number().prefault(0),
      当前位置: z.string().prefault('未知'),
    }).prefault({}),
    穿着: z.object({}).prefault({}),
  }).prefault({}),
});
"""

# 真实卡里的 initvar 形状（缩进式 YAML，包在 <UpdateVariable><initvar> 里）
_INITVAR_TEXT = """<story>
七月的清晨，日光落进卧房。
</story>
<UpdateVariable>
<initvar>
环境:
  时间:
    年: 2026
    季节: "夏"
    月: 7
  温度: 24

露缇雅:
  状态:
    爱意: 5
    魔力值: 60
    饥饿度: 60
    当前位置: "哥哥的卧室"
  穿着:
    上身: "浅粉色纯棉无袖睡裙"
</initvar>
</UpdateVariable>"""


def _tavern_helper() -> dict:
    return {"scripts": [{"content": _SCHEMA_SCRIPT}], "variables": {}}


class TestNestedRawCardData:
    """根因场景：initvar 在 palink_raw_card_data 嵌套层，必须被提取且覆盖 prefault。"""

    def test_v3_data_layer_first_mes(self):
        ext = {
            "tavern_helper": _tavern_helper(),
            "palink_raw_card_data": {
                "spec": "chara_card_v3",
                "spec_version": "3.0",
                "data": {"first_mes": _INITVAR_TEXT},
            },
        }
        sd = build_initial_stat_data(ext)["stat_data"]
        # initvar 覆盖 prefault —— 修复前这里会是 1/100/0/未知
        assert sd["环境"]["时间"]["年"] == 2026
        assert sd["环境"]["时间"]["月"] == 7
        assert sd["环境"]["时间"]["季节"] == "夏"
        assert sd["环境"]["温度"] == 24
        assert sd["露缇雅"]["状态"]["爱意"] == 5
        assert sd["露缇雅"]["状态"]["魔力值"] == 60
        assert sd["露缇雅"]["状态"]["饥饿度"] == 60
        assert sd["露缇雅"]["状态"]["当前位置"] == "哥哥的卧室"
        # 真实卡最典型的现象：穿着在 prefault 里是空对象，initvar 才带来字段
        assert sd["露缇雅"]["穿着"] == {"上身": "浅粉色纯棉无袖睡裙"}

    def test_v2_top_level_of_raw_snapshot(self):
        ext = {
            "tavern_helper": _tavern_helper(),
            "palink_raw_card_data": {
                "spec": "chara_card_v2",
                "first_mes": _INITVAR_TEXT,
            },
        }
        sd = build_initial_stat_data(ext)["stat_data"]
        assert sd["露缇雅"]["状态"]["爱意"] == 5
        assert sd["露缇雅"]["状态"]["魔力值"] == 60

    def test_palink_sillytavern_card_fields_layer(self):
        ext = {
            "tavern_helper": _tavern_helper(),
            "palink_sillytavern": {"card_fields": {"first_mes": _INITVAR_TEXT}},
        }
        sd = build_initial_stat_data(ext)["stat_data"]
        assert sd["露缇雅"]["状态"]["饥饿度"] == 60

    def test_v3_data_layer_wins_over_legacy_and_v2_top(self):
        legacy_text = "<initvar>\n露缇雅:\n  状态:\n    爱意: 1\n</initvar>"
        v2_text = "<initvar>\n露缇雅:\n  状态:\n    爱意: 2\n</initvar>"
        ext = {
            "tavern_helper": _tavern_helper(),
            "first_mes": legacy_text,
            "palink_raw_card_data": {
                "first_mes": v2_text,
                "data": {"first_mes": _INITVAR_TEXT},
            },
        }
        sd = build_initial_stat_data(ext)["stat_data"]
        assert sd["露缇雅"]["状态"]["爱意"] == 5  # v3 data 层最高


class TestLegacyStructureRegression:
    """顶层 first_mes 老结构（现有测试的覆盖面）行为必须不变。"""

    def test_top_level_first_mes_still_extracted(self):
        ext = {
            "tavern_helper": _tavern_helper(),
            "first_mes": "<story>x</story>\n<initvar>\n露缇雅:\n  状态:\n    爱意: 9\n</initvar>",
        }
        sd = build_initial_stat_data(ext)["stat_data"]
        assert sd["露缇雅"]["状态"]["爱意"] == 9
        # 未在 initvar 里声明的字段仍取 schema 默认
        assert sd["露缇雅"]["状态"]["魔力值"] == 100

    def test_stat_data_wrapped_initvar_block(self):
        ext = {
            "tavern_helper": _tavern_helper(),
            "first_mes": "<initvar>\nstat_data:\n  露缇雅:\n    状态:\n      爱意: 7\n</initvar>",
        }
        assert build_initial_stat_data(ext)["stat_data"]["露缇雅"]["状态"]["爱意"] == 7

    def test_no_sources_keeps_schema_defaults(self):
        sd = build_initial_stat_data({"tavern_helper": _tavern_helper()})["stat_data"]
        assert sd["露缇雅"]["状态"] == {
            "爱意": 0,
            "魔力值": 100,
            "饥饿度": 0,
            "当前位置": "未知",
        }
        assert sd["露缇雅"]["穿着"] == {}

    def test_empty_and_non_dict_inputs(self):
        assert build_initial_stat_data({}) == {"stat_data": {}}
        assert build_initial_stat_data(None) == {"stat_data": {}}


class TestExplicitColumnPriority:
    """调用点传入的数据库列值（live 值）优先于导入快照。"""

    def test_column_first_mes_overrides_raw_snapshot(self):
        raw_text = "<initvar>\n露缇雅:\n  状态:\n    爱意: 1\n</initvar>"
        column_text = "<initvar>\n露缇雅:\n  状态:\n    爱意: 5\n</initvar>"
        ext = {
            "tavern_helper": _tavern_helper(),
            "palink_raw_card_data": {"data": {"first_mes": raw_text}},
        }
        sd = build_initial_stat_data(ext, first_mes=column_text)["stat_data"]
        assert sd["露缇雅"]["状态"]["爱意"] == 5

    def test_alternate_greetings_column_accepts_json_string(self):
        ext = {"tavern_helper": _tavern_helper()}
        column = json.dumps(
            ["<initvar>\n露缇雅:\n  状态:\n    爱意: 3\n</initvar>"],
            ensure_ascii=False,
        )
        sd = build_initial_stat_data(ext, alternate_greetings=column)["stat_data"]
        assert sd["露缇雅"]["状态"]["爱意"] == 3

    def test_nested_alternate_greetings_list(self):
        ext = {
            "tavern_helper": _tavern_helper(),
            "palink_raw_card_data": {
                "data": {
                    "alternate_greetings": [
                        "<initvar>\n露缇雅:\n  状态:\n    爱意: 4\n</initvar>",
                    ]
                }
            },
        }
        assert build_initial_stat_data(ext)["stat_data"]["露缇雅"]["状态"]["爱意"] == 4

    def test_empty_column_does_not_wipe_sources(self):
        """列值为空串/NULL 时不得把已有来源覆盖成空。"""
        ext = {
            "tavern_helper": _tavern_helper(),
            "palink_raw_card_data": {"data": {"first_mes": _INITVAR_TEXT}},
        }
        for empty in ("", None, "[]"):
            sd = build_initial_stat_data(ext, first_mes=empty)["stat_data"]
            assert sd["露缇雅"]["状态"]["爱意"] == 5, f"empty={empty!r} 时被清空"


class TestCharacterBookPriority:
    """character_book：嵌套快照只兜底，顶层（world_books 合并结果）优先。"""

    def test_raw_nested_character_book_used_as_fallback(self):
        ext = {
            "tavern_helper": _tavern_helper(),
            "palink_raw_card_data": {
                "data": {
                    "character_book": {
                        "entries": [
                            {
                                "content": "<initvar>\n露缇雅:\n  状态:\n    当前位置: 书房\n</initvar>",
                                "enabled": False,
                            }
                        ]
                    }
                }
            },
        }
        sd = build_initial_stat_data(ext)["stat_data"]
        assert sd["露缇雅"]["状态"]["当前位置"] == "书房"

    def test_top_level_character_book_wins_over_snapshot(self):
        """顶层 character_book 来自 world_books（用户可编辑），必须覆盖导入快照。"""
        ext = {
            "tavern_helper": _tavern_helper(),
            "palink_raw_card_data": {
                "data": {
                    "character_book": {
                        "entries": [
                            {"content": "<initvar>\n露缇雅:\n  状态:\n    当前位置: 旧快照\n</initvar>"}
                        ]
                    }
                }
            },
            "character_book": {
                "entries": {
                    "0": {"content": "<initvar>\n露缇雅:\n  状态:\n    当前位置: 权威值\n</initvar>"}
                }
            },
        }
        sd = build_initial_stat_data(ext)["stat_data"]
        assert sd["露缇雅"]["状态"]["当前位置"] == "权威值"

    def test_v2_raw_top_level_character_book(self):
        ext = {
            "tavern_helper": _tavern_helper(),
            "palink_raw_card_data": {
                "character_book": {
                    "entries": [
                        {"content": "<initvar>\n露缇雅:\n  状态:\n    当前位置: v2书\n</initvar>"}
                    ]
                }
            },
        }
        assert build_initial_stat_data(ext)["stat_data"]["露缇雅"]["状态"]["当前位置"] == "v2书"


class TestMvuEngineWrappers:
    """薄封装必须透传列值（否则调用点传了也白传）。"""

    def test_init_session_variables_forwards_first_mes(self):
        ext = {"tavern_helper": _tavern_helper()}
        out = MvuEngine.init_session_variables(
            ext,
            first_mes="<initvar>\n露缇雅:\n  状态:\n    爱意: 8\n</initvar>",
        )
        assert out["stat_data"]["露缇雅"]["状态"]["爱意"] == 8

    def test_update_from_reply_fallback_init_uses_columns(self):
        ext = {"tavern_helper": _tavern_helper()}
        new_vars, logs, _patches = MvuEngine.update_from_reply(
            {"stat_data": {}},
            '<UpdateVariable><JSONPatch>[{"op":"replace","path":"/露缇雅/状态/爱意","value":6}]</JSONPatch></UpdateVariable>',
            ext,
            first_mes="<initvar>\n露缇雅:\n  状态:\n    爱意: 5\n    魔力值: 60\n</initvar>",
        )
        assert new_vars["stat_data"]["露缇雅"]["状态"]["爱意"] == 6
        assert new_vars["stat_data"]["露缇雅"]["状态"]["魔力值"] == 60  # 兜底 init 生效
        assert logs

    def test_positional_legacy_call_signature_still_works(self):
        """老调用方（单参数位置传参）不得被关键字参数改动破坏。"""
        ext = {"tavern_helper": _tavern_helper()}
        assert MvuEngine.init_session_variables(ext)["stat_data"]["露缇雅"]["状态"]["魔力值"] == 100
        new_vars, logs, _patches = MvuEngine.update_from_reply({"stat_data": {"露缇雅": {"状态": {"爱意": 1}}}}, "无更新", ext)
        assert new_vars["stat_data"]["露缇雅"]["状态"]["爱意"] == 1
        assert logs == []
