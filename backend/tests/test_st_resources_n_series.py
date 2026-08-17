"""N1-N5: ST 资源端点行为回归测试。

对照 docs/MOBILE_ST_COMPAT_VERIFY_2026-08-12.md §7.1「新发现」N1-N5：
- N1: /api/avatars/delete 请求体 avatar vs path → 422（双字段兼容后应 200/404 而非 422）
- N2: /api/backgrounds/delete（bg 字段）
- N3: /api/backgrounds/rename（old_bg/new_bg 字段）
- N4: /api/backgrounds/upload 返回纯文本背景名（非 JSON）
- N5: /api/sprites/get 返回裸数组 [{label, path}]（非 {"sprites":[...]} + name 字段）
"""
import io
import os
from pathlib import Path

from app.core.config import settings


def _bg_path(rel: str) -> Path:
    return Path(settings.DATA_DIR) / rel


def _touch_data_file(rel: str, content: bytes = b"test") -> Path:
    p = _bg_path(rel)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(content)
    return p


def _cleanup_rel(rel: str) -> None:
    try:
        _bg_path(rel).unlink()
    except FileNotFoundError:
        pass


def test_n1_avatars_delete_accepts_avatar_field(client, auth_headers):
    """N1: ST personas.js:1173-1174 发 avatar 字段——不应 422。"""
    rel = "characters/N1Char/avatar.png"
    _touch_data_file(rel)
    try:
        resp = client.post("/api/avatars/delete", json={"avatar": rel}, headers=auth_headers)
        assert resp.status_code == 200, resp.text
        assert not _bg_path(rel).exists()
    finally:
        _cleanup_rel(rel)


def test_n1_avatars_delete_accepts_path_field(client, auth_headers):
    """N1 兼容: 旧 path 字段仍可用。"""
    rel = "characters/N1CharB/avatar.png"
    _touch_data_file(rel)
    try:
        resp = client.post("/api/avatars/delete", json={"path": rel}, headers=auth_headers)
        assert resp.status_code == 200, resp.text
    finally:
        _cleanup_rel(rel)


def test_n2_backgrounds_delete_accepts_bg_field(client, auth_headers):
    """N2: ST backgrounds.js:1453-1454 发 bg 字段——不应 422。"""
    rel = "backgrounds/N2Test.png"
    _touch_data_file(rel)
    try:
        resp = client.post("/api/backgrounds/delete", json={"bg": rel}, headers=auth_headers)
        assert resp.status_code == 200, resp.text
        assert not _bg_path(rel).exists()
    finally:
        _cleanup_rel(rel)


def test_n2_backgrounds_delete_accepts_path_field(client, auth_headers):
    """N2 兼容: 旧 path 字段仍可用。"""
    rel = "backgrounds/N2TestB.png"
    _touch_data_file(rel)
    try:
        resp = client.post("/api/backgrounds/delete", json={"path": rel}, headers=auth_headers)
        assert resp.status_code == 200, resp.text
    finally:
        _cleanup_rel(rel)


def test_n3_backgrounds_rename_accepts_old_bg_new_bg(client, auth_headers):
    """N3: ST backgrounds.js:511 发 old_bg/new_bg——不应 422。"""
    old_rel = "backgrounds/N3Old.png"
    new_rel = "backgrounds/N3New.png"
    _touch_data_file(old_rel)
    try:
        resp = client.post("/api/backgrounds/rename", json={"old_bg": old_rel, "new_bg": new_rel}, headers=auth_headers)
        assert resp.status_code == 200, resp.text
        assert _bg_path(new_rel).exists()
        assert not _bg_path(old_rel).exists()
    finally:
        _cleanup_rel(old_rel)
        _cleanup_rel(new_rel)


def test_n3_backgrounds_rename_accepts_old_path_new_path(client, auth_headers):
    """N3 兼容: 旧 old_path/new_path 字段仍可用。"""
    old_rel = "backgrounds/N3OldB.png"
    new_rel = "backgrounds/N3NewB.png"
    _touch_data_file(old_rel)
    try:
        resp = client.post("/api/backgrounds/rename", json={"old_path": old_rel, "new_path": new_rel}, headers=auth_headers)
        assert resp.status_code == 200, resp.text
    finally:
        _cleanup_rel(old_rel)
        _cleanup_rel(new_rel)


def test_n4_backgrounds_upload_returns_plain_text_name(client, auth_headers):
    """N4: ST backgrounds.js:1565 response.text() 期望纯文本背景名。

    必须为不带引号的裸文本：FastAPI 直接 return str 会序列化为 JSON 字符串
    （带引号 "N4Bg.png"），ST 前端拿到引号背景名失效。
    """
    resp = client.post(
        "/api/backgrounds/upload",
        files={"avatar": ("N4Bg.png", io.BytesIO(b"\x89PNG\r\n\x1a\n fake"), "image/png")},
        headers=auth_headers,
    )
    assert resp.status_code == 200, resp.text
    text = resp.text
    assert text == "N4Bg.png" or text.startswith("N4Bg-"), f"expected plain name, got: {text!r}"
    # 若 FastAPI 序列化为 JSON 字符串会以 " 开头——N4 修复后为裸文件名
    assert not text.startswith('"'), f"expected bare plain text (no JSON quotes), got: {text!r}"
    assert not text.startswith("{")


def test_n5_sprites_get_returns_bare_array(client, auth_headers):
    """N5: ST expressions/index.js:1295-1300 消费 sprite.label/path——
    返回裸数组而非 {"sprites":[...]}。"""
    # 创建角色立绘
    sprite_rel = "characters/N5Char/sprites/happy.png"
    _touch_data_file(sprite_rel, b"\x89PNG\r\n\x1a\n fake")
    try:
        resp = client.get("/api/sprites/get", params={"name": "N5Char"}, headers=auth_headers)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert isinstance(data, list), f"expected bare array, got: {type(data)} {data!r}"
        assert len(data) >= 1
        first = data[0]
        assert "label" in first and "path" in first, f"expected label/path keys, got: {first!r}"
        assert first["label"] == "happy"
    finally:
        _cleanup_rel(sprite_rel)


def test_n5_sprites_get_unknown_character_returns_empty_array(client, auth_headers):
    """N5: 未知角色返回空数组（非 404/错误对象）。"""
    resp = client.get("/api/sprites/get", params={"name": "NoSuchCharXYZ"}, headers=auth_headers)
    assert resp.status_code == 200, resp.text
    assert resp.json() == []
