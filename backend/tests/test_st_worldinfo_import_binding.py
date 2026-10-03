"""
守卫：ST 插件面的世界书写入路径必须支持角色绑定，不得静默产生「无头」书。

背景（用户实测发现）：Palink 的世界书注入是按角色隔离的 —— 未绑定的书不注入任何角色。
但 ST 侧三条写入路径曾把 `character_id` 写死 None：
  1. POST /api/worldinfo/edit      （st_edit_worldinfo）
  2. POST /api/worldinfo/import    （st_import_worldinfo，单文件）
  3. POST /api/worldinfo/import/batch（st_batch_import_worldinfo，ZIP 批量）
于是经插件面导入的书必然「无头」—— 用户以为导入了，其实任何角色的会话都读不到它。

本次修法：三条路径都接受可选 `characterId`（camelCase，与 ST 请求体风格一致），
经 `_resolve_owned_character_id` 校验归属后才写入。

本测试锁两件事：
  · 源码层：三条路径不得再出现硬编码 `character_id=None` 的落库
  · 归属校验：绑定到他人角色会被拒（越权等于把内容送到别人会话里）
"""
import re
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1] / "app" / "api"
ST_PY = API_DIR / "silly_tavern.py"


@pytest.fixture(scope="module")
def src() -> str:
    return ST_PY.read_text(encoding="utf-8")


class TestStWorldinfoWritePathsAcceptBinding:
    def test_edit_request_model_accepts_character_id(self, src):
        block = re.search(
            r"class WorldInfoEditRequest\(BaseModel\):.*?(?=\n\nclass |\n\n@router)",
            src, re.S,
        )
        assert block, "应仍存在 WorldInfoEditRequest"
        assert "characterId" in block.group(0), \
            "WorldInfoEditRequest 未接受 characterId —— /api/worldinfo/edit 导入的书会是无头的"

    def test_persist_helper_accepts_character_id_param(self, src):
        sig = re.search(
            r"def _persist_worldbook_from_data\((.*?)\) -> str:", src, re.S
        )
        assert sig, "应仍存在 _persist_worldbook_from_data"
        assert "character_id" in sig.group(1), \
            "_persist_worldbook_from_data 未接受 character_id 参数"

    def test_both_import_endpoints_accept_character_id(self, src):
        for fn in ("st_import_worldinfo", "st_batch_import_worldinfo"):
            sig = re.search(rf"async def {fn}\((.*?)\n\):", src, re.S)
            assert sig, f"应仍存在 {fn}"
            assert "characterId" in sig.group(1), \
                f"{fn} 未接受 characterId —— 经该路径导入的书会是无头的"

    def test_ownership_guard_exists_and_is_used(self, src):
        assert "def _resolve_owned_character_id(" in src, \
            "缺少 _resolve_owned_character_id —— 绑定不校验归属等于允许越权挂他人角色"
        # 三条路径都要过这道校验：
        #   edit 端点内联一次 + 单文件导入一次 + 批量导入在循环外算一次
        uses = src.count("_resolve_owned_character_id(db, user")
        assert uses >= 3, \
            f"三条 ST 世界书写入路径应都经过归属校验，当前只见到 {uses} 处"


class TestNoHardcodedNoneBinding:
    def test_no_st_worldbook_write_path_hardcodes_none(self, src):
        """落库处不得再写死 character_id=None。

        只看 WorldBook( 构造块，避免误伤纯查询处的 None。
        """
        offenders = []
        for m in re.finditer(r"WorldBook\((.*?)\n\s*\)", src, re.S):
            block = m.group(1)
            if "character_id=None" in block:
                line = src[: m.start()].count("\n") + 1
                offenders.append(line)
        assert not offenders, (
            f"仍有世界书落库点写死 character_id=None（行 {offenders}）—— 会产生无头书"
        )

    def test_edit_path_only_overwrites_binding_when_explicitly_provided(self, src):
        """整页覆盖时若不显式传绑定，不能把已有绑定悄悄抹掉。"""
        assert "if req.characterId is not None:" in src, \
            "整体覆盖前应判断是否显式传了绑定，否则改个名字就把绑定抹了"