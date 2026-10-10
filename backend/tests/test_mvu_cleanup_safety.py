"""MVU 变量清理的**安全边界**测试（2026-10-05 立）。

`test_mvu_cleanup.py` 钉的是"清理行为对不对"；本文件钉的是**"清理会不会误伤别的东西"**——
清理是破坏性操作，一次误伤就是数据丢失。五组：

1. **不碰别的东西**：extra 里的 reasoning/model/ext_prompts/gen_id、``mvu_patch``（恢复的命根子）、
   消息正文与 swipes、会话级 ``chat_metadata.variables``、``chat_variables`` 表
2. **作用域隔离**：只动目标分支 / 只动目标会话 / 设置按 (用户, 卡) 隔离
3. **提示词装配不受影响**：清理后 ``_load_effective_stat_data`` 在保留窗口内取值不变
4. **体积真的下降**：给出前后对比数字（不是"感觉小了"）
5. **HTTP 端点**：手动清理端点可用、越权返 404

运行: py -3 -m pytest tests/test_mvu_cleanup_safety.py -q
"""
from __future__ import annotations

import json
import uuid

from app.services.mvu_cleanup import (
    PATCH_EXTRA_KEY,
    run_auto_cleanup_for_session,
    run_manual_cleanup,
)


# ---------------------------------------------------------------------------
# 建世界（带分支 / 带丰富 extra）
# ---------------------------------------------------------------------------


def _rich_extra(floor: int) -> dict:
    """一份"真实形状"的 extra：除了 variables，还带落库时同批写入的其它键。"""
    return {
        "variables": {
            "stat_data": {"好感度": floor, "世界信息": {"地点": "教室"}},
            "schema": {"好感度": 0},
            "initialized_lorebooks": {"wb": [1, 2, 3]},
        },
        "mvu_patch": [{"op": "replace", "path": "/好感度", "value": floor}],
        "reasoning": f"第 {floor} 楼的思考链",
        "reasoning_type": "thinking",
        "model": "test-model",
        "token_count": 100 + floor,
        "gen_id": f"gen-{floor}",
        "ext_prompts": {"some": "evidence"},
    }


def _make_world(db_session, *, floors: int = 0, branch_id=None, suffix: str = ""):
    from app.models import (
        Character,
        CharacterChatMessage,
        CharacterChatSession,
        User,
    )

    tag = suffix or uuid.uuid4().hex[:8]
    user = User(
        username=f"mvu_safe_{tag}",
        hashed_password="dummy",
        role="user",
        is_active=True,
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)

    char = Character(
        user_id=user.id,
        name=f"安全测试卡{tag}",
        description="d",
        personality="",
        scenario="",
        first_mes="",
        mes_example="",
        system_prompt="",
        post_history_instructions="",
        alternate_greetings="[]",
        tags="[]",
        creator_notes="",
        creator="test",
        character_version="1.0",
        extensions="{}",
    )
    db_session.add(char)
    db_session.commit()
    db_session.refresh(char)

    session = CharacterChatSession(
        id=f"mvu-safe-{uuid.uuid4().hex[:8]}",
        user_id=user.id,
        character_id=char.id,
        title="safety session",
        chat_metadata=json.dumps(
            {"variables": {"stat_data": {"好感度": 999, "会话级": True}}},
            ensure_ascii=False,
        ),
    )
    db_session.add(session)
    db_session.commit()
    db_session.refresh(session)

    for i in range(floors):
        db_session.add(
            CharacterChatMessage(
                session_id=session.id,
                branch_id=branch_id,
                role="assistant",
                content=f"floor {i + 1}",
                swipes=json.dumps([f"floor {i + 1}", f"floor {i + 1} alt"]),
                extra=json.dumps(_rich_extra(i + 1), ensure_ascii=False),
            )
        )
    db_session.commit()
    return user, char, session


def _enable(db_session, user_id: int, character_id: str, keep: int = 2, interval: int = 50):
    from app.models import UserSetting

    setting = db_session.query(UserSetting).filter(UserSetting.user_id == user_id).first()
    if setting is None:
        setting = UserSetting(user_id=user_id)
        db_session.add(setting)
    setting.silly_tavern_settings = json.dumps(
        {
            "plugin_extension_settings_by_character": {
                str(character_id): {
                    "mvu_settings": {
                        "自动清理变量": {
                            "启用": True,
                            "快照保留间隔": interval,
                            "要保留变量的最近楼层数": keep,
                        }
                    }
                }
            }
        },
        ensure_ascii=False,
    )
    db_session.commit()


def _rows(db_session, session_id: str, branch_id=None):
    from app.models import CharacterChatMessage

    q = db_session.query(CharacterChatMessage).filter(
        CharacterChatMessage.session_id == session_id
    )
    if branch_id is not None:
        q = q.filter(CharacterChatMessage.branch_id == branch_id)
    return q.order_by(CharacterChatMessage.id).all()


def _extras(rows):
    return [json.loads(r.extra or "{}") for r in rows]


# ---------------------------------------------------------------------------
# 1. 不碰别的东西
# ---------------------------------------------------------------------------


class TestDoesNotTouchOtherData:
    def test_other_extra_keys_survive(self, db_session):
        """reasoning / model / token_count / gen_id / ext_prompts 一个都不能少。"""
        user, char, session = _make_world(db_session, floors=10)
        _enable(db_session, user.id, char.id)
        run_auto_cleanup_for_session(db_session, session.id)
        db_session.commit()

        for extra in _extras(_rows(db_session, session.id)):
            assert extra["reasoning"].startswith("第 ")
            assert extra["reasoning_type"] == "thinking"
            assert extra["model"] == "test-model"
            assert extra["token_count"] > 100
            assert extra["gen_id"].startswith("gen-")
            assert extra["ext_prompts"] == {"some": "evidence"}

    def test_mvu_patch_survives_cleanup(self, db_session):
        """``mvu_patch`` 是恢复（重演）的唯一原料 —— 清理绝不能把它带走。"""
        user, char, session = _make_world(db_session, floors=10)
        _enable(db_session, user.id, char.id)
        run_auto_cleanup_for_session(db_session, session.id)
        db_session.commit()

        for idx, extra in enumerate(_extras(_rows(db_session, session.id)), start=1):
            assert extra.get(PATCH_EXTRA_KEY) == [
                {"op": "replace", "path": "/好感度", "value": idx}
            ], f"第 {idx} 楼补丁丢失"

    def test_message_content_and_swipes_untouched(self, db_session):
        user, char, session = _make_world(db_session, floors=10)
        _enable(db_session, user.id, char.id)
        before = [(r.content, r.swipes, r.swipe_id) for r in _rows(db_session, session.id)]

        run_auto_cleanup_for_session(db_session, session.id)
        db_session.commit()

        after = [(r.content, r.swipes, r.swipe_id) for r in _rows(db_session, session.id)]
        assert after == before, "正文 / swipes / swipe_id 不得被清理碰到"

    def test_session_level_variables_untouched(self, db_session):
        """会话级 ``chat_metadata.variables`` 是提示词注入的真源，清它等于直接崩。"""
        user, char, session = _make_world(db_session, floors=10)
        _enable(db_session, user.id, char.id)
        before = session.chat_metadata

        run_auto_cleanup_for_session(db_session, session.id)
        db_session.commit()
        db_session.refresh(session)
        assert session.chat_metadata == before

    def test_chat_variables_table_untouched(self, db_session):
        """``chat_variables`` 是 ST 客户端镜像，属另一条链路。"""
        from app.models import ChatVariable

        user, char, session = _make_world(db_session, floors=10)
        _enable(db_session, user.id, char.id)
        db_session.add(ChatVariable(session_id=session.id, key="stat_data", value='{"a":1}'))
        db_session.commit()

        run_auto_cleanup_for_session(db_session, session.id)
        db_session.commit()

        row = db_session.query(ChatVariable).filter(
            ChatVariable.session_id == session.id
        ).first()
        assert row is not None and row.value == '{"a":1}'


# ---------------------------------------------------------------------------
# 2. 作用域隔离
# ---------------------------------------------------------------------------


class TestScopeIsolation:
    def test_only_target_session(self, db_session):
        u1, c1, s1 = _make_world(db_session, floors=10, suffix="a")
        u2, c2, s2 = _make_world(db_session, floors=10, suffix="b")
        _enable(db_session, u1.id, c1.id)
        _enable(db_session, u2.id, c2.id)
        before2 = [r.extra for r in _rows(db_session, s2.id)]

        run_auto_cleanup_for_session(db_session, s1.id)
        db_session.commit()

        after2 = [r.extra for r in _rows(db_session, s2.id)]
        assert after2 == before2, "另一个会话不得被碰到"

    def test_only_target_branch(self, db_session):
        """只动**当前活跃分支**；非活跃分支的楼层原样保留。"""
        from app.models import CharacterChatMessage, CharacterChatSessionBranch

        user, char, session = _make_world(db_session, floors=0)
        active = CharacterChatSessionBranch(
            id=f"br-active-{uuid.uuid4().hex[:6]}",
            session_id=session.id,
            branch_name="主分支",
            is_active=True,
        )
        other = CharacterChatSessionBranch(
            id=f"br-other-{uuid.uuid4().hex[:6]}",
            session_id=session.id,
            branch_name="旧分支",
            is_active=False,
        )
        db_session.add_all([active, other])
        db_session.commit()

        for br in (active.id, other.id):
            for i in range(10):
                db_session.add(
                    CharacterChatMessage(
                        session_id=session.id,
                        branch_id=br,
                        role="assistant",
                        content=f"{br} floor {i + 1}",
                        extra=json.dumps(_rich_extra(i + 1), ensure_ascii=False),
                    )
                )
        db_session.commit()
        _enable(db_session, user.id, char.id)

        before_other = [r.extra for r in _rows(db_session, session.id, other.id)]
        run_auto_cleanup_for_session(db_session, session.id)
        db_session.commit()

        after_other = [r.extra for r in _rows(db_session, session.id, other.id)]
        assert after_other == before_other, "非活跃分支不得被清理"

        active_extras = _extras(_rows(db_session, session.id, active.id))
        assert active_extras[1]["variables"].get("stat_data") is None, "活跃分支应被清理"

    def test_settings_are_per_user(self, db_session):
        from app.services.mvu_cleanup import CleanupSettings, resolve_cleanup_settings

        u1, c1, _s1 = _make_world(db_session, suffix="u1")
        u2, c2, _s2 = _make_world(db_session, suffix="u2")
        _enable(db_session, u1.id, c1.id, keep=3)
        # u2 显式关闭
        from app.models import UserSetting

        st = db_session.query(UserSetting).filter(UserSetting.user_id == u2.id).first()
        if st is None:
            st = UserSetting(user_id=u2.id)
            db_session.add(st)
        st.silly_tavern_settings = json.dumps(
            {
                "plugin_extension_settings_by_character": {
                    str(c2.id): {"mvu_settings": {"自动清理变量": {"启用": False}}}
                }
            }
        )
        db_session.commit()

        assert resolve_cleanup_settings(db_session, u1.id, c1.id).enabled is True
        assert resolve_cleanup_settings(db_session, u2.id, c2.id).enabled is False
        # u2 的设置不会渗到 u1
        assert resolve_cleanup_settings(db_session, u1.id, c1.id) != CleanupSettings(enabled=False)

    def test_settings_are_per_character(self, db_session):
        from app.services.mvu_cleanup import resolve_cleanup_settings

        user, char, _session = _make_world(db_session)
        _enable(db_session, user.id, char.id, keep=7)
        # 同用户的另一张卡：没有设置 → 默认
        assert resolve_cleanup_settings(db_session, user.id, "another-char-id") != (
            resolve_cleanup_settings(db_session, user.id, char.id)
        )
        assert resolve_cleanup_settings(db_session, user.id, "another-char-id").keep_recent_floors == 20


# ---------------------------------------------------------------------------
# 3. 提示词装配不受影响（SPEC §7 验收项）
# ---------------------------------------------------------------------------


class TestPromptAssemblyUnaffected:
    def test_effective_stat_data_unchanged_within_keep_window(self, db_session):
        """保留窗口内的取值必须逐字节不变 —— 这是提示词注入的读路径。"""
        from app.services.roleplay_prompt_assembly import _load_effective_stat_data

        user, char, session = _make_world(db_session, floors=10)
        _enable(db_session, user.id, char.id, keep=2)

        before = _load_effective_stat_data(db_session, session.id)
        run_auto_cleanup_for_session(db_session, session.id)
        db_session.commit()
        after = _load_effective_stat_data(db_session, session.id)

        assert before == after, "清理不得改变装配侧读到的 stat_data"
        assert after["好感度"] == 10, "应取最新一楼的快照"

    def test_falls_back_to_session_level_when_window_has_no_snapshot(self, db_session):
        """窗口内全无快照时回落会话级 —— 降级路径必须**不抛异常**（可见即可，不静默崩）。"""
        from app.services.roleplay_prompt_assembly import _load_effective_stat_data

        user, char, session = _make_world(db_session, floors=6)
        # keep=0 → i = 6，6 楼也被清；再把 5、6 楼也清掉，构造"窗口内无快照"
        _enable(db_session, user.id, char.id, keep=0)
        run_manual_cleanup(
            db_session,
            session_id=session.id,
            branch_id=None,
            character_id=char.id,
            user_id=user.id,
            depth=0,
        )
        db_session.commit()

        got = _load_effective_stat_data(db_session, session.id)
        assert got is not None, "应回落会话级而不是返回 None"
        assert got.get("会话级") is True, "回落值就是会话级 stat_data"


# ---------------------------------------------------------------------------
# 4. 体积真的下降
# ---------------------------------------------------------------------------


class TestVolumeReduction:
    def test_bytes_drop_measurably(self, db_session):
        """用手动清理（清 1..end）测体积 —— 自动清理一次只扫一小段窗口（插件同款）。"""
        user, char, session = _make_world(db_session, floors=30)
        _enable(db_session, user.id, char.id, keep=2, interval=50)

        def total_bytes() -> int:
            return sum(
                len(
                    json.dumps(
                        json.loads(r.extra or "{}").get("variables") or {},
                        ensure_ascii=False,
                    ).encode("utf-8")
                )
                for r in _rows(db_session, session.id)
            )

        before = total_bytes()
        run_manual_cleanup(
            db_session,
            session_id=session.id,
            branch_id=None,
            character_id=char.id,
            user_id=user.id,
            depth=2,
        )
        db_session.commit()
        after = total_bytes()

        assert after < before, "清理后体积必须下降"
        drop = 1 - after / before
        print(f"\n[体积] {before} B -> {after} B（降 {drop * 100:.0f}%）")
        assert drop > 0.8, f"清 28/30 楼后降幅应超 8 成，实测 {drop * 100:.0f}%"

    def test_auto_cleanup_only_scans_its_window(self, db_session):
        """反证上一条：自动清理**一次只动一段窗口**，不是全表扫（插件同款滚动覆盖）。"""
        user, char, session = _make_world(db_session, floors=30)
        _enable(db_session, user.id, char.id, keep=2, interval=50)

        cleaned = run_auto_cleanup_for_session(db_session, session.id)
        db_session.commit()
        # n = 30-2 = 28；start = max(1, 28-2-4) = 22 → 只清 22..28 共 7 楼
        assert cleaned == 7, f"自动清理应只清窗口内的 7 楼，实测 {cleaned}"

        extras = _extras(_rows(db_session, session.id))
        assert extras[0]["variables"].get("stat_data") is not None, "1 楼不在窗口内"
        assert extras[25]["variables"].get("stat_data") is None, "26 楼在窗口内，应被清"


# ---------------------------------------------------------------------------
# 6. 消息级快照必须真的被读到（存量 bug 的回归守卫）
# ---------------------------------------------------------------------------


class TestMessageLevelSnapshotActuallyRead:
    """[EXTRA-STR-FIX 2026-10-05] `extra` 列是 Text（JSON 字符串）。

    ``_load_effective_stat_data`` 原实现直接 ``isinstance(extra, dict)`` 判断 ——
    对字符串恒为 False → **从未取到过消息级快照**，一直静默回落会话级。
    本组是那条修复的回归守卫（修之前这里必红）。
    """

    def test_message_level_wins_over_session_level(self, db_session):
        from app.models import CharacterChatMessage
        from app.services.roleplay_prompt_assembly import _load_effective_stat_data

        user, char, session = _make_world(db_session, floors=0)
        db_session.add(
            CharacterChatMessage(
                session_id=session.id,
                branch_id=None,
                role="assistant",
                content="x",
                extra=json.dumps(
                    {"variables": {"stat_data": {"来源": "消息级", "楼层": 1}}},
                    ensure_ascii=False,
                ),
            )
        )
        db_session.commit()

        got = _load_effective_stat_data(db_session, session.id)
        assert got is not None
        assert got.get("来源") == "消息级", "消息级快照必须优先于会话级"

    def test_extra_column_really_is_a_json_string(self, db_session):
        """把"extra 是字符串"这个前提钉住 —— 它是上面那条 bug 的根因。"""
        from app.models import CharacterChatMessage

        user, char, session = _make_world(db_session, floors=1)
        row = (
            db_session.query(CharacterChatMessage)
            .filter(CharacterChatMessage.session_id == session.id)
            .first()
        )
        assert isinstance(row.extra, str), (
            "extra 列若是 dict，则 EXTRA-STR-FIX 的解析分支是多余的；"
            "若改成 JSON 类型列，本测试会红 —— 届时同步改 _load_effective_stat_data"
        )
        assert isinstance(json.loads(row.extra), dict)


# ---------------------------------------------------------------------------
# 5. HTTP 端点
# ---------------------------------------------------------------------------


class TestApiEndpoint:
    def _make_for_test_user(self, db_session, test_user, *, floors: int = 8):
        from app.models import Character, CharacterChatMessage, CharacterChatSession

        char = Character(
            user_id=test_user.id,
            name=f"端点卡{uuid.uuid4().hex[:6]}",
            description="d",
            personality="",
            scenario="",
            first_mes="",
            mes_example="",
            system_prompt="",
            post_history_instructions="",
            alternate_greetings="[]",
            tags="[]",
            creator_notes="",
            creator="test",
            character_version="1.0",
            extensions="{}",
        )
        db_session.add(char)
        db_session.commit()
        db_session.refresh(char)

        session = CharacterChatSession(
            id=f"mvu-ep-{uuid.uuid4().hex[:8]}",
            user_id=test_user.id,
            character_id=char.id,
            title="endpoint session",
            chat_metadata="{}",
        )
        db_session.add(session)
        db_session.commit()
        for i in range(floors):
            db_session.add(
                CharacterChatMessage(
                    session_id=session.id,
                    branch_id=None,
                    role="assistant",
                    content=f"floor {i + 1}",
                    extra=json.dumps(_rich_extra(i + 1), ensure_ascii=False),
                )
            )
        db_session.commit()
        return char, session

    def test_manual_cleanup_endpoint(self, client, auth_headers, db_session, test_user):
        char, session = self._make_for_test_user(db_session, test_user, floors=8)
        resp = client.post(
            f"/api/character-sessions/{session.id}/mvu-cleanup",
            headers=auth_headers,
            json={"depth": 3},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["depth"] == 3
        assert body["cleaned"] == 5, "8 楼保留末尾 3 楼 → 清 1..5"

        rows = _rows(db_session, session.id)
        assert json.loads(rows[4].extra)["variables"].get("stat_data") is None
        assert json.loads(rows[7].extra)["variables"]["stat_data"] is not None

    def test_endpoint_404_for_foreign_session(self, client, auth_headers, db_session):
        """别人的会话必须 404（不返 403 —— 403 等于确认该 id 存在，可被探测）。"""
        _other_user, _char, foreign = _make_world(db_session, floors=3, suffix="foreign")
        resp = client.post(
            f"/api/character-sessions/{foreign.id}/mvu-cleanup",
            headers=auth_headers,
            json={"depth": 1},
        )
        assert resp.status_code == 404
