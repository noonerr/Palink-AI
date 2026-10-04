"""MVU 读写两扇门的回归（P0-1 / P0-2 门 B，2026-10-05）。

## 这两条为什么值得单独立文件

它们都属于「**静态读码看不出来、跑起来也未必立刻报错**」的那类故障：
数据被静默写坏 / 读旧，界面上表现为「变量明明更新了，但拿到的是旧值」。

### P0-1 读优先级倒挂

`_chat_header` 把 `chat_metadata.variables`（MVU 引擎写的真源）与
`ChatVariable` 表行合并时，旧实现是

    merged = dict(base)          # base = chat_metadata.variables
    merged.update(db_variables)  # ChatVariable 行「后写覆盖」→ 优先级反而更高

只要历史上任何一次 saveChat 带着 variables 落过一行
`ChatVariable(key="stat_data")`，那行的值就**永久遮蔽**此后 MVU 引擎对
`chat_metadata` 的全部更新。本文件把它钉成「chat_metadata 胜出」。

### P0-2 门 B：chats/save 的整包覆写

`POST /api/chats/save` 只在 payload 里**带 chat_metadata 条目**时才用它当新值；
插件的 `setChatMessages` 走 `slice(1)` 把 header 切掉，**天然不带该条目** ——
旧实现此时 persisted_metadata 仍是 `{}`，只回填 `palink_*` 后整份写回，
于是 `variables` / `note_prompt` / `hidden_bots` 被**一次调用清空**。

运行: cd backend && py -3 -m pytest tests/test_mvu_read_priority_and_save_gate.py -q
"""
import json

import pytest

from app.models import Character, CharacterChatSession
from app.models.chat_variable import ChatVariable


SID = "sess-mvu-read-priority"
CID = "char-mvu-read-priority"


# ─────────────────────────────────────────────────────────────────────────────
# P0-1 · 读优先级
# ─────────────────────────────────────────────────────────────────────────────
@pytest.fixture()
def session_with_conflicting_variables(db_session, test_user):
    """建会话：chat_metadata 里 stat_data.好感度=10，ChatVariable 表里同一键=1。

    外加一个只存在于 ChatVariable 表里的键 `only_in_db`，用于验证
    「以 chat_metadata 为准」不等于「丢掉 DB 侧独有的键」。
    """
    char = Character(id=CID, user_id=test_user.id, name="读优先级卡")
    db_session.add(char)
    db_session.add(
        CharacterChatSession(
            id=SID,
            user_id=test_user.id,
            character_id=CID,
            title="读优先级",
            chat_metadata=json.dumps(
                {"variables": {"stat_data": {"好感度": 10}}, "note_prompt": "元提示词"},
                ensure_ascii=False,
            ),
        )
    )
    db_session.add(
        ChatVariable(session_id=SID, key="stat_data", value=json.dumps({"好感度": 1}))
    )
    db_session.add(ChatVariable(session_id=SID, key="only_in_db", value=json.dumps({"k": "v"})))
    db_session.commit()
    return SID


def _call_chat_header(db_session, test_user, session_id):
    """直接调真函数（不是 grep 源码）：真实 ORM 对象 + 真实 DB 会话。"""
    from app.api.silly_tavern import _chat_header

    session = db_session.query(CharacterChatSession).filter_by(id=session_id).one()
    character = db_session.query(Character).filter_by(id=session.character_id).one()
    return _chat_header(db_session, session, character, test_user, None)


def test_chat_metadata_wins_over_chat_variable_rows(
    db_session, test_user, session_with_conflicting_variables
):
    """★ P0-1 主回归：chat_metadata.variables 必须压过 ChatVariable 行的旧值。

    改坏方式：把 `_chat_header` 里的顺序换回 merged = dict(base); update(db_variables)。
    本用例会读到 好感度 == 1（旧值）而变红。
    """
    header = _call_chat_header(db_session, test_user, session_with_conflicting_variables)
    stat = header["chat_metadata"]["variables"]["stat_data"]
    assert stat["好感度"] == 10, (
        f"读到了 ChatVariable 行的旧值（{stat['好感度']}），说明 chat_metadata 真源 "
        f"被反向遮蔽 —— 正是 P0-1 要修的倒挂"
    )


def test_db_only_keys_are_still_merged(db_session, test_user, session_with_conflicting_variables):
    """「以 chat_metadata 为准」不等于丢弃 DB 侧独有键 —— 只补缺，不清场。"""
    header = _call_chat_header(db_session, test_user, session_with_conflicting_variables)
    variables = header["chat_metadata"]["variables"]
    assert variables["only_in_db"] == {"k": "v"}, (
        f"ChatVariable 里独有的键被丢了：{sorted(variables)}"
    )


def test_note_prompt_survives_header_build(db_session, test_user, session_with_conflicting_variables):
    """无关键不应被合并逻辑影响（守卫：别把整包 variables 的处理外溢到别的键）。"""
    header = _call_chat_header(db_session, test_user, session_with_conflicting_variables)
    assert header["chat_metadata"]["note_prompt"] == "元提示词"


# ─────────────────────────────────────────────────────────────────────────────
# P0-2 门 B · chats/save 不带 chat_metadata 时不得清空
# ─────────────────────────────────────────────────────────────────────────────
def _create_character_via_api(client, auth_headers, name: str) -> dict:
    resp = client.post(
        "/api/characters/create",
        headers=auth_headers,
        json={"name": name, "description": "d", "personality": "p",
              "first_mes": "hi", "scenario": "s"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_save_without_metadata_entry_keeps_variables(client, auth_headers, db_session, test_user):
    """★ P0-2 门 B 主回归：payload 无 chat_metadata 条目时，不得清空既有 metadata。

    复现路径：插件 setChatMessages 走 slice(1) 切掉 header → 天然不带该条目 →
    旧实现把 variables / note_prompt 整份抹掉。

    改坏方式：把 `if not has_incoming_metadata:` 那段去掉（回到只回填 palink_*），
    本用例会读到 variables 缺失而变红。
    """
    created = _create_character_via_api(client, auth_headers, name="SaveGate Char")
    avatar = created["avatar"]

    # ① 先带 metadata 条目种值
    seed_resp = client.post(
        "/api/chats/save",
        headers=auth_headers,
        json={
            "avatar_url": avatar,
            "ch_name": "SaveGate Chat",
            "chat": [
                {"chat_metadata": {
                    "variables": {"stat_data": {"好感度": 7}},
                    "note_prompt": "元提示词",
                    "hidden_bots": ["bot-1"],
                }},
                {"name": "User", "is_user": True, "mes": "hello",
                 "send_date": "2024-01-01T00:00:00"},
            ],
        },
    )
    assert seed_resp.status_code == 200, seed_resp.text

    # ② 再不带 metadata 条目调用一次（插件热路径）
    wipe_resp = client.post(
        "/api/chats/save",
        headers=auth_headers,
        json={
            "avatar_url": avatar,
            "ch_name": "SaveGate Chat",
            "chat": [
                {"name": "User", "is_user": True, "mes": "hello",
                 "send_date": "2024-01-01T00:00:00"},
                {"name": "SaveGate Char", "is_user": False, "mes": "hi",
                 "send_date": "2024-01-01T00:01:00"},
            ],
        },
    )
    assert wipe_resp.status_code == 200, wipe_resp.text

    # ③ 直读库，确认 metadata 还在
    session = (
        db_session.query(CharacterChatSession)
        .filter(CharacterChatSession.user_id == test_user.id)
        .order_by(CharacterChatSession.created_at.desc())
        .first()
    )
    assert session is not None
    meta = json.loads(session.chat_metadata) if isinstance(session.chat_metadata, str) else (session.chat_metadata or {})

    assert "variables" in meta, (
        f"payload 没带 chat_metadata 条目就把 variables 整份清掉了 "
        f"（现存键：{sorted(meta)}）—— 正是 P0-2 门 B 要修的整包覆写"
    )
    assert meta["variables"]["stat_data"]["好感度"] == 7
    assert meta["note_prompt"] == "元提示词"
    assert meta["hidden_bots"] == ["bot-1"]


def test_save_with_metadata_entry_still_replaces(client, auth_headers, db_session, test_user):
    """反向守卫：payload **带了** chat_metadata 条目时，仍应照常整包替换。

    防止「门 B 修过头」——把合法的整包覆盖也一并禁掉。
    """
    created = _create_character_via_api(client, auth_headers, name="SaveGate2 Char")
    avatar = created["avatar"]

    client.post(
        "/api/chats/save",
        headers=auth_headers,
        json={
            "avatar_url": avatar,
            "ch_name": "SaveGate2 Chat",
            "chat": [{"chat_metadata": {"variables": {"stat_data": {"好感度": 1}}}}],
        },
    )
    resp = client.post(
        "/api/chats/save",
        headers=auth_headers,
        json={
            "avatar_url": avatar,
            "ch_name": "SaveGate2 Chat",
            "chat": [{"chat_metadata": {"variables": {"stat_data": {"好感度": 99}}}}],
        },
    )
    assert resp.status_code == 200, resp.text

    session = (
        db_session.query(CharacterChatSession)
        .filter(CharacterChatSession.user_id == test_user.id)
        .order_by(CharacterChatSession.created_at.desc())
        .first()
    )
    meta = json.loads(session.chat_metadata) if isinstance(session.chat_metadata, str) else (session.chat_metadata or {})
    assert meta["variables"]["stat_data"]["好感度"] == 99, (
        f"带 metadata 条目时应照常覆盖，实际得到 {meta.get('variables')}"
    )
