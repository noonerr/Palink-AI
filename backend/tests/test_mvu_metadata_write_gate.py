"""PUT /api/character-sessions/{sid}/metadata 写入闸门回归（P0-2 门 A，2026-10-05）。

## 背景

原实现是裸 `existing.update(body)`：无键白名单、无类型校验、无大小限制。
而前端送的是**整个** `window.chat_metadata`（`lib/sillytavern/getContext.ts`
`_persistChatMetadata`），于是任何让 `window.chat_metadata` 变成「插件局部视图」
的路径都会把服务端真源整份换掉。

## 刻意不禁 `variables`（这是本文件最关键的一条）

实测：本端点是会话变量（stat_data）从前端落库的**唯一**通道
（`/api/variables/global` 是全局量，不是会话量）。若照 SPEC 字面上「至少禁
variables」去禁，卡脚本的变量写入会彻底失效 = 回归。

故改为**只拦明显是坏的输入**，并把「合法整包覆盖」保留下来（有反向守卫钉住）。

| 闸门 | 行为 |
|---|---|
| `palink_*` | 一律剔除（内部路由/注入键，插件不得设置） |
| `variables` 非 dict | 忽略，不拿垃圾覆盖真源 |
| `variables` 空 dict 且库里非空 | 忽略并告警（「整份被清空」的典型症状） |
| 其余键 | 照常写入（含合法的 variables 整包覆盖） |

运行: cd backend && py -3 -m pytest tests/test_mvu_metadata_write_gate.py -q
"""
import json

import pytest

from app.models import Character, CharacterChatSession


SID = "sess-meta-gate"
CID = "char-meta-gate"


@pytest.fixture()
def session_with_metadata(db_session, test_user):
    db_session.add(Character(id=CID, user_id=test_user.id, name="门A卡"))
    db_session.add(
        CharacterChatSession(
            id=SID,
            user_id=test_user.id,
            character_id=CID,
            title="门A",
            chat_metadata=json.dumps(
                {
                    "palink_injections": [{"id": "origin"}],
                    "variables": {"stat_data": {"好感度": 10}},
                    "note_prompt": "元提示词",
                },
                ensure_ascii=False,
            ),
        )
    )
    db_session.commit()
    return SID


def _put(client, auth_headers, session_id, body):
    return client.put(
        f"/api/character-sessions/{session_id}/metadata",
        headers=auth_headers,
        json=body,
    )


def _stored(db_session, session_id):
    s = db_session.query(CharacterChatSession).filter_by(id=session_id).one()
    return json.loads(s.chat_metadata) if isinstance(s.chat_metadata, str) else (s.chat_metadata or {})


def test_palink_keys_are_rejected(client, auth_headers, db_session, session_with_metadata):
    """★ 主回归：插件不得通过本端点篡改 palink_* 内部键。

    改坏方式：去掉 startswith("palink_") 的剔除循环，本用例会读到被篡改的值而变红。
    """
    resp = _put(
        client, auth_headers, session_with_metadata,
        {
            "palink_injections": [{"id": "hacked"}],
            "palink_character_id": "attacker",
        },
    )
    assert resp.status_code == 200, resp.text[:400]
    stored = _stored(db_session, session_with_metadata)
    assert stored["palink_injections"] == [{"id": "origin"}], (
        f"palink_injections 被插件改写了：{stored['palink_injections']}"
    )
    assert "palink_character_id" not in stored, "插件塞进来的 palink_* 键没被剔除"


def test_empty_variables_does_not_wipe_stored(client, auth_headers, db_session, session_with_metadata):
    """★ 主回归：传空 dict 而库里非空 = 「整份被清空」的症状，必须忽略。

    改坏方式：去掉空 dict 那条分支，本用例会读到 variables 被清空而变红。
    """
    resp = _put(client, auth_headers, session_with_metadata, {"variables": {}})
    assert resp.status_code == 200, resp.text[:400]
    stored = _stored(db_session, session_with_metadata)
    assert stored["variables"]["stat_data"]["好感度"] == 10, (
        f"空 dict 把 stat_data 整份清掉了：{stored.get('variables')}"
    )


def test_non_dict_variables_is_ignored(client, auth_headers, db_session, session_with_metadata):
    """非 dict 的 variables 不得覆盖真源。"""
    resp = _put(client, auth_headers, session_with_metadata, {"variables": "not-a-dict"})
    assert resp.status_code == 200, resp.text[:400]
    stored = _stored(db_session, session_with_metadata)
    assert stored["variables"]["stat_data"]["好感度"] == 10, (
        f"非 dict 覆盖了真源：{stored.get('variables')}"
    )


def test_legit_variables_overwrite_still_works(client, auth_headers, db_session, session_with_metadata):
    """反向守卫：合法的整包覆盖必须照常生效 —— 这是卡脚本变量落库的唯一通道。

    ⚠️ 若哪天有人「照 SPEC 字面」把 variables 整键禁掉，本用例会立刻变红。
    """
    resp = _put(
        client, auth_headers, session_with_metadata,
        {"variables": {"stat_data": {"好感度": 77}}},
    )
    assert resp.status_code == 200, resp.text[:400]
    stored = _stored(db_session, session_with_metadata)
    assert stored["variables"]["stat_data"]["好感度"] == 77, (
        f"合法的变量覆盖被挡住了 —— 这会让卡脚本变量写入彻底失效：{stored.get('variables')}"
    )


def test_normal_keys_still_persist(client, auth_headers, db_session, session_with_metadata):
    """普通键（note_prompt 等）不受闸门影响。"""
    resp = _put(client, auth_headers, session_with_metadata, {"note_prompt": "新提示词"})
    assert resp.status_code == 200, resp.text[:400]
    stored = _stored(db_session, session_with_metadata)
    assert stored["note_prompt"] == "新提示词"
    # 未被提交的键必须原样保留
    assert stored["variables"]["stat_data"]["好感度"] == 10


def test_other_users_session_is_404(client, auth_headers, session_with_metadata):
    resp = _put(client, auth_headers, "sess-not-mine", {"note_prompt": "x"})
    assert resp.status_code == 404, f"越权应 404，实际 {resp.status_code}"
