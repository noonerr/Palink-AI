"""批次UI1：设置控件补齐（作者注 / 全局破甲）的接口契约测试。

背景（盘点报告 `docs/_active/report/REPORT_ST设置前端可达性盘点_2026-10-21.md`）：
- 作者注四字段（`author_note` / `author_note_position` / `author_note_frequency` /
  `author_note_depth`）读写与装配消费本来就通，**纯缺控件** —— 本文件钉住
  "控件要能写进/读回这四格"的接口契约。
- 全局破甲 `UserSetting.jailbreak` 列早已存在（装配于批次JB接通），但
  `UserSettingUpdate` 没有这个字段 ⇒ 唯一写路径是 ST 兼容端点。
  本批只加 schema 字段（**不加列、不写迁移**），并定清空值语义：

      null（PUT）= 本次不修改（沿用全局 PUT 约定）
      ""        = 显式清空 = 不注入（装配侧 strip 后为空即跳过）
      非空串    = 注入内容

ST 一手锚点（参照树 d:/SillyTavern-release，2026-10-21 复核）：
- public/script.js:483-488         extension_prompt_types = NONE -1 / IN_PROMPT 0 / IN_CHAT 1 / BEFORE_PROMPT 2
- public/scripts/authors-note.js:272-274  DEFAULT_DEPTH=4 / DEFAULT_POSITION=1 / DEFAULT_INTERVAL=1
- public/index.html:7775-7779      Insertion Frequency "(0 = Disable, 1 = Always)"
- public/scripts/openai.js:103     default_jailbreak_prompt = ''（空 → 不注入）

⚠️ 本文件**不**改 `roleplay_prompt_assembly` / `character_message_builder` 的行为，
只验证"写进去的值能被读回并以既有语义生效"。
"""

import os
import sys
from types import SimpleNamespace

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.core.security import get_password_hash  # noqa: E402
from app.models import User, UserSetting  # noqa: E402
from app.services.character_message_builder import build_character_chat_messages  # noqa: E402


def _mk_user(db_session, username: str) -> User:
    user = User(
        username=username,
        hashed_password=get_password_hash("TestPassword1"),
        role="user",
        is_active=True,
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


def _get_setting(db_session, user_id: int) -> UserSetting:
    db_session.expire_all()
    setting = db_session.query(UserSetting).filter(UserSetting.user_id == user_id).first()
    assert setting is not None, "PUT /settings 应自动建行"
    return setting


def _mk_char() -> SimpleNamespace:
    return SimpleNamespace(
        id="ui1-char",
        name="UI1Char",
        description="D",
        personality="",
        scenario="",
        mes_example="",
        post_history_instructions=None,
        jailbreak=None,
    )


def _build_messages_with(db_session, setting: UserSetting):
    """用真实 UserSetting 行跑装配，确认写入的卷轴真的影响注入。"""
    return build_character_chat_messages(
        db=db_session,
        char=_mk_char(),
        user_nickname="Tester",
        session_id="ui1-sess",
        branch_id="ui1-branch",
        message="hello",
        images=[],
        system_prompt="SYS",
        dynamic_context_parts=[],
        prompt_lang="en",
        user_setting=setting,
        _replace_placeholders=lambda text, u, c: text,
        _get_full_branch_history=lambda *a, **k: [],
        _contains_chinese=lambda t: False,
        normalize_image_url=lambda url, check_size=False: url,
        include_user_message=True,
        include_title_instruction=False,
        context_template=None,
    )


# ---------------------------------------------------------------------------
# 全局破甲：读写 + 空值语义
# ---------------------------------------------------------------------------
def test_jailbreak_roundtrip_and_injection(client, db_session, test_user):
    """PUT 非空破甲 ⇒ GET 读回同一串，且装配真的把它插进消息序列。"""
    res = client.put(
        "/api/users/me/settings",
        json={"jailbreak": "GLOBAL JB FROM UI1"},
    )
    assert res.status_code == 200, res.text
    assert res.json() == {"status": "ok"}

    got = client.get("/api/users/me/settings")
    assert got.status_code == 200, got.text
    assert got.json()["jailbreak"] == "GLOBAL JB FROM UI1"

    setting = _get_setting(db_session, test_user.id)
    assert setting.jailbreak == "GLOBAL JB FROM UI1"

    contents = [m.get("content") for m in _build_messages_with(db_session, setting)]
    assert contents.count("GLOBAL JB FROM UI1") == 1


def test_jailbreak_empty_string_clears_and_means_no_injection(client, db_session, test_user):
    """空串 = 显式清空：落库是 ""（不是 NULL），装配侧不注入。"""
    client.put("/api/users/me/settings", json={"jailbreak": "TEMP JB"})
    assert _get_setting(db_session, test_user.id).jailbreak == "TEMP JB"

    res = client.put("/api/users/me/settings", json={"jailbreak": ""})
    assert res.status_code == 200, res.text
    got = client.get("/api/users/me/settings").json()
    assert got["jailbreak"] == ""

    setting = _get_setting(db_session, test_user.id)
    assert setting.jailbreak == "", "空串必须原样落库（不是 NULL）"
    contents = [m.get("content") for m in _build_messages_with(db_session, setting)]
    assert "TEMP JB" not in contents
    # 空破甲零回归：只有 system + user
    assert contents == ["SYS", "hello"]


def test_jailbreak_null_means_do_not_modify(client, db_session, test_user):
    """PUT null = 本次不修改（沿用 users.py PUT 的 None 约定），不是"清空"。"""
    client.put("/api/users/me/settings", json={"jailbreak": "KEEP ME"})
    res = client.put("/api/users/me/settings", json={"jailbreak": None})
    assert res.status_code == 200, res.text

    got = client.get("/api/users/me/settings").json()
    assert got["jailbreak"] == "KEEP ME"
    assert _get_setting(db_session, test_user.id).jailbreak == "KEEP ME"


def test_jailbreak_default_is_empty_string_for_fresh_user(client, test_user):
    """从未写过的用户：GET 回 ""，前端 textarea 直接可绑定（不是 null）。"""
    # GET /settings 有 30s TTL 缓存，且 SQLite in-memory 的 user id 会被复用；
    # 先失效本用户键，避免读到上一条用例的缓存（不是接口行为）。
    from app.core.cache import invalidate_cache

    invalidate_cache(f"user_settings:user={test_user.id}")
    got = client.get("/api/users/me/settings")
    assert got.status_code == 200, got.text
    assert got.json()["jailbreak"] == ""


# ---------------------------------------------------------------------------
# 作者注四字段：控件要能写进/读回
# ---------------------------------------------------------------------------
def test_author_note_four_fields_roundtrip(client, db_session, test_user):
    """位置 / 频率 / 深度与内容一起 PUT ⇒ GET 原样回；包含 ST 的 NONE(-1)。"""
    payload = {
        "author_note": "[AN] keep it short",
        "author_note_position": -1,
        "author_note_frequency": 3,
        "author_note_depth": 7,
    }
    res = client.put("/api/users/me/settings", json=payload)
    assert res.status_code == 200, res.text

    got = client.get("/api/users/me/settings").json()
    for key, value in payload.items():
        assert got[key] == value, f"{key} 未按写入值回读"

    setting = _get_setting(db_session, test_user.id)
    assert setting.author_note_position == -1
    assert setting.author_note_frequency == 3
    assert setting.author_note_depth == 7

    # 位置 = -1(NONE) ⇒ 即使有内容也不注入（ST extension_prompt_types.NONE 语义）
    contents = [m.get("content") for m in _build_messages_with(db_session, setting)]
    assert all("keep it short" not in str(c) for c in contents)


def test_author_note_position_accepts_all_st_extension_prompt_types(client):
    """ST 四个取值（-1/0/1/2）都必须能落库、能读回（控件下拉的四项）。"""
    for position in (-1, 0, 1, 2):
        res = client.put(
            "/api/users/me/settings",
            json={"author_note": "AN", "author_note_position": position},
        )
        assert res.status_code == 200, f"position={position}: {res.text}"
        assert client.get("/api/users/me/settings").json()["author_note_position"] == position


# ---------------------------------------------------------------------------
# 越权：users/me 结构上只能写自己，这里钉住隔离效果
# ---------------------------------------------------------------------------
def test_settings_write_is_self_scoped(client, db_session, test_user):
    """换成用户 2 身份 PUT ⇒ 只写用户 2 自己的行，用户 1 的破甲原样不动。"""
    other = _mk_user(db_session, "ui1_other_user")

    client.put("/api/users/me/settings", json={"jailbreak": "USER1 JB"})
    assert _get_setting(db_session, test_user.id).jailbreak == "USER1 JB"

    from app.api.dependencies import get_current_user
    from app.main import app

    async def _as_other():
        return other

    app.dependency_overrides[get_current_user] = _as_other
    try:
        res = client.put("/api/users/me/settings", json={"jailbreak": "USER2 JB"})
        assert res.status_code == 200, res.text
        assert client.get("/api/users/me/settings").json()["jailbreak"] == "USER2 JB"
    finally:
        app.dependency_overrides.pop(get_current_user, None)

    db_session.expire_all()
    assert _get_setting(db_session, test_user.id).jailbreak == "USER1 JB"
    assert _get_setting(db_session, other.id).jailbreak == "USER2 JB"
