"""V2 角色卡 ``depth_prompt`` 导入保留回归（2026-09-27）。

背景（真 BUG，用户报）：V2 卡把 ``depth_prompt`` 放在 **data 顶层**（多数导出器的写法）
时，导入后 ``characters.extensions`` 里只在 ``palink_sillytavern.card_fields`` 深处
留了一份副本，而唯一消费它的装配层
``roleplay_prompt_assembly._insert_depth_prompt``（第 5046 行）只读 extensions
**顶层** ``depth_prompt`` → 深度提示词实际不生效（"导入后丢失"）。

反过来，写在 ``data.extensions.depth_prompt`` 的卡却正常 —— 因为 extensions 被整体
拷贝进结果。这种"非标准位置反而保住、标准位置反而丢"的不对称就是本 BUG 的特征。

修复口径：**两种位置都要落到 extensions 顶层**，且二者都存在时以
``data.extensions.*``（ST 标准位置）为准。
"""

import json
import os
import sys

# 让 ``backend`` 目录可被导入（测试可位于 backend/tests/ 下独立运行）
_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.services.character_import_service import CharacterDataNormalizer  # noqa: E402


DEPTH_PROMPT_A = {"prompt": "深层视角：观察者注视梦境", "depth": 4, "role": "system"}
DEPTH_PROMPT_B = {"prompt": "extensions 里的深层提示", "depth": 3, "role": "system"}


def _v2_card(depth_prompt=None, extensions=None):
    data = {
        "name": "Depth Tester",
        "description": "用于验证 depth_prompt 导入保留",
        "personality": "沉静",
        "first_mes": "……",
        "extensions": dict(extensions or {}),
    }
    if depth_prompt is not None:
        data["depth_prompt"] = depth_prompt
    return {"spec": "chara_card_v2", "spec_version": "2.0", "data": data}


class TestDepthPromptImportPositions:
    """两种写法的位置都要保住 —— 关键是 extensions 顶层（装配层的唯一读取点）。"""

    def test_data_top_level_depth_prompt_lands_in_extensions(self):
        """标准位置：``data.depth_prompt`` → extensions 顶层可见。"""
        normalized = CharacterDataNormalizer.normalize(_v2_card(depth_prompt=DEPTH_PROMPT_A))
        extensions = normalized["extensions"]

        assert extensions.get("depth_prompt") == DEPTH_PROMPT_A

    def test_extensions_depth_prompt_still_preserved(self):
        """非标准/ST 惯用位置：``data.extensions.depth_prompt`` 不能被改坏。"""
        card = _v2_card(extensions={"depth_prompt": DEPTH_PROMPT_B})
        normalized = CharacterDataNormalizer.normalize(card)
        extensions = normalized["extensions"]

        assert extensions.get("depth_prompt") == DEPTH_PROMPT_B

    def test_both_positions_extensions_wins(self):
        """两处都有时以 extensions（ST 标准位置）为准，不被 data 顶层覆盖。"""
        card = _v2_card(
            depth_prompt=DEPTH_PROMPT_A,
            extensions={"depth_prompt": DEPTH_PROMPT_B},
        )
        normalized = CharacterDataNormalizer.normalize(card)

        assert normalized["extensions"]["depth_prompt"] == DEPTH_PROMPT_B

    def test_card_fields_copy_unchanged(self):
        """既有行为不动：card_fields 里仍留一份，且 extensions 版本不被写脏。"""
        normalized = CharacterDataNormalizer.normalize(_v2_card(depth_prompt=DEPTH_PROMPT_A))
        palink_st = normalized["extensions"]["palink_sillytavern"]

        assert palink_st["card_fields"]["depth_prompt"] == DEPTH_PROMPT_A

    def test_card_without_depth_prompt_gets_no_key(self):
        """没有 depth_prompt 的卡不得被无中生有地塞一个空键（污染 extensions）。"""
        normalized = CharacterDataNormalizer.normalize(_v2_card())

        assert "depth_prompt" not in normalized["extensions"]

    def test_non_dict_depth_prompt_is_ignored(self):
        """脏数据：非 dict 形态不得被抬进 extensions（装配层读 dict 才生效）。"""
        card = _v2_card(depth_prompt="不是 dict")
        normalized = CharacterDataNormalizer.normalize(card)

        assert normalized["extensions"].get("depth_prompt") is None

    def test_extensions_payload_is_json_serializable(self):
        """落地路径是 extensions=json.dumps(...)，必须可序列化且能原样读回。"""
        normalized = CharacterDataNormalizer.normalize(_v2_card(depth_prompt=DEPTH_PROMPT_A))
        roundtrip = json.loads(json.dumps(normalized["extensions"], ensure_ascii=False))

        assert roundtrip["depth_prompt"]["prompt"] == DEPTH_PROMPT_A["prompt"]
