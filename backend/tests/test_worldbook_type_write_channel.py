"""[ST-BRIDGE-BOOKBIND 2026-10-20] 世界书 ``type`` 的 API 写通道回归测试。

背景（为什么会有这个文件）：
    包H 台账把 TavernHelper 的四个"书↔角色绑定/删书"键列为缺桥（D 类）：
    ``deleteLorebook`` / ``deleteWorldbook`` / ``setCurrentCharLorebooks`` /
    ``rebindCharWorldbooks``。核到后端时发现的真实缺口不是"没有写端点"，而是
    **写通道只通了一半**：

      · ``PUT /api/worldbooks/{id}`` 早就能改 ``character_id``（WB-CHAR-BIND）；
      · 但 ``type`` 列**全仓没有任何 API 写通道** —— 只有"角色卡导入"这条
        service 内部路径会把它写成 ``character_book``。

    而 Palink 认「这张卡的角色书是哪本」恰好同时依赖这两列：
      · ``api/worldbook.py::list_worldbooks`` 的 ``type == "character_book"`` 过滤
        ⇒ 前端 ``resolveCharWorldbookExport``（getCharWorldbook 的父侧落点）靠它取 primary；
      · ``services/mvu_entry_filter.select_character_book_contents`` 的同名过滤
        ⇒ MVU 的 <initvar> / schema 提取靠它。

    只改 character_id 不改 type ⇒ 卡调完 setCurrentCharLorebooks 后重新加载仍是旧绑定，
    即"绑了读不回来"的半个通道。本文件钉住补齐后的写通道行为。

覆盖五条：
    1. PUT 显式带 type ⇒ 落库 type 真的变了（核心 assertion）
    2. PUT **不带** type ⇒ type 不动（不许把已有类型抹成默认值）
    3. PUT type 传第三态/任意串 ⇒ 422（不许造出既非角色书也非全局书的类型）
    4. 跨用户 PUT ⇒ 404（type 写了反倒不安全就完了）
    5. 端到端：绑完 character_id + type 后，按 character 源读得回来（这条是对 FFT 4-1 的直接回答）
"""

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


def _mk_character(db: Session, user: User, name: str) -> Character:
    c = Character(
        id=f"char-{uuid.uuid4().hex[:12]}",
        user_id=user.id,
        name=name,
        description="pytest fixture character",
        avatar="none.png",
    )
    db.add(c)
    db.commit()
    db.refresh(c)
    return c


def _mk_book(db: Session, user: User, name: str, type_: str = "world_book") -> WorldBook:
    wb = WorldBook(
        id=f"wb-{uuid.uuid4().hex[:12]}",
        user_id=user.id,
        name=name,
        type=type_,
        source_type="online_edit",
        description="pytest fixture book",
    )
    db.add(wb)
    db.commit()
    db.refresh(wb)
    return wb


def _reload(db: Session, book_id: str) -> WorldBook:
    db.expire_all()
    return db.query(WorldBook).filter(WorldBook.id == book_id).first()


def test_put_type_switches_book_to_character_book(client: TestClient, db_session: Session, test_user):
    """PUT 显式带 type=character_book ⇒ 落库真的变成 character_book。"""
    book = _mk_book(db_session, test_user, f"type-sw-{uuid.uuid4().hex[:6]}")
    assert book.type == "world_book"

    resp = client.put(f"/api/worldbooks/{book.id}", json={"type": "character_book"})
    assert resp.status_code == 200, resp.text

    assert _reload(db_session, book.id).type == "character_book"


def test_put_without_type_leaves_type_untouched(client: TestClient, db_session: Session, test_user):
    """只改名字、不带 type ⇒ type 保持原值（model_fields_set 区分"没传"与"传 null"）。"""
    book = _mk_book(db_session, test_user, f"type-keep-{uuid.uuid4().hex[:6]}", type_="character_book")

    resp = client.put(f"/api/worldbooks/{book.id}", json={"name": "renamed-only"})
    assert resp.status_code == 200, resp.text

    after = _reload(db_session, book.id)
    assert after.name == "renamed-only"
    assert after.type == "character_book"


def test_put_invalid_type_rejected_with_422(client: TestClient, db_session: Session, test_user):
    """type 只收两个枚举值，第三态一律拒（避免造出读不到的孤儿类型）。"""
    book = _mk_book(db_session, test_user, f"type-bad-{uuid.uuid4().hex[:6]}")
    before = _reload(db_session, book.id).type

    resp = client.put(f"/api/worldbooks/{book.id}", json={"type": "character-book-of-doom"})
    assert resp.status_code == 422, resp.text

    assert _reload(db_session, book.id).type == before


def test_put_type_cross_user_returns_404(client: TestClient, db_session: Session, test_user):
    """别的用户的书 ⇒ 404，type 改不到（写了反倒不安全，故先按 user_id 过滤）。"""
    other = User(
        username=f"typesec-{uuid.uuid4().hex[:8]}",
        hashed_password=get_password_hash("TestPassword1"),
        role="user",
        is_active=True,
    )
    db_session.add(other)
    db_session.commit()
    db_session.refresh(other)

    foreign = _mk_book(db_session, other, f"type-fgn-{uuid.uuid4().hex[:6]}")

    resp = client.put(f"/api/worldbooks/{foreign.id}", json={"type": "character_book"})
    assert resp.status_code == 404, resp.text
    assert _reload(db_session, foreign.id).type == "world_book"


def test_delete_then_cross_check_row_is_gone(client: TestClient, db_session: Session, test_user):
    """删除之后**换一条路再查一次**，确认行真的没了。

    为什么还要这条：`DELETE` 返回 200 不等于删掉了。本仓踩过"synced 计数会骗人"的坑
    （同步/审计计数说成功，但源行还在）。这里的复核是双路的：
      ① 走 API 的 LIST（带 15s TTL 缓存，顺带验证失效真的产出了新数据）；
      ② 直接 ORM 查表（绕过一切缓存与序列化）⇒ 两路都必须看不见这本书。
    """
    book = _mk_book(db_session, test_user, f"del-{uuid.uuid4().hex[:6]}")

    listed_before = client.get("/api/worldbooks")
    assert listed_before.status_code == 200, listed_before.text
    assert book.id in [row["id"] for row in listed_before.json()]

    resp = client.delete(f"/api/worldbooks/{book.id}")
    assert resp.status_code == 200, resp.text

    # ① API 侧：缓存失效必须生效，否则 LIST 会吐出已删的书
    listed_after = client.get("/api/worldbooks")
    assert listed_after.status_code == 200, listed_after.text
    assert book.id not in [row["id"] for row in listed_after.json()]

    # ② 存储侧：绕过所有缓存直接查表
    db_session.expire_all()
    assert db_session.query(WorldBook).filter(WorldBook.id == book.id).first() is None


def test_bind_then_readable_as_character_source(
    client: TestClient, db_session: Session, test_user
):
    """端到端：绑 character_id + type 之后，按角色 source 读得回来。

    这条是四个 ST 键能不能落地的判据 —— 改前只改 character_id 读不回来，
    理由就是 list_worldbooks 的 ``type == "character_book"`` 过滤。
    """
    character = _mk_character(db_session, test_user, f"bind-{uuid.uuid4().hex[:6]}")
    book = _mk_book(db_session, test_user, f"bind-book-{uuid.uuid4().hex[:6]}")

    # 改前：这本书虽然是当前用户的，但按角色源查不到（type 不是 character_book）
    before = client.get(
        "/api/worldbooks",
        params={"character_id": character.id, "type": "character_book"},
    )
    assert before.status_code == 200, before.text
    assert [row["id"] for row in before.json()] == []

    resp = client.put(
        f"/api/worldbooks/{book.id}",
        json={"character_id": character.id, "type": "character_book"},
    )
    assert resp.status_code == 200, resp.text

    after = client.get(
        "/api/worldbooks",
        params={"character_id": character.id, "type": "character_book"},
    )
    assert after.status_code == 200, after.text
    rows = after.json()
    assert [row["id"] for row in rows] == [book.id]

    # 解绑之后同样应当立刻读不到（character_id=null ⇒ 不再属于任何角色）
    unbind = client.put(
        f"/api/worldbooks/{book.id}",
        json={"character_id": None, "type": "world_book"},
    )
    assert unbind.status_code == 200, unbind.text

    gone = client.get(
        "/api/worldbooks",
        params={"character_id": character.id, "type": "character_book"},
    )
    assert gone.status_code == 200, gone.text
    assert [row["id"] for row in gone.json()] == []
