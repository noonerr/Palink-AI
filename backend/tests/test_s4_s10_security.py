"""S-4 / S-10 修复验证测试（pytest，复用 conftest fixtures）。

验证:
- S-4: 伪造他人 session_id 访问 variables/get/set/delete 应 404（越权被拒）
- S-10: /api/images/upload 拒绝 .html/.svg（扩展名白名单）、拒绝伪 PNG（魔数校验）、接受合法 PNG
"""
import io
import uuid

from app.models.character import Character, CharacterChatSession
from app.models.user import User


def _create_session(db_session, user: User) -> str:
    character = Character(
        id=str(uuid.uuid4()),
        user_id=user.id,
        name="S4 Test Char",
    )
    db_session.add(character)
    db_session.flush()
    session = CharacterChatSession(
        id=str(uuid.uuid4()),
        user_id=user.id,
        character_id=character.id,
        title="s4-test",
    )
    db_session.add(session)
    db_session.commit()
    db_session.refresh(session)
    return session.id


def test_s4_variables_get_rejects_foreign_session(client, db_session, test_user, auth_headers):
    """伪造他人 session_id → 404（水平越权防护）。"""
    resp = client.post(
        "/api/variables/get",
        headers={**auth_headers, "X-Palink-Session-Id": "00000000-0000-0000-0000-000000000000"},
        json={"variableName": "k"},
    )
    assert resp.status_code == 404, resp.text


def test_s4_variables_set_rejects_foreign_session(client, db_session, test_user, auth_headers):
    """伪造他人 session_id 写变量 → 404。"""
    resp = client.post(
        "/api/variables/set",
        headers={**auth_headers, "X-Palink-Session-Id": "00000000-0000-0000-0000-000000000000"},
        json={"variableName": "k", "variableValue": "v"},
    )
    assert resp.status_code == 404, resp.text


def test_s4_variables_delete_rejects_foreign_session(client, db_session, test_user, auth_headers):
    """伪造他人 session_id 删变量 → 404。"""
    resp = client.post(
        "/api/variables/delete",
        headers={**auth_headers, "X-Palink-Session-Id": "00000000-0000-0000-0000-000000000000"},
        json={"variableName": "k"},
    )
    assert resp.status_code == 404, resp.text


def test_s4_variables_own_session_still_works(client, db_session, test_user, auth_headers):
    """自己的 session 读写变量仍正常（不破坏现有功能）。"""
    session_id = _create_session(db_session, test_user)
    resp = client.post(
        "/api/variables/set",
        headers={**auth_headers, "X-Palink-Session-Id": session_id},
        json={"variableName": "own_key", "variableValue": "own_val"},
    )
    assert resp.status_code == 200, resp.text
    resp = client.post(
        "/api/variables/get",
        headers={**auth_headers, "X-Palink-Session-Id": session_id},
        json={"variableName": "own_key"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json().get("value") == "own_val"


def test_s10_upload_rejects_html(client, auth_headers):
    """S-10: .html 扩展名 → 400（存储型 XSS 防护）。"""
    resp = client.post(
        "/api/images/upload",
        headers=auth_headers,
        files={"avatar": ("evil.html", io.BytesIO(b"<script>alert(1)</script>"), "text/html")},
    )
    assert resp.status_code == 400, resp.text


def test_s10_upload_rejects_svg(client, auth_headers):
    """S-10: .svg 扩展名 → 400（脚本型矢量图拒绝）。"""
    resp = client.post(
        "/api/images/upload",
        headers=auth_headers,
        files={"avatar": ("evil.svg", io.BytesIO(b"<svg onload=alert(1)>"), "image/svg+xml")},
    )
    assert resp.status_code == 400, resp.text


def test_s10_upload_rejects_fake_png_magic(client, auth_headers):
    """S-10: 扩展名 .png 但魔数错误 → 400（魔数校验）。"""
    resp = client.post(
        "/api/images/upload",
        headers=auth_headers,
        files={"avatar": ("fake.png", io.BytesIO(b"not-a-png-content"), "image/png")},
    )
    assert resp.status_code == 400, resp.text


def test_s10_upload_accepts_valid_png(client, auth_headers):
    """S-10: 合法 PNG（正确魔数）→ 200（不破坏正常上传）。"""
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
    resp = client.post(
        "/api/images/upload",
        headers=auth_headers,
        files={"avatar": ("ok.png", io.BytesIO(png), "image/png")},
    )
    assert resp.status_code == 200, resp.text
    assert "url" in resp.json()
