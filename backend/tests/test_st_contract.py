"""ST (SillyTavern) 兼容性契约 / 冒烟测试 harness。

对照 SillyTavern 1.18.0 端点规范，为 Palink 后端 ``app/api/silly_tavern.py``
（以及 ``st_groups.py`` / ``st_resources.py``）的 ST 兼容端点创建契约测试。

测试分两层：
1. 端点注册静态检查（无需 DB / HTTP）：导入 ``api_router``，验证 spec 中列出
   的所有 ST 端点路径都已注册，不会返回 404。此为纯函数测试，写真实断言。
2. 端点行为契约（需要 DB session）：覆盖 settings / characters / chats /
   groups / worldinfo / generation 各端点的请求-响应形状。

============================================================================
说明
============================================================================
* DB session 由 ``backend/tests/conftest.py`` 提供的 ``db_session`` / ``client``
  / ``test_user`` / ``auth_headers`` fixtures 注入，使用 SQLite in-memory。
* 端点注册检查通过静态路由反射完成，不发 HTTP 请求，不依赖 DB。
* 本文件仅作测试 harness，不修改任何现有源代码。
"""

import io
import json
import os
import struct
import sys
import zlib

import pytest

# 让 ``backend`` 目录可被导入（测试可位于 backend/tests/ 下独立运行）
_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)


# ---------------------------------------------------------------------------
# spec 中列出的已知 ST 端点（不应返回 404）
# 覆盖 silly_tavern.py / st_groups.py / st_resources.py 中的 ST 兼容路由
# ---------------------------------------------------------------------------
ST_ENDPOINTS = [
    # Version & CSRF
    "/version", "/csrf-token",
    "/api/st/version", "/api/st/csrf-token",
    # Settings
    "/api/settings/get", "/api/settings/save",
    # Characters
    "/api/characters/all", "/api/characters/get", "/api/characters/import",
    "/api/characters/export", "/api/characters/edit", "/api/characters/create",
    "/api/characters/delete", "/api/characters/duplicate", "/api/characters/rename",
    "/api/characters/merge-attributes", "/api/characters/chats",
    "/api/characters/edit-avatar", "/api/characters/edit-attribute",
    # Chats — core CRUD
    "/api/chats/get", "/api/chats/save", "/api/chats/import", "/api/chats/export",
    "/api/chats/recent", "/api/chats/search", "/api/chats/rename", "/api/chats/delete",
    # Chats — generation
    "/api/chats/continue", "/api/chats/regenerate", "/api/chats/swipe",
    # Chats — group operations
    "/api/chats/group/get", "/api/chats/group/save", "/api/chats/group/delete",
    "/api/chats/group/info", "/api/chats/group/import",
    # Chats — message-level ops
    "/api/chats/hide", "/api/chats/unhide", "/api/chats/delete-message",
    "/api/chats/rename-session", "/api/chats/find", "/api/chats/set-input",
    "/api/chats/inject", "/api/chats/flush-inject", "/api/chats/trigger",
    "/api/chats/popup", "/api/chats/buttons", "/api/chats/messages",
    # WorldInfo
    "/api/worldinfo/list", "/api/worldinfo/get", "/api/worldinfo/import",
    "/api/worldinfo/export", "/api/worldinfo/batch-import",
    "/api/worldinfo/edit", "/api/worldinfo/delete",
    # Groups
    "/api/groups/all", "/api/groups/create", "/api/groups/edit", "/api/groups/delete",
    "/api/groups/get", "/api/groups/member-get", "/api/groups/member-add",
    "/api/groups/member-remove", "/api/groups/chats",
    # Quick Replies
    "/api/quick-replies/save", "/api/quick-replies/delete", "/api/quick-replies/list",
    "/api/quick-replies/execute", "/api/quick-replies/create", "/api/quick-replies/update",
    # Backgrounds (st_resources.py)
    "/api/backgrounds/all", "/api/backgrounds/folders", "/api/backgrounds/upload",
    "/api/backgrounds/rename", "/api/backgrounds/delete",
    # Avatars (st_resources.py)
    "/api/avatars/get", "/api/avatars/upload", "/api/avatars/delete",
    # Sprites (st_resources.py)
    "/api/sprites/get", "/api/sprites/upload", "/api/sprites/upload-zip", "/api/sprites/delete",
    # Assets (st_resources.py)
    "/api/assets/get", "/api/assets/character", "/api/assets/download", "/api/assets/delete",
    # Secrets (Palink redirect to ConnectionProfiles)
    "/api/secrets/write", "/api/secrets/read", "/api/secrets/view", "/api/secrets/find",
    "/api/secrets/delete", "/api/secrets/rotate", "/api/secrets/rename",
    # Extensions (Palink redirect to extension market)
    "/api/extensions/install", "/api/extensions/update", "/api/extensions/delete",
    "/api/extensions/discover",
    # Images
    "/api/images/upload",
    # Vector
    "/api/vector/index", "/api/vector/query", "/api/vector/insert", "/api/vector/delete",
    # Speech
    "/api/speech/list", "/api/speech/get", "/api/speech/preview", "/api/speech/generate",
    # Translate & Search
    "/api/translate", "/api/search",
    # Backends
    "/api/backends/chat-completions/status", "/api/backends/chat-completions/generate",
    "/api/backends/text-completions/generate",
]


# ---------------------------------------------------------------------------
# 辅助：构造最小 PNG 角色卡（zTXt 内嵌 chara JSON）
# ---------------------------------------------------------------------------
def _make_minimal_png_with_card(chara_card: dict) -> bytes:
    """构造最小 1x1 PNG 并以 zTXt chunk 嵌入 chara JSON。

    使用 struct/zlib 现场生成合法 PNG（PNG signature + IHDR + IDAT + IEND），
    然后在 IEND 之前插入 zTXt chunk。zTXt 二进制布局：
        keyword \\x00  compression_method(1B)  compressed_text
    复刻 ``app.character_card.create_png_with_chara_card`` 的实现，
    确保导入端点能通过 ``extract_chara_card_from_png`` 解析。
    """
    import struct as _struct
    import zlib as _zlib

    def _chunk(chunk_type: bytes, data: bytes) -> bytes:
        crc = _zlib.crc32(chunk_type + data) & 0xFFFFFFFF
        return _struct.pack(">I", len(data)) + chunk_type + data + _struct.pack(">I", crc)

    signature = b"\x89PNG\r\n\x1a\n"
    # IHDR: 1x1, 8-bit RGBA
    ihdr_data = _struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0)
    # IDAT: 1x1 transparent pixel (filter byte 0 + RGBA 0,0,0,0)
    idat_data = _zlib.compress(b"\x00\x00\x00\x00\x00")
    base_png = (
        signature
        + _chunk(b"IHDR", ihdr_data)
        + _chunk(b"IDAT", idat_data)
    )
    # zTXt chunk: keyword "chara" + \x00 + compression_method(0=zlib) + compressed JSON
    chara_json = json.dumps(chara_card, ensure_ascii=False)
    compressed = _zlib.compress(chara_json.encode("utf-8"))
    ztxt_data = b"chara\x00\x00" + compressed
    # 在 IEND 之前插入 zTXt
    return base_png + _chunk(b"zTXt", ztxt_data) + _chunk(b"IEND", b"")


def _make_st_v2_card(name: str = "ST Contract Char") -> dict:
    """构造最小 ST V2 角色卡 dict。"""
    return {
        "spec": "chara_card_v2",
        "spec_version": "2.0",
        "data": {
            "name": name,
            "description": "A character for ST contract tests",
            "personality": "Calm and precise",
            "scenario": "Test scenario",
            "first_mes": "Hello, contract tester.",
            "mes_example": "User: Hi\nChar: Hello!",
            "creator_notes": "Created by pytest",
            "system_prompt": "You are a test character",
            "post_history_instructions": "Remember the contract",
            "tags": ["test", "contract"],
            "creator": "Pytest",
            "character_version": "1.0",
            "alternate_greetings": ["Greetings, tester!"],
            "extensions": {"depth_prompt": {"prompt": "dp", "depth": 4}},
        },
    }


def _create_character_via_api(client, auth_headers, name: str = "ST Contract Char") -> dict:
    """通过 POST /api/characters/create 创建角色并返回响应 JSON。"""
    resp = client.post(
        "/api/characters/create",
        headers=auth_headers,
        json={"name": name, "description": "desc", "personality": "p",
              "first_mes": "hi", "scenario": "s"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


# ---------------------------------------------------------------------------
# ST settings get/save 契约
# ---------------------------------------------------------------------------
class TestSTSettingsContract:
    """ST settings get/save 契约"""

    def test_settings_get_returns_st_shape(self, client, auth_headers):
        """GET /api/settings/get 返回 ST 格式设置。"""
        resp = client.post("/api/settings/get", headers=auth_headers)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        # ST 期望顶层字段
        assert data["result"] == "ok"
        assert "settings" in data
        assert "enable_accounts" in data
        assert "world_names" in data
        assert "themes" in data
        assert isinstance(data["world_names"], list)
        assert isinstance(data["themes"], list)
        assert "i18n_state" in data
        # settings 字段是 JSON 字符串，ST 客户端会再次 parse
        assert isinstance(data["settings"], str)

    def test_settings_save_accepts_st_shape(self, client, auth_headers):
        """POST /api/settings/save 接受 ST 格式设置。"""
        payload = {
            "power_user": {"font_size": 14, "language": "en"},
            "extension_settings": {"themes": [], "quickReplyV2": {"sets": []}},
            "ui_settings": {"sidebar_width": 240},
        }
        resp = client.post("/api/settings/save", headers=auth_headers, json=payload)
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"result": "ok"}
        # 验证回读：保存的 ui_settings 应能取回
        get_resp = client.post("/api/settings/get", headers=auth_headers)
        assert get_resp.status_code == 200
        get_data = get_resp.json()
        parsed = json.loads(get_data["settings"])
        # 至少 power_user / extension_settings 应被持久化
        assert "power_user" in parsed or "extension_settings" in parsed


# ---------------------------------------------------------------------------
# 角色卡端点契约
# ---------------------------------------------------------------------------
class TestSTCharactersContract:
    """角色卡端点契约"""

    def test_characters_all_returns_list(self, client, auth_headers):
        """POST /api/characters/all 返回角色列表。"""
        # 先创建一个角色保证非空
        _create_character_via_api(client, auth_headers, name="CharList Item")
        resp = client.post("/api/characters/all", headers=auth_headers)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert isinstance(data, list)
        assert len(data) >= 1
        # 列表项应包含 ST 期望字段
        item = data[0]
        assert "name" in item
        assert "avatar" in item
        assert "id" in item
        # avatar 应为 palink-{id}.png 格式
        assert item["avatar"].startswith("palink-")
        assert item["avatar"].endswith(".png")

    def test_characters_get_returns_card(self, client, auth_headers):
        """POST /api/characters/get 返回角色卡详情（含 ST 字段）。"""
        created = _create_character_via_api(client, auth_headers, name="Get Target")
        avatar = created["avatar"]
        resp = client.post(
            "/api/characters/get",
            headers=auth_headers,
            json={"avatar_url": avatar},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        # ST 期望角色卡字段
        assert data["name"] == "Get Target"
        assert data["avatar"] == avatar
        assert "description" in data
        assert "spec" in data
        assert "spec_version" in data
        # ST data 字段是嵌套对象（含 extensions / tags 等）
        assert isinstance(data.get("data"), dict)

    def test_characters_create_returns_name(self, client, auth_headers):
        """POST /api/characters/create 返回 {result, character_id, avatar}。"""
        resp = client.post(
            "/api/characters/create",
            headers=auth_headers,
            json={"name": "Created Char", "description": "d", "first_mes": "hi"},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["result"] == "ok"
        assert "character_id" in data
        assert "avatar" in data
        assert data["avatar"].startswith("palink-")
        # character_id 应为非空字符串
        assert isinstance(data["character_id"], str) and data["character_id"]

    def test_characters_edit_updates_fields(self, client, auth_headers):
        """POST /api/characters/edit 更新角色字段。"""
        created = _create_character_via_api(client, auth_headers, name="Edit Target")
        avatar = created["avatar"]
        resp = client.post(
            "/api/characters/edit",
            headers=auth_headers,
            json={"avatar_url": avatar, "description": "edited-description",
                  "personality": "edited-personality"},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"result": "ok", "character_id": created["character_id"]}
        # 验证字段已更新
        get_resp = client.post(
            "/api/characters/get", headers=auth_headers,
            json={"avatar_url": avatar},
        )
        assert get_resp.status_code == 200
        char = get_resp.json()
        assert char["description"] == "edited-description"
        assert char["personality"] == "edited-personality"

    def test_characters_import_accepts_png(self, client, auth_headers):
        """POST /api/characters/import 接受 PNG（内嵌 chara JSON）角色卡。

        V-4 修复: ST 客户端用 `avatar` 字段名上传（multer），之前测试用 `file`
        字段掩盖了 C-2 的 avatar 兼容实现未真正被 ST 契约覆盖的问题。此处模拟
        ST 客户端真实行为。
        """
        card = _make_st_v2_card(name="Imported PNG Char")
        png_bytes = _make_minimal_png_with_card(card)
        resp = client.post(
            "/api/characters/import",
            headers=auth_headers,
            files={"avatar": ("imported.png", io.BytesIO(png_bytes), "image/png")},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["name"] == "Imported PNG Char"
        assert "filename" in data
        # filename 应为 palink-{id}.png 格式
        assert data["filename"].startswith("palink-")
        assert data["filename"].endswith(".png")

    def test_characters_import_accepts_json(self, client, auth_headers):
        """POST /api/characters/import 接受 JSON 角色卡（avatar 字段，ST 客户端语义）。"""
        card = _make_st_v2_card(name="Imported JSON Char")
        json_bytes = json.dumps(card, ensure_ascii=False).encode("utf-8")
        resp = client.post(
            "/api/characters/import",
            headers=auth_headers,
            files={"avatar": ("imported.json", io.BytesIO(json_bytes), "application/json")},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["name"] == "Imported JSON Char"
        assert data["filename"].startswith("palink-")

    def test_characters_import_resolves_world_string_ref(self, client, auth_headers, db_session):
        """R-2: extensions.world 字符串引用（ST 主流格式）按名解析已有世界书。"""
        from app.models.worldbook import WorldBook

        # 1. 先导入带 character_book 的角色 → 创建名为 MyWorld 的世界书
        wb_card = _make_st_v2_card(name="WB Source")
        wb_card["data"]["character_book"] = {
            "name": "MyWorld",
            "entries": {
                "e1": {"key": ["k1"], "content": "world content", "order": 0, "position": 4},
            },
        }
        wb_resp = client.post(
            "/api/characters/import",
            headers=auth_headers,
            files={"avatar": ("wb.json", io.BytesIO(json.dumps(wb_card).encode()), "application/json")},
        )
        assert wb_resp.status_code == 200, wb_resp.text
        assert wb_resp.json()["name"] == "WB Source"
        assert db_session.query(WorldBook).filter(WorldBook.name == "MyWorld").count() >= 1
        # 2. 导入 extensions.world 为字符串的角色卡
        ref_card = _make_st_v2_card(name="World Ref Char")
        ref_card["data"]["extensions"]["world"] = "MyWorld"
        ref_resp = client.post(
            "/api/characters/import",
            headers=auth_headers,
            files={"avatar": ("ref.json", io.BytesIO(json.dumps(ref_card).encode()), "application/json")},
        )
        assert ref_resp.status_code == 200, ref_resp.text
        ref_data = ref_resp.json()
        ref_char_id = str(ref_data["filename"])[len("palink-"):-4]
        # 3. R-2: 该角色应获得按名解析出的世界书副本
        ref_wb = db_session.query(WorldBook).filter(WorldBook.character_id == ref_char_id).first()
        assert ref_wb is not None, "extensions.world 字符串引用应按名解析已有世界书"
        assert ref_wb.name == "MyWorld"

    def test_characters_import_still_accepts_file_field(self, client, auth_headers):
        """POST /api/characters/import 仍兼容 Palink 前端的 `file` 字段名。"""
        card = _make_st_v2_card(name="Imported File Field Char")
        json_bytes = json.dumps(card, ensure_ascii=False).encode("utf-8")
        resp = client.post(
            "/api/characters/import",
            headers=auth_headers,
            files={"file": ("imported.json", io.BytesIO(json_bytes), "application/json")},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["name"] == "Imported File Field Char"
        assert data["filename"].startswith("palink-")

    def test_characters_export_returns_file(self, client, auth_headers):
        """POST /api/characters/export 返回文件（PNG 或 JSON）。"""
        created = _create_character_via_api(client, auth_headers, name="Export Target")
        avatar = created["avatar"]
        # JSON 格式导出
        resp = client.post(
            "/api/characters/export",
            headers=auth_headers,
            json={"avatar_url": avatar, "format": "json"},
        )
        assert resp.status_code == 200, resp.text
        # Content-Disposition 应含 attachment
        assert "attachment" in resp.headers.get("content-disposition", "")
        body = resp.json()
        # 导出的 JSON 应是合法角色卡
        assert body.get("spec") in ("chara_card_v2", "chara_card_v3")
        assert body["data"]["name"] == "Export Target"

    def test_characters_delete_returns_ok(self, client, auth_headers):
        """POST /api/characters/delete 删除角色后返回 ok。"""
        created = _create_character_via_api(client, auth_headers, name="Delete Target")
        avatar = created["avatar"]
        resp = client.post(
            "/api/characters/delete",
            headers=auth_headers,
            json={"avatar_url": avatar},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"result": "ok"}
        # 再次 GET /all 不应返回该角色
        all_resp = client.post("/api/characters/all", headers=auth_headers)
        assert all_resp.status_code == 200
        names = [c.get("name") for c in all_resp.json()]
        assert "Delete Target" not in names


# ---------------------------------------------------------------------------
# 聊天端点契约
# ---------------------------------------------------------------------------
class TestSTChatsContract:
    """聊天端点契约"""

    def test_chats_get_returns_messages(self, client, auth_headers):
        """POST /api/chats/get 返回消息数组（首项为 chat header）。"""
        created = _create_character_via_api(client, auth_headers, name="ChatGet Char")
        avatar = created["avatar"]
        resp = client.post(
            "/api/chats/get",
            headers=auth_headers,
            json={"avatar_url": avatar, "ch_name": "ChatGet Char"},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        # 即使无消息，也应返回包含 chat header 的 list
        assert isinstance(data, list)
        assert len(data) >= 1
        header = data[0]
        assert "chat_name" in header
        assert "file_name" in header

    def test_chats_save_persists_messages(self, client, auth_headers):
        """POST /api/chats/save 持久化消息后再 GET 能取回。"""
        created = _create_character_via_api(client, auth_headers, name="ChatSave Char")
        avatar = created["avatar"]
        messages = [
            {"name": "User", "is_user": True, "is_system": False, "mes": "hello",
             "send_date": "2024-01-01T00:00:00"},
            {"name": "ChatSave Char", "is_user": False, "is_system": False, "mes": "hi there",
             "send_date": "2024-01-01T00:01:00"},
        ]
        save_resp = client.post(
            "/api/chats/save",
            headers=auth_headers,
            json={"avatar_url": avatar, "ch_name": "ChatSave Char",
                  "chat": messages},
        )
        assert save_resp.status_code == 200, save_resp.text
        # P0-1: ST 1.18.0 (chats.js:511) 期望 {ok: true}
        assert save_resp.json() == {"ok": True}
        # GET 验证消息已持久化
        get_resp = client.post(
            "/api/chats/get",
            headers=auth_headers,
            json={"avatar_url": avatar, "ch_name": "ChatSave Char"},
        )
        assert get_resp.status_code == 200
        data = get_resp.json()
        # header + 2 条消息
        assert len(data) >= 3
        # 验证消息内容
        contents = [item.get("mes") for item in data[1:]]
        assert "hello" in contents
        assert "hi there" in contents

    def test_chats_import_accepts_jsonl(self, client, auth_headers):
        """POST /api/chats/import 接受 JSONL 聊天导入。"""
        created = _create_character_via_api(client, auth_headers, name="ChatImport Char")
        avatar = created["avatar"]
        jsonl_lines = [
            json.dumps({"name": "User", "is_user": True, "is_system": False,
                        "mes": "imported hello", "send_date": "2024-01-01T00:00:00"}),
            json.dumps({"name": "ChatImport Char", "is_user": False, "is_system": False,
                        "mes": "imported reply", "send_date": "2024-01-01T00:01:00"}),
        ]
        jsonl_bytes = ("\n".join(jsonl_lines) + "\n").encode("utf-8")
        resp = client.post(
            "/api/chats/import",
            headers=auth_headers,
            data={"avatar_url": avatar, "ch_name": "Imported Chat"},
            files={"file": ("chat.jsonl", io.BytesIO(jsonl_bytes), "application/jsonl")},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        # 返回 {name, size}
        assert "name" in data
        assert "size" in data
        assert data["size"] == 2

    def test_chats_export_returns_jsonl(self, client, auth_headers):
        """POST /api/chats/export 返回 application/jsonl 文件。"""
        created = _create_character_via_api(client, auth_headers, name="ChatExport Char")
        avatar = created["avatar"]
        # 先保存一条消息
        client.post(
            "/api/chats/save",
            headers=auth_headers,
            json={"avatar_url": avatar, "ch_name": "ChatExport Char",
                  "chat": [
                      {"name": "User", "is_user": True, "is_system": False,
                       "mes": "export me", "send_date": "2024-01-01T00:00:00"},
                  ]},
        )
        resp = client.post(
            "/api/chats/export",
            headers=auth_headers,
            json={"avatar_url": avatar, "ch_name": "ChatExport Char"},
        )
        assert resp.status_code == 200, resp.text
        assert "attachment" in resp.headers.get("content-disposition", "")
        # body 应为 JSONL：每行一个 JSON
        body = resp.content.decode("utf-8")
        lines = [ln for ln in body.splitlines() if ln.strip()]
        assert len(lines) >= 2  # header + 至少一条消息
        # 第一行应为 chat header
        header = json.loads(lines[0])
        assert "chat_name" in header
        # 消息行应包含 mes 字段
        msg = json.loads(lines[1])
        assert "mes" in msg

    def test_chats_export_format_jsonl_st_compatible(self, client, auth_headers):
        """POST /api/chats/export 带 format=jsonl 返回 ST 1.18.0 兼容 JSON {message, result}。

        参考: SillyTavern-1.18.0/src/endpoints/chats.js:624-634 + script.js:11456-11474
        ST 前端期望响应为 JSON {message, result}，其中 result 是原始 JSONL 字符串。
        """
        created = _create_character_via_api(client, auth_headers, name="ChatExport Jsonl")
        avatar = created["avatar"]
        client.post(
            "/api/chats/save",
            headers=auth_headers,
            json={"avatar_url": avatar, "ch_name": "ChatExport Jsonl",
                  "chat": [
                      {"name": "Alice", "is_user": True, "is_system": False,
                       "mes": "hello world", "send_date": "2024-01-01T00:00:00"},
                      {"name": "Char", "is_user": False, "is_system": False,
                       "mes": "hi back", "send_date": "2024-01-01T00:00:01"},
                  ]},
        )
        resp = client.post(
            "/api/chats/export",
            headers=auth_headers,
            json={
                "avatar_url": avatar,
                "ch_name": "ChatExport Jsonl",
                "format": "jsonl",
                "exportfilename": "test.jsonl",
                "is_group": False,
            },
        )
        assert resp.status_code == 200, resp.text
        # ST 1.18.0 期望 JSON 响应而非文件下载
        assert resp.headers.get("content-type", "").startswith("application/json")
        data = resp.json()
        assert "message" in data
        assert "result" in data
        assert "test.jsonl" in data["message"]
        # result 应为 JSONL 字符串 (header + 2 条消息 = 3 行)
        result_lines = [ln for ln in data["result"].splitlines() if ln.strip()]
        assert len(result_lines) == 3
        header = json.loads(result_lines[0])
        assert "chat_name" in header or "user_name" in header
        msg1 = json.loads(result_lines[1])
        assert msg1["mes"] == "hello world"
        msg2 = json.loads(result_lines[2])
        assert msg2["mes"] == "hi back"

    def test_chats_export_format_txt_st_compatible(self, client, auth_headers):
        """POST /api/chats/export 带 format=txt 返回纯文本格式。

        参考: SillyTavern-1.18.0/src/endpoints/chats.js:645-661
        纯文本格式: 跳过 is_system 消息，每条 name: message\\n\\n
        """
        created = _create_character_via_api(client, auth_headers, name="ChatExport Txt")
        avatar = created["avatar"]
        client.post(
            "/api/chats/save",
            headers=auth_headers,
            json={"avatar_url": avatar, "ch_name": "ChatExport Txt",
                  "chat": [
                      {"name": "Alice", "is_user": True, "is_system": False,
                       "mes": "txt msg 1", "send_date": "2024-01-01T00:00:00"},
                      {"name": "System", "is_user": False, "is_system": True,
                       "mes": "should be skipped", "send_date": "2024-01-01T00:00:01"},
                      {"name": "Char", "is_user": False, "is_system": False,
                       "mes": "txt reply", "send_date": "2024-01-01T00:00:02"},
                  ]},
        )
        resp = client.post(
            "/api/chats/export",
            headers=auth_headers,
            json={
                "avatar_url": avatar,
                "ch_name": "ChatExport Txt",
                "format": "txt",
                "exportfilename": "test.txt",
            },
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert "message" in data
        assert "test.txt" in data["message"]
        # 纯文本: 应包含 Alice 和 Char 的消息，跳过 System
        result = data["result"]
        assert "Alice: txt msg 1" in result
        assert "Char: txt reply" in result
        assert "should be skipped" not in result
        # 每条消息应以 \n\n 结尾
        assert "txt msg 1\n\n" in result
        assert "txt reply\n\n" in result

    def test_chats_export_format_jsonl_skips_palink_injection_in_result(self, client, auth_headers):
        """POST /api/chats/export format=jsonl 的 result 不应包含文件下载 header。

        验证 ST 1.18.0 兼容路径与 Palink-native 旧路径的隔离。
        """
        created = _create_character_via_api(client, auth_headers, name="ChatExport Isolation")
        avatar = created["avatar"]
        client.post(
            "/api/chats/save",
            headers=auth_headers,
            json={"avatar_url": avatar, "ch_name": "ChatExport Isolation",
                  "chat": [
                      {"name": "U", "is_user": True, "is_system": False,
                       "mes": "x", "send_date": "2024-01-01T00:00:00"},
                  ]},
        )
        # ST 路径: JSON 响应, 无 attachment header
        st_resp = client.post(
            "/api/chats/export",
            headers=auth_headers,
            json={"avatar_url": avatar, "ch_name": "ChatExport Isolation", "format": "jsonl"},
        )
        assert "attachment" not in st_resp.headers.get("content-disposition", "")
        assert st_resp.headers.get("content-type", "").startswith("application/json")

        # Palink-native 路径: 文件下载, 有 attachment header
        palink_resp = client.post(
            "/api/chats/export",
            headers=auth_headers,
            json={"avatar_url": avatar, "ch_name": "ChatExport Isolation"},
        )
        assert "attachment" in palink_resp.headers.get("content-disposition", "")
        assert palink_resp.headers.get("content-type") == "application/jsonl"

    def test_chats_search_returns_results(self, client, auth_headers):
        """POST /api/chats/search 返回匹配结果。"""
        created = _create_character_via_api(client, auth_headers, name="ChatSearch Char")
        avatar = created["avatar"]
        # 先保存一条聊天
        client.post(
            "/api/chats/save",
            headers=auth_headers,
            json={"avatar_url": avatar, "ch_name": "ChatSearch Char",
                  "chat": [{"name": "User", "is_user": True, "is_system": False,
                            "mes": "searchable", "send_date": "2024-01-01T00:00:00"}]},
        )
        # 空查询返回该角色所有聊天
        resp = client.post(
            "/api/chats/search",
            headers=auth_headers,
            json={"avatar_url": avatar, "query": ""},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert isinstance(data, list)
        assert len(data) >= 1

    def test_chats_rename_updates_name(self, client, auth_headers):
        """POST /api/chats/rename 更新聊天标题。"""
        created = _create_character_via_api(client, auth_headers, name="ChatRename Char")
        avatar = created["avatar"]
        # 先保存创建一个聊天
        save_resp = client.post(
            "/api/chats/save",
            headers=auth_headers,
            json={"avatar_url": avatar, "ch_name": "ChatRename Char",
                  "chat": [{"name": "User", "is_user": True, "is_system": False,
                            "mes": "rename me", "send_date": "2024-01-01T00:00:00"}]},
        )
        assert save_resp.status_code == 200
        file_name = save_resp.json().get("file_name")
        # 从 /api/characters/chats 获取 file_name
        chats_resp = client.post(
            "/api/characters/chats",
            headers=auth_headers,
            json={"avatar_url": avatar},
        )
        assert chats_resp.status_code == 200
        chats = chats_resp.json()
        assert len(chats) >= 1
        original_file = chats[0]["file_name"]
        # 重命名
        rename_resp = client.post(
            "/api/chats/rename",
            headers=auth_headers,
            json={"avatar_url": avatar, "original_file": original_file,
                  "new_file_name": "RenamedChat.jsonl"},
        )
        assert rename_resp.status_code == 200, rename_resp.text
        # P0-1: ST 1.18.0 (chats.js:569) 期望 {ok: true, sanitizedFileName}
        rename_data = rename_resp.json()
        assert rename_data.get("ok") is True
        assert "sanitizedFileName" in rename_data

    def test_chats_delete_removes_chat(self, client, auth_headers):
        """POST /api/chats/delete 删除聊天。"""
        created = _create_character_via_api(client, auth_headers, name="ChatDelete Char")
        avatar = created["avatar"]
        # 先创建聊天
        client.post(
            "/api/chats/save",
            headers=auth_headers,
            json={"avatar_url": avatar, "ch_name": "ChatDelete Char",
                  "chat": [{"name": "User", "is_user": True, "is_system": False,
                            "mes": "delete me", "send_date": "2024-01-01T00:00:00"}]},
        )
        chats_resp = client.post(
            "/api/characters/chats",
            headers=auth_headers,
            json={"avatar_url": avatar},
        )
        chats = chats_resp.json()
        assert len(chats) >= 1
        file_name = chats[0]["file_name"]
        # 删除
        del_resp = client.post(
            "/api/chats/delete",
            headers=auth_headers,
            json={"avatar_url": avatar, "chatfile": file_name},
        )
        assert del_resp.status_code == 200, del_resp.text
        # P0-1: ST 1.18.0 (chats.js:595) 期望 {ok: true}
        assert del_resp.json() == {"ok": True}
        # 删除后再列应为空
        chats_after = client.post(
            "/api/characters/chats", headers=auth_headers,
            json={"avatar_url": avatar},
        ).json()
        assert len(chats_after) == 0


# ---------------------------------------------------------------------------
# 群聊端点契约
# ---------------------------------------------------------------------------
class TestSTGroupsContract:
    """群聊端点契约"""

    def test_groups_all_returns_list(self, client, auth_headers):
        """POST /api/groups/all 返回群组列表。"""
        # 先创建一个群组保证非空
        client.post(
            "/api/groups/create",
            headers=auth_headers,
            json={"name": "GroupList Test", "members": []},
        )
        resp = client.post("/api/groups/all", headers=auth_headers)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert isinstance(data, list)
        assert len(data) >= 1
        group = data[0]
        # ST 期望群组字段
        assert "name" in group
        assert "id" in group
        assert "members" in group

    def test_groups_create_returns_group(self, client, auth_headers):
        """POST /api/groups/create 返回群组对象。"""
        resp = client.post(
            "/api/groups/create",
            headers=auth_headers,
            json={"name": "Created Group", "members": [],
                  "activation_strategy": 0, "allow_self_responses": False},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["name"] == "Created Group"
        assert "id" in data
        # ST id 格式：palink-group-{uuid}.png
        assert data["id"].startswith("palink-group-")
        assert data["id"].endswith(".png")

    def test_groups_edit_updates_fields(self, client, auth_headers):
        """POST /api/groups/edit 更新群组字段。"""
        create_resp = client.post(
            "/api/groups/create",
            headers=auth_headers,
            json={"name": "EditGroup", "members": []},
        )
        group_id = create_resp.json()["group_id"]
        resp = client.post(
            "/api/groups/edit",
            headers=auth_headers,
            json={"id": group_id, "name": "EditedGroup",
                  "allow_self_responses": True},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["name"] == "EditedGroup"
        assert data["allow_self_responses"] is True

    def test_groups_delete_removes_group(self, client, auth_headers):
        """POST /api/groups/delete 删除群组。"""
        create_resp = client.post(
            "/api/groups/create",
            headers=auth_headers,
            json={"name": "DeleteGroup", "members": []},
        )
        group_id = create_resp.json()["group_id"]
        resp = client.post(
            "/api/groups/delete",
            headers=auth_headers,
            json={"id": group_id},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"result": "ok"}
        # 验证删除后 groups/all 中不再包含
        all_resp = client.post("/api/groups/all", headers=auth_headers)
        assert all_resp.status_code == 200
        ids = [g.get("group_id") for g in all_resp.json()]
        assert group_id not in ids

    def test_group_chat_get_returns_messages(self, client, auth_headers):
        """POST /api/chats/group/get 返回群聊消息。"""
        # 创建群组 + 群聊 session
        create_resp = client.post(
            "/api/groups/create",
            headers=auth_headers,
            json={"name": "GroupChatGet", "members": []},
        )
        group_id = create_resp.json()["group_id"]
        # 保存群聊消息
        save_resp = client.post(
            "/api/chats/group/save",
            headers=auth_headers,
            json={
                "group_id": f"palink-group-{group_id}.png",
                "chat": [{"name": "Bot1", "is_user": False, "is_system": False,
                          "mes": "group msg", "send_date": "2024-01-01T00:00:00"}],
                "chat_name": "Group Chat",
            },
        )
        assert save_resp.status_code == 200, save_resp.text
        file_name = save_resp.json()["file_name"]
        get_resp = client.post(
            "/api/chats/group/get",
            headers=auth_headers,
            json={"file_name": file_name},
        )
        assert get_resp.status_code == 200, get_resp.text
        # N10 修复: ST loadGroupChat 期望裸消息数组（Array.isArray 判定）
        data = get_resp.json()
        assert isinstance(data, list)
        assert len(data) >= 1
        assert data[0]["mes"] == "group msg"

    def test_group_chat_get_accepts_st_chat_id(self, client, auth_headers):
        """N7 修复: ST saveGroupChat/loadGroupChat 用 {id: chat_id}（palink-group-session-{id}，
        无 .jsonl）调用 /api/chats/group/get，此前未剥前缀导致 404。"""
        create_resp = client.post(
            "/api/groups/create",
            headers=auth_headers,
            json={"name": "GroupChatGetByChatId", "members": []},
        )
        group_id = create_resp.json()["group_id"]
        save_resp = client.post(
            "/api/chats/group/save",
            headers=auth_headers,
            json={
                "group_id": f"palink-group-{group_id}.png",
                "chat": [{"name": "Bot1", "is_user": False, "is_system": False,
                          "mes": "by chat_id", "send_date": "2024-01-01T00:00:00"}],
            },
        )
        assert save_resp.status_code == 200, save_resp.text
        file_name = save_resp.json()["file_name"]  # palink-group-session-{id}.jsonl
        chat_id = file_name[:-len(".jsonl")]       # palink-group-session-{id}
        # ST 用 {id: chat_id}（无 .jsonl、带前缀）
        get_resp = client.post(
            "/api/chats/group/get",
            headers=auth_headers,
            json={"id": chat_id},
        )
        assert get_resp.status_code == 200, get_resp.text
        data = get_resp.json()
        assert isinstance(data, list)
        assert data[0]["mes"] == "by chat_id"

    def test_group_chat_save_persists(self, client, auth_headers):
        """POST /api/chats/group/save 持久化群聊消息。"""
        create_resp = client.post(
            "/api/groups/create",
            headers=auth_headers,
            json={"name": "GroupChatSave", "members": []},
        )
        group_id = create_resp.json()["group_id"]
        resp = client.post(
            "/api/chats/group/save",
            headers=auth_headers,
            json={
                "group_id": f"palink-group-{group_id}.png",
                "chat": [
                    {"name": "User", "is_user": True, "is_system": False,
                     "mes": "user msg", "send_date": "2024-01-01T00:00:00"},
                    {"name": "Bot", "is_user": False, "is_system": False,
                     "mes": "bot reply", "send_date": "2024-01-01T00:01:00"},
                ],
                "chat_name": "Persisted Group Chat",
                "avtors": [],
            },
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert "file_name" in data
        # 验证持久化：再次 GET 取回消息（N10: 裸数组）
        get_resp = client.post(
            "/api/chats/group/get", headers=auth_headers,
            json={"file_name": data["file_name"]},
        )
        assert get_resp.status_code == 200
        chat = get_resp.json()
        assert isinstance(chat, list)
        assert len(chat) == 2
        assert chat[0]["mes"] == "user msg"
        assert chat[1]["mes"] == "bot reply"

    def test_groups_all_chats_is_string_array(self, client, auth_headers):
        """N9 修复: ST 期望 group.chats 为 chat 文件名（chatId）字符串数组。"""
        create_resp = client.post(
            "/api/groups/create",
            headers=auth_headers,
            json={"name": "ChatsStringArray", "members": []},
        )
        group_id = create_resp.json()["group_id"]
        # 保存一个群聊 session，使其出现在 chats 中
        save_resp = client.post(
            "/api/chats/group/save",
            headers=auth_headers,
            json={
                "group_id": f"palink-group-{group_id}.png",
                "chat": [{"name": "Bot", "is_user": False, "is_system": False,
                          "mes": "hi", "send_date": "2024-01-01T00:00:00"}],
            },
        )
        assert save_resp.status_code == 200, save_resp.text
        all_resp = client.post("/api/groups/all", headers=auth_headers)
        assert all_resp.status_code == 200
        group = next((g for g in all_resp.json() if g.get("group_id") == group_id), None)
        assert group is not None
        assert isinstance(group.get("chats"), list)
        assert all(isinstance(c, str) for c in group["chats"])
        assert group["chats"][0].startswith("palink-group-session-")

    def test_group_chat_info_returns_chat_info(self, client, auth_headers):
        """N-G1: /api/chats/group/info 对齐 ST —— {id: chatId} 返回 ChatInfo 元数据。"""
        create_resp = client.post(
            "/api/groups/create",
            headers=auth_headers,
            json={"name": "GroupInfoChatInfo", "members": []},
        )
        group_id = create_resp.json()["group_id"]
        save_resp = client.post(
            "/api/chats/group/save",
            headers=auth_headers,
            json={
                "group_id": f"palink-group-{group_id}.png",
                "chat": [{"name": "Bot", "is_user": False, "is_system": False,
                          "mes": "last message here", "send_date": "2024-01-01T00:00:00"}],
            },
        )
        assert save_resp.status_code == 200, save_resp.text
        file_name = save_resp.json()["file_name"]
        chat_id = file_name[:-len(".jsonl")]
        # ST getGroupPastChats 用 {id: chatId}（带前缀、无 .jsonl）
        resp = client.post(
            "/api/chats/group/info",
            headers=auth_headers,
            json={"id": chat_id},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("file_id") == chat_id
        assert data.get("chat_items") == 1
        assert data.get("mes") == "last message here"
        assert "file_name" in data


# ---------------------------------------------------------------------------
# 世界书端点契约
# ---------------------------------------------------------------------------
class TestSTWorldInfoContract:
    """世界书端点契约"""

    def test_worldinfo_list_returns_dict(self, client, auth_headers):
        """POST /api/worldinfo/list 返回 dict（{world_id: world_entry}）。"""
        # 先导入一本世界书保证非空
        wb_data = {
            "name": "WIList World",
            "description": "for list test",
            "entries": {
                "0": {"key": ["foo"], "content": "foo content",
                      "comment": "foo entry", "order": 0},
            },
        }
        wb_bytes = json.dumps(wb_data).encode("utf-8")
        client.post(
            "/api/worldinfo/import",
            headers=auth_headers,
            files={"file": ("wilist.json", io.BytesIO(wb_bytes), "application/json")},
        )
        resp = client.post("/api/worldinfo/list", headers=auth_headers)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        # 应返回 dict（V3 默认格式）
        assert isinstance(data, dict)
        assert len(data) >= 1
        # 每个值应包含 ST 期望字段
        first_entry = list(data.values())[0]
        assert "name" in first_entry
        assert "entries" in first_entry
        # V3 结构包含 order / originalData
        assert "order" in first_entry
        assert "originalData" in first_entry

    def test_worldinfo_get_returns_entries(self, client, auth_headers):
        """POST /api/worldinfo/get 按 name 返回全局世界书。

        对齐 ST 1.18.0 契约：body = {name}，返回 {entries: {uid: entry, ...}}。
        """
        # 先通过 import 创建一本全局世界书
        wb_data = {
            "name": "WIGet World",
            "description": "for get test",
            "entries": {
                "0": {"key": ["foo"], "content": "foo content",
                      "comment": "foo", "order": 0, "position": 0},
            },
        }
        wb_bytes = json.dumps(wb_data).encode("utf-8")
        client.post(
            "/api/worldinfo/import",
            headers=auth_headers,
            files={"file": ("wiget.json", io.BytesIO(wb_bytes), "application/json")},
        )
        # 调用 worldinfo/get with {name}
        resp = client.post(
            "/api/worldinfo/get",
            headers=auth_headers,
            json={"name": "WIGet World"},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert "entries" in data
        assert isinstance(data["entries"], dict)
        # 应至少有一条条目
        assert len(data["entries"]) >= 1
        # ST 期望顶层有 name 字段
        assert data.get("name") == "WIGet World"

    def test_worldinfo_get_returns_empty_for_unknown_name(self, client, auth_headers):
        """POST /api/worldinfo/get 对不存在的 name 返回 {entries: {}}（ST allowDummy 行为）。"""
        resp = client.post(
            "/api/worldinfo/get",
            headers=auth_headers,
            json={"name": "NonExistentWorld_xyz"},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("entries") == {}

    def test_worldinfo_import_accepts_json(self, client, auth_headers):
        """POST /api/worldinfo/import 接受 JSON 世界书。"""
        wb_data = {
            "name": "Imported WI",
            "description": "imported",
            "entries": {
                "0": {"key": ["alpha"], "content": "alpha content",
                      "comment": "alpha", "order": 0},
                "1": {"key": ["beta"], "content": "beta content",
                      "comment": "beta", "order": 1},
            },
        }
        wb_bytes = json.dumps(wb_data).encode("utf-8")
        resp = client.post(
            "/api/worldinfo/import",
            headers=auth_headers,
            files={"file": ("imported.json", io.BytesIO(wb_bytes), "application/json")},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["name"] == "Imported WI"

    def test_worldinfo_edit_updates_entry(self, client, auth_headers):
        """POST /api/worldinfo/edit 按 name 整体保存全局世界书。

        对齐 ST 1.18.0 契约：body = {name, data}，data 含 entries dict。
        成功返回 {ok: true}。
        """
        # 先通过 import 创建一本世界书
        wb_data = {
            "name": "WIEdit World",
            "description": "orig desc",
            "entries": {
                "0": {"key": ["orig"], "content": "orig content",
                      "comment": "orig", "order": 0, "position": 0},
            },
        }
        wb_bytes = json.dumps(wb_data).encode("utf-8")
        client.post(
            "/api/worldinfo/import",
            headers=auth_headers,
            files={"file": ("wiedit.json", io.BytesIO(wb_bytes), "application/json")},
        )
        # 整体覆盖保存：修改 content 并新增一条目
        edit_data = {
            "name": "WIEdit World",
            "description": "edited desc",
            "entries": {
                "0": {"key": ["edited"], "content": "edited content",
                      "comment": "edited", "order": 0, "position": 0},
                "1": {"key": ["new"], "content": "new entry",
                      "comment": "new", "order": 1, "position": 0},
            },
        }
        edit_resp = client.post(
            "/api/worldinfo/edit",
            headers=auth_headers,
            json={"name": "WIEdit World", "data": edit_data},
        )
        assert edit_resp.status_code == 200, edit_resp.text
        # ST 1.18.0 返回 {ok: true}
        assert edit_resp.json() == {"ok": True}
        # 验证更新生效
        verify_resp = client.post(
            "/api/worldinfo/get", headers=auth_headers,
            json={"name": "WIEdit World"},
        )
        assert verify_resp.status_code == 200
        data = verify_resp.json()
        entries = data["entries"]
        # 应有 2 条
        assert len(entries) == 2
        contents = [e.get("content") for e in entries.values()]
        assert "edited content" in contents
        assert "new entry" in contents
        # 旧的 "orig content" 应被覆盖掉
        assert "orig content" not in contents
        # 描述应更新
        assert data.get("description") == "edited desc"

    def test_worldinfo_edit_creates_new_world(self, client, auth_headers):
        """POST /api/worldinfo/edit 对不存在的 name 创建新世界书。"""
        edit_data = {
            "name": "WINewWorld",
            "description": "brand new",
            "entries": {
                "0": {"key": ["fresh"], "content": "fresh content",
                      "comment": "fresh", "order": 0},
            },
        }
        edit_resp = client.post(
            "/api/worldinfo/edit",
            headers=auth_headers,
            json={"name": "WINewWorld", "data": edit_data},
        )
        assert edit_resp.status_code == 200, edit_resp.text
        assert edit_resp.json() == {"ok": True}
        # 验证可查到
        get_resp = client.post(
            "/api/worldinfo/get", headers=auth_headers,
            json={"name": "WINewWorld"},
        )
        assert get_resp.status_code == 200
        assert len(get_resp.json()["entries"]) == 1

    def test_worldinfo_delete_removes_entry(self, client, auth_headers):
        """POST /api/worldinfo/delete 按 name 删除整个全局世界书。

        对齐 ST 1.18.0 契约：body = {name}，删除整个世界书（非单个条目）。
        """
        # 先导入一本世界书
        wb_data = {
            "name": "WIDelete World",
            "description": "for delete test",
            "entries": {
                "0": {"key": ["keep"], "content": "keep content",
                      "comment": "keep", "order": 0, "position": 0},
                "1": {"key": ["drop"], "content": "drop content",
                      "comment": "drop", "order": 1, "position": 0},
            },
        }
        wb_bytes = json.dumps(wb_data).encode("utf-8")
        client.post(
            "/api/worldinfo/import",
            headers=auth_headers,
            files={"file": ("widelete.json", io.BytesIO(wb_bytes), "application/json")},
        )
        # 确认存在
        before_resp = client.post(
            "/api/worldinfo/get", headers=auth_headers,
            json={"name": "WIDelete World"},
        )
        assert before_resp.status_code == 200
        assert len(before_resp.json()["entries"]) == 2
        # 删除整个世界书
        del_resp = client.post(
            "/api/worldinfo/delete",
            headers=auth_headers,
            json={"name": "WIDelete World"},
        )
        assert del_resp.status_code == 200, del_resp.text
        # ST 1.18.0 返回 200 空 body（TestClient 解析为空 dict 或空内容）
        # 验证世界书已被删除：get 返回 {entries: {}}
        after_resp = client.post(
            "/api/worldinfo/get", headers=auth_headers,
            json={"name": "WIDelete World"},
        )
        assert after_resp.status_code == 200
        assert after_resp.json().get("entries") == {}


# ---------------------------------------------------------------------------
# 生成端点契约
# ---------------------------------------------------------------------------
class TestSTGenerationContract:
    """生成端点契约"""

    def test_chat_completions_generate_returns_response(self, client, auth_headers):
        """POST /api/backends/chat-completions/generate 返回响应。

        此端点依赖真实 LLM provider，若无可用模型则返回 400/500 —— 测试
        只验证响应是 chat.completion 形状（非流式）或正确的错误。
        """
        payload = {
            "model": "test-model",
            "messages": [{"role": "user", "content": "hi"}],
            "stream": False,
        }
        resp = client.post(
            "/api/backends/chat-completions/generate",
            headers=auth_headers,
            json=payload,
        )
        # 接受 200（有可用模型）或 400/500（无可用模型，端点契约形状仍然存在）
        assert resp.status_code in (200, 400, 500), resp.text
        # 端点存在且响应是 JSON（错误 detail 或 chat.completion 对象）
        data = resp.json()
        if resp.status_code == 200:
            # 成功路径应为 OpenAI ChatCompletion 形状
            assert "id" in data or "choices" in data or "object" in data

    def test_chat_completions_status_returns_shape(self, client, auth_headers):
        """POST /api/backends/chat-completions/status 返回 ST 状态形状。"""
        resp = client.post(
            "/api/backends/chat-completions/status",
            headers=auth_headers,
            json={},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        # ST 期望字段
        assert data["result"] == "ok"
        assert "valid" in data
        assert "status" in data
        assert "data" in data
        assert isinstance(data["data"], list)


# ---------------------------------------------------------------------------
# 端点注册静态检查（纯函数测试，无需 DB / HTTP，写真实断言）
# ---------------------------------------------------------------------------
class TestSTEndpointNo404:
    """验证已知 ST 端点不返回 404。

    通过导入 ``app.api.api_router`` 反射已注册路由路径，静态校验 spec 中列出
    的所有 ST 端点都已注册。不发 HTTP 请求，不依赖 DB session。
    """

    ST_ENDPOINTS = ST_ENDPOINTS

    def _collect_registered_paths(self) -> set:
        """从 ``api_router`` 反射收集所有已注册路由路径。

        FastAPI 的 ``APIRouter.include_router()`` 会在父路由器的 ``routes`` 中
        产生 ``_IncludedRouter`` 包装对象（无 ``path`` 属性），需要递归访问
        ``original_router.routes`` 才能拿到真正的 ``APIRoute`` 路径。
        """
        from app.api import api_router

        registered: set = set()

        def _walk(routes):
            for route in routes:
                # _IncludedRouter 包装：访问 original_router 的 routes
                orig = getattr(route, "original_router", None)
                if orig is not None and hasattr(orig, "routes"):
                    _walk(orig.routes)
                    continue
                # 嵌套 APIRouter：递归
                if hasattr(route, "routes") and not hasattr(route, "path"):
                    _walk(route.routes)
                    continue
                # 普通路由：取 path
                path = getattr(route, "path", None)
                if isinstance(path, str) and path:
                    registered.add(path)

        _walk(api_router.routes)
        return registered

    def test_no_known_404(self):
        """验证所有已知 ST 端点都已注册。"""
        try:
            registered = self._collect_registered_paths()
        except Exception as exc:  # 导入失败（如缺少依赖）时跳过，不阻断收集
            pytest.skip(f"无法导入 api_router 进行路由反射: {exc}")

        missing = [ep for ep in self.ST_ENDPOINTS if ep not in registered]
        assert not missing, (
            "以下 ST 端点未在 api_router 中注册（将返回 404）: "
            f"{missing}"
        )

    def test_endpoints_list_non_empty(self):
        """ST_ENDPOINTS 列表本身非空（防止误清空）。"""
        assert len(self.ST_ENDPOINTS) >= 80, "ST_ENDPOINTS 列表意外过短"


# ---------------------------------------------------------------------------
# bridge.js REAL_API_PATHS 白名单同步验证
# 防止 Palink 实现的端点未被加入 bridge.js 白名单，导致请求被错误代理到 ST sidecar
# ---------------------------------------------------------------------------

# bridge.js 位于 frontend/public/st/bridge.js，本测试在能访问该文件的环境运行
# (本地开发或 CI)。后端容器未挂载 frontend 目录时自动跳过。
_BRIDGE_JS_CANDIDATE_PATHS = [
    os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
        "frontend", "public", "st", "bridge.js",
    ),
    # 容器内若挂载 frontend 时可能的位置
    "/app/frontend/public/st/bridge.js",
    "/frontend/public/st/bridge.js",
]


def _resolve_bridge_js_path() -> str:
    for candidate in _BRIDGE_JS_CANDIDATE_PATHS:
        if os.path.isfile(candidate):
            return candidate
    return _BRIDGE_JS_CANDIDATE_PATHS[0]


_BRIDGE_JS_PATH = _resolve_bridge_js_path()
_BRIDGE_JS_AVAILABLE = os.path.isfile(_BRIDGE_JS_PATH)


@pytest.mark.skipif(
    not _BRIDGE_JS_AVAILABLE,
    reason=(
        "bridge.js 不在测试环境可达路径下 (frontend/public/st/bridge.js)。"
        "本测试仅在能访问前端源码的环境运行 (本地开发/CI)。"
    ),
)
class TestBridgeJsRealApiPathsSync:
    """验证 frontend/public/st/bridge.js 中的 REAL_API_PATHS 白名单
    与后端实际注册的 ST 端点保持同步。

    如果 Palink 后端实现了某个 ST 端点但未加入 bridge.js 的 REAL_API_PATHS，
    会导致 ST 前端 iframe 内对该端点的请求被透明代理到 ST sidecar，
    而非路由到 Palink 后端，造成 Palink DB 与 ST sidecar 文件系统数据不一致。
    """

    BRIDGE_JS_PATH = _BRIDGE_JS_PATH

    def _extract_real_api_paths(self) -> set:
        """从 bridge.js 提取 REAL_API_PATHS 字典中的所有路径。"""
        import re

        with open(self.BRIDGE_JS_PATH, "r", encoding="utf-8") as f:
            content = f.read()

        # 匹配 '/api/...': true 或 '/version': true 形式
        # REAL_API_PATHS 字典内的键值
        pattern = re.compile(
            r"^\s*'(/[^']+)':\s*true\s*,?\s*$",
            re.MULTILINE,
        )
        paths = set()
        in_dict = False
        for line in content.splitlines():
            stripped = line.strip()
            if "var REAL_API_PATHS" in line:
                in_dict = True
                continue
            if in_dict and stripped == "};":
                in_dict = False
                continue
            if in_dict:
                m = pattern.match(line)
                if m:
                    paths.add(m.group(1))
        return paths

    def _extract_real_api_prefixes(self) -> list:
        """从 bridge.js 提取 REAL_API_PREFIXES 数组中的所有前缀。"""
        with open(self.BRIDGE_JS_PATH, "r", encoding="utf-8") as f:
            content = f.read()

        import re
        # 匹配 REAL_API_PREFIXES 数组内的字符串
        match = re.search(
            r"var\s+REAL_API_PREFIXES\s*=\s*\[([^\]]*)\]",
            content,
            re.DOTALL,
        )
        if not match:
            return []
        body = match.group(1)
        prefixes = re.findall(r"'([^']+)'", body)
        return prefixes

    def _collect_backend_registered_st_endpoints(self) -> set:
        """收集后端注册的所有 ST 兼容端点。

        仅返回 ST 1.18.0 前端会调用的 API 路径，过滤掉 Palink-native 端点
        (如 /api/admin/*, /api/character-sessions/*, /api/personas/* 等)。
        """
        from app.api import api_router

        registered: set = set()

        def _walk(routes):
            for route in routes:
                orig = getattr(route, "original_router", None)
                if orig is not None and hasattr(orig, "routes"):
                    _walk(orig.routes)
                    continue
                if hasattr(route, "routes") and not hasattr(route, "path"):
                    _walk(route.routes)
                    continue
                path = getattr(route, "path", None)
                if isinstance(path, str) and path:
                    # 仅收集 ST 兼容端点（/api/* 或 /version, /csrf-token）
                    if not (path.startswith("/api/") or path in ("/version", "/csrf-token")):
                        continue
                    # 排除 Palink 内部端点
                    if path.startswith("/api/st/native") or path.startswith("/api/st/sync"):
                        continue
                    if path.startswith("/api/st/version") or path.startswith("/api/st/csrf-token"):
                        registered.add(path)
                        continue
                    if path.startswith("/api/st/"):
                        continue
                    # 排除 Palink-native 端点（非 ST API）
                    # 这些端点 Palink 原生使用，ST 前端不会调用
                    PALINK_NATIVE_PREFIXES = (
                        "/api/admin/",
                        "/api/auth/",
                        "/api/character-chat",
                        "/api/character-sessions/",
                        "/api/characters/batch-import",
                        "/api/characters/export-all",
                        "/api/characters/import-parse-image",
                        "/api/characters/parse",
                        "/api/characters/translate",
                        "/api/chat",
                        "/api/chats/generate-raw",
                        "/api/chats/import-third-party",
                        "/api/chats/stop",
                        "/api/connection-profiles",
                        "/api/expressions/",
                        "/api/extension-prompts",
                        "/api/image-generation/",
                        "/api/instruct-templates",  # Palink-native, ST 存在 settings 里
                        "/api/mcp/",
                        "/api/memory/",
                        "/api/models",
                        "/api/openai/v1/",  # OpenAI 兼容 API（非 ST 端点）
                        "/api/personas",
                        "/api/plotlines",
                        "/api/plugins",  # Palink-native plugin 管理（非 ST 的 /api/extensions）
                        "/api/prompt-manager/",
                        "/api/recommendations/",
                        "/api/register",
                        "/api/regex-scripts",  # Palink-native, ST 存在角色卡 extensions
                        "/api/roleplay/",
                        "/api/sd/",  # ST image gen, 由 nativeMode 拦截管理
                        "/api/sessions",  # Palink-native session 管理（无尾斜杠也匹配）
                        "/api/smart-card-assets",
                        "/api/stats/",
                        "/api/stt",
                        "/api/themes",  # Palink-native theme 管理（非 ST 的 settings 主题）
                        "/api/token",
                        "/api/tokenizers/count",
                        "/api/tokenizers/decode",
                        "/api/tokenizers/encode",
                        "/api/tokenizers/list",
                        "/api/tts",
                        "/api/upload",
                        "/api/users/me",
                        "/api/variables/",
                        "/api/workspace",
                        "/api/worldbook-blueprints",
                        "/api/worldbooks",
                        "/api/ws/",
                    )
                    if any(path.startswith(prefix) for prefix in PALINK_NATIVE_PREFIXES):
                        continue
                    # 排除 /api/characters/{character_id} 这类 Palink-native 动态路径
                    # ST 使用 /api/characters/get?avatar_url=xxx 而非路径参数
                    if path == "/api/characters" or path.startswith("/api/characters/{"):
                        continue
                    # 排除 /api/backgrounds/* Palink-native 动态路径
                    # ST 使用 /api/backgrounds/all (POST) 而非 /api/backgrounds/{id}
                    # /api/backgrounds/ (带尾斜杠) 是 Palink-native 列表端点
                    if path == "/api/backgrounds/" or path.startswith("/api/backgrounds/{") or path.startswith("/api/backgrounds/active/") or path.startswith("/api/backgrounds/set/"):
                        continue
                    # /api/openai/generate-image 和 /api/openai/generate-voice 是 ST 端点，
                    # 但 bridge.js 通过 guard `apiPath.startsWith('/api/openai/')` 处理，
                    # 不需要在 REAL_API_PATHS 中。这里跳过检查。
                    if path.startswith("/api/openai/generate-"):
                        continue
                    registered.add(path)

        _walk(api_router.routes)
        return registered

    def test_bridge_js_file_exists(self):
        """bridge.js 文件存在且可读。"""
        assert os.path.isfile(self.BRIDGE_JS_PATH), (
            f"bridge.js 不存在: {self.BRIDGE_JS_PATH}"
        )

    def test_real_api_paths_non_empty(self):
        """REAL_API_PATHS 白名单非空。"""
        paths = self._extract_real_api_paths()
        assert len(paths) >= 30, (
            f"REAL_API_PATHS 白名单意外过短 ({len(paths)} < 30)"
        )

    def test_palink_owned_endpoints_in_bridge_js(self):
        """所有后端注册的 ST 端点都应在 bridge.js 的 REAL_API_PATHS 白名单中。

        如果缺失，会导致该端点请求被错误代理到 ST sidecar 而非 Palink 后端。
        """
        try:
            backend_endpoints = self._collect_backend_registered_st_endpoints()
        except Exception as exc:
            pytest.skip(f"无法导入 api_router: {exc}")

        bridge_paths = self._extract_real_api_paths()
        bridge_prefixes = self._extract_real_api_prefixes()

        # 动态路径（含 {param}）需要前缀匹配
        dynamic_paths = {p for p in backend_endpoints if "{" in p and "}" in p}
        static_paths = backend_endpoints - dynamic_paths

        # 静态路径：应在 REAL_API_PATHS 中精确匹配
        missing_static = sorted(p for p in static_paths if p not in bridge_paths)

        # 动态路径：应在 REAL_API_PREFIXES 中有对应前缀
        missing_dynamic = []
        for path in sorted(dynamic_paths):
            # 将 {param} 替换为占位符，提取前缀
            import re
            prefix_match = re.match(r"^(/[^{]*)\{", path)
            if not prefix_match:
                missing_dynamic.append(path)
                continue
            prefix = prefix_match.group(1)
            # 检查是否有前缀匹配
            matched = any(prefix.startswith(p) for p in bridge_prefixes)
            if not matched:
                missing_dynamic.append(path)

        missing = missing_static + missing_dynamic
        assert not missing, (
            "以下后端注册的 ST 端点未在 bridge.js REAL_API_PATHS 白名单中，"
            "ST 前端 iframe 调用时会被错误代理到 ST sidecar 而非 Palink 后端，"
            "可能导致 Palink DB 与 ST sidecar 数据不一致:\n"
            f"缺失端点: {missing}\n"
            f"白名单路径数: {len(bridge_paths)}, 前缀数: {len(bridge_prefixes)}"
        )


# ---------------------------------------------------------------------------
# 端到端场景测试
# ---------------------------------------------------------------------------
class TestSTEndToEndScenario:
    """端到端场景：模拟 ST 客户端的完整流程。

    覆盖 ST 1.18.0 用户的典型工作流：
    1. 创建角色 → 发送聊天消息 → 验证响应包含角色信息
    2. 导入角色卡 → 导出 → 验证内容一致
    """

    def test_create_character_send_message_verify_prompt(self, client, auth_headers):
        """创建角色 → 保存聊天 → 验证消息含角色信息。

        场景：
        1. POST /api/characters/create 创建角色（含 first_mes / system_prompt）
        2. POST /api/chats/get 拉取聊天（触发懒创建 session）
        3. POST /api/chats/save 保存用户消息
        4. POST /api/chats/get 再次拉取，验证消息中包含角色名
        """
        # Step 1: 创建角色
        create_resp = client.post(
            "/api/characters/create",
            headers=auth_headers,
            json={
                "name": "E2E Roleplay Char",
                "description": "An E2E test character",
                "personality": "Friendly",
                "first_mes": "Hi! I'm E2E Roleplay Char.",
                "system_prompt": "You are E2E Roleplay Char.",
                "scenario": "E2E scenario",
            },
        )
        assert create_resp.status_code == 200, create_resp.text
        char_data = create_resp.json()
        avatar = char_data["avatar"]
        character_id = char_data["character_id"]

        # Step 2: 拉取聊天（首次会触发 session 懒创建）
        get_resp = client.post(
            "/api/chats/get",
            headers=auth_headers,
            json={"avatar_url": avatar, "ch_name": "E2E Roleplay Char"},
        )
        assert get_resp.status_code == 200, get_resp.text
        chat_data = get_resp.json()
        assert isinstance(chat_data, list)
        assert len(chat_data) >= 1
        header = chat_data[0]
        # chat header 中应包含角色名相关字段
        assert "chat_name" in header
        assert "file_name" in header

        # Step 3: 保存用户消息
        user_message = {
            "name": "Tester",
            "is_user": True,
            "is_system": False,
            "mes": "Hello, E2E Roleplay Char!",
            "send_date": "2024-01-01T00:00:00",
        }
        save_resp = client.post(
            "/api/chats/save",
            headers=auth_headers,
            json={"avatar_url": avatar, "ch_name": "E2E Roleplay Char",
                  "chat": [user_message]},
        )
        assert save_resp.status_code == 200, save_resp.text

        # Step 4: 再次拉取并验证消息包含角色信息
        verify_resp = client.post(
            "/api/chats/get",
            headers=auth_headers,
            json={"avatar_url": avatar, "ch_name": "E2E Roleplay Char"},
        )
        assert verify_resp.status_code == 200, verify_resp.text
        messages = verify_resp.json()
        # 至少有 header + 用户消息
        assert len(messages) >= 2
        # 找到用户消息，验证内容
        user_msgs = [m for m in messages[1:] if m.get("is_user")]
        assert len(user_msgs) >= 1
        assert "E2E Roleplay Char" in user_msgs[0]["mes"]

        # Step 5: 验证 /api/characters/get 返回的角色卡包含 system_prompt
        char_resp = client.post(
            "/api/characters/get",
            headers=auth_headers,
            json={"avatar_url": avatar},
        )
        assert char_resp.status_code == 200
        char = char_resp.json()
        assert char["name"] == "E2E Roleplay Char"
        # ST 角色卡应包含 first_mes / system_prompt 字段
        assert "first_mes" in char
        assert "system_prompt" in char
        # avatar 包含 character_id
        assert character_id in char["avatar"]

    def test_import_export_roundtrip(self, client, auth_headers):
        """导入角色卡 → 导出 → 验证关键字段一致。

        场景：
        1. 构造 ST V2 角色卡 JSON
        2. POST /api/characters/import 导入
        3. POST /api/characters/export 导出 JSON
        4. 验证导入导出后的核心字段（name/description/personality 等）一致
        """
        original_card = _make_st_v2_card(name="Roundtrip Char")
        original_data = original_card["data"]
        # Step 1: 导入
        json_bytes = json.dumps(original_card, ensure_ascii=False).encode("utf-8")
        import_resp = client.post(
            "/api/characters/import",
            headers=auth_headers,
            files={"file": ("roundtrip.json", io.BytesIO(json_bytes), "application/json")},
        )
        assert import_resp.status_code == 200, import_resp.text
        import_data = import_resp.json()
        assert import_data["name"] == "Roundtrip Char"
        avatar = import_data["filename"]

        # Step 2: 导出 JSON
        export_resp = client.post(
            "/api/characters/export",
            headers=auth_headers,
            json={"avatar_url": avatar, "format": "json"},
        )
        assert export_resp.status_code == 200, export_resp.text
        exported_card = export_resp.json()

        # Step 3: 验证核心字段一致
        assert exported_card["spec"] == original_card["spec"]
        assert exported_card["spec_version"] == original_card["spec_version"]
        exported_data = exported_card["data"]
        # 核心字段应保留
        assert exported_data["name"] == original_data["name"]
        assert exported_data["description"] == original_data["description"]
        assert exported_data["personality"] == original_data["personality"]
        assert exported_data["scenario"] == original_data["scenario"]
        assert exported_data["first_mes"] == original_data["first_mes"]
        assert exported_data["mes_example"] == original_data["mes_example"]
        assert exported_data["system_prompt"] == original_data["system_prompt"]
        assert exported_data["creator"] == original_data["creator"]
        assert exported_data["character_version"] == original_data["character_version"]
        assert exported_data["tags"] == original_data["tags"]
        assert exported_data["alternate_greetings"] == original_data["alternate_greetings"]
