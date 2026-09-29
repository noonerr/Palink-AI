"""SPEC_世界书向量召回接通与防护 §11 A + R1(B)：词条级 ``vectorized`` 字段白名单往返。

四处白名单（漏一处即"保存即丢"）：
  1. ``schemas/worldbook.py::WorldBookStageResponse``（响应模型带字段）；
  2. ``api/worldbook.py::_stage_to_response``（逐字段手抄 dict——真白名单）；
  3. ``schemas/worldbook.py::WorldBookStageUpdate``（PUT 请求体接收字段）；
  4. ``api/worldbook.py::update_stage``（落库 + commit 后触发向量同步）。

往返 = PUT 带 ``vectorized=true`` → 响应含 true → 详情回读仍为 true → DB 列 true。
任一层漏掉，本文件立即红灯（而非"界面看着勾上了、刷新就没了"）。

R1（update_stage 提交后必须复用 ``_schedule_worldbook_vector_sync``——P2 的
``_book_vectors_ready`` 只比行数、不做内容脏检查，词条改内容后不触发同步，
向量库会一直留着旧内容的向量）的断言见
``tests/test_worldbook_stage_vector_sync_trigger.py``。

夹具全部自造中性文本（仓库照明/天气类），不读取任何真实用户数据。
"""

import json
import os
import sys

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from app.models.worldbook import WorldBookStage  # noqa: E402


# 自造中性夹具：仓库值班照明规则（与任何真实角色/世界书无关）
LOREBOOK_ENTRY = {
    "uid": 0,
    "key": ["warehouse lighting"],
    "keysecondary": [],
    "comment": "仓库夜班照明",
    "content": "夜班期间仓库主通道保持常亮，侧通道按需开启。",
    "constant": False,
    "vectorized": False,
    "selective": False,
    "order": 100,
    "position": 0,
    "probability": 100,
    "useProbability": True,
    "depth": 4,
    "scanDepth": None,
    "caseSensitive": False,
    "matchWholeWords": False,
    "group": "",
}


def _import_book(client: TestClient, auth_headers: dict, name: str, vectorized: bool) -> str:
    payload = {
        "name": name,
        "description": "中性夹具",
        "entries": {"0": {**LOREBOOK_ENTRY, "vectorized": vectorized}},
    }
    resp = client.post(
        "/api/worldbooks/import",
        headers=auth_headers,
        files={"file": ("fixture.json", json.dumps(payload).encode("utf-8"))},
    )
    assert resp.status_code == 200, f"import failed: {resp.text}"
    return resp.json()["id"]


def _stage_id(client: TestClient, auth_headers: dict, book_id: str) -> str:
    resp = client.get(f"/api/worldbooks/{book_id}", headers=auth_headers)
    assert resp.status_code == 200, f"detail failed: {resp.text}"
    stages = resp.json()["stages"]
    assert len(stages) == 1
    return stages[0]["id"]


@pytest.fixture()
def book_id(client: TestClient, auth_headers: dict) -> str:
    return _import_book(client, auth_headers, "向量白名单夹具书", vectorized=False)


# ============================================================
# A：schema 层白名单
# ============================================================

def test_stage_schemas_expose_vectorized_field():
    from app.schemas.worldbook import WorldBookStageResponse, WorldBookStageUpdate

    assert "vectorized" in WorldBookStageResponse.model_fields, (
        "WorldBookStageResponse 缺 vectorized 字段——前端读不到勾选状态"
    )
    assert "vectorized" in WorldBookStageUpdate.model_fields, (
        "WorldBookStageUpdate 缺 vectorized 字段——PUT 请求体字段会被静默丢弃"
    )


# ============================================================
# A：往返（PUT → 响应 → 详情回读 → DB 列）
# ============================================================

def test_update_stage_vectorized_roundtrip(
    client: TestClient, auth_headers: dict, db_session: Session, book_id: str
):
    sid = _stage_id(client, auth_headers, book_id)

    resp = client.put(
        f"/api/worldbooks/{book_id}/stages/{sid}",
        headers=auth_headers,
        json={"vectorized": True},
    )
    assert resp.status_code == 200, f"update_stage failed: {resp.text}"
    body = resp.json()

    # 第 2/3 层白名单：_stage_to_response 不带该字段 → 这里直接 KeyError 红
    assert "vectorized" in body, "PUT 响应缺 vectorized——_stage_to_response 白名单漏了"
    assert body["vectorized"] is True, f"PUT 响应 vectorized 应为 True，实际 {body['vectorized']!r}"

    # 详情回读仍为 True（证明真的落库，不是回显请求体）
    detail = client.get(f"/api/worldbooks/{book_id}", headers=auth_headers).json()
    assert detail["stages"][0]["vectorized"] is True, "详情回读 vectorized 丢了——保存即丢"

    stage = db_session.query(WorldBookStage).filter(WorldBookStage.id == sid).first()
    assert stage.vectorized is True, "DB 列未落库"


def test_stage_response_defaults_vectorized_false(client: TestClient, auth_headers: dict, book_id: str):
    """未勾选的存量条目：响应显式带 false（前端受控组件需要确定的初值）。"""
    detail = client.get(f"/api/worldbooks/{book_id}", headers=auth_headers).json()
    assert "vectorized" in detail["stages"][0], "响应缺 vectorized 字段"
    assert detail["stages"][0]["vectorized"] is False


def test_update_stage_vectorized_can_be_turned_off(
    client: TestClient, auth_headers: dict, db_session: Session, book_id: str
):
    sid = _stage_id(client, auth_headers, book_id)
    client.put(
        f"/api/worldbooks/{book_id}/stages/{sid}", headers=auth_headers, json={"vectorized": True}
    )
    client.put(
        f"/api/worldbooks/{book_id}/stages/{sid}", headers=auth_headers, json={"vectorized": False}
    )
    detail = client.get(f"/api/worldbooks/{book_id}", headers=auth_headers).json()
    assert detail["stages"][0]["vectorized"] is False
    stage = db_session.query(WorldBookStage).filter(WorldBookStage.id == sid).first()
    assert stage.vectorized is False


def test_update_stage_omitting_vectorized_keeps_value(
    client: TestClient, auth_headers: dict, db_session: Session, book_id: str
):
    """Optional[bool]=None 语义：不传该字段不得把已勾选项冲成 False。"""
    sid = _stage_id(client, auth_headers, book_id)
    client.put(
        f"/api/worldbooks/{book_id}/stages/{sid}", headers=auth_headers, json={"vectorized": True}
    )
    client.put(
        f"/api/worldbooks/{book_id}/stages/{sid}",
        headers=auth_headers,
        json={"content": "侧通道照明改用感应开关。"},
    )
    stage = db_session.query(WorldBookStage).filter(WorldBookStage.id == sid).first()
    assert stage.vectorized is True, "不传 vectorized 时被误改成 False"


# 注：本文件只覆盖"字段白名单 + 往返"。update_stage 提交后必须触发向量同步
# （SPEC §11 R1）的断言在 tests/test_worldbook_stage_vector_sync_trigger.py。
