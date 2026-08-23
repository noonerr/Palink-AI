"""P1-D-2 修复验证: /api/worldbooks/import 字段映射补齐。

ST lorebook JSON 的条目级高级字段（order/sticky/cooldown/delay/depth/
selectiveLogic/caseSensitive/matchWholeWords/excludeRecursion/preventRecursion/
group 系/scanDepth 等）在旧导入实现中被静默丢弃（仅映射 8 项），UI 直接
上传的世界书全部退化为默认值。本测试锁定「导入 → 落库列」的保真契约。

注：swipes 干净断言不适用本项（导入路径不写消息表）；该断言由 #2 的
persist 链路测试覆盖（test_regex_p2.py::test_sync_message_content_to_active_swipe_*）。
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

from app.models.worldbook import WorldBookStage  # noqa: E402


LOREBOOK_ENTRY = {
    "uid": 0,
    "key": ["dragon"],
    "keysecondary": ["fire"],
    "comment": "advanced entry",
    "content": "Dragon lore content",
    "constant": False,
    "vectorized": False,
    "selective": True,
    "selectiveLogic": 2,
    "addMemo": True,
    "order": 7,
    "position": 0,
    "excludeRecursion": True,
    "preventRecursion": True,
    "delayUntilRecursion": False,
    "probability": 80,
    "useProbability": False,
    "displayIndex": 1,
    "group": "dragons",
    "groupOverride": True,
    "groupWeight": 90,
    "scanDepth": 6,
    "caseSensitive": True,
    "matchWholeWords": True,
    "useGroupScoring": None,
    "automationId": "",
    "role": None,
    "sticky": 3,
    "cooldown": 2,
    "delay": 5,
    "depth": 2,
    "disable": False,
}


@pytest.fixture()
def imported_book_id(client: TestClient, auth_headers: dict) -> str:
    payload = {
        "name": "P1 Import Fields Book",
        "description": "field fidelity test",
        "entries": {"0": LOREBOOK_ENTRY},
    }
    resp = client.post(
        "/api/worldbooks/import",
        headers=auth_headers,
        files={"file": ("p1_fields.json", json.dumps(payload).encode("utf-8"))},
    )
    assert resp.status_code == 200, f"import failed: {resp.text}"
    return resp.json()["id"]


def test_import_preserves_entry_level_advanced_fields(
    client: TestClient,
    db_session: Session,
    auth_headers: dict,
    imported_book_id: str,
):
    stages = (
        db_session.query(WorldBookStage)
        .filter(WorldBookStage.world_book_id == imported_book_id)
        .all()
    )
    assert len(stages) == 1
    s = stages[0]

    # 排序与计时字段（旧行为：order 丢失、sticky/cooldown/delay 全为默认 0）
    assert s.order == 7, f"order 应映射落库，实际 {s.order}"
    assert s.sticky == 3, f"sticky 应映射落库，实际 {s.sticky}"
    assert s.cooldown == 2, f"cooldown 应映射落库，实际 {s.cooldown}"
    assert s.delay == 5, f"delay 应映射落库，实际 {s.delay}"
    assert s.depth == 2, f"depth 应映射落库，实际 {s.depth}"

    # 匹配语义字段（旧行为：selective_logic 恒 0、大小写/全词匹配丢失）
    assert s.selective_logic == 2, f"selectiveLogic 应映射落库，实际 {s.selective_logic}"
    assert s.case_sensitive is True
    assert s.match_whole_words is True
    assert s.scan_depth == 6, f"scanDepth 应映射落库，实际 {s.scan_depth}"

    # 递归控制字段
    assert s.exclude_recursion is True
    assert s.prevent_recursion is True

    # 分组字段
    assert s.group == "dragons"
    assert s.group_override is True
    assert s.group_weight == 90

    # 基础字段回归
    assert s.probability == 80
    assert s.position == 0
    assert s.constant is False


def test_import_multiple_entries_sorted_by_order(
    client: TestClient,
    db_session: Session,
    auth_headers: dict,
):
    entries = {}
    for i, order in enumerate([30, 10, 20]):
        entries[str(i)] = {
            **LOREBOOK_ENTRY,
            "uid": i,
            "comment": f"entry-{i}",
            "content": f"content {i}",
            "key": [f"k{i}"],
            "order": order,
        }
    payload = {"name": "Order Book", "entries": entries}
    resp = client.post(
        "/api/worldbooks/import",
        headers=auth_headers,
        files={"file": ("order_book.json", json.dumps(payload).encode("utf-8"))},
    )
    assert resp.status_code == 200
    book_id = resp.json()["id"]

    stages = (
        db_session.query(WorldBookStage)
        .filter(WorldBookStage.world_book_id == book_id)
        .all()
    )
    assert len(stages) == 3
    orders = sorted(s.order for s in stages)
    assert orders == [10, 20, 30], f"order 应逐条目落库，实际 {orders}"
