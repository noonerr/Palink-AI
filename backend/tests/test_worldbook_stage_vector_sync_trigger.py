"""SPEC_世界书向量召回接通与防护 §11 R1(B)：``update_stage`` 必须触发向量同步。

背景（为什么这条不能省）：P2 之后的检索路径**零 sync**，就绪判定
``_book_vectors_ready`` 只做「向量行数 ≥ vectorized 条目数」的两次计数，
**不做内容脏检查**（docstring 明写：内容变更的收敛交给书级 PUT / 导入）。
词条编辑端点如果不同步触发，用户改完词条内容后向量库里永远是旧内容的向量
——界面看着勾上了、召回的却是上一次的设定。

本文件只断言"触发"，不断言"嵌入结果"（后者由 test_worldbook_vector_recall.py 覆盖）。

夹具全部自造中性文本（仓库照明/巡检），不读取任何真实用户数据。
"""

import json
import os
import sys

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from fastapi.testclient import TestClient  # noqa: E402


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
    return _import_book(client, auth_headers, "同步触发夹具书", vectorized=False)


@pytest.fixture()
def sync_calls(monkeypatch) -> list:
    """拦截 _fire_vector_sync（真 fire-and-forget 线程），只记录 book_id。"""
    import app.api.worldbook as wb_api

    calls: list = []
    monkeypatch.setattr(wb_api, "_fire_vector_sync", lambda world_book_id: calls.append(world_book_id))
    return calls


def test_update_stage_triggers_vector_sync_once(
    client: TestClient, auth_headers: dict, book_id: str, sync_calls: list
):
    sid = _stage_id(client, auth_headers, book_id)
    resp = client.put(
        f"/api/worldbooks/{book_id}/stages/{sid}", headers=auth_headers, json={"vectorized": True}
    )
    assert resp.status_code == 200
    assert sync_calls == [book_id], f"勾选后应触发一次同步，实际 {sync_calls}"


def test_update_stage_content_change_triggers_sync(
    client: TestClient, auth_headers: dict, book_id: str, sync_calls: list
):
    """R1 核心：改内容也要触发——就绪检测只比行数，不做内容脏检查。"""
    sid = _stage_id(client, auth_headers, book_id)
    client.put(
        f"/api/worldbooks/{book_id}/stages/{sid}", headers=auth_headers, json={"vectorized": True}
    )
    assert len(sync_calls) == 1

    client.put(
        f"/api/worldbooks/{book_id}/stages/{sid}",
        headers=auth_headers,
        json={"content": "夜班照明改为分区控制，装卸区单独供电。"},
    )
    assert len(sync_calls) == 2, f"内容变更后应再触发一次，实际 {len(sync_calls)} 次"
    assert sync_calls == [book_id, book_id]


def test_update_stage_without_vectorized_entry_does_not_trigger_sync(
    client: TestClient, auth_headers: dict, book_id: str, sync_calls: list
):
    """存量零突变：书内无 vectorized 条目时，编辑不得触发同步。"""
    sid = _stage_id(client, auth_headers, book_id)
    client.put(
        f"/api/worldbooks/{book_id}/stages/{sid}",
        headers=auth_headers,
        json={"content": "未勾选向量的条目改内容。"},
    )
    assert sync_calls == [], f"无 vectorized 条目不应触发同步，实际 {sync_calls}"


def test_update_stage_of_vectorized_book_triggers_sync(
    client: TestClient, auth_headers: dict, sync_calls: list
):
    """书内已有 vectorized 条目时，编辑同书条目也要触发（该书整体重算）。

    注意：导入路径本身就会触发一次（既有行为），故断言"增量 +1"而非绝对次数。
    """
    book = _import_book(client, auth_headers, "混合夹具书", vectorized=True)
    detail = client.get(f"/api/worldbooks/{book}", headers=auth_headers).json()
    sid = detail["stages"][0]["id"]
    assert detail["stages"][0]["vectorized"] is True
    assert len(sync_calls) == 1, f"导入含 vectorized 条目应触发一次，实际 {sync_calls}"

    client.put(
        f"/api/worldbooks/{book}/stages/{sid}",
        headers=auth_headers,
        json={"content": "照明巡检频率调整为每周一次。"},
    )
    assert len(sync_calls) == 2, f"词条编辑应再触发一次（共 2 次），实际 {len(sync_calls)}"
    assert set(sync_calls) == {book}
