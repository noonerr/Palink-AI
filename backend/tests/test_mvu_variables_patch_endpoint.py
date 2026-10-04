"""POST /api/character-sessions/{sid}/variables/patch 回归（2026-10-05 第二波）。

## 为什么单独一个文件

这是**变量写入链路**的新端点，上游 SPEC 明确要求「必须单独做、单独验」。
它同时是第一波 P0-1 的下游：P0-1 保证 chat_metadata 是读侧真源，
本端点保证写侧也落在 chat_metadata —— 读写同源，才不会出现「改完读不回来」。

## 钉住的四件事

1. 归属校验（别人的 session 一律 404，防水平越权）
2. 补丁真的应用并回写（行为断言：调真端点 → 直读库）
3. `_` 前缀只读（MVU 的约定，不能被面板改掉）
4. **不凭空初始化** —— 会话没初始化过就 409，而不是用 initvar 造一份

运行: cd backend && py -3 -m pytest tests/test_mvu_variables_patch_endpoint.py -q
"""
import json

import pytest

from app.models import Character, CharacterChatSession


SID = "sess-mvu-patch"
CID = "char-mvu-patch"
OTHER_SID = "sess-mvu-patch-other"


@pytest.fixture()
def session_with_variables(db_session, test_user):
    char = Character(id=CID, user_id=test_user.id, name="补丁卡")
    db_session.add(char)
    db_session.add(
        CharacterChatSession(
            id=SID,
            user_id=test_user.id,
            character_id=CID,
            title="补丁会话",
            chat_metadata=json.dumps(
                {
                    # note_prompt 是 variables 的**同级**键（真实形状）；
                    # 改变量时它必须原样保留 —— 本文件有专门的守卫用例盯这件事。
                    "note_prompt": "元提示词",
                    "variables": {
                        "stat_data": {"角色": {"络络": {"好感度": 10}}, "_meta": {"v": 1}},
                    },
                },
                ensure_ascii=False,
            ),
        )
    )
    db_session.commit()
    return SID


def _stored_variables(db_session, session_id):
    session = db_session.query(CharacterChatSession).filter_by(id=session_id).one()
    raw = session.chat_metadata
    meta = json.loads(raw) if isinstance(raw, str) else (raw or {})
    return meta.get("variables")


def _patch(client, auth_headers, session_id, patches):
    return client.post(
        f"/api/character-sessions/{session_id}/variables/patch",
        headers=auth_headers,
        json={"patches": patches},
    )


def test_patch_applies_and_persists(client, auth_headers, db_session, session_with_variables):
    """★ 主回归：补丁真的应用，且回写到 chat_metadata.variables。"""
    # ⚠️ 路径是**相对 stat_data** 的：apply_patches 内部先
    # `target = stat_data.get("stat_data", stat_data)` 再应用，最后包回 result["stat_data"]。
    # 写成 /stat_data/角色/... 会创建出 stat_data.stat_data.角色 这层多余的嵌套。
    resp = _patch(
        client, auth_headers, session_with_variables,
        [{"op": "replace", "path": "/角色/络络/好感度", "value": 42}],
    )
    assert resp.status_code == 200, resp.text[:500]
    body = resp.json()
    assert body["ok"] is True

    stored = _stored_variables(db_session, session_with_variables)
    assert stored["stat_data"]["角色"]["络络"]["好感度"] == 42, (
        f"补丁没落库：{stored}"
    )
    # 返回值应等于落库值（面板可直接拿去刷新，不必再读一次）
    assert body["variables"]["stat_data"]["角色"]["络络"]["好感度"] == 42


def test_patch_does_not_touch_sibling_keys(client, auth_headers, db_session, session_with_variables):
    """改一个字段不得把同级其它字段 / 其它顶层键弄丢。"""
    resp = _patch(
        client, auth_headers, session_with_variables,
        [{"op": "replace", "path": "/角色/络络/好感度", "value": 7}],
    )
    assert resp.status_code == 200, resp.text[:300]

    stored = _stored_variables(db_session, session_with_variables)
    assert stored["stat_data"]["角色"]["络络"]["好感度"] == 7
    # note_prompt 与 (variables 之外的) 元数据键必须原样保留
    session = db_session.query(CharacterChatSession).filter_by(id=session_with_variables).one()
    meta = json.loads(session.chat_metadata) if isinstance(session.chat_metadata, str) else {}
    assert meta["note_prompt"] == "元提示词"


def test_readonly_underscore_prefix_is_skipped(client, auth_headers, db_session, session_with_variables):
    """`_` 前缀是 MVU 的只读约定，面板不得改掉。"""
    # 同一批发两条：一条只读路径、一条正常路径。
    # 只断言「只读的值没变」是不**可证伪**的 —— 若 readonly_prefix 被写成空串，
    # 所有路径都会被跳过，值同样不变、用例照样绿。因此必须同时要求
    # 「正常路径确实被应用了」，才能把「正确跳过」与「全部跳过」区分开。
    resp = _patch(
        client, auth_headers, session_with_variables,
        [
            {"op": "replace", "path": "/_meta/v", "value": 999},
            {"op": "replace", "path": "/角色/络络/好感度", "value": 55},
        ],
    )
    assert resp.status_code == 200, resp.text[:300]
    stored = _stored_variables(db_session, session_with_variables)
    assert stored["stat_data"]["_meta"]["v"] == 1, (
        f"`_` 前缀被改了（{stored['stat_data']['_meta']}），违反 MVU 只读约定"
    )
    assert stored["stat_data"]["角色"]["络络"]["好感度"] == 55, (
        "同批的**正常**路径没被应用 —— 说明不是「只读跳过」而是「整批被跳过」，"
        "此时上一条断言会假绿"
    )
    assert any("skip readonly" in str(line) for line in resp.json()["logs"]), (
        f"日志里没有 skip readonly 记录：{resp.json()['logs']}"
    )


def test_uninitialized_session_returns_409(client, auth_headers, db_session, test_user):
    """会话没初始化过 → 409，而不是凭空用 initvar 造一份。

    改坏方式：在端点里加 init 兜底，本用例会变成 200 而变红。
    """
    # 自建一张卡，避免与其它用例共用 CID 触发跨用例外键/唯一约束耦合
    other_char_id = "char-mvu-patch-uninit"
    db_session.add(Character(id=other_char_id, user_id=test_user.id, name="未初始化卡"))
    db_session.add(
        CharacterChatSession(
            id=OTHER_SID, user_id=test_user.id, character_id=other_char_id, title="未初始化",
            chat_metadata=json.dumps({"note_prompt": "x"}, ensure_ascii=False),
        )
    )
    db_session.commit()

    resp = _patch(
        client, auth_headers, OTHER_SID,
        [{"op": "replace", "path": "/a", "value": 1}],
    )
    assert resp.status_code == 409, (
        f"未初始化会话应 409（拒绝凭空初始化），实际 {resp.status_code}"
    )


def test_other_users_session_is_404(client, auth_headers, db_session, session_with_variables):
    """水平越权防护：别人的 session 一律 404。"""
    resp = _patch(
        client, auth_headers, "sess-not-mine",
        [{"op": "replace", "path": "/a", "value": 1}],
    )
    assert resp.status_code == 404, f"越权访问应 404，实际 {resp.status_code}"


def test_empty_patches_is_noop(client, auth_headers, db_session, session_with_variables):
    """空补丁不该报错，也不该改变数据。"""
    before = _stored_variables(db_session, session_with_variables)
    resp = _patch(client, auth_headers, session_with_variables, [])
    assert resp.status_code == 200, resp.text[:300]
    assert _stored_variables(db_session, session_with_variables) == before
