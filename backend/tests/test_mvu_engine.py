"""mvu_engine 单测 —— 覆盖 spec §7.1 全部用例。"""

import json
import sys
import os
import pytest

# 确保能 import（backend 目录——此前误插仓库根，单独运行本文件时
# "app is not a package" 收集失败，全量运行靠其他测试文件先行注入才侥幸通过）
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.services.mvu_engine import (
    extract_update_variable_blocks,
    apply_patches,
    extract_schema_defaults,
    build_initial_stat_data,
    MvuEngine,
)


# ===========================================================================
# 1. extract_update_variable_blocks
# ===========================================================================


class TestExtractBlocks:
    def test_single_block_with_jsonpatch_tag(self):
        text = '一些回复\n<UpdateVariable>\n<Analysis>分析</Analysis>\n<JSONPatch>\n[{"op":"replace","path":"/桃汐/好感度","value":60}]\n</JSONPatch>\n</UpdateVariable>'
        blocks = extract_update_variable_blocks(text)
        assert len(blocks) == 1
        assert blocks[0] == [{"op": "replace", "path": "/桃汐/好感度", "value": 60}]

    def test_multiple_blocks(self):
        text = (
            '<UpdateVariable><JSONPatch>[{"op":"delta","path":"/a","value":1}]</JSONPatch></UpdateVariable>'
            '中间文本'
            '<UpdateVariable><JSONPatch>[{"op":"delta","path":"/b","value":2}]</JSONPatch></UpdateVariable>'
        )
        blocks = extract_update_variable_blocks(text)
        assert len(blocks) == 2
        assert blocks[0][0]["path"] == "/a"
        assert blocks[1][0]["path"] == "/b"

    def test_no_jsonpatch_tag_fallback_array(self):
        text = '<UpdateVariable>\n<Analysis>分析</Analysis>\n[\n  {"op": "replace", "path": "/x", "value": 1}\n]\n</UpdateVariable>'
        blocks = extract_update_variable_blocks(text)
        assert len(blocks) == 1
        assert blocks[0] == [{"op": "replace", "path": "/x", "value": 1}]

    def test_empty_text(self):
        assert extract_update_variable_blocks("") == []
        assert extract_update_variable_blocks("没有变量的普通回复") == []

    def test_illegal_json_skipped(self):
        text = '<UpdateVariable><JSONPatch>[这不是json]</JSONPatch></UpdateVariable>'
        blocks = extract_update_variable_blocks(text)
        assert blocks == []

    def test_trailing_comma_repair(self):
        text = '<UpdateVariable><JSONPatch>[{"op":"replace","path":"/a","value":1},]</JSONPatch></UpdateVariable>'
        blocks = extract_update_variable_blocks(text)
        assert len(blocks) == 1
        assert len(blocks[0]) == 1

    def test_single_quotes_repair(self):
        text = "<UpdateVariable><JSONPatch>[{'op':'replace','path':'/a','value':1}]</JSONPatch></UpdateVariable>"
        blocks = extract_update_variable_blocks(text)
        assert len(blocks) == 1

    def test_placeholder_lines_removed(self):
        """AI 偶发未替换 ${...} 占位行应被移除。"""
        text = '<UpdateVariable><JSONPatch>[\n{"op": "replace", "path": "/世界信息/日期时间", "value": "${new_value}"},\n{"op": "replace", "path": "/世界信息/天气", "value": "晴"}\n]</JSONPatch></UpdateVariable>'
        blocks = extract_update_variable_blocks(text)
        assert len(blocks) == 1
        # 含 ${} 的行被移除，只剩 1 条
        assert len(blocks[0]) == 1
        assert blocks[0][0]["path"] == "/世界信息/天气"


# ===========================================================================
# 2. apply_patches
# ===========================================================================


class TestApplyPatches:
    def test_replace_number(self):
        stat = {"stat_data": {"桃汐": {"好感度": 50}}}
        patches = [{"op": "replace", "path": "/桃汐/好感度", "value": 60}]
        result, logs = apply_patches(stat, patches)
        assert result["stat_data"]["桃汐"]["好感度"] == 60
        # 原始不被修改
        assert stat["stat_data"]["桃汐"]["好感度"] == 50

    def test_replace_string(self):
        stat = {"stat_data": {"世界信息": {"天气": ""}}}
        patches = [{"op": "replace", "path": "/世界信息/天气", "value": "晴"}]
        result, _ = apply_patches(stat, patches)
        assert result["stat_data"]["世界信息"]["天气"] == "晴"

    def test_delta_positive(self):
        stat = {"stat_data": {"桃汐": {"好感度": 50}}}
        patches = [{"op": "delta", "path": "/桃汐/好感度", "value": 5}]
        result, _ = apply_patches(stat, patches)
        assert result["stat_data"]["桃汐"]["好感度"] == 55

    def test_delta_negative(self):
        stat = {"stat_data": {"桃汐": {"好感度": 50}}}
        patches = [{"op": "delta", "path": "/桃汐/好感度", "value": -10}]
        result, _ = apply_patches(stat, patches)
        assert result["stat_data"]["桃汐"]["好感度"] == 40

    def test_delta_int_preserved(self):
        """原值 int + delta int → 结果 int（不变成 float）。"""
        stat = {"stat_data": {"a": 10}}
        result, _ = apply_patches(stat, [{"op": "delta", "path": "/a", "value": 3}])
        assert result["stat_data"]["a"] == 13
        assert isinstance(result["stat_data"]["a"], int)

    def test_delta_non_number_skipped(self):
        stat = {"stat_data": {"桃汐": {"关系": "青梅竹马"}}}
        patches = [{"op": "delta", "path": "/桃汐/关系", "value": 5}]
        result, logs = apply_patches(stat, patches)
        assert result["stat_data"]["桃汐"]["关系"] == "青梅竹马"
        assert any("delta skip" in l for l in logs)

    def test_delta_missing_path_skipped(self):
        stat = {"stat_data": {}}
        patches = [{"op": "delta", "path": "/桃汐/好感度", "value": 5}]
        result, logs = apply_patches(stat, patches)
        assert result["stat_data"] == {}
        assert any("delta skip" in l for l in logs)

    def test_insert_array_append(self):
        stat = {"stat_data": {"事件日志": []}}
        patches = [{"op": "insert", "path": "/事件日志/-", "value": "第一次约会"}]
        result, _ = apply_patches(stat, patches)
        assert result["stat_data"]["事件日志"] == ["第一次约会"]

    def test_insert_object_new_key(self):
        stat = {"stat_data": {"桃汐": {}}}
        patches = [{"op": "insert", "path": "/桃汐/新字段", "value": "test"}]
        result, _ = apply_patches(stat, patches)
        assert result["stat_data"]["桃汐"]["新字段"] == "test"

    def test_remove_existing(self):
        stat = {"stat_data": {"桃汐": {"临时": "x", "好感度": 50}}}
        patches = [{"op": "remove", "path": "/桃汐/临时"}]
        result, _ = apply_patches(stat, patches)
        assert "临时" not in result["stat_data"]["桃汐"]
        assert result["stat_data"]["桃汐"]["好感度"] == 50

    def test_remove_nonexistent(self):
        stat = {"stat_data": {"桃汐": {}}}
        patches = [{"op": "remove", "path": "/桃汐/不存在"}]
        result, logs = apply_patches(stat, patches)
        assert "不存在" not in result["stat_data"]["桃汐"]

    def test_move(self):
        stat = {"stat_data": {"a": {"值": 1}, "b": {}}}
        patches = [{"op": "move", "from": "/a/值", "path": "/b/值"}]
        result, _ = apply_patches(stat, patches)
        assert "值" not in result["stat_data"]["a"]
        assert result["stat_data"]["b"]["值"] == 1

    def test_readonly_prefix_skipped(self):
        stat = {"stat_data": {"_变量": "secret", "桃汐": {"好感度": 50}}}
        patches = [{"op": "replace", "path": "/_变量", "value": "hacked"}]
        result, logs = apply_patches(stat, patches)
        assert result["stat_data"]["_变量"] == "secret"
        assert any("readonly" in l for l in logs)

    def test_readonly_nested_skipped(self):
        stat = {"stat_data": {"_internal": {"key": "v"}}}
        patches = [{"op": "replace", "path": "/_internal/key", "value": "hacked"}]
        result, logs = apply_patches(stat, patches)
        assert result["stat_data"]["_internal"]["key"] == "v"
        assert any("readonly" in l for l in logs)

    def test_single_op_error_no_abort(self):
        stat = {"stat_data": {"a": 1}}
        patches = [
            {"op": "replace", "path": "/a", "value": 2},
            {"op": "badop", "path": "/b", "value": 3},
            {"op": "replace", "path": "/c", "value": 3},
        ]
        result, logs = apply_patches(stat, patches)
        assert result["stat_data"]["a"] == 2
        assert result["stat_data"]["c"] == 3
        assert any("unknown op" in l for l in logs)

    def test_json_pointer_escaping(self):
        """路径含 ~1 (=/) 和 ~0 (=~)。"""
        stat = {"stat_data": {"a/b": {"c": 1}}}
        patches = [{"op": "replace", "path": "/a~1b/c", "value": 2}]
        result, _ = apply_patches(stat, patches)
        assert result["stat_data"]["a/b"]["c"] == 2

    def test_empty_patches(self):
        stat = {"stat_data": {"a": 1}}
        result, logs = apply_patches(stat, [])
        assert result["stat_data"]["a"] == 1
        assert logs == []

    def test_deep_nested_set_creates_path(self):
        stat = {"stat_data": {}}
        patches = [{"op": "replace", "path": "/a/b/c/d", "value": 42}]
        result, _ = apply_patches(stat, patches)
        assert result["stat_data"]["a"]["b"]["c"]["d"] == 42

    def test_idempotent_replace(self):
        """同一回复应用两次 replace 结果一致。"""
        stat = {"stat_data": {"a": 1}}
        patches = [{"op": "replace", "path": "/a", "value": 5}]
        r1, _ = apply_patches(stat, patches)
        r2, _ = apply_patches(r1, patches)
        assert r2["stat_data"]["a"] == 5


# ===========================================================================
# 3. extract_schema_defaults
# ===========================================================================

# 从猫娘卡提取的真实「变量结构」脚本（截取关键部分）
_CATGIRL_SCHEMA_SCRIPT = """import { registerMvuSchema } from 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js';

export const Schema = z.object({
  世界信息: z.object({
    日期时间: z.string().prefault(''),
    天气: z.string().prefault(''),
    风力: z.string().prefault(''),
    地点: z.string().prefault(''),
  }).prefault({}),

  桃汐: z.object({
    好感度: z.coerce.number().transform(v => _.clamp(v, 0, 100)).prefault(50),
    关系: z.string().prefault('青梅竹马'),
    性欲值: z.coerce.number().transform(v => _.clamp(v, 0, 100)).prefault(20),
    服饰: z.string().prefault(''),
    内心想法: z.string().prefault(''),
    发情期: z.string().prefault('2026年06月13日'),
  }).prefault({}),

  苏小兰: z.object({
    好感度: z.coerce.number().transform(v => _.clamp(v, 0, 100)).prefault(20),
    关系: z.string().prefault('邻居'),
  }).prefault({}),
});
"""


class TestExtractSchemaDefaults:
    def test_catgirl_schema(self):
        th = {"scripts": [{"content": _CATGIRL_SCHEMA_SCRIPT}]}
        defaults = extract_schema_defaults(th)
        assert defaults["桃汐"]["好感度"] == 50
        assert defaults["桃汐"]["关系"] == "青梅竹马"
        assert defaults["桃汐"]["性欲值"] == 20
        assert defaults["桃汐"]["发情期"] == "2026年06月13日"
        assert defaults["世界信息"]["日期时间"] == ""
        assert defaults["世界信息"]["天气"] == ""
        assert defaults["苏小兰"]["好感度"] == 20
        assert defaults["苏小兰"]["关系"] == "邻居"

    def test_no_schema_returns_empty(self):
        th = {"scripts": [{"content": "console.log('no schema')"}]}
        assert extract_schema_defaults(th) == {}

    def test_no_scripts_returns_empty(self):
        assert extract_schema_defaults({}) == {}
        assert extract_schema_defaults({"scripts": []}) == {}

    def test_non_dict_returns_empty(self):
        assert extract_schema_defaults(None) == {}
        assert extract_schema_defaults("string") == {}

    def test_nested_object_prefault_explicit(self):
        schema = """
        z.object({
          角色: z.object({
            名字: z.string().prefault('默认名'),
          }).prefault({ 名字: '覆盖名' }),
        });
        """
        th = {"scripts": [{"content": schema}]}
        defaults = extract_schema_defaults(th)
        assert defaults["角色"]["名字"] == "覆盖名"

    def test_no_prefault_zero_values(self):
        schema = """
        z.object({
          文本: z.string(),
          数字: z.number(),
          开关: z.boolean(),
          列表: z.array(z.string()),
        });
        """
        th = {"scripts": [{"content": schema}]}
        defaults = extract_schema_defaults(th)
        assert defaults["文本"] == ""
        assert defaults["数字"] == 0
        assert defaults["开关"] is False
        assert defaults["列表"] == []


# ===========================================================================
# 4. build_initial_stat_data
# ===========================================================================


class TestBuildInitialStatData:
    def test_from_schema(self):
        ext = {
            "tavern_helper": {"scripts": [{"content": _CATGIRL_SCHEMA_SCRIPT}], "variables": {}},
        }
        result = build_initial_stat_data(ext)
        assert "stat_data" in result
        assert result["stat_data"]["桃汐"]["好感度"] == 50

    def test_variables_override_schema(self):
        ext = {
            "tavern_helper": {
                "scripts": [{"content": _CATGIRL_SCHEMA_SCRIPT}],
                "variables": {"桃汐": {"好感度": 99}},
            },
        }
        result = build_initial_stat_data(ext)
        assert result["stat_data"]["桃汐"]["好感度"] == 99
        # schema 其他字段保留
        assert result["stat_data"]["桃汐"]["关系"] == "青梅竹马"

    def test_initvar_merge(self):
        ext = {
            "first_mes": "开头\n<initvar>\nstat_data:\n  桃汐:\n    好感度: 30\n</initvar>",
            "tavern_helper": {"scripts": [{"content": _CATGIRL_SCHEMA_SCRIPT}], "variables": {}},
        }
        result = build_initial_stat_data(ext)
        # initvar 覆盖 schema 默认值
        assert result["stat_data"]["桃汐"]["好感度"] == 30

    def test_empty_extensions(self):
        assert build_initial_stat_data({}) == {"stat_data": {}}

    def test_non_dict(self):
        assert build_initial_stat_data(None) == {"stat_data": {}}


# ===========================================================================
# 5. MvuEngine 封装
# ===========================================================================


class TestMvuEngine:
    def test_init_session_variables(self):
        ext = {"tavern_helper": {"scripts": [{"content": _CATGIRL_SCHEMA_SCRIPT}], "variables": {}}}
        result = MvuEngine.init_session_variables(ext)
        assert result["stat_data"]["桃汐"]["好感度"] == 50

    def test_update_from_reply_applies_patch(self):
        ext = {"tavern_helper": {"scripts": [{"content": _CATGIRL_SCHEMA_SCRIPT}], "variables": {}}}
        cur = {"stat_data": {"桃汐": {"好感度": 50, "关系": "青梅竹马"}}}
        reply = '<UpdateVariable><JSONPatch>[{"op":"delta","path":"/桃汐/好感度","value":5},{"op":"replace","path":"/桃汐/关系","value":"恋人"}]</JSONPatch></UpdateVariable>'
        new_vars, logs = MvuEngine.update_from_reply(cur, reply, ext)
        assert new_vars["stat_data"]["桃汐"]["好感度"] == 55
        assert new_vars["stat_data"]["桃汐"]["关系"] == "恋人"
        assert len(logs) > 0

    def test_update_from_reply_no_update_variable(self):
        ext = {"tavern_helper": {"scripts": [{"content": _CATGIRL_SCHEMA_SCRIPT}], "variables": {}}}
        cur = {"stat_data": {"桃汐": {"好感度": 50}}}
        new_vars, logs = MvuEngine.update_from_reply(cur, "普通回复无变量更新", ext)
        assert new_vars["stat_data"]["桃汐"]["好感度"] == 50
        assert logs == []

    def test_update_from_reply_empty_stat_init_from_schema(self):
        """stat_data 为空时，先从 schema 兜底初始化。"""
        ext = {"tavern_helper": {"scripts": [{"content": _CATGIRL_SCHEMA_SCRIPT}], "variables": {}}}
        cur = {"stat_data": {}}
        reply = '<UpdateVariable><JSONPatch>[{"op":"delta","path":"/桃汐/好感度","value":5}]</JSONPatch></UpdateVariable>'
        new_vars, logs = MvuEngine.update_from_reply(cur, reply, ext)
        # 兜底初始化为 50，再 delta 5 → 55
        assert new_vars["stat_data"]["桃汐"]["好感度"] == 55

    def test_update_from_reply_multiple_blocks(self):
        cur = {"stat_data": {"a": 0}}
        reply = (
            '<UpdateVariable><JSONPatch>[{"op":"delta","path":"/a","value":1}]</JSONPatch></UpdateVariable>'
            '<UpdateVariable><JSONPatch>[{"op":"delta","path":"/a","value":2}]</JSONPatch></UpdateVariable>'
        )
        new_vars, logs = MvuEngine.update_from_reply(cur, reply, {})
        assert new_vars["stat_data"]["a"] == 3
        assert len(logs) == 2

    def test_update_from_reply_illegal_block_skipped(self):
        cur = {"stat_data": {"a": 1}}
        reply = (
            '<UpdateVariable><JSONPatch>[bad json]</JSONPatch></UpdateVariable>'
            '<UpdateVariable><JSONPatch>[{"op":"delta","path":"/a","value":5}]</JSONPatch></UpdateVariable>'
        )
        new_vars, logs = MvuEngine.update_from_reply(cur, reply, {})
        assert new_vars["stat_data"]["a"] == 6

    def test_update_does_not_mutate_input(self):
        cur = {"stat_data": {"a": 1}}
        reply = '<UpdateVariable><JSONPatch>[{"op":"replace","path":"/a","value":99}]</JSONPatch></UpdateVariable>'
        new_vars, _ = MvuEngine.update_from_reply(cur, reply, {})
        assert cur["stat_data"]["a"] == 1
        assert new_vars["stat_data"]["a"] == 99


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
