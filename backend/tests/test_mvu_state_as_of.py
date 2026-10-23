"""`mvu_state.resolve_stat_data_as_of` 的行为型测试（2026-10-22 批次 MS-1）。

钉的是老板 2026-10-22 的验收线：**切分支、看不同楼层时，取到的必须是那条故事线、
那一楼层的状态**。判据全部用「值不相等」表达，不靠读源码文本。

⚠️ 本文件即旧 bug 的**反证守卫**：`test_never_falls_back_to_session_metadata` 里放了一份
诱饵 `chat_metadata`（第 -1 楼），任何"取不到就回落会话级"的改动都会让它变红。
旧实现正是靠那条回落，把「回跳第 2 楼显示第 100 楼数据」变成了常态。
取证见 `docs/_active/report/REPORT_变量清理与故事线回跳_取证_2026-10-22.md` §3。
"""

from __future__ import annotations

import json

import pytest

from app.models import (
    CharacterChatMessage,
    CharacterChatSession,
    CharacterChatSessionBranch,
)
from app.services.mvu_state import MARK_UNAVAILABLE, resolve_stat_data_as_of


def _vars(**stat) -> str:
    return json.dumps({"variables": {"stat_data": stat}}, ensure_ascii=False)


def _pruned(patch=None) -> str:
    """清理后的形态：明细被摘，只留 `pruned` 痕迹 +（可选）重演原料补丁。"""
    payload = {"variables": {"pruned": True}}
    if patch is not None:
        payload["mvu_patch"] = patch
    return json.dumps(payload, ensure_ascii=False)


def _make_session(db, user, *, decoy=None):
    sess = CharacterChatSession(
        user_id=user.id,
        title="t-mvu-state",
        chat_metadata=json.dumps(
            {"variables": {"stat_data": {"好感度": -1}}} if decoy else {},
            ensure_ascii=False,
        ),
    )
    db.add(sess)
    db.flush()
    return sess


def _make_branch(db, sess, branch_id, *, parent_branch_id=None, parent_message_id=None):
    db.add(
        CharacterChatSessionBranch(
            id=branch_id,
            session_id=sess.id,
            branch_name=branch_id,
            parent_branch_id=parent_branch_id,
            parent_message_id=parent_message_id,
            is_active=True,
        )
    )
    db.flush()
    return branch_id


def _msg(db, sess, branch_id, *, role, extra=None, content="x"):
    m = CharacterChatMessage(
        session_id=sess.id,
        branch_id=branch_id,
        role=role,
        content=content,
        is_user=role == "user",
        is_system=False,
        is_locked=False,
        swipe_id=0,
        swipes=json.dumps([content], ensure_ascii=False),
        extra=extra,
    )
    db.add(m)
    db.flush()
    return m


def test_viewpoint_returns_that_floor_not_the_latest(db_session, test_user):
    """★ 核心判据：视点在哪一楼，就拿哪一楼的状态，而不是该分支最新那份。"""
    sess = _make_session(db_session, test_user)
    br = _make_branch(db_session, sess, "br-main")
    _msg(db_session, sess, br, role="assistant", extra=_vars(好感度=1))
    f2 = _msg(db_session, sess, br, role="assistant", extra=_vars(好感度=2))
    _msg(db_session, sess, br, role="assistant", extra=_vars(好感度=100))
    db_session.commit()

    got = resolve_stat_data_as_of(
        db_session, sess.id, br, as_of_message_id=f2.id
    )
    assert got.available is True
    assert got.stat_data == {"好感度": 2}
    assert got.reason == "floor"

    tip = resolve_stat_data_as_of(db_session, sess.id, br)
    assert tip.stat_data == {"好感度": 100}, "不带视点时应取分支最新一楼"


def test_pruned_floor_is_replayed_from_patches(db_session, test_user):
    """明细被自动清理摘掉的楼层 ⇒ 用该楼留存的补丁重演，算出"到这一楼"的值。"""
    sess = _make_session(db_session, test_user)
    br = _make_branch(db_session, sess, "br-main")
    _msg(db_session, sess, br, role="assistant", extra=_vars(好感度=1))
    f2 = _msg(
        db_session, sess, br, role="assistant",
        extra=_pruned([{"op": "replace", "path": "/好感度", "value": 7}]),
    )
    _msg(db_session, sess, br, role="assistant", extra=_vars(好感度=99))
    db_session.commit()

    got = resolve_stat_data_as_of(
        db_session, sess.id, br, as_of_message_id=f2.id
    )
    assert got.stat_data == {"好感度": 7}, got
    assert got.reason == "replay"
    # 上游四项参数不动的前提下，"保留 20 楼之外"的楼层靠重演而非回落，这条必须成立
    assert got.stat_data != {"好感度": 99}


def test_multi_branch_session_never_falls_back_to_session_metadata(db_session, test_user):
    """★ 反证守卫：会话一旦有第二条故事线，那份会话级诱饵值就绝不能被当成某楼的历史值。

    旧实现在消息级取不到时静默读 `chat_metadata.variables`，实测库里那份与全库
    48 条消息级 `stat_data` 中的 **0 条**相等 ⇒ 它不是任何楼层的真实状态；
    而 `switch_branch` 不重置它（`character_ext.py:3704-3735`）⇒ 切分支后必然串味。
    把本例的诱饵注回去 ⇒ `test` 立刻变红（本批已实测该敏感性）。
    """
    sess = _make_session(db_session, test_user, decoy=True)
    _make_branch(db_session, sess, "br-a")
    br_b = _make_branch(db_session, sess, "br-b")  # 有第二条 ⇒ 禁止兜底
    _msg(db_session, sess, br_b, role="user", content="没有变量的楼层")
    db_session.commit()

    got = resolve_stat_data_as_of(db_session, sess.id, br_b)
    assert got.available is False
    assert got.stat_data is None
    assert got.reason == "empty"
    assert got.stat_data != {"好感度": -1}, "跨故事线兜底"


def test_single_branch_tip_read_keeps_live_store_semantics(db_session, test_user):
    """单分支会话没有"别的故事线"可串 ⇒ 视点=最新楼时保留上游的实时 store 语义；
    但**视点被指到某一楼**时同样禁止兜底（那是要看历史，不是看当前）。"""
    sess = _make_session(db_session, test_user, decoy=True)
    br = _make_branch(db_session, sess, "br-solo")
    f1 = _msg(db_session, sess, br, role="user", content="没有变量的楼层")
    db_session.commit()

    tip = resolve_stat_data_as_of(db_session, sess.id, br)
    assert tip.reason == "trunk_live"
    assert tip.stat_data == {"好感度": -1}, "单分支 + 最新视点：实时值合法"

    as_of = resolve_stat_data_as_of(db_session, sess.id, br, as_of_message_id=f1.id)
    assert as_of.available is False, "明确指定楼层历史视点时不得用实时值顶替"


def test_batch_scan_returns_each_floor_own_value(db_session, test_user):
    """★ 逐楼下发的判据：同一批里第 2 楼拿到第 2 楼的值、最新楼拿到最新楼的值。

    这是给「卡片逐楼状态栏」补明细的那条路径（`_materialize_floor_variables_for_display`）
    的行为底座 —— 没有它，前端对历史楼层就只剩会话级可用。
    """
    from app.services.mvu_state import resolve_stat_data_by_message_ids

    sess = _make_session(db_session, test_user, decoy=True)
    br = _make_branch(db_session, sess, "br-main")
    f1 = _msg(db_session, sess, br, role="assistant", extra=_vars(好感度=1))
    f2 = _msg(
        db_session, sess, br, role="assistant",
        extra=_pruned([{"op": "replace", "path": "/好感度", "value": 2}]),
    )
    f3 = _msg(
        db_session, sess, br, role="assistant",
        extra=_pruned([{"op": "replace", "path": "/好感度", "value": 3}]),
    )
    f4 = _msg(db_session, sess, br, role="assistant", extra=_vars(好感度=100))
    db_session.commit()

    got = resolve_stat_data_by_message_ids(
        db_session, sess.id, br, [f1.id, f2.id, f3.id, f4.id]
    )
    assert got[f1.id].stat_data == {"好感度": 1}, got[f1.id]
    assert got[f2.id].stat_data == {"好感度": 2}, "第 2 楼必须拿到第 2 楼的值"
    assert got[f3.id].stat_data == {"好感度": 3}
    assert got[f4.id].stat_data == {"好感度": 100}
    assert got[f2.id].stat_data != {"好感度": 100}, "串味"
    assert got[f2.id].reason == "replay"
    assert got[f4.id].reason == "floor"


def test_batch_scan_marks_unreconstructible_as_empty(db_session, test_user):
    """重演原料也没有的楼层 ⇒ available=False（下发侧据此标 unavailable，不编值）。"""
    from app.services.mvu_state import resolve_stat_data_by_message_ids

    sess = _make_session(db_session, test_user, decoy=True)
    br = _make_branch(db_session, sess, "br-old")
    f1 = _msg(db_session, sess, br, role="assistant", extra=_pruned())
    db_session.commit()

    got = resolve_stat_data_by_message_ids(db_session, sess.id, br, [f1.id])
    assert got[f1.id].available is False
    assert got[f1.id].reason == "empty"
    assert got[f1.id].stat_data != {"好感度": -1}, "不得用会话级诱饵顶替"


def test_branch_without_lineage_does_not_see_sibling(db_session, test_user):
    """父指针缺失（现库 32 行分支全为 NULL）⇒ 该分支只能当独立故事线，绝不并兄弟分支的值。"""
    sess = _make_session(db_session, test_user, decoy=True)
    br_a = _make_branch(db_session, sess, "br-a")
    _msg(db_session, sess, br_a, role="assistant", extra=_vars(好感度=50))
    br_b = _make_branch(db_session, sess, "br-b")  # 无父指针
    _msg(db_session, sess, br_b, role="assistant", extra=_vars(好感度=3))
    db_session.commit()

    got = resolve_stat_data_as_of(db_session, sess.id, br_b)
    assert got.stat_data == {"好感度": 3}
    assert got.stat_data != {"好感度": 50}, "跨分支串味"


def test_ancestor_chain_is_truncated_at_fork_point(db_session, test_user):
    """父指针齐备时：祖先分支只带到分叉点，分叉点之后的楼层不得污染子分支状态。"""
    sess = _make_session(db_session, test_user)
    br_a = _make_branch(db_session, sess, "br-a")
    _msg(db_session, sess, br_a, role="assistant", extra=_vars(好感度=1))
    fork = _msg(db_session, sess, br_a, role="assistant", extra=_vars(好感度=2))
    _msg(db_session, sess, br_a, role="assistant", extra=_vars(好感度=4))

    br_b = _make_branch(
        db_session, sess, "br-b", parent_branch_id=br_a, parent_message_id=fork.id
    )
    _msg(
        db_session, sess, br_b, role="assistant",
        extra=_pruned([{"op": "replace", "path": "/好感度", "value": 20}]),
    )
    db_session.commit()

    got = resolve_stat_data_as_of(db_session, sess.id, br_b)
    assert got.stat_data == {"好感度": 20}, got
    assert got.stat_data != {"好感度": 4}, "分叉点之后的祖先楼层被并进来了"
    assert got.floors_scanned == 3, "祖先 2 楼（截断到分叉点）+ 本分支 1 楼"


def test_missing_material_is_reported_not_guessed(db_session, test_user, caplog):
    """重演原料缺口 ⇒ 如实标 `replay_partial` 并留稳定标记，不许悄悄当作"没变化"。"""
    sess = _make_session(db_session, test_user)
    br = _make_branch(db_session, sess, "br-main")
    _msg(db_session, sess, br, role="assistant", extra=_vars(好感度=1))
    _msg(db_session, sess, br, role="assistant", extra=_pruned())  # 明细没了、补丁也没有
    _msg(db_session, sess, br, role="assistant", extra=_pruned())
    db_session.commit()

    with caplog.at_level("WARNING"):
        got = resolve_stat_data_as_of(db_session, sess.id, br)

    assert got.reason == "replay_partial"
    assert 2 in got.missing_floors and 3 in got.missing_floors
    assert MARK_UNAVAILABLE in caplog.text, "静默失败必须可被 grep 到"


# ─────────────────────────────────────────────────────────────────────────────
# 4. 切换分支的响应也必须带变量（批次 MS-2 收尾：switch 与 GET 共用同一段接线）
#
# 修前 `switch_branch` 只回 `messages`，前端 `CharacterView.switchBranch` 也只
# `setMessages` ⇒ 页面级变量仍是上一条故事线的那份，逐楼更是拿不到被清理楼层
# 自己的值。下面两条钉住「接口真的接线了」，而不是内核能算出来而已。
# ─────────────────────────────────────────────────────────────────────────────
def _seed_two_storylines(db, user):
    """两条故事线：br-a（另一条，值 50）+ br-main（目标，含一层明细被清理的楼）。

    会话级 `chat_metadata` 放诱饵 -1：页面级变量若来自它而不是
    `resolve_stat_data_as_of`，下面的断言立刻变红。
    """
    sess = _make_session(db, user, decoy=True)
    br_a = _make_branch(db, sess, "br-a")
    _msg(db, sess, br_a, role="assistant", extra=_vars(好感度=50))
    br_main = _make_branch(db, sess, "br-main")
    _msg(db, sess, br_main, role="assistant", extra=_vars(好感度=1))
    f2 = _msg(
        db, sess, br_main, role="assistant",
        extra=_pruned([{"op": "replace", "path": "/好感度", "value": 2}]),
    )
    db.commit()
    return sess, br_main, f2


def _switch(client, session_id, branch_id):
    r = client.post(f"/api/character-sessions/{session_id}/branches/{branch_id}/switch?limit=10")
    assert r.status_code == 200, r.text
    return r.json()


def test_switch_branch_response_carries_floor_and_page_variables(client, db_session, test_user):
    """★ switch 响应里：被清理楼层拿到自己的值，页面级拿到视点分支的值。"""
    sess, br_main, f2 = _seed_two_storylines(db_session, test_user)

    body = _switch(client, sess.id, br_main)

    floor = next(
        (m for m in body.get("messages", []) if int(m.get("id")) == int(f2.id)), None
    )
    assert floor is not None, f"第 {f2.id} 楼不在 switch 响应里"
    assert (floor.get("extra") or {}).get("mvu_state_source") == "replay"
    assert ((floor.get("extra") or {}).get("variables") or {}).get("stat_data") == {"好感度": 2}, (
        "被清理摘掉明细的楼层没拿到该楼自己的 stat_data"
    )

    page = body.get("variables") or {}
    assert page.get("mvu_state_source") == "replay", page
    assert page.get("stat_data") == {"好感度": 2}, page
    assert page.get("stat_data") != {"好感度": -1}, "页面级变量回落到了会话级诱饵"
    assert page.get("stat_data") != {"好感度": 50}, "页面级变量串到了另一条故事线"
    assert body.get("active_branch_id") == br_main


def test_switch_branch_variable_backfill_does_not_write_db(client, db_session, test_user):
    """★ 逐楼补值只改响应载荷：调用前后消息行逐字节一致，库里的被清理楼层仍是摘掉态。"""
    sess, br_main, f2 = _seed_two_storylines(db_session, test_user)

    def snapshot():
        db_session.expire_all()
        rows = (
            db_session.query(CharacterChatMessage)
            .filter(CharacterChatMessage.session_id == sess.id)
            .order_by(CharacterChatMessage.id)
            .all()
        )
        return [(m.id, m.extra, m.content, m.branch_id) for m in rows]

    before = snapshot()
    _switch(client, sess.id, br_main)
    after = snapshot()
    assert after == before, "switch 把逐楼补值写回了库"

    db_session.expire_all()
    stored = (
        db_session.query(CharacterChatMessage)
        .filter(CharacterChatMessage.id == f2.id)
        .one()
    )
    stored_variables = (json.loads(stored.extra or "{}").get("variables")) or {}
    assert "stat_data" not in stored_variables, "库里的被清理楼层被补写"
