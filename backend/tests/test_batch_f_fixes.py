"""批次 F 修复测试（2026-08-29）：导出/导入保真 + BYAF ZIP + 双宏引擎收敛子集。

来源: docs/REPORT_ST兼容性深度调研_2026-08-29.md 第三档
     G1（导出方言）/ G2（BYAF ZIP）/ G3（extensions.position）/ G5（YAML 方言）/
     G6（禁用条目保留）/ G7（分支问候宏替换）/ G8（useProbability 回填）/
     G15（导出 schema 污染）/ G19（导出取书类型）+ F7 宏子集。

约束: 全部为无行为冲突的保真/补缺修复（用户红线: 不影响既有组件/功能）。
"""

import io
import json
import os
import sys
import zipfile
from types import SimpleNamespace

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from app.api.character_ext import _worldbook_to_charbook
    from app.services.character_import_service import CharacterImportService
    from app.services import character_import_service as _cis_mod
    from app.character_card import convert_character_to_chara_card
    from app.services.macro_service import MacroEnv, evaluate_macros
    from app.models.character import (
        Character,
        CharacterChatMessage,
        CharacterChatSession,
    )
    from app.models.worldbook import WorldBook, WorldBookStage
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")


# ---------------------------------------------------------------------------
# G1: 导出 charbook 方言（数组 + V3 字段名，委托 STP 权威实现）
# ---------------------------------------------------------------------------

class TestG1ExportDialect:
    def _make_wb(self, db, char_id, user_id):
        wb = WorldBook(name="B", character_id=char_id, user_id=user_id)
        db.add(wb)
        db.flush()
        db.add(WorldBookStage(world_book_id=wb.id, stage_index=0, title="e0",
                              content="C0", keys=json.dumps(["k0"]),
                              enabled=True, position=0, probability=100))
        db.add(WorldBookStage(world_book_id=wb.id, stage_index=1, title="e1",
                              content="C1", keys=json.dumps(["k1"]),
                              enabled=True, position=4, probability=100))
        db.add(WorldBookStage(world_book_id=wb.id, stage_index=2, title="e2",
                              content="C2", keys=json.dumps(["k2"]),
                              enabled=False, position=1, probability=100))
        db.flush()
        return wb

    def test_export_entries_is_array_with_v3_names(self, db_session, test_user):
        """ST convertCharacterBook 要求 entries 数组 + V3 字段名（此前 dict+V2 名致 ST 端崩溃）。"""
        char = Character(user_id=test_user.id, name="A")
        db_session.add(char)
        db_session.flush()
        wb = self._make_wb(db_session, char.id, test_user.id)
        result = _worldbook_to_charbook(wb)
        assert isinstance(result["entries"], list)
        e0 = result["entries"][0]
        for key in ("keys", "secondary_keys", "insertion_order", "enabled", "extensions", "id", "position"):
            assert key in e0, f"missing V3 field: {key}"
        assert "key" not in e0 and "disable" not in e0 and "order" not in e0
        # G6: 禁用条目保留（enabled=False）
        assert result["entries"][2]["enabled"] is False

    def test_export_position_extensions_fidelity(self, db_session, test_user):
        """G3 导出侧: 数值位置 2-7 仅存于 extensions.position；0/1 由顶层字符串承载。"""
        char = Character(user_id=test_user.id, name="A")
        db_session.add(char)
        db_session.flush()
        wb = self._make_wb(db_session, char.id, test_user.id)
        entries = _worldbook_to_charbook(wb)["entries"]
        e0, e1 = entries[0], entries[1]
        assert e0["position"] == "before_char"
        assert "position" not in e0["extensions"]
        assert e1["position"] == "after_char"
        assert e1["extensions"].get("position") == 4

    def test_export_null_semantics_preserved(self, db_session, test_user):
        """G14: 条目级 NULL 语义不污染为 False/默认值（ST 用 ?? 全局回退）。

        ORM 列默认（scan_depth=4 等）会填充新建行，真正的 NULL 场景是存量行/
        手工置空——用原生 SQL 置空后导出必须保持 null（而非 False/4）。
        """
        from sqlalchemy import text as _text

        char = Character(user_id=test_user.id, name="A")
        db_session.add(char)
        db_session.flush()
        wb = WorldBook(name="B", character_id=char.id, user_id=test_user.id)
        db_session.add(wb)
        db_session.flush()
        stage = WorldBookStage(world_book_id=wb.id, stage_index=0, title="n0",
                               content="CN", keys=json.dumps(["kn"]),
                               enabled=True, position=1, probability=100)
        db_session.add(stage)
        db_session.flush()
        db_session.execute(
            _text("UPDATE world_book_stages SET scan_depth=NULL, case_sensitive=NULL, "
                  "match_whole_words=NULL WHERE id = :i"),
            {"i": stage.id},
        )
        db_session.expire(stage)
        ext = _worldbook_to_charbook(wb)["entries"][0]["extensions"]
        assert ext["scan_depth"] is None
        assert ext["case_sensitive"] is None
        assert ext["match_whole_words"] is None


# ---------------------------------------------------------------------------
# G2: BYAF ZIP 支持（真实格式）+ 纯 JSON 兼容
# ---------------------------------------------------------------------------

class TestG2ByafZip:
    def _make_byaf_zip(self) -> bytes:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("manifest.json", json.dumps({
                "author": {"name": "BYAF-AUTHOR", "backyardURL": "https://backyard.ai/x"},
                "characters": ["character.json"],
                "scenarios": ["scenario.json", "scenario2.json"],
            }))
            zf.writestr("character.json", json.dumps({
                "name": "Zia",
                "displayName": "Zia Display",
                "persona": "Hello {character}, I am {user}.",
                "isNSFW": True,
                "loreItems": [{"key": "garden, rose", "value": "A secret garden for {user}."}],
            }))
            zf.writestr("scenario.json", json.dumps({
                "narrative": "The story begins.",
                "firstMessages": [{"text": "Greetings, {user}!"}],
                "exampleMessages": [{"text": "example line"}],
                "formattingInstructions": "Stay in character.",
            }))
            zf.writestr("scenario2.json", json.dumps({
                "firstMessages": [{"text": "Alternate opening!"}],
            }))
        return buf.getvalue()

    def test_zip_byaf_full_mapping(self, db_session, test_user):
        svc = CharacterImportService(db_session)
        data = svc._import_from_byaf(self._make_byaf_zip())
        assert data["name"] == "Zia"
        # 宏归一: {character}→{{char}}、{user}→{{user}}
        assert "{{char}}" in data["description"] and "{{user}}" in data["description"]
        assert "{character}" not in data["description"]
        assert data["first_mes"] == "Greetings, {{user}}!"
        assert data["scenario"] == "The story begins."
        assert data["system_prompt"] == "Stay in character."
        assert data["creator"] == "BYAF-AUTHOR"
        assert data["creator_notes"] == "https://backyard.ai/x"
        assert data["tags"] == ["nsfw"]
        assert data["alternate_greetings"] == ["Alternate opening!"]
        assert "<START>" in data["mes_example"]
        book = data["character_book"]
        assert book["entries"][0]["keys"] == ["garden", "rose"]
        assert data["extensions"] == {"display_name": "Zia Display"}

    def test_corrupt_zip_rejected(self, db_session, test_user):
        svc = CharacterImportService(db_session)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("other.txt", "x")
        with pytest.raises(ValueError):
            svc._import_from_byaf(buf.getvalue())

    def test_json_byaf_fallback_preserved(self, db_session, test_user):
        """历史 B-5 纯 JSON 行为零回归。"""
        svc = CharacterImportService(db_session)
        data = svc._import_from_byaf(json.dumps({"fields": {"name": "Legacy"}}).encode())
        assert data["name"] == "Legacy"


# ---------------------------------------------------------------------------
# G3/G6/G8: charbook 导入保真
# ---------------------------------------------------------------------------

class TestG3G6G8ImportFidelity:
    def _import_book(self, db_session, test_user, entries):
        char = Character(user_id=test_user.id, name="A")
        db_session.add(char)
        db_session.flush()
        svc = CharacterImportService(db_session)
        return svc._create_worldbook_from_character_book(
            {"name": "T", "entries": entries}, "A", test_user.id, char.id
        )

    def test_extensions_position_authoritative(self, db_session, test_user):
        """G3: extensions.position 数值优先；无位置信息缺省 after_char(1)（K2）。"""
        wb = self._import_book(db_session, test_user, [
            {"keys": ["a"], "content": "A", "enabled": True, "insertion_order": 0,
             "extensions": {"position": 4}},
            {"keys": ["b"], "content": "B", "enabled": True, "insertion_order": 1,
             "extensions": {"position": 2}},
            {"keys": ["c"], "content": "C", "enabled": True, "insertion_order": 2},
        ])
        positions = {s.content: s.position for s in wb.entries}
        assert positions["A"] == 4
        assert positions["B"] == 2
        assert positions["C"] == 1

    def test_disabled_entries_retained(self, db_session, test_user):
        """G6: 禁用条目保留落库（enabled=False），不再导入即丢。"""
        wb = self._import_book(db_session, test_user, [
            {"keys": ["a"], "content": "A", "enabled": True, "insertion_order": 0},
            {"keys": ["b"], "content": "B", "enabled": False, "insertion_order": 1},
        ])
        by_content = {s.content: s.enabled for s in wb.entries}
        assert by_content["A"] is True
        assert by_content["B"] is False

    def test_use_probability_mapping(self, db_session, test_user):
        """G8: 顶层/extensions 的 useProbability 双读回填（false=必现）。"""
        wb = self._import_book(db_session, test_user, [
            {"keys": ["a"], "content": "A", "enabled": True, "insertion_order": 0,
             "useProbability": False},
            {"keys": ["b"], "content": "B", "enabled": True, "insertion_order": 1,
             "extensions": {"useProbability": False}},
            {"keys": ["c"], "content": "C", "enabled": True, "insertion_order": 2},
        ])
        ups = {s.content: s.use_probability for s in wb.entries}
        assert ups["A"] is False
        assert ups["B"] is False
        assert ups["C"] is True


# ---------------------------------------------------------------------------
# G5: TavernAI YAML 方言
# ---------------------------------------------------------------------------

class TestG5YamlDialect:
    def test_yaml_context_greeting_mapping(self, db_session, test_user):
        if _cis_mod._yaml is None:
            pytest.skip("PyYAML 不可用")
        svc = CharacterImportService(db_session)
        data = svc._import_from_yaml(
            b"name: Tavern\ncontext: Long description here\ngreeting: Hi there!\n"
        )
        assert data["description"] == "Long description here"
        assert data["first_mes"] == "Hi there!"

    def test_yaml_explicit_values_not_overridden(self, db_session, test_user):
        if _cis_mod._yaml is None:
            pytest.skip("PyYAML 不可用")
        svc = CharacterImportService(db_session)
        data = svc._import_from_yaml(
            b"name: Tavern\ncontext: C1\ndescription: D1\ngreeting: G1\nfirst_mes: F1\n"
        )
        assert data["description"] == "D1"
        assert data["first_mes"] == "F1"


# ---------------------------------------------------------------------------
# G7: 分支创建问候语宏替换 + AI_OUTPUT 正则 + 空提升
# ---------------------------------------------------------------------------

class TestG7BranchGreeting:
    def test_branch_greeting_macro_replaced(self, db_session, test_user, client, auth_headers):
        char = Character(
            user_id=test_user.id,
            name="Alice",
            description="d",
            first_mes="{{user}} 你好，{{char}} 为你服务。",
        )
        db_session.add(char)
        db_session.flush()
        session = CharacterChatSession(character_id=char.id, user_id=test_user.id)
        db_session.add(session)
        db_session.flush()
        db_session.commit()

        resp = client.post(
            f"/api/character-sessions/{session.id}/branches",
            json={"session_id": session.id, "branch_name": "b1"},
            headers=auth_headers,
        )
        assert resp.status_code == 200, resp.text
        greeting = resp.json().get("greeting") or {}
        content = greeting.get("content") or ""
        assert content, "branch greeting missing"
        # 宏已替换（原样泄漏即回归）
        assert "{{user}}" not in content and "{{char}}" not in content
        assert test_user.username in content
        # DB 侧一致
        msg = db_session.get(CharacterChatMessage, greeting["id"])
        assert msg is not None and "{{user}}" not in (msg.content or "")


# ---------------------------------------------------------------------------
# G15: V3 导出不再强写 ST 不认识的字段默认值
# ---------------------------------------------------------------------------

class TestG15ExportNoSchemaPollution:
    def _char(self, db, user_id, raw_data, **col_kw):
        char = Character(
            user_id=user_id,
            name="A",
            extensions=json.dumps({"palink_raw_card_data": raw_data}),
            **col_kw,
        )
        db.add(char)
        db.flush()
        return char

    def test_no_default_pollution(self, db_session, test_user):
        raw = {"spec": "chara_card_v3", "spec_version": "3.0",
               "data": {"name": "A", "description": "D"}}
        char = self._char(db_session, test_user.id, raw)
        data = convert_character_to_chara_card(char)["data"]
        assert "nickname" not in data
        assert "group_only_greetings" not in data
        assert "talkativeness" not in data

    def test_explicit_values_roundtrip(self, db_session, test_user):
        raw = {"spec": "chara_card_v3", "spec_version": "3.0",
               "data": {"name": "A", "description": "D", "nickname": "N-ORIG"}}
        char = self._char(db_session, test_user.id, raw)
        data = convert_character_to_chara_card(char)["data"]
        assert data["nickname"] == "N-ORIG"

    def test_column_value_written(self, db_session, test_user):
        raw = {"spec": "chara_card_v3", "spec_version": "3.0",
               "data": {"name": "A", "description": "D"}}
        char = self._char(db_session, test_user.id, raw, nickname="V2-SET")
        data = convert_character_to_chara_card(char)["data"]
        assert data["nickname"] == "V2-SET"


# ---------------------------------------------------------------------------
# F7: 双宏引擎收敛子集（后端补齐有数据源的 ST 宏）
# ---------------------------------------------------------------------------

class TestF7MacroSubset:
    def _env(self, **kw):
        defaults = dict(db=None, user_name="U", char_name="C",
                        input_text="ORIGINAL-TEXT")
        defaults.update(kw)
        return MacroEnv(**defaults)

    def test_new_macros_resolve(self, db_session):
        char = SimpleNamespace(
            first_mes="HELLO-GREETING",
            mes_example="RAW-EXAMPLE",
            character_version="1.2.3",
        )
        env = self._env(character=char)
        out = evaluate_macros(
            "{{greeting}}|{{charVersion}}|{{mesExamplesRaw}}|{{original}}|{{charFirstMessage}}",
            env,
        )
        parts = out.split("|")
        assert parts[0] == "HELLO-GREETING"
        assert parts[1] == "1.2.3"
        assert parts[2] == "RAW-EXAMPLE"
        assert parts[3] == "ORIGINAL-TEXT"
        assert parts[4] == "HELLO-GREETING"
        assert "{{" not in out

    def test_version_alias(self, db_session):
        char = SimpleNamespace(character_version="9.9")
        out = evaluate_macros("v={{version}}", self._env(character=char))
        assert out == "v=9.9"

    def test_idle_duration_alias_no_leak(self, db_session):
        """{{idleDuration}}（ST 命名）此前泄漏，现注册别名；无时间数据返回空串。"""
        out = evaluate_macros("t=[{{idleDuration}}]", self._env())
        assert out == "t=[]"

    def test_idle_duration_with_time(self, db_session):
        from datetime import datetime, timedelta
        env = self._env(last_message_time=datetime.utcnow() - timedelta(seconds=30))
        out = evaluate_macros("t=[{{idleDuration}}]", env)
        assert out == "t=[30s]"
