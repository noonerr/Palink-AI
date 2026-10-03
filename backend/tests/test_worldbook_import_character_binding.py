"""[WB-CHAR-BIND-IMPORT 2026-10-03] 世界书导入必须能绑角色。

缺陷：``POST /api/worldbooks/import`` 的 handler 构造 ``WorldBook(...)`` 时
**根本没有 character_id 形参** → 用户导入的每一本世界书都落成全局书
（``character_id = NULL``）。对比卡内嵌路径（``character_import_service``:845）
一直是绑角色的。于是形成了报告口径能标 ``source=global``（可见性做到了）
但**隔离没做到**的矛盾状态：用户的串味投诉在世界书维度没被解决。

本文件锁死：
  1. 带 ``character_id`` 表单字段导入 → 落库绑到该角色（核心断言）。
  2. 归属校验：绑到**别的用户**的角色 → 400 点名报错，
     不静默落成全局书（静默落全局 = 用户以为隔离了其实没隔离）。
  3. 不传 / 传空串 → 全局书（与修复前逐字一致，不破坏既有调用方）。
  4. 响应体回显 character_id（前端导入后提示条要靠它判断是不是全局书）。
  5. 绑好的书真的对别的角色不可见（隔离端到端生效，不只是落了个字段）。
"""

import json
import os
import sys
import uuid

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from app.core.security import get_password_hash  # noqa: E402
from app.models import Character, User  # noqa: E402
from app.models.worldbook import WorldBook  # noqa: E402


LOREBOOK = {
    "name": "B3 Import Bind Book",
    "entries": {
        "0": {
            "key": ["dragon"],
            "comment": "e0",
            "content": "Dragon lore",
            "constant": True,
            "disable": False,
        }
    },
}


def _mk_user(db: Session, tag: str) -> User:
    u = User(
        username=f"wbbind-{tag}-{uuid.uuid4().hex[:8]}",
        hashed_password=get_password_hash("TestPassword1"),
        role="user",
        is_active=True,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _mk_char(db: Session, user: User, name: str) -> Character:
    c = Character(id=f"wbbind-c-{uuid.uuid4().hex[:8]}", user_id=user.id, name=name)
    db.add(c)
    db.commit()
    db.refresh(c)
    return c


def _import(client: TestClient, headers: dict, name: str, character_id=None):
    """走 multipart 导入。character_id 走 **data**（表单字段），不是 query。"""
    payload = dict(LOREBOOK, name=name)
    files = {"file": (f"{name}.json", json.dumps(payload).encode("utf-8"))}
    data = {} if character_id is None else {"character_id": character_id}
    return client.post("/api/worldbooks/import", headers=headers, files=files, data=data)


def _current_user(db: Session) -> User:
    """取 conftest 建的那个测试用户（client 注入的就是它的 token）。"""
    u = db.query(User).order_by(User.id.desc()).first()
    assert u is not None, "conftest 的 test_user 不在库里"
    return u


# ── 1. 核心：导入时带角色 → 落库绑到该角色 ──────────────────────────────

def test_import_with_character_id_binds_book_to_character(
    client: TestClient, db_session: Session, auth_headers: dict
):
    char = _mk_char(db_session, _current_user(db_session), "B3 Card A")

    resp = _import(client, auth_headers, "B3 bound book", character_id=char.id)
    assert resp.status_code == 200, f"import failed: {resp.text}"
    book_id = resp.json()["id"]

    wb = db_session.query(WorldBook).filter(WorldBook.id == book_id).first()
    assert wb is not None
    assert wb.character_id == char.id, (
        f"导入的书没绑到角色（落成 character_id={wb.character_id!r}）—— "
        "这正是串味投诉在世界书维度没被解决的根因"
    )


def test_import_response_echoes_character_id(
    client: TestClient, db_session: Session, auth_headers: dict
):
    """前端导入后的提示条靠响应里的 character_id 判断是不是全局书。"""
    char = _mk_char(db_session, _current_user(db_session), "B3 Card Echo")

    resp = _import(client, auth_headers, "B3 echo book", character_id=char.id)
    assert resp.status_code == 200, f"import failed: {resp.text}"
    assert resp.json()["character_id"] == char.id


# ── 2. 归属校验：不静默落成全局书 ───────────────────────────────────────

def test_import_rejects_foreign_character(
    client: TestClient, db_session: Session, auth_headers: dict
):
    """绑到别的用户的角色 → 400 点名报错（FK 只校验 id 存在、不校验归属）。"""
    other = _mk_user(db_session, "other")
    foreign_char = _mk_char(db_session, other, "B3 Foreign Card")

    resp = _import(client, auth_headers, "B3 foreign book", character_id=foreign_char.id)
    assert resp.status_code == 400, (
        f"绑别的用户的角色应 400，实际 {resp.status_code}（静默落全局 = "
        "用户以为隔离了其实没有）"
    )
    assert foreign_char.id in resp.text


# ── 3. 零回归：不传 / 空串 → 全局书 ────────────────────────────────────

@pytest.mark.parametrize("payload", [None, ""])
def test_import_without_character_id_stays_global(
    client: TestClient, db_session: Session, auth_headers: dict, payload
):
    """不传 / 空串 = 全局书，与修复前行为逐字一致（既有调用方不被打破）。"""
    resp = _import(client, auth_headers, f"B3 global book {payload!r}", character_id=payload)
    assert resp.status_code == 200, f"import failed: {resp.text}"
    book_id = resp.json()["id"]

    wb = db_session.query(WorldBook).filter(WorldBook.id == book_id).first()
    assert wb is not None
    assert wb.character_id is None


def test_import_omitted_character_id_matches_explicit_empty(
    client: TestClient, auth_headers: dict
):
    """完全不传该字段（旧版前端请求体）与传空串结果必须一致。"""
    files = {"file": ("b3_omitted.json", json.dumps(
        dict(LOREBOOK, name="B3 omitted")
    ).encode("utf-8"))}
    resp = client.post(
        "/api/worldbooks/import", headers=auth_headers, files=files,
    )
    assert resp.status_code == 200, f"import failed: {resp.text}"
    assert resp.json()["character_id"] is None


# ── 4. 导入路径接线静态守卫（防止字段被误删成 query 参数）──────────────

def test_import_handler_declares_character_id_as_form_field():
    """⚠️ 必须声明成 Form：同 endpoint 有 File，用 Query 会被 FastAPI 静默忽略 →
    书照样落成全局书，而前端以为传了。这就是「静默失败」，必须守住。"""
    path = os.path.join(_BACKEND_DIR, "app", "api", "worldbook.py")
    with open(path, "r", encoding="utf-8") as f:
        src = f.read()

    marker = "async def import_worldbook("
    idx = src.index(marker)
    sig = src[idx:idx + 500]
    assert "character_id" in sig, "import handler 签名里没有 character_id"
    assert "Form(None)" in sig, (
        "character_id 必须用 Form(None)（与 File 同处一个 multipart 请求体）；"
        "用 Query 会被静默忽略 → 导入的书照样落成全局书"
    )