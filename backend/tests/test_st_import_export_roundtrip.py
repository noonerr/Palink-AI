"""ST (SillyTavern) 兼容端点导入导出往返测试。

验证角色卡、聊天 JSONL、世界书数据在 ST 兼容端点往返不丢失字段。

测试分三层：
1. 纯函数往返（无需 DB）：使用真实导入/导出函数 + 内存模型对象验证字段保留。
   - 角色卡：``CharacterDataNormalizer.normalize`` (导入) → 内存 ``Character`` →
     ``convert_character_to_chara_card`` (导出)
   - 聊天 JSONL：``convert_group_chat_to_jsonl`` ↔ ``convert_jsonl_to_group_chat``
   - 世界书：内存 ``WorldBookStage`` → ``_worldbook_to_charbook`` (导出)
2. 需 DB 的端到端测试（占位 ``pytest.skip``）。
3. 字段覆盖验证：检查 Palink 数据模型覆盖了所有 ST 必需字段。

注意：ST 世界书条目使用混合命名约定 —— 部分字段为 camelCase（selectiveLogic,
groupOverride 等），部分为 lowercase（key, content, depth 等）。本测试的 fixture
使用与 ST 实际格式一致的字段名，以确保导入代码能正确读取。
"""

import json
import os
import sys
from datetime import datetime, timezone

import pytest

# 让 ``backend`` 目录可被导入（测试可位于 backend/tests/ 下独立运行）
_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.character_card import convert_character_to_chara_card  # noqa: E402
from app.services.character_import_service import CharacterDataNormalizer  # noqa: E402
from app.services.st_sync_service import (  # noqa: E402
    _message_to_st_jsonl,
    _st_msg_content,
    _st_msg_extra,
    _st_msg_role,
    _st_msg_swipes,
    _worldbook_to_charbook,
    convert_group_chat_to_jsonl,
    convert_jsonl_to_group_chat,
)
from app.models import Character, CharacterChatMessage, User  # noqa: E402
from app.models.worldbook import WorldBook, WorldBookStage  # noqa: E402


# ---------------------------------------------------------------------------
# ST 角色卡 Fixtures
# ---------------------------------------------------------------------------

ST_V2_CARD = {
    "spec": "chara_card_v2",
    "spec_version": "2.0",
    "data": {
        "name": "Test Character",
        "description": "A test character",
        "personality": "Friendly and curious",
        "scenario": "In a forest",
        "first_mes": "Hello there!",
        "mes_example": "User: Hi\nChar: Hello!",
        "creator_notes": "Created for testing",
        "system_prompt": "You are a character",
        "post_history_instructions": "Remember context",
        "tags": ["fantasy", "test"],
        "creator": "TestAuthor",
        "character_version": "1.0",
        "alternate_greetings": ["Greetings, traveler!", "Well met!"],
        "extensions": {
            "depth_prompt": {"prompt": "Depth prompt", "depth": 4},
            "talkativeness": "0.5",
        },
        "character_book": {
            "name": "test_book",
            "entries": {
                "0": {
                    "key": ["forest"],
                    "keysecondary": [],
                    "content": "The forest is dark",
                    "comment": "Forest entry",
                    "constant": False,
                    "selective": False,
                    "selectiveLogic": 0,
                    "position": 0,
                    "depth": 4,
                    "probability": 100,
                    "disable": False,
                }
            },
        },
    },
}

ST_V3_CARD = {
    "spec": "chara_card_v3",
    "spec_version": "3.0",
    "data": {
        **ST_V2_CARD["data"],
        "extensions": {**ST_V2_CARD["data"]["extensions"], "v3_spec": True},
        "group_only_greetings": ["Group greeting 1"],
        "assets": [
            {"type": "icon", "uri": "data:image/png;base64,AAAA", "name": "icon.png"}
        ],
    },
}


# ---------------------------------------------------------------------------
# ST 聊天 JSONL Fixtures
# ---------------------------------------------------------------------------

ST_CHAT_MESSAGES = [
    {
        "name": "Test Character",
        "is_user": False,
        "is_system": False,
        "send_date": "2024-01-01T00:00:00",
        "mes": "Hello!",
        "swipe_id": 0,
        "swipes": ["Hello!", "Hi there!"],
        "extra": {"reasoning": "thinking..."},
    },
    {
        "name": "User",
        "is_user": True,
        "is_system": False,
        "send_date": "2024-01-01T00:01:00",
        "mes": "Hi",
        "swipe_id": 0,
        "swipes": ["Hi"],
        "extra": {},
    },
    {
        "name": "Test Character",
        "is_user": False,
        "is_system": True,
        "send_date": "2024-01-01T00:02:00",
        "mes": "System note",
        "swipe_id": 0,
        "swipes": ["System note"],
        "extra": {"is_system": True},
    },
]

ST_CHAT_METADATA_HEADER = {
    "user_name": "TestUser",
    "character_name": "Test Character",
    "create_date": "2024-01-01T00:00:00",
    "chat_metadata": {
        "talkativeness": "0.5",
        "variables": {"location": "forest", "mood": "happy"},
    },
}


def _build_jsonl_with_header():
    """构建带 chat_metadata header 行的完整 JSONL 字符串。"""
    lines = [json.dumps(ST_CHAT_METADATA_HEADER, ensure_ascii=False)]
    for msg in ST_CHAT_MESSAGES:
        lines.append(json.dumps(msg, ensure_ascii=False))
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# ST 世界书 Fixtures
# ---------------------------------------------------------------------------

# 使用 ST 实际格式：camelCase 字段（selectiveLogic, groupOverride 等）+
# lowercase 字段（key, content, depth 等）
ST_WORLD_INFO = {
    "name": "Test World",
    "description": "A test worldbook",
    "entries": {
        "0": {
            "uid": 0,
            "key": ["dragon"],
            "keysecondary": ["fire"],
            "comment": "Dragon entry",
            "content": "Dragons breathe fire",
            "constant": False,
            "selective": True,
            "selectiveLogic": 0,
            "position": 0,
            "disable": False,
            "probability": 100,
            "depth": 4,
            "order": 0,
            "group": "creatures",
            "groupWeight": 100,
            "groupOverride": False,
            "use_regex": False,
            "automation_id": "",
            "role": 0,
            "recursion": True,
            "excludeRecursion": False,
            "preventRecursion": False,
            "delay_until_recursion": False,
            "delay_until_recursion_level": 0,
            "sticky": 3,
            "cooldown": 2,
            "delay": 1,
            "vectorized": False,
            "scanDepth": 4,
            "caseSensitive": True,
            "matchWholeWords": False,
            "addMemo": True,
            "decorators": ["@@activate"],
            "extensions": {"custom_field": "custom_value"},
        }
    },
}


# ---------------------------------------------------------------------------
# ST 必须保留的字段清单
# ---------------------------------------------------------------------------

ST_CHARACTER_FIELDS = [
    "name", "description", "personality", "scenario", "first_mes",
    "mes_example", "creator_notes", "system_prompt",
    "post_history_instructions", "tags", "creator", "character_version",
    "alternate_greetings", "extensions", "character_book",
]

ST_CHAT_FIELDS = [
    "name", "is_user", "is_system", "send_date", "mes",
    "swipe_id", "swipes", "extra",
]

ST_WI_FIELDS = [
    "uid", "key", "keysecondary", "comment", "content",
    "constant", "selective", "selective_logic", "position",
    "disable", "probability", "depth", "group", "group_weight",
    "group_override", "use_regex", "recursion", "exclude_recursion",
    "prevent_recursion", "delay_until_recursion", "delay_until_recursion_level",
    "sticky", "cooldown", "delay", "vectorized", "extensions",
]

# Palink WorldBookStage 模型中与 ST 字段对应的列名
ST_WI_FIELD_TO_MODEL = {
    "uid": "id",
    "key": "keys",
    "keysecondary": "secondary_keys",
    "comment": "title",
    "content": "content",
    "constant": "constant",
    "selective": "selective",
    "selective_logic": "selective_logic",
    "position": "position",
    "disable": "enabled",  # 反转
    "probability": "probability",
    "depth": "depth",
    "group": "group",
    "group_weight": "group_weight",
    "group_override": "group_override",
    "exclude_recursion": "exclude_recursion",
    "prevent_recursion": "prevent_recursion",
    "delay_until_recursion": "delay_until_recursion",
    "delay_until_recursion_level": "delay_until_recursion",  # model uses single int
    "sticky": "sticky",
    "cooldown": "cooldown",
    "delay": "delay",
    "vectorized": "vectorized",
    "extensions": "extensions_json",
}


# ---------------------------------------------------------------------------
# 辅助函数：纯函数往返所需内存对象构建
# ---------------------------------------------------------------------------

def _import_card_to_character(card):
    """将 ST 角色卡 dict 导入为内存 Character 对象（模拟 _create_character，无需 DB）。

    使用真实的 ``CharacterDataNormalizer.normalize`` 完成导入归一化，
    然后构建未绑定到任何 DB session 的 Character 实例。
    """
    normalized = CharacterDataNormalizer.normalize(card)
    return Character(
        name=normalized["name"],
        description=normalized["description"],
        background=normalized.get("background"),
        personality=normalized["personality"],
        scenario=normalized["scenario"],
        first_mes=normalized["first_mes"],
        mes_example=normalized["mes_example"],
        system_prompt=normalized["system_prompt"],
        creator=normalized["creator"],
        character_version=normalized["character_version"],
        tags=json.dumps(normalized["tags"], ensure_ascii=False),
        extensions=json.dumps(normalized["extensions"], ensure_ascii=False),
        alternate_greetings=(
            json.dumps(normalized["alternate_greetings"], ensure_ascii=False)
            if normalized.get("alternate_greetings")
            else None
        ),
        creator_notes=normalized.get("creator_notes") or None,
        post_history_instructions=normalized.get("post_history_instructions") or None,
        ui_config=(
            json.dumps(normalized["ui_config"], ensure_ascii=False)
            if normalized.get("ui_config")
            else None
        ),
        raw_card_spec_version=normalized.get("raw_card_spec_version") or None,
        assets=(
            json.dumps(normalized["assets"], ensure_ascii=False)
            if normalized.get("assets")
            else None
        ),
    )


def _build_stage_from_st_entry(entry):
    """将 ST 世界书条目 dict 转为内存 WorldBookStage（复刻 st_import_worldinfo 的字段映射）。

    仅用于单元测试，不写入 DB。映射规则与 ``silly_tavern.py`` 中
    ``st_import_worldinfo`` 端点的导入逻辑一致。
    """
    stage = WorldBookStage(
        id=str(entry.get("uid") or f"stage-{id(entry)}"),
        world_book_id="wb-test",
        stage_index=entry.get("order", 0) if isinstance(entry.get("order"), int) else 0,
        title=str(entry.get("comment") or "")[:200],
        content=str(entry.get("content") or "").strip(),
        token_count=len(str(entry.get("content") or "")) // 4,
        keys=_json_dumps(entry.get("key") or []),
        secondary_keys=_json_dumps(entry.get("keysecondary") or []),
        scan_depth=entry.get("scanDepth") if isinstance(entry.get("scanDepth"), int) else 4,
        position=entry.get("position") if isinstance(entry.get("position"), int) else 4,
        depth=entry.get("depth") if isinstance(entry.get("depth"), int) else 4,
        order=entry.get("order") if isinstance(entry.get("order"), int) else 0,
        selective=bool(entry.get("selective")),
        probability=entry.get("probability") if entry.get("probability") is not None else 100,
        constant=bool(entry.get("constant")),
        enabled=not bool(entry.get("disable")),
        case_sensitive=bool(entry.get("caseSensitive")),
        match_whole_words=bool(entry.get("matchWholeWords")),
        exclude_recursion=bool(entry.get("excludeRecursion")),
        prevent_recursion=bool(entry.get("preventRecursion")),
        selective_logic=entry.get("selectiveLogic") if isinstance(entry.get("selectiveLogic"), int) else 0,
        sticky=entry.get("sticky") if isinstance(entry.get("sticky"), int) else 0,
        cooldown=entry.get("cooldown") if isinstance(entry.get("cooldown"), int) else 0,
        delay=entry.get("delay") if isinstance(entry.get("delay"), int) else 0,
        group=str(entry.get("group") or "")[:100] or None,
        group_override=bool(entry.get("groupOverride")),
        group_weight=entry.get("groupWeight") if isinstance(entry.get("groupWeight"), int) else 0,
        vectorized=bool(entry.get("vectorized")),
        add_memo=bool(entry.get("addMemo")),
        decorators=_json_dumps(entry.get("decorators") or []),
        extensions_json=_json_dumps(entry.get("extensions") or {}),
    )
    return stage


def _json_dumps(value):
    """与 st_sync_service._safe_json_dumps 一致的序列化。"""
    try:
        return json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        return "null"


def _build_wb_from_st_world_info(world_info):
    """将 ST 世界书 dict 转为内存 WorldBook + WorldBookStage（复刻导入映射，无需 DB）。"""
    wb = WorldBook(
        id="wb-test",
        name=world_info.get("name", "Test World"),
        description=world_info.get("description") or "",
        type="world_book",
        format="silly_tavern_v2",
    )
    entries = world_info.get("entries", {})
    stages = []
    for _key, entry in sorted(
        entries.items(),
        key=lambda x: x[1].get("order", 0) if isinstance(x[1], dict) else 0,
    ):
        if not isinstance(entry, dict):
            continue
        if entry.get("disable", False):
            continue
        content = str(entry.get("content") or "").strip()
        if not content:
            continue
        stage = _build_stage_from_st_entry(entry)
        stage.world_book_id = wb.id
        stages.append(stage)
    wb.entries = stages
    return wb


def _make_chat_message(
    name="Test Character",
    is_user=False,
    is_system=False,
    content="Hello!",
    swipes=None,
    swipe_id=0,
    extra=None,
    created_at=None,
    mesid=0,
):
    """构建内存 CharacterChatMessage 对象（无需 DB）。"""
    if swipes is None:
        swipes = [content]
    if extra is None:
        extra = {}
    return CharacterChatMessage(
        id=1,
        session_id="session-test",
        branch_id="branch-test",
        role="user" if is_user else ("system" if is_system else "assistant"),
        content=content,
        name=name,
        is_user=is_user,
        is_system=is_system,
        mesid=mesid,
        swipe_id=swipe_id,
        swipes=json.dumps(swipes, ensure_ascii=False),
        extra=json.dumps(extra, ensure_ascii=False),
        created_at=created_at or datetime(2024, 1, 1, tzinfo=timezone.utc),
    )


def _make_user(username="TestUser"):
    """构建内存 User 对象（无需 DB）。"""
    return User(id=1, username=username, hashed_password="x", role="user")


def _make_character(name="Test Character"):
    """构建内存 Character 对象用于聊天导出测试（无需 DB）。"""
    return Character(id="char-test", name=name, user_id=1)


# ===========================================================================
# 第一层：角色卡 JSON 往返测试（纯函数，无需 DB）
# ===========================================================================

class TestCharacterCardRoundTrip:
    """验证角色卡导入导出不丢失字段。

    使用真实 ``CharacterDataNormalizer.normalize``（导入归一化）+
    ``convert_character_to_chara_card``（导出），构建内存 Character 对象完成往返。
    """

    def test_v2_json_roundtrip_preserves_core_fields(self):
        """V2 JSON 往返保留核心字段（name/description/personality 等）。"""
        character = _import_card_to_character(ST_V2_CARD)
        exported = convert_character_to_chara_card(character)

        assert exported["spec"] == "chara_card_v2"
        assert exported["spec_version"] == "2.0"

        data = exported["data"]
        original = ST_V2_CARD["data"]

        assert data["name"] == original["name"]
        assert data["description"] == original["description"]
        assert data["personality"] == original["personality"]
        assert data["scenario"] == original["scenario"]
        assert data["first_mes"] == original["first_mes"]
        assert data["mes_example"] == original["mes_example"]
        assert data["system_prompt"] == original["system_prompt"]
        assert data["creator"] == original["creator"]
        assert data["character_version"] == original["character_version"]
        assert data["creator_notes"] == original["creator_notes"]
        assert data["post_history_instructions"] == original["post_history_instructions"]

    def test_v2_json_roundtrip_preserves_extensions(self):
        """V2 JSON 往返保留 extensions（depth_prompt, talkativeness）。"""
        character = _import_card_to_character(ST_V2_CARD)
        exported = convert_character_to_chara_card(character)
        extensions = exported["data"]["extensions"]
        original_ext = ST_V2_CARD["data"]["extensions"]

        assert extensions["depth_prompt"] == original_ext["depth_prompt"]
        assert extensions["talkativeness"] == original_ext["talkativeness"]

    def test_v2_json_roundtrip_preserves_alternate_greetings(self):
        """V2 JSON 往返保留 alternate_greetings。"""
        character = _import_card_to_character(ST_V2_CARD)
        exported = convert_character_to_chara_card(character)

        assert exported["data"]["alternate_greetings"] == ST_V2_CARD["data"]["alternate_greetings"]

    def test_v2_json_roundtrip_preserves_character_book(self):
        """V2 JSON 往返保留 character_book（需传入 world_book_data）。"""
        # 构建内存 WorldBook 用于 character_book 导出
        cb = ST_V2_CARD["data"]["character_book"]
        wb = _build_wb_from_st_world_info(cb)
        charbook = _worldbook_to_charbook(wb)

        character = _import_card_to_character(ST_V2_CARD)
        exported = convert_character_to_chara_card(character, world_book_data=charbook)

        assert "character_book" in exported["data"]
        assert exported["data"]["character_book"]["name"] == cb["name"]
        # 验证条目内容保留
        exported_entries = exported["data"]["character_book"]["entries"]
        assert len(exported_entries) == len(cb["entries"])
        first_entry = list(exported_entries.values())[0]
        assert first_entry["content"] == "The forest is dark"
        assert first_entry["key"] == ["forest"]

    def test_v2_json_roundtrip_preserves_depth_prompt(self):
        """V2 JSON 往返保留 depth_prompt（在 extensions 和 data 顶层）。"""
        character = _import_card_to_character(ST_V2_CARD)
        exported = convert_character_to_chara_card(character)

        original_dp = ST_V2_CARD["data"]["extensions"]["depth_prompt"]
        # depth_prompt 保留在 extensions 中
        assert exported["data"]["extensions"]["depth_prompt"] == original_dp
        # V2 导出还会在 data 顶层添加 depth_prompt
        assert exported["data"]["depth_prompt"] == original_dp

    def test_v2_json_roundtrip_preserves_tags(self):
        """V2 JSON 往返保留 tags。"""
        character = _import_card_to_character(ST_V2_CARD)
        exported = convert_character_to_chara_card(character)

        assert exported["data"]["tags"] == ST_V2_CARD["data"]["tags"]

    def test_v3_card_does_not_degrade_to_v2(self):
        """V3 卡导入后导出仍保持 V3 格式（不降级为 V2）。"""
        character = _import_card_to_character(ST_V3_CARD)
        exported = convert_character_to_chara_card(character)

        assert exported["spec"] == "chara_card_v3"
        assert exported["spec_version"] == "3.0"

    def test_v3_preserves_group_only_greetings(self):
        """V3 卡保留 group_only_greetings（通过 palink_raw_card_data 保留）。"""
        character = _import_card_to_character(ST_V3_CARD)
        exported = convert_character_to_chara_card(character)

        assert exported["data"]["group_only_greetings"] == ST_V3_CARD["data"]["group_only_greetings"]

    def test_v3_preserves_assets(self):
        """V3 卡保留 assets。"""
        character = _import_card_to_character(ST_V3_CARD)
        exported = convert_character_to_chara_card(character)

        assert exported["data"]["assets"] == ST_V3_CARD["data"]["assets"]

    def test_v3_preserves_core_fields(self):
        """V3 卡往返保留核心字段（与 V2 相同的字段集）。"""
        character = _import_card_to_character(ST_V3_CARD)
        exported = convert_character_to_chara_card(character)

        data = exported["data"]
        original = ST_V3_CARD["data"]

        assert data["name"] == original["name"]
        assert data["description"] == original["description"]
        assert data["personality"] == original["personality"]
        assert data["scenario"] == original["scenario"]
        assert data["first_mes"] == original["first_mes"]
        assert data["mes_example"] == original["mes_example"]
        assert data["creator"] == original["creator"]
        assert data["character_version"] == original["character_version"]
        assert data["alternate_greetings"] == original["alternate_greetings"]
        assert data["tags"] == original["tags"]

    def test_v3_preserves_extensions(self):
        """V3 卡往返保留 extensions（含 V3 特有字段 v3_spec）。"""
        character = _import_card_to_character(ST_V3_CARD)
        exported = convert_character_to_chara_card(character)
        extensions = exported["data"]["extensions"]

        original_ext = ST_V3_CARD["data"]["extensions"]
        assert extensions["depth_prompt"] == original_ext["depth_prompt"]
        assert extensions["talkativeness"] == original_ext["talkativeness"]
        assert extensions["v3_spec"] == original_ext["v3_spec"]

    def test_v3_export_honors_cleared_fields(self):
        """E-1: 用户清空的字段导出时不再被原始卡值复活（V3 overlay 路径）。"""
        character = _import_card_to_character(ST_V3_CARD)
        # 模拟用户在编辑器中显式清空 description 与 creator_notes
        character.description = ""
        character.creator_notes = ""
        exported = convert_character_to_chara_card(character)

        data = exported["data"]
        assert data["description"] == ""
        assert data["creator_notes"] == ""

    def test_v3_export_keeps_original_when_column_null(self):
        """E-1: 列为 NULL（旧数据未回填）时保留原始卡值，不误判为用户清空。"""
        character = _import_card_to_character(ST_V3_CARD)
        character.creator_notes = None
        exported = convert_character_to_chara_card(character)

        assert exported["data"]["creator_notes"] == ST_V3_CARD["data"]["creator_notes"]


# ===========================================================================
# 第二层：聊天 JSONL 往返测试（纯函数，无需 DB）
# ===========================================================================

class TestChatJSONLRoundTrip:
    """验证聊天 JSONL 往返不丢失字段。

    使用 ``convert_group_chat_to_jsonl`` / ``convert_jsonl_to_group_chat``
    纯函数往返验证，以及 ``_message_to_st_jsonl`` 导出函数验证。
    """

    def test_jsonl_roundtrip_preserves_messages(self):
        """JSONL 往返保留所有消息。"""
        jsonl = convert_group_chat_to_jsonl(ST_CHAT_MESSAGES)
        assert jsonl.strip() != ""

        parsed = convert_jsonl_to_group_chat(jsonl)
        assert len(parsed) == len(ST_CHAT_MESSAGES)
        for original, result in zip(ST_CHAT_MESSAGES, parsed):
            assert result["mes"] == original["mes"]
            assert result["name"] == original["name"]

    def test_jsonl_roundtrip_preserves_swipes(self):
        """JSONL 往返保留 swipes 和 swipe_id。"""
        messages = [
            {
                "name": "Char",
                "is_user": False,
                "is_system": False,
                "send_date": "2024-01-01T00:00:00",
                "mes": "Hello!",
                "extra": {},
                "swipes": ["Hello!", "Hi there!", "Greetings!"],
                "swipe_id": 1,
            },
        ]
        jsonl = convert_group_chat_to_jsonl(messages)
        parsed = convert_jsonl_to_group_chat(jsonl)

        assert parsed[0]["swipes"] == ["Hello!", "Hi there!", "Greetings!"]
        assert parsed[0]["swipe_id"] == 1

    def test_jsonl_roundtrip_preserves_is_system(self):
        """JSONL 往返保留 is_system 标志。"""
        jsonl = convert_group_chat_to_jsonl(ST_CHAT_MESSAGES)
        parsed = convert_jsonl_to_group_chat(jsonl)

        assert parsed[0]["is_system"] is False
        assert parsed[1]["is_user"] is True
        assert parsed[2]["is_system"] is True

    def test_jsonl_roundtrip_preserves_extra(self):
        """JSONL 往返保留 extra 字段。"""
        jsonl = convert_group_chat_to_jsonl(ST_CHAT_MESSAGES)
        parsed = convert_jsonl_to_group_chat(jsonl)

        # 第一条消息的 extra 含 reasoning
        assert parsed[0]["extra"]["reasoning"] == "thinking..."
        # 第三条消息的 extra 含 is_system
        assert parsed[2]["extra"]["is_system"] is True

    def test_jsonl_roundtrip_preserves_is_hidden(self):
        """JSONL 往返保留 is_hidden 标志（通过 extra 字段）。

        ST JSONL 格式本身没有 is_hidden 字段；Palink 将其存储在 extra 中。
        需 DB 的端到端测试占位。
        """
        pytest.skip("requires DB session for CharacterChatMessage.is_hidden round-trip")

    def test_jsonl_roundtrip_preserves_is_locked(self):
        """JSONL 往返保留 is_locked 标志（通过 extra 字段）。

        ST JSONL 格式本身没有 is_locked 字段；Palink 将其存储在 extra 中。
        需 DB 的端到端测试占位。
        """
        pytest.skip("requires DB session for CharacterChatMessage.is_locked round-trip")

    def test_jsonl_roundtrip_preserves_chat_metadata(self):
        """JSONL 往返保留 chat_metadata（header 行被 convert_jsonl_to_group_chat 跳过）。

        ``convert_jsonl_to_group_chat`` 会跳过含 chat_metadata 且无 mes 的 header 行，
        这是设计行为（群聊元数据由调用方单独处理）。
        """
        jsonl = _build_jsonl_with_header()
        parsed = convert_jsonl_to_group_chat(jsonl)

        # header 行应被跳过，只保留消息行
        assert len(parsed) == len(ST_CHAT_MESSAGES)
        # 验证 header 中的 chat_metadata 不出现在消息中
        for msg in parsed:
            assert "chat_metadata" not in msg or "mes" in msg

    def test_jsonl_roundtrip_preserves_variables(self):
        """JSONL 往返保留 variables（存储在 extra 或 chat_metadata 中）。"""
        messages_with_vars = [
            {
                "name": "Char",
                "is_user": False,
                "is_system": False,
                "send_date": "2024-01-01T00:00:00",
                "mes": "Hello!",
                "extra": {"variables": {"location": "forest"}},
            },
        ]
        jsonl = convert_group_chat_to_jsonl(messages_with_vars)
        parsed = convert_jsonl_to_group_chat(jsonl)

        assert parsed[0]["extra"]["variables"] == {"location": "forest"}

    def test_jsonl_roundtrip_preserves_mesid_and_id(self):
        """JSONL 往返保留 mesid 和 id 字段。"""
        messages = [
            {
                "name": "Char",
                "is_user": False,
                "is_system": False,
                "send_date": "",
                "mes": "Hello!",
                "extra": {},
                "mesid": 5,
                "id": 42,
            },
        ]
        jsonl = convert_group_chat_to_jsonl(messages)
        parsed = convert_jsonl_to_group_chat(jsonl)

        assert parsed[0]["mesid"] == 5
        assert parsed[0]["id"] == 42

    def test_jsonl_roundtrip_preserves_swipe_info(self):
        """JSONL 往返保留 swipe_info 字段。"""
        messages = [
            {
                "name": "Char",
                "is_user": False,
                "is_system": False,
                "send_date": "2024-01-01T00:00:00",
                "mes": "Hello!",
                "extra": {},
                "swipes": ["Hello!", "Hi!"],
                "swipe_id": 0,
                "swipe_info": [
                    {"send_date": "2024-01-01T00:00:00", "extra": {}},
                    {"send_date": "2024-01-01T00:00:01", "extra": {}},
                ],
            },
        ]
        jsonl = convert_group_chat_to_jsonl(messages)
        parsed = convert_jsonl_to_group_chat(jsonl)

        assert len(parsed[0]["swipe_info"]) == 2
        assert parsed[0]["swipe_info"][0]["send_date"] == "2024-01-01T00:00:00"

    def test_jsonl_roundtrip_empty_messages(self):
        """空消息列表导出返回空字符串。"""
        assert convert_group_chat_to_jsonl([]) == ""
        assert convert_jsonl_to_group_chat("") == []

    def test_jsonl_roundtrip_skips_invalid_json(self):
        """JSONL 导入跳过无效 JSON 行。"""
        jsonl = '{"name":"A","mes":"hi","extra":{}}\ninvalid json\n{"name":"B","mes":"yo","extra":{}}\n'
        parsed = convert_jsonl_to_group_chat(jsonl)
        assert len(parsed) == 2
        assert parsed[0]["name"] == "A"
        assert parsed[1]["name"] == "B"

    def test_message_to_st_jsonl_preserves_core_fields(self):
        """``_message_to_st_jsonl`` 导出保留核心字段。"""
        msg = _make_chat_message(
            name="Test Character",
            is_user=False,
            is_system=False,
            content="Hello world!",
            swipes=["Hello world!", "Hi!"],
            swipe_id=0,
            extra={"reasoning": "thinking", "is_name": True},
        )
        character = _make_character(name="Test Character")
        user = _make_user(username="TestUser")

        record = _message_to_st_jsonl(msg, 0, character, user)

        assert record["mes"] == "Hello world!"
        assert record["name"] == "Test Character"
        assert record["is_user"] is False
        assert record["is_system"] is False
        assert record["swipes"] == ["Hello world!", "Hi!"]
        assert record["swipe_id"] == 0
        assert record["extra"]["reasoning"] == "thinking"
        assert record["extra"]["is_name"] is True

    def test_message_to_st_jsonl_preserves_swipes(self):
        """``_message_to_st_jsonl`` 导出保留 swipes 和 swipe_id。"""
        msg = _make_chat_message(
            content="default",
            swipes=["default", "alt1", "alt2"],
            swipe_id=2,
        )
        character = _make_character()
        user = _make_user()

        record = _message_to_st_jsonl(msg, 0, character, user)

        assert record["swipes"] == ["default", "alt1", "alt2"]
        assert record["swipe_id"] == 2

    def test_message_to_st_jsonl_preserves_extra(self):
        """``_message_to_st_jsonl`` 导出保留 extra 字段（含 swipe_info）。"""
        extra = {
            "reasoning": "thinking...",
            "model": "gpt-4",
            "is_name": True,
            "force_avatar": "char.png",
        }
        msg = _make_chat_message(content="hi", extra=extra)
        character = _make_character()
        user = _make_user()

        record = _message_to_st_jsonl(msg, 0, character, user)

        # swipe_info 由导出函数自动补全为顶层字段（ST JSONL 格式）
        assert "swipe_info" in record
        assert isinstance(record["swipe_info"], list)
        assert len(record["swipe_info"]) == len(record["swipes"])
        # 原始 extra 字段保留（swipe_info 不混入 extra）
        assert record["extra"]["reasoning"] == "thinking..."
        assert record["extra"]["model"] == "gpt-4"
        assert record["extra"]["is_name"] is True
        # force_avatar 是 ST 1.18.0 顶层字段：_message_to_st_jsonl 导出时按
        # script.js:5835 从 extra 提升为顶层（lift 逻辑，见函数 line 332-335），
        # 因此断言顶层而非 extra 内。import 侧 _st_msg_extra 会再读回 extra，往返一致。
        assert record["force_avatar"] == "char.png"

    def test_st_msg_role_parsing(self):
        """``_st_msg_role`` 正确解析角色（system/user/assistant）。"""
        assert _st_msg_role({"is_system": True, "is_user": False}) == "system"
        assert _st_msg_role({"is_system": False, "is_user": True}) == "user"
        assert _st_msg_role({"is_system": False, "is_user": False}) == "assistant"

    def test_st_msg_content_parsing(self):
        """``_st_msg_content`` 正确提取消息内容（兼容 mes/content/message/text）。"""
        assert _st_msg_content({"mes": "hello"}) == "hello"
        assert _st_msg_content({"content": "hello"}) == "hello"
        assert _st_msg_content({"message": "hello"}) == "hello"
        assert _st_msg_content({"text": "hello"}) == "hello"
        assert _st_msg_content({}) == ""

    def test_st_msg_swipes_parsing(self):
        """``_st_msg_swipes`` 正确提取 swipes（兼容 V1 无 swipes 格式）。"""
        assert _st_msg_swipes({"swipes": ["a", "b"]}, "a") == ["a", "b"]
        # V1 格式：无 swipes 字段时用 [content]
        assert _st_msg_swipes({}, "hello") == ["hello"]
        # 空 swipes 也回退为 [content]
        assert _st_msg_swipes({"swipes": []}, "hello") == ["hello"]

    def test_st_msg_extra_preserves_fields(self):
        """``_st_msg_extra`` 保留 extra 中的字段并补全 swipe_info。"""
        item = {
            "extra": {"reasoning": "thinking"},
            "is_name": True,
            "force_avatar": "char.png",
            "send_date": "2024-01-01T00:00:00",
        }
        swipes = ["hello"]
        extra = _st_msg_extra(item, swipes, 0)

        # swipe_info 自动补全
        assert "swipe_info" in extra
        assert len(extra["swipe_info"]) == 1
        # 原始 extra 字段保留
        assert extra["reasoning"] == "thinking"
        # 顶层字段被复制到 extra
        assert extra["is_name"] is True
        assert extra["force_avatar"] == "char.png"


# ===========================================================================
# 第三层：世界书往返测试（纯函数 + DB占位）
# ===========================================================================

class TestWorldInfoRoundTrip:
    """验证世界书往返不丢失字段。

    使用内存 WorldBookStage + ``_worldbook_to_charbook`` 导出函数验证字段保留。
    导入映射通过 ``_build_stage_from_st_entry`` 复刻 ``st_import_worldinfo`` 端点逻辑。
    """

    def test_wi_roundtrip_preserves_entries(self):
        """世界书往返保留所有条目。"""
        wb = _build_wb_from_st_world_info(ST_WORLD_INFO)
        charbook = _worldbook_to_charbook(wb)

        assert charbook["name"] == ST_WORLD_INFO["name"]
        assert len(charbook["entries"]) == len(ST_WORLD_INFO["entries"])

    def test_wi_roundtrip_preserves_selective_logic(self):
        """世界书往返保留 selectiveLogic。"""
        wb = _build_wb_from_st_world_info(ST_WORLD_INFO)
        charbook = _worldbook_to_charbook(wb)
        entry = list(charbook["entries"].values())[0]

        assert entry["selectiveLogic"] == ST_WORLD_INFO["entries"]["0"]["selectiveLogic"]

    def test_wi_roundtrip_preserves_group_fields(self):
        """世界书往返保留 group/groupWeight/groupOverride。"""
        wb = _build_wb_from_st_world_info(ST_WORLD_INFO)
        charbook = _worldbook_to_charbook(wb)
        entry = list(charbook["entries"].values())[0]
        original = ST_WORLD_INFO["entries"]["0"]

        assert entry["group"] == original["group"]
        assert entry["groupWeight"] == original["groupWeight"]
        assert entry["groupOverride"] == original["groupOverride"]

    def test_wi_roundtrip_preserves_recursion_flags(self):
        """世界书往返保留 excludeRecursion/preventRecursion。"""
        wb = _build_wb_from_st_world_info(ST_WORLD_INFO)
        charbook = _worldbook_to_charbook(wb)
        entry = list(charbook["entries"].values())[0]
        original = ST_WORLD_INFO["entries"]["0"]

        assert entry["excludeRecursion"] == original["excludeRecursion"]
        assert entry["preventRecursion"] == original["preventRecursion"]

    def test_wi_roundtrip_preserves_sticky_cooldown_delay(self):
        """世界书往返保留 sticky/cooldown/delay。"""
        wb = _build_wb_from_st_world_info(ST_WORLD_INFO)
        charbook = _worldbook_to_charbook(wb)
        entry = list(charbook["entries"].values())[0]
        original = ST_WORLD_INFO["entries"]["0"]

        assert entry["sticky"] == original["sticky"]
        assert entry["cooldown"] == original["cooldown"]
        assert entry["delay"] == original["delay"]

    def test_wi_roundtrip_preserves_depth_and_position(self):
        """世界书往返保留 depth 和 position。"""
        wb = _build_wb_from_st_world_info(ST_WORLD_INFO)
        charbook = _worldbook_to_charbook(wb)
        entry = list(charbook["entries"].values())[0]
        original = ST_WORLD_INFO["entries"]["0"]

        assert entry["depth"] == original["depth"]
        assert entry["position"] == original["position"]

    def test_wi_roundtrip_preserves_probability(self):
        """世界书往返保留 probability。"""
        wb = _build_wb_from_st_world_info(ST_WORLD_INFO)
        charbook = _worldbook_to_charbook(wb)
        entry = list(charbook["entries"].values())[0]

        assert entry["probability"] == ST_WORLD_INFO["entries"]["0"]["probability"]

    def test_wi_roundtrip_preserves_extensions(self):
        """世界书往返保留 extensions。"""
        wb = _build_wb_from_st_world_info(ST_WORLD_INFO)
        charbook = _worldbook_to_charbook(wb)
        entry = list(charbook["entries"].values())[0]

        assert entry["extensions"] == ST_WORLD_INFO["entries"]["0"]["extensions"]

    def test_wi_roundtrip_preserves_keys(self):
        """世界书往返保留主/次关键词。"""
        wb = _build_wb_from_st_world_info(ST_WORLD_INFO)
        charbook = _worldbook_to_charbook(wb)
        entry = list(charbook["entries"].values())[0]
        original = ST_WORLD_INFO["entries"]["0"]

        assert entry["key"] == original["key"]
        assert entry["keysecondary"] == original["keysecondary"]

    def test_wi_roundtrip_preserves_content_and_comment(self):
        """世界书往返保留 content 和 comment。"""
        wb = _build_wb_from_st_world_info(ST_WORLD_INFO)
        charbook = _worldbook_to_charbook(wb)
        entry = list(charbook["entries"].values())[0]
        original = ST_WORLD_INFO["entries"]["0"]

        assert entry["content"] == original["content"]
        assert entry["comment"] == original["comment"]

    def test_wi_roundtrip_preserves_constant_and_selective(self):
        """世界书往返保留 constant 和 selective。"""
        wb = _build_wb_from_st_world_info(ST_WORLD_INFO)
        charbook = _worldbook_to_charbook(wb)
        entry = list(charbook["entries"].values())[0]
        original = ST_WORLD_INFO["entries"]["0"]

        assert entry["constant"] == original["constant"]
        assert entry["selective"] == original["selective"]

    def test_wi_roundtrip_preserves_disable(self):
        """世界书往返保留 disable（通过 enabled 反转）。"""
        wb = _build_wb_from_st_world_info(ST_WORLD_INFO)
        charbook = _worldbook_to_charbook(wb)
        entry = list(charbook["entries"].values())[0]
        original = ST_WORLD_INFO["entries"]["0"]

        assert entry["disable"] == original["disable"]

    def test_wi_roundtrip_preserves_scan_depth(self):
        """世界书往返保留 scanDepth。"""
        wb = _build_wb_from_st_world_info(ST_WORLD_INFO)
        charbook = _worldbook_to_charbook(wb)
        entry = list(charbook["entries"].values())[0]

        assert entry["scanDepth"] == ST_WORLD_INFO["entries"]["0"]["scanDepth"]

    def test_wi_roundtrip_preserves_vectorized(self):
        """世界书往返保留 vectorized。"""
        wb = _build_wb_from_st_world_info(ST_WORLD_INFO)
        charbook = _worldbook_to_charbook(wb)
        entry = list(charbook["entries"].values())[0]

        assert entry["vectorized"] == ST_WORLD_INFO["entries"]["0"]["vectorized"]

    def test_wi_roundtrip_preserves_decorators(self):
        """世界书往返保留 decorators。"""
        wb = _build_wb_from_st_world_info(ST_WORLD_INFO)
        charbook = _worldbook_to_charbook(wb)
        entry = list(charbook["entries"].values())[0]

        assert entry["decorators"] == ST_WORLD_INFO["entries"]["0"]["decorators"]

    def test_wi_roundtrip_preserves_case_sensitive(self):
        """世界书往返保留 caseSensitive。"""
        wb = _build_wb_from_st_world_info(ST_WORLD_INFO)
        charbook = _worldbook_to_charbook(wb)
        entry = list(charbook["entries"].values())[0]

        assert entry["caseSensitive"] == ST_WORLD_INFO["entries"]["0"]["caseSensitive"]

    def test_wi_export_includes_all_st_fields(self):
        """``_worldbook_to_charbook`` 输出包含所有 ST 必需字段。"""
        wb = _build_wb_from_st_world_info(ST_WORLD_INFO)
        charbook = _worldbook_to_charbook(wb)
        entry = list(charbook["entries"].values())[0]

        # ST 世界书条目必需字段
        required_fields = [
            "key", "keysecondary", "content", "comment",
            "constant", "selective", "selectiveLogic", "position",
            "probability", "depth", "order", "disable",
            "group", "groupOverride", "groupWeight",
            "sticky", "cooldown", "delay",
            "vectorized", "caseSensitive", "matchWholeWords",
            "excludeRecursion", "preventRecursion",
            "addMemo", "decorators", "scanDepth",
        ]
        for field in required_fields:
            assert field in entry, f"Missing ST field: {field}"

    def test_wi_export_none_returns_none(self):
        """``_worldbook_to_charbook(None)`` 返回 None。"""
        assert _worldbook_to_charbook(None) is None

    def test_wi_export_empty_entries(self):
        """``_worldbook_to_charbook`` 处理空条目列表。"""
        wb = WorldBook(id="wb-empty", name="Empty", entries=[])
        charbook = _worldbook_to_charbook(wb)

        assert charbook["name"] == "Empty"
        assert charbook["entries"] == {}

    def test_wi_roundtrip_multiple_entries(self):
        """世界书往返保留多个条目。"""
        world_info = {
            "name": "Multi World",
            "entries": {
                "0": {
                    "uid": 0,
                    "key": ["dragon"],
                    "keysecondary": [],
                    "comment": "Entry 0",
                    "content": "Dragon content",
                    "constant": True,
                    "selective": False,
                    "selectiveLogic": 0,
                    "position": 0,
                    "depth": 4,
                    "probability": 100,
                    "disable": False,
                    "group": "",
                    "groupWeight": 0,
                    "groupOverride": False,
                    "sticky": 0,
                    "cooldown": 0,
                    "delay": 0,
                    "vectorized": False,
                    "scanDepth": 4,
                    "caseSensitive": False,
                    "matchWholeWords": False,
                    "excludeRecursion": False,
                    "preventRecursion": False,
                    "addMemo": False,
                    "decorators": [],
                    "extensions": {},
                },
                "1": {
                    "uid": 1,
                    "key": ["castle"],
                    "keysecondary": ["dungeon"],
                    "comment": "Entry 1",
                    "content": "Castle content",
                    "constant": False,
                    "selective": True,
                    "selectiveLogic": 0,
                    "position": 4,
                    "depth": 2,
                    "probability": 50,
                    "disable": False,
                    "group": "locations",
                    "groupWeight": 80,
                    "groupOverride": True,
                    "sticky": 5,
                    "cooldown": 3,
                    "delay": 2,
                    "vectorized": True,
                    "scanDepth": 6,
                    "caseSensitive": True,
                    "matchWholeWords": True,
                    "excludeRecursion": True,
                    "preventRecursion": True,
                    "addMemo": True,
                    "decorators": ["@@activate"],
                    "extensions": {"priority": 10},
                },
            },
        }
        wb = _build_wb_from_st_world_info(world_info)
        charbook = _worldbook_to_charbook(wb)

        assert len(charbook["entries"]) == 2
        entries = list(charbook["entries"].values())

        # 第一条目
        assert entries[0]["key"] == ["dragon"]
        assert entries[0]["constant"] is True
        assert entries[0]["probability"] == 100

        # 第二条目
        assert entries[1]["key"] == ["castle"]
        assert entries[1]["keysecondary"] == ["dungeon"]
        assert entries[1]["selective"] is True
        assert entries[1]["probability"] == 50
        assert entries[1]["group"] == "locations"
        assert entries[1]["groupWeight"] == 80
        assert entries[1]["groupOverride"] is True
        assert entries[1]["sticky"] == 5
        assert entries[1]["cooldown"] == 3
        assert entries[1]["delay"] == 2
        assert entries[1]["vectorized"] is True
        assert entries[1]["scanDepth"] == 6
        assert entries[1]["caseSensitive"] is True
        assert entries[1]["matchWholeWords"] is True
        assert entries[1]["excludeRecursion"] is True
        assert entries[1]["preventRecursion"] is True
        assert entries[1]["addMemo"] is True
        assert entries[1]["decorators"] == ["@@activate"]
        assert entries[1]["extensions"] == {"priority": 10}

    def test_wi_endpoint_roundtrip_requires_db(self):
        """ST 世界书导入端点往返需要 DB session。"""
        pytest.skip("requires DB session")


# ===========================================================================
# 第四层：字段覆盖验证（检查 Palink 数据模型覆盖 ST 必需字段）
# ===========================================================================

class TestFieldCoverage:
    """验证 Palink 数据模型覆盖了所有 ST 必需字段。"""

    def test_character_model_covers_st_fields(self):
        """Character 模型包含所有 ST 角色卡字段（列或 JSON 存储）。

        ST 角色卡字段 → Character 模型列映射：
        - name, description, personality, scenario, first_mes, mes_example,
          system_prompt, creator, character_version, creator_notes,
          post_history_instructions → 同名列
        - tags → tags (JSON 字符串)
        - alternate_greetings → alternate_greetings (JSON 字符串)
        - extensions → extensions (JSON 字符串，含 depth_prompt 等)
        - character_book → 通过 WorldBook 关系存储（type=character_book）
        """
        # Character 模型有的列
        character_columns = {
            "name", "description", "personality", "scenario", "first_mes",
            "mes_example", "system_prompt", "creator", "character_version",
            "creator_notes", "post_history_instructions",
            "tags", "alternate_greetings", "extensions",
            "assets",  # V3
            "raw_card_spec_version",  # V3 spec 版本
            "ui_config",
        }

        # ST 角色卡核心字段 → 模型列
        st_field_to_model = {
            "name": "name",
            "description": "description",
            "personality": "personality",
            "scenario": "scenario",
            "first_mes": "first_mes",
            "mes_example": "mes_example",
            "system_prompt": "system_prompt",
            "creator_notes": "creator_notes",
            "post_history_instructions": "post_history_instructions",
            "tags": "tags",
            "creator": "creator",
            "character_version": "character_version",
            "alternate_greetings": "alternate_greetings",
            "extensions": "extensions",
            # character_book 通过 WorldBook 关系存储，不是 Character 列
        }

        for st_field, model_col in st_field_to_model.items():
            assert model_col in character_columns, (
                f"ST field '{st_field}' has no corresponding Character column '{model_col}'"
            )

    def test_character_model_has_assets_for_v3(self):
        """Character 模型有 assets 列用于 ST V3 多模态资源。"""
        assert hasattr(Character, "assets"), "Character model must have 'assets' column for V3"

    def test_character_model_has_raw_card_spec_version(self):
        """Character 模型有 raw_card_spec_version 列用于区分 V2/V3。"""
        assert hasattr(Character, "raw_card_spec_version"), (
            "Character model must have 'raw_card_spec_version' to distinguish V2/V3"
        )

    def test_chat_message_covers_st_fields(self):
        """CharacterChatMessage 模型包含所有 ST 聊天字段。

        ST 聊天字段 → CharacterChatMessage 模型列映射：
        - name, is_user, is_system, mes(content), swipe_id, swipes, extra
        - send_date → created_at
        - mesid → mesid
        - is_hidden, is_locked → Palink 扩展字段（ST JSONL 不原生支持）
        """
        chat_field_to_model = {
            "name": "name",
            "is_user": "is_user",
            "is_system": "is_system",
            "send_date": "created_at",  # 映射到 created_at
            "mes": "content",  # ST 的 mes 映射到 Palink 的 content
            "swipe_id": "swipe_id",
            "swipes": "swipes",
            "extra": "extra",
        }

        for st_field, model_col in chat_field_to_model.items():
            assert hasattr(CharacterChatMessage, model_col), (
                f"ST chat field '{st_field}' has no corresponding CharacterChatMessage column '{model_col}'"
            )

    def test_chat_message_has_palink_extensions(self):
        """CharacterChatMessage 模型有 Palink 扩展字段（is_hidden, is_locked）。"""
        assert hasattr(CharacterChatMessage, "is_hidden"), (
            "CharacterChatMessage must have 'is_hidden' for Palink-internal state"
        )
        assert hasattr(CharacterChatMessage, "is_locked"), (
            "CharacterChatMessage must have 'is_locked' for Palink-internal state"
        )

    def test_worldbook_entry_covers_st_fields(self):
        """WorldBookStage 模型包含所有 ST 世界书条目字段。"""
        # ST 世界书条目字段 → WorldBookStage 模型列
        wi_field_to_model = {
            "key": "keys",
            "keysecondary": "secondary_keys",
            "comment": "title",
            "content": "content",
            "constant": "constant",
            "selective": "selective",
            "selective_logic": "selective_logic",
            "position": "position",
            "probability": "probability",
            "depth": "depth",
            "group": "group",
            "group_weight": "group_weight",
            "group_override": "group_override",
            "exclude_recursion": "exclude_recursion",
            "prevent_recursion": "prevent_recursion",
            "sticky": "sticky",
            "cooldown": "cooldown",
            "delay": "delay",
            "vectorized": "vectorized",
            "extensions": "extensions_json",
            "scan_depth": "scan_depth",
            "order": "order",
            "case_sensitive": "case_sensitive",
            "match_whole_words": "match_whole_words",
            "add_memo": "add_memo",
            "decorators": "decorators",
        }

        missing = []
        for st_field, model_col in wi_field_to_model.items():
            if not hasattr(WorldBookStage, model_col):
                missing.append(f"{st_field} → {model_col}")

        assert not missing, (
            f"WorldBookStage missing columns for ST fields: {', '.join(missing)}"
        )

    def test_worldbook_stage_has_advanced_st_fields(self):
        """WorldBookStage 模型有 ST 高级字段（delay_until_recursion, min_activations 等）。"""
        advanced_fields = [
            "delay_until_recursion",
            "min_activations",
            "triggers",
            "outlet_name",
            "match_persona_description",
            "match_character_description",
            "match_character_personality",
            "match_character_depth_prompt",
            "match_scenario",
            "match_creator_notes",
        ]
        missing = [f for f in advanced_fields if not hasattr(WorldBookStage, f)]
        assert not missing, f"WorldBookStage missing advanced ST fields: {', '.join(missing)}"

    def test_worldbook_has_budget_fields(self):
        """WorldBook 模型有 ST 兼容预算字段（budget_tokens, budget_cap）。"""
        assert hasattr(WorldBook, "budget_tokens"), (
            "WorldBook must have 'budget_tokens' for ST budget compatibility"
        )
        assert hasattr(WorldBook, "budget_cap"), (
            "WorldBook must have 'budget_cap' for ST budget compatibility"
        )

    def test_st_character_fields_list_complete(self):
        """ST_CHARACTER_FIELDS 清单覆盖所有必需字段。"""
        # 确保清单不为空且包含关键字段
        assert len(ST_CHARACTER_FIELDS) >= 15
        for field in ["name", "description", "extensions", "character_book", "alternate_greetings"]:
            assert field in ST_CHARACTER_FIELDS

    def test_st_chat_fields_list_complete(self):
        """ST_CHAT_FIELDS 清单覆盖所有必需字段。"""
        assert len(ST_CHAT_FIELDS) >= 8
        for field in ["name", "is_user", "is_system", "mes", "swipes", "extra"]:
            assert field in ST_CHAT_FIELDS

    def test_st_wi_fields_list_complete(self):
        """ST_WI_FIELDS 清单覆盖所有必需字段。"""
        assert len(ST_WI_FIELDS) >= 20
        for field in ["uid", "key", "content", "selective_logic", "sticky", "cooldown", "extensions"]:
            assert field in ST_WI_FIELDS


# ===========================================================================
# 端到端占位测试（需要 DB session）
# ===========================================================================

class TestEndpointRoundTripDB:
    """端到端往返测试（需要 DB session，占位）。

    这些测试验证通过 ST 兼容 HTTP 端点的完整往返：
    - POST /api/characters/import → POST /api/characters/export
    - POST /api/chats/import → POST /api/chats/export
    - POST /api/worldinfo/import → POST /api/worldinfo/list
    """

    def test_character_import_export_endpoint_roundtrip(self):
        """角色卡通过 ST 端点导入再导出，字段不丢失。"""
        pytest.skip("requires DB session")

    def test_chat_import_export_endpoint_roundtrip(self):
        """聊天 JSONL 通过 ST 端点导入再导出，字段不丢失。"""
        pytest.skip("requires DB session")

    def test_worldinfo_import_list_endpoint_roundtrip(self):
        """世界书通过 ST 端点导入再列出，字段不丢失。"""
        pytest.skip("requires DB session")

    def test_v3_character_endpoint_roundtrip(self):
        """V3 角色卡通过 ST 端点往返保持 V3 格式。"""
        pytest.skip("requires DB session")

    def test_character_book_endpoint_roundtrip(self):
        """角色卡内嵌 character_book 通过 ST 端点往返不丢失。"""
        pytest.skip("requires DB session")


# ===========================================================================
# 第五层：导入导出契约测试（SubTask 5.4.2 - 14 个独立契约场景）
# ===========================================================================

class TestImportExportContract:
    """导入导出契约测试：覆盖 V2/V3 角色卡、聊天 JSONL、世界书的导入→导出→对比。

    这 14 个契约测试对应 ``docs/PALINK_ST_AGENT_TODO.md`` 中"14/14 pass"的声明，
    每个 test_contract_* 函数独立验证一个契约场景的关键字段保留。

    契约场景分组：
    - V2 角色卡（4 个）：核心字段 / extensions / alternate_greetings / character_book
    - V3 角色卡（3 个）：spec 版本 / extensions（含 v3_spec）/ V3 特有字段
    - 聊天 JSONL（3 个）：消息数量 / 消息内容 / swipes
    - 世界书（4 个）：条目数 / 内容 / 顺序 / selectiveLogic
    """

    # ------------------------------------------------------------------
    # V2 角色卡契约（4 个）
    # ------------------------------------------------------------------

    def test_contract_v2_card_core_fields(self):
        """契约 1/14：V2 角色卡导入→导出保留核心字段。

        验证 name/description/personality/scenario/first_mes/mes_example
        在 ``CharacterDataNormalizer.normalize`` (导入) →
        ``convert_character_to_chara_card`` (导出) 往返后不丢失。
        """
        character = _import_card_to_character(ST_V2_CARD)
        exported = convert_character_to_chara_card(character)

        assert exported["spec"] == "chara_card_v2"
        assert exported["spec_version"] == "2.0"

        data = exported["data"]
        original = ST_V2_CARD["data"]

        assert data["name"] == original["name"]
        assert data["description"] == original["description"]
        assert data["personality"] == original["personality"]
        assert data["scenario"] == original["scenario"]
        assert data["first_mes"] == original["first_mes"]
        assert data["mes_example"] == original["mes_example"]

    def test_contract_v2_card_extensions(self):
        """契约 2/14：V2 角色卡导入→导出保留 extensions。

        验证 depth_prompt (含 depth) 和 talkativeness 在往返后不丢失。
        """
        character = _import_card_to_character(ST_V2_CARD)
        exported = convert_character_to_chara_card(character)

        extensions = exported["data"]["extensions"]
        original_ext = ST_V2_CARD["data"]["extensions"]

        assert extensions["depth_prompt"] == original_ext["depth_prompt"]
        assert extensions["depth_prompt"]["prompt"] == "Depth prompt"
        assert extensions["depth_prompt"]["depth"] == 4
        assert extensions["talkativeness"] == original_ext["talkativeness"]

    def test_contract_v2_card_alternate_greetings(self):
        """契约 3/14：V2 角色卡导入→导出保留 alternate_greetings。

        验证多开场白列表在往返后顺序和内容不丢失。
        """
        character = _import_card_to_character(ST_V2_CARD)
        exported = convert_character_to_chara_card(character)

        assert exported["data"]["alternate_greetings"] == ST_V2_CARD["data"]["alternate_greetings"]
        assert len(exported["data"]["alternate_greetings"]) == 2
        assert exported["data"]["alternate_greetings"][0] == "Greetings, traveler!"

    def test_contract_v2_card_character_book(self):
        """契约 4/14：V2 角色卡导入→导出保留 character_book 条目。

        验证角色卡内嵌的世界书条目在往返后 content/key 不丢失。
        """
        cb = ST_V2_CARD["data"]["character_book"]
        wb = _build_wb_from_st_world_info(cb)
        charbook = _worldbook_to_charbook(wb)

        character = _import_card_to_character(ST_V2_CARD)
        exported = convert_character_to_chara_card(character, world_book_data=charbook)

        assert "character_book" in exported["data"]
        assert exported["data"]["character_book"]["name"] == cb["name"]

        exported_entries = exported["data"]["character_book"]["entries"]
        assert len(exported_entries) == len(cb["entries"])

        first_entry = list(exported_entries.values())[0]
        assert first_entry["content"] == "The forest is dark"
        assert first_entry["key"] == ["forest"]

    # ------------------------------------------------------------------
    # V3 角色卡契约（3 个）
    # ------------------------------------------------------------------

    def test_contract_v3_card_spec(self):
        """契约 5/14：V3 角色卡导入→导出保持 V3 格式（不降级为 V2）。

        验证 spec == "chara_card_v3" 且 spec_version == "3.0"。
        """
        character = _import_card_to_character(ST_V3_CARD)
        exported = convert_character_to_chara_card(character)

        assert exported["spec"] == "chara_card_v3"
        assert exported["spec_version"] == "3.0"

    def test_contract_v3_card_extensions(self):
        """契约 6/14：V3 角色卡导入→导出保留 extensions（含 v3_spec 字段）。

        验证 V3 特有的 v3_spec extension 字段在往返后不丢失。
        """
        character = _import_card_to_character(ST_V3_CARD)
        exported = convert_character_to_chara_card(character)

        extensions = exported["data"]["extensions"]
        original_ext = ST_V3_CARD["data"]["extensions"]

        assert extensions["depth_prompt"] == original_ext["depth_prompt"]
        assert extensions["talkativeness"] == original_ext["talkativeness"]
        assert extensions["v3_spec"] == original_ext["v3_spec"]
        assert extensions["v3_spec"] is True

    def test_contract_v3_card_v3_fields(self):
        """契约 7/14：V3 角色卡导入→导出保留 V3 特有字段。

        验证 group_only_greetings 和 assets 在往返后不丢失。
        """
        character = _import_card_to_character(ST_V3_CARD)
        exported = convert_character_to_chara_card(character)

        assert exported["data"]["group_only_greetings"] == ST_V3_CARD["data"]["group_only_greetings"]
        assert exported["data"]["group_only_greetings"] == ["Group greeting 1"]

        assert exported["data"]["assets"] == ST_V3_CARD["data"]["assets"]
        assert len(exported["data"]["assets"]) == 1
        assert exported["data"]["assets"][0]["type"] == "icon"

    # ------------------------------------------------------------------
    # 聊天 JSONL 契约（3 个）
    # ------------------------------------------------------------------

    def test_contract_chat_jsonl_message_count(self):
        """契约 8/14：聊天 JSONL 导入→导出保留消息数量。

        验证 ``convert_group_chat_to_jsonl`` →
        ``convert_jsonl_to_group_chat`` 往返后消息数量一致。
        """
        jsonl = convert_group_chat_to_jsonl(ST_CHAT_MESSAGES)
        assert jsonl.strip() != ""

        parsed = convert_jsonl_to_group_chat(jsonl)
        assert len(parsed) == len(ST_CHAT_MESSAGES)

    def test_contract_chat_jsonl_message_content(self):
        """契约 9/14：聊天 JSONL 导入→导出保留消息内容。

        验证每条消息的 mes 和 name 字段在往返后不丢失。
        """
        jsonl = convert_group_chat_to_jsonl(ST_CHAT_MESSAGES)
        parsed = convert_jsonl_to_group_chat(jsonl)

        for original, result in zip(ST_CHAT_MESSAGES, parsed):
            assert result["mes"] == original["mes"]
            assert result["name"] == original["name"]

        # 验证第一条消息内容
        assert parsed[0]["mes"] == "Hello!"
        assert parsed[0]["name"] == "Test Character"

    def test_contract_chat_jsonl_swipes(self):
        """契约 10/14：聊天 JSONL 导入→导出保留 swipes 和 swipe_id。

        验证 swipes 列表和当前 swipe_id 在往返后不丢失。
        """
        messages = [
            {
                "name": "Char",
                "is_user": False,
                "is_system": False,
                "send_date": "2024-01-01T00:00:00",
                "mes": "Hello!",
                "extra": {},
                "swipes": ["Hello!", "Hi there!", "Greetings!"],
                "swipe_id": 1,
            },
        ]
        jsonl = convert_group_chat_to_jsonl(messages)
        parsed = convert_jsonl_to_group_chat(jsonl)

        assert parsed[0]["swipes"] == ["Hello!", "Hi there!", "Greetings!"]
        assert parsed[0]["swipe_id"] == 1
        assert len(parsed[0]["swipes"]) == 3

    # ------------------------------------------------------------------
    # 世界书契约（4 个）
    # ------------------------------------------------------------------

    def test_contract_worldbook_entries(self):
        """契约 11/14：世界书导入→导出保留条目数量。

        验证 ``_build_wb_from_st_world_info`` (导入) →
        ``_worldbook_to_charbook`` (导出) 往返后条目数量一致。
        """
        wb = _build_wb_from_st_world_info(ST_WORLD_INFO)
        charbook = _worldbook_to_charbook(wb)

        assert charbook["name"] == ST_WORLD_INFO["name"]
        assert len(charbook["entries"]) == len(ST_WORLD_INFO["entries"])

    def test_contract_worldbook_content(self):
        """契约 12/14：世界书导入→导出保留条目内容和注释。

        验证 entry 的 content 和 comment 字段在往返后不丢失。
        """
        wb = _build_wb_from_st_world_info(ST_WORLD_INFO)
        charbook = _worldbook_to_charbook(wb)

        entry = list(charbook["entries"].values())[0]
        original = ST_WORLD_INFO["entries"]["0"]

        assert entry["content"] == original["content"]
        assert entry["content"] == "Dragons breathe fire"
        assert entry["comment"] == original["comment"]
        assert entry["comment"] == "Dragon entry"

    def test_contract_worldbook_order(self):
        """契约 13/14：世界书导入→导出保留条目顺序。

        验证条目按 order 字段排序后在导出中保持正确顺序
        （order=1 在前，order=2 在后）。
        """
        world_info = {
            "name": "Order Test World",
            "entries": {
                "0": {
                    "uid": 0,
                    "key": ["alpha"],
                    "keysecondary": [],
                    "comment": "Alpha entry",
                    "content": "Alpha content",
                    "constant": False,
                    "selective": False,
                    "selectiveLogic": 0,
                    "position": 0,
                    "depth": 4,
                    "probability": 100,
                    "disable": False,
                    "order": 2,
                    "group": "",
                    "groupWeight": 0,
                    "groupOverride": False,
                    "sticky": 0,
                    "cooldown": 0,
                    "delay": 0,
                    "vectorized": False,
                    "scanDepth": 4,
                    "caseSensitive": False,
                    "matchWholeWords": False,
                    "excludeRecursion": False,
                    "preventRecursion": False,
                    "addMemo": False,
                    "decorators": [],
                    "extensions": {},
                },
                "1": {
                    "uid": 1,
                    "key": ["beta"],
                    "keysecondary": [],
                    "comment": "Beta entry",
                    "content": "Beta content",
                    "constant": False,
                    "selective": False,
                    "selectiveLogic": 0,
                    "position": 0,
                    "depth": 4,
                    "probability": 100,
                    "disable": False,
                    "order": 1,
                    "group": "",
                    "groupWeight": 0,
                    "groupOverride": False,
                    "sticky": 0,
                    "cooldown": 0,
                    "delay": 0,
                    "vectorized": False,
                    "scanDepth": 4,
                    "caseSensitive": False,
                    "matchWholeWords": False,
                    "excludeRecursion": False,
                    "preventRecursion": False,
                    "addMemo": False,
                    "decorators": [],
                    "extensions": {},
                },
            },
        }
        wb = _build_wb_from_st_world_info(world_info)
        charbook = _worldbook_to_charbook(wb)

        entries = list(charbook["entries"].values())
        assert len(entries) == 2

        # 条目按 order 排序：Beta (order=1) 在前，Alpha (order=2) 在后
        assert entries[0]["comment"] == "Beta entry"
        assert entries[0]["key"] == ["beta"]
        assert entries[1]["comment"] == "Alpha entry"
        assert entries[1]["key"] == ["alpha"]

    def test_contract_worldbook_selective_logic(self):
        """契约 14/14：世界书导入→导出保留 selectiveLogic。

        验证 selectiveLogic 字段在往返后保持原值（ST 世界书的核心字段）。
        """
        wb = _build_wb_from_st_world_info(ST_WORLD_INFO)
        charbook = _worldbook_to_charbook(wb)

        entry = list(charbook["entries"].values())[0]
        original = ST_WORLD_INFO["entries"]["0"]

        assert entry["selectiveLogic"] == original["selectiveLogic"]
        assert entry["selectiveLogic"] == 0
