"""预设模板库后端（2026-10-25）—— 清单 / ST 原生导入 / 导出 / 删除 / 归属。

钉的行为（不是"端点存在"）：

① 自带中文明单四类齐全，且重复播种**幂等**（created 全 0、数组无重复），
   用户改过的数组条目不会被种子回滚；
② ST 四类判定（instruct / context / sysprompt / reasoning）与 **instruct 全字段
   透传**——反证锚：把 ``_ST_INSTRUCT_FIELD_MAP`` 里任一列漏掉，本文件必红；
③ context 无列可落的 ST 键（story_string_position / story_string_role /
   story_string_depth / example_separator 等）必须出现在 warnings 里，不静默丢；
④ 5MB 上限 413；非法 JSON 400；重名加 " (imported)"；
⑤ 删除归属：他人行 404、内置 400、本人 200；
⑥ context 可见性 = builtin + 历史共享行（user_id NULL）+ 本人；
⑦ 导出可回灌（``_palink_kind`` + ST 原生字段名），再导入不丢字段；
⑧ ST 设置整块保存（``/api/settings/save``）不会抹掉 sysprompt/reasoning 数组。

运行: cd backend && py -3 -m pytest tests/test_preset_library_api.py -q
"""
from __future__ import annotations

import json
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

from app.api.dependencies import get_current_user
from app.core.preset_library_seeds import (
    BUILTIN_REASONING_PRESETS,
    BUILTIN_SYSPROMPT_PRESETS,
    REASONING_PRESETS_KEY,
    SYSPROMPT_PRESETS_KEY,
    ensure_preset_library_seeds,
)
from app.main import app
from app.models import ContextTemplate, InstructTemplate, User, UserSetting

LIB_URL = "/api/preset-library"
IMPORT_URL = f"{LIB_URL}/import"


# ---------------------------------------------------------------------------
# 工具
# ---------------------------------------------------------------------------
def _upload(client: TestClient, payload, headers: dict, filename: str = "preset.json"):
    return client.post(
        IMPORT_URL,
        files={"file": (filename, json.dumps(payload, ensure_ascii=False).encode("utf-8"), "application/json")},
        headers=headers,
    )


def _library(client: TestClient, headers: dict | None = None) -> dict:
    resp = client.get(LIB_URL, headers=headers or {})
    assert resp.status_code == 200, resp.text
    return resp.json()


def _names(entries: list[dict]) -> list[str]:
    return [entry.get("name") for entry in entries]


@pytest.fixture()
def as_user(client: TestClient):
    """临时把 get_current_user 覆写为指定用户（对齐 test_pentest_fixes 的 admin_client）。"""
    original = app.dependency_overrides.get(get_current_user)
    setter = {"override": None}

    def _set(user: User):
        app.dependency_overrides[get_current_user] = lambda: user
        setter["override"] = True

    yield _set
    app.dependency_overrides.pop(get_current_user, None)
    if original is not None:
        app.dependency_overrides[get_current_user] = original


def _other_user(db_session, username: str = "preset_lib_other") -> User:
    user = User(username=username, hashed_password="x", role="user", is_active=True)
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


# ---------------------------------------------------------------------------
# ① 自带默认 + 幂等
# ---------------------------------------------------------------------------
class TestBuiltinLibrary:
    def test_list_has_four_kinds_with_chinese_builtins(self, client):
        library = _library(client)
        assert set(library.keys()) == {"context", "instruct", "sysprompt", "reasoning"}
        assert "Palink·沉浸叙事" in _names(library["context"])
        assert "Palink·极简" in _names(library["context"])
        assert "Palink·对话体" in _names(library["instruct"])
        assert "Palink·小说正文体" in _names(library["instruct"])
        assert [s["name"] for s in library["sysprompt"]] == [
            s["name"] for s in BUILTIN_SYSPROMPT_PRESETS
        ]
        assert [s["name"] for s in library["reasoning"]] == [
            s["name"] for s in BUILTIN_REASONING_PRESETS
        ]
        # 自带的都是 builtin 标记（删除侧据此拒绝）
        assert all(item["is_builtin"] for item in library["context"] if item["name"].startswith("Palink·"))
        assert all(item["builtin"] for item in library["sysprompt"])

    def test_seed_is_idempotent_and_keeps_user_edits(self, client, db_session, test_user):
        first = ensure_preset_library_seeds(db_session, user_id=test_user.id)
        db_session.commit()
        assert first["sysprompt_created"] == len(BUILTIN_SYSPROMPT_PRESETS)
        assert first["reasoning_created"] == len(BUILTIN_REASONING_PRESETS)
        assert first["context_created"] == 2
        assert first["instruct_created"] == 2

        # 模拟用户改了自带 sysprompt 的正文
        setting = db_session.query(UserSetting).filter(UserSetting.user_id == test_user.id).first()
        stored = json.loads(setting.silly_tavern_settings)
        stored[SYSPROMPT_PRESETS_KEY][0]["content"] = "用户改过的内容"
        setting.silly_tavern_settings = json.dumps(stored, ensure_ascii=False)
        db_session.commit()

        second = ensure_preset_library_seeds(db_session, user_id=test_user.id)
        db_session.commit()
        assert all(value == 0 for value in second.values()), second

        db_session.expire_all()
        setting = db_session.query(UserSetting).filter(UserSetting.user_id == test_user.id).first()
        stored = json.loads(setting.silly_tavern_settings)
        names = [entry["name"] for entry in stored[SYSPROMPT_PRESETS_KEY]]
        assert len(names) == len(set(names)) == len(BUILTIN_SYSPROMPT_PRESETS)
        assert stored[SYSPROMPT_PRESETS_KEY][0]["content"] == "用户改过的内容"

        assert db_session.query(ContextTemplate).filter(ContextTemplate.is_builtin.is_(True)).count() == 2
        assert (
            db_session.query(InstructTemplate).filter(InstructTemplate.user_id.is_(None)).count() == 2
        )

    def test_ensure_defaults_endpoint_is_idempotent(self, client, auth_headers):
        first = client.post(f"{LIB_URL}/ensure-defaults", headers=auth_headers)
        assert first.status_code == 200, first.text
        second = client.post(f"{LIB_URL}/ensure-defaults", headers=auth_headers)
        assert second.status_code == 200
        assert all(value == 0 for value in second.json()["counts"].values())


# ---------------------------------------------------------------------------
# ② ST 四类判定 + instruct 全字段透传
# ---------------------------------------------------------------------------
ST_INSTRUCT = {
    "name": "ST导入模板",
    "system_prompt": "系统提示正文",
    "input_sequence": "<user>",
    "input_suffix": "</user>",
    "output_sequence": "<assistant>",
    "output_suffix": "</assistant>",
    "system_sequence": "<system>",
    "system_suffix": "</system>",
    "last_system_sequence": "<last_system>",
    "first_input_sequence": "<first_input>",
    "last_input_sequence": "<last_input>",
    "first_output_sequence": "<first_output>",
    "last_output_sequence": "<last_output>",
    "user_alignment_message": "对齐提示",
    "story_string_prefix": "故事前缀",
    "story_string_suffix": "故事后缀",
    "stop_sequence": "<stop>",
    "separator_sequence": "\n---\n",
    "wrap": True,
    "macro": True,
    "names_behavior": "always",
    "system_same_as_user": True,
    "sequences_as_stop_strings": False,
    "skip_examples": True,
    # ST 独有、本仓无列 ⇒ 必须进 warnings，不许静默
    "activation_regex": "\\breset\\b",
}


class TestStInstructImport:
    def test_full_field_passthrough(self, client, auth_headers):
        resp = _upload(client, ST_INSTRUCT, auth_headers)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert [item["kind"] for item in body["created"]] == ["instruct"]
        assert body["created"][0]["name"] == "ST导入模板"
        assert any("activation_regex" in warning for warning in body["warnings"])

        library = _library(client)
        entry = next(
            (item for item in library["instruct"] if item["name"] == "ST导入模板"), None
        )
        assert entry is not None
        # 逐字段对账（漏一个列本断言就红）
        assert entry["input_prefix"] == "<user>"
        assert entry["input_suffix"] == "</user>"
        assert entry["output_prefix"] == "<assistant>"
        assert entry["output_suffix"] == "</assistant>"
        assert entry["system_sequence"] == "<system>"
        assert entry["system_suffix"] == "</system>"
        assert entry["last_system_sequence"] == "<last_system>"
        assert entry["first_input_sequence"] == "<first_input>"
        assert entry["last_input_sequence"] == "<last_input>"
        assert entry["first_output_prefix"] == "<first_output>"
        assert entry["last_output_prefix"] == "<last_output>"
        assert entry["user_alignment_message"] == "对齐提示"
        assert entry["story_string_prefix"] == "故事前缀"
        assert entry["story_string_suffix"] == "故事后缀"
        assert entry["stop_sequence"] == "<stop>"
        assert entry["separator_sequence"] == "\n---\n"
        assert entry["wrap_sequences"] is True
        assert entry["macro"] is True
        assert entry["names_behavior"] == "always"
        assert entry["system_same_as_user"] is True
        assert entry["sequences_as_stop_strings"] is False
        assert entry["skip_examples"] is True
        assert entry["system_prompt"] == "系统提示正文"
        assert entry["user_id"] is not None
        assert entry["is_builtin"] is False

    def test_export_roundtrip_uses_st_names(self, client, auth_headers):
        _upload(client, ST_INSTRUCT, auth_headers)
        exported = client.get(
            f"{LIB_URL}/export", params={"kind": "instruct", "name": "ST导入模板"}
        )
        assert exported.status_code == 200, exported.text
        data = exported.json()
        assert data["_palink_kind"] == "instruct"
        assert data["input_sequence"] == "<user>"
        assert data["output_sequence"] == "<assistant>"
        assert data["first_output_sequence"] == "<first_output>"
        assert data["wrap"] is True
        assert "input_prefix" not in data

        reimport = _upload(client, data, auth_headers)
        assert reimport.status_code == 200
        assert reimport.json()["created"][0]["name"] == "ST导入模板 (imported)"


# ---------------------------------------------------------------------------
# ③ context：只落 story_string/chat_start + warnings
# ---------------------------------------------------------------------------
ST_CONTEXT = {
    "name": "ST上下文模板",
    "story_string": "{{description}}\n{{scenario}}",
    "chat_start": "***",
    "example_separator": "***",
    "use_stop_strings": True,
    "names_as_stop_strings": True,
    "story_string_position": 0,
    "story_string_role": 0,
    "story_string_depth": 1,
}


class TestStContextImport:
    def test_unmappable_keys_warn_and_row_is_owned(self, client, auth_headers, test_user):
        resp = _upload(client, ST_CONTEXT, auth_headers)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["created"][0]["kind"] == "context"
        warnings = " ".join(body["warnings"])
        for key in ("example_separator", "story_string_position", "story_string_role", "story_string_depth"):
            assert key in warnings, (key, warnings)

        library = _library(client)
        entry = next(item for item in library["context"] if item["name"] == "ST上下文模板")
        assert entry["story_string"] == "{{description}}\n{{scenario}}"
        assert entry["chat_start"] == "***"
        assert entry["user_id"] == test_user.id
        assert entry["is_builtin"] is False

    def test_duplicate_name_gets_imported_suffix(self, client, auth_headers):
        assert _upload(client, ST_CONTEXT, auth_headers).status_code == 200
        second = _upload(client, ST_CONTEXT, auth_headers)
        assert second.status_code == 200
        created = second.json()["created"][0]
        assert created["name"] == "ST上下文模板 (imported)"
        assert created["renamed_from"] == "ST上下文模板"

    def test_third_duplicate_gets_numbered_suffix(self, client, auth_headers):
        for _ in range(3):
            assert _upload(client, ST_CONTEXT, auth_headers).status_code == 200
        names = _names(_library(client)["context"])
        assert "ST上下文模板 (imported)" in names
        assert "ST上下文模板 (imported 2)" in names


# ---------------------------------------------------------------------------
# ④ sysprompt / reasoning：判定 + 打包 + 数组落点
# ---------------------------------------------------------------------------
class TestStArrayPresets:
    def test_pack_detects_sysprompt_and_reasoning(self, client, auth_headers, db_session, test_user):
        pack = {
            "items": [
                {"name": "ST系统提示", "content": "你是旁白。", "post_history": "不要落库"},
                {"name": "ST推理模板", "prefix": "<r>", "suffix": "</r>", "separator": "\n"},
            ]
        }
        resp = _upload(client, pack, auth_headers)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        kinds = {item["kind"] for item in body["created"]}
        assert kinds == {"sysprompt", "reasoning"}
        assert any("post_history" in warning for warning in body["warnings"])

        library = _library(client)
        sysprompt = next(item for item in library["sysprompt"] if item["name"] == "ST系统提示")
        assert sysprompt["content"] == "你是旁白。"
        assert sysprompt["builtin"] is False
        reasoning = next(item for item in library["reasoning"] if item["name"] == "ST推理模板")
        assert (reasoning["prefix"], reasoning["suffix"], reasoning["separator"]) == (
            "<r>",
            "</r>",
            "\n",
        )

        # 落点必须是用户设置里的数组键（而不是 ST 的当前选中值）
        db_session.expire_all()
        setting = db_session.query(UserSetting).filter(UserSetting.user_id == test_user.id).first()
        stored = json.loads(setting.silly_tavern_settings)
        assert "ST系统提示" in [entry["name"] for entry in stored[SYSPROMPT_PRESETS_KEY]]
        assert "ST推理模板" in [entry["name"] for entry in stored[REASONING_PRESETS_KEY]]

    def test_import_name_colliding_with_builtin_is_renamed(self, client, auth_headers):
        _library(client)  # 先触发播种，让 builtin 名在场
        resp = _upload(
            client, {"name": BUILTIN_SYSPROMPT_PRESETS[0]["name"], "content": "改过的"}, auth_headers
        )
        assert resp.status_code == 200
        assert resp.json()["created"][0]["name"] == f"{BUILTIN_SYSPROMPT_PRESETS[0]['name']} (imported)"

    def test_settings_save_keeps_presets_arrays(self, client, auth_headers, db_session, test_user):
        """ST 前端整块保存设置不得抹掉预设库数组（反证锚：删保护逻辑必红）。"""
        assert _upload(client, {"name": "ST系统提示", "content": "x"}, auth_headers).status_code == 200

        saved = client.post("/api/settings/save", json={"power_user": {"name": "tester"}}, headers=auth_headers)
        assert saved.status_code == 200, saved.text

        db_session.expire_all()
        setting = db_session.query(UserSetting).filter(UserSetting.user_id == test_user.id).first()
        stored = json.loads(setting.silly_tavern_settings)
        assert "ST系统提示" in [entry["name"] for entry in stored[SYSPROMPT_PRESETS_KEY]]
        assert stored[SYSPROMPT_PRESETS_KEY], "预设库数组被整块保存抹掉了"


# ---------------------------------------------------------------------------
# ⑤ 删除归属
# ---------------------------------------------------------------------------
class TestDeletePermissions:
    def test_builtin_cannot_be_deleted(self, client, auth_headers):
        _library(client)
        cases = [
            ("context", "Palink·沉浸叙事"),
            ("instruct", "Palink·对话体"),
            ("sysprompt", BUILTIN_SYSPROMPT_PRESETS[0]["name"]),
            ("reasoning", BUILTIN_REASONING_PRESETS[0]["name"]),
        ]
        for kind, name in cases:
            resp = client.delete(f"{LIB_URL}/{kind}/{quote(name)}", headers=auth_headers)
            assert resp.status_code == 400, (kind, name, resp.status_code, resp.text)

    def test_owner_deletes_own_context(self, client, auth_headers):
        created = _upload(client, ST_CONTEXT, auth_headers).json()["created"][0]
        resp = client.delete(f"{LIB_URL}/context/{created['id']}", headers=auth_headers)
        assert resp.status_code == 200, resp.text
        assert "ST上下文模板" not in _names(_library(client)["context"])

    def test_other_user_cannot_delete(self, client, auth_headers, db_session, as_user):
        created = _upload(client, ST_CONTEXT, auth_headers).json()["created"][0]
        _upload(client, {"name": "别人的系统提示", "content": "x"}, auth_headers)

        other = _other_user(db_session)
        as_user(other)

        # 他人 Import 的 context 行：404，且行还在
        resp = client.delete(f"{LIB_URL}/context/{created['id']}", headers=auth_headers)
        assert resp.status_code == 404
        db_session.expire_all()
        assert db_session.query(ContextTemplate).filter(ContextTemplate.id == created["id"]).first() is not None

        # 他人 Import 的 sysprompt 数组条目：同样 404（各自 settings 隔离）
        assert (
            client.delete(f"{LIB_URL}/sysprompt/{quote('别人的系统提示')}", headers=auth_headers).status_code
            == 404
        )

    def test_owner_deletes_imported_sysprompt(self, client, auth_headers):
        _upload(client, {"name": "我的系统提示", "content": "x"}, auth_headers)
        resp = client.delete(f"{LIB_URL}/sysprompt/{quote('我的系统提示')}", headers=auth_headers)
        assert resp.status_code == 200
        assert "我的系统提示" not in _names(_library(client)["sysprompt"])


# ---------------------------------------------------------------------------
# ⑥ context 可见性
# ---------------------------------------------------------------------------
class TestContextVisibility:
    def _seed_rows(self, db_session, test_user, other: User):
        rows = [
            ContextTemplate(name="vis-builtin", is_builtin=True, user_id=None),
            ContextTemplate(name="vis-shared", is_builtin=False, user_id=None),
            ContextTemplate(name="vis-mine", is_builtin=False, user_id=test_user.id),
            ContextTemplate(name="vis-other", is_builtin=False, user_id=other.id),
        ]
        db_session.add_all(rows)
        db_session.commit()
        return rows

    def test_list_scope_builtin_shared_and_own(self, client, db_session, test_user, as_user):
        other = _other_user(db_session)
        self._seed_rows(db_session, test_user, other)

        mine = set(_names(_library(client)["context"]))
        assert {"vis-builtin", "vis-shared", "vis-mine"} <= mine
        assert "vis-other" not in mine

        as_user(other)
        theirs = set(_names(_library(client)["context"]))
        assert {"vis-builtin", "vis-shared", "vis-other"} <= theirs
        assert "vis-mine" not in theirs

    def test_get_by_name_hides_other_users_row(self, client, db_session, test_user, as_user):
        other = _other_user(db_session)
        self._seed_rows(db_session, test_user, other)
        assert client.get("/api/roleplay/context-templates/vis-mine").status_code == 200
        assert client.get("/api/roleplay/context-templates/vis-other").status_code == 404
        assert client.get("/api/roleplay/context-templates/vis-shared").status_code == 200


# ---------------------------------------------------------------------------
# ⑦ 导入容错
# ---------------------------------------------------------------------------
class TestImportGuards:
    def test_too_large_413(self, client, auth_headers):
        oversized = b" " * (5 * 1024 * 1024 + 2)
        resp = client.post(
            IMPORT_URL,
            files={"file": ("big.json", oversized, "application/json")},
            headers=auth_headers,
        )
        assert resp.status_code == 413

    def test_invalid_json_400(self, client, auth_headers):
        resp = client.post(
            IMPORT_URL,
            files={"file": ("bad.json", b"{not json", "application/json")},
            headers=auth_headers,
        )
        assert resp.status_code == 400

    def test_unrecognized_entry_is_skipped(self, client, auth_headers):
        resp = _upload(client, {"items": [{"foo": "bar"}, ST_CONTEXT]}, auth_headers)
        assert resp.status_code == 200
        body = resp.json()
        assert len(body["skipped"]) == 1
        assert body["skipped"][0]["reason"] == "unrecognized preset type"
        assert len(body["created"]) == 1

    def test_export_unknown_404(self, client):
        assert client.get(f"{LIB_URL}/export", params={"kind": "context", "name": "nope"}).status_code == 404
        assert client.get(f"{LIB_URL}/export", params={"kind": "bogus", "name": "x"}).status_code == 400

    def test_export_all_contains_four_kinds(self, client):
        resp = client.get(f"{LIB_URL}/export-all")
        assert resp.status_code == 200
        data = resp.json()
        kinds = {item["_palink_kind"] for item in data["items"]}
        assert kinds == {"context", "instruct", "sysprompt", "reasoning"}
        assert data["count"] == len(data["items"])
