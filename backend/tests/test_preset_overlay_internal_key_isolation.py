"""会话内部簿记键**永不出现在卡可见变量里** —— 批次P2 / P2-1，2026-10-21。

背景（主脑一手 grep，本文件写前复核过）：`__palink_internal_` 在 `backend/`
只命中 5 处生产码、`backend/tests/` **0 处** ⇒ P-1 的防外泄逻辑**没有任何
回归测试钉住**。本文件就是那颗钉子，钉三条：

  ① **卡可见变量集不含内部键**：`api/silly_tavern.py::_chat_header` 构造
     `chat_metadata.variables` 时跳过 `INTERNAL_KEY_PREFIX` 前缀的行；
     同一条路径上的用户变量必须**照旧出现**（否则"全跳过"也能让断言绿）。
  ② **内部行不被当成用户自建变量**：`/api/variables/local/{sid}` 列表里没有它，
     `PUT`/`DELETE` 也改不动它（覆盖层有专属端点，不许被变量面板静默破坏）。
  ③ **前缀判定用常量**：`INTERNAL_KEY_PREFIX` 是唯一来源，生产码里不再手写
     字面量 `"__palink_internal_"`（除常量定义处）。

反证（写进报告，本节也可复跑）：
  删掉 `silly_tavern.py` 里 `if v.key.startswith(INTERNAL_KEY_PREFIX): continue`
  那两行 ⇒ ① 必红；恢复 ⇒ 全绿。
"""

import os
import re
import sys

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.core.security import get_password_hash  # noqa: E402
from app.models import Character, CharacterChatSession, ChatVariable, User  # noqa: E402
from app.models.prompt_preset import PromptPreset  # noqa: E402
from app.services.preset_overlay import (  # noqa: E402
    INTERNAL_KEY_PREFIX,
    OVERLAY_KEY,
    write_overlay,
)

_APP_DIR = os.path.join(_BACKEND_DIR, "app")
_SILLY_TAVERN = os.path.join(_APP_DIR, "api", "silly_tavern.py")
_VARIABLES_API = os.path.join(_APP_DIR, "api", "variables.py")
_PRESET_OVERLAY = os.path.join(_APP_DIR, "services", "preset_overlay.py")


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


def _mk_character(db_session, user, name: str = "露缇雅") -> Character:
    character = Character(id="char-" + name, user_id=user.id, name=name)
    db_session.add(character)
    db_session.commit()
    db_session.refresh(character)
    return character


def _mk_session(db_session, user, character, sid: str) -> CharacterChatSession:
    """卡片真正用的会话表是 `character_chat_sessions`（见批次P2 报告「否证主脑」段）。"""
    session = CharacterChatSession(
        id=sid,
        user_id=user.id,
        character_id=character.id,
        title="t-" + sid,
    )
    db_session.add(session)
    db_session.commit()
    db_session.refresh(session)
    return session


def _mk_preset(db_session, user, name: str) -> PromptPreset:
    preset = PromptPreset(
        id="preset-" + name,
        user_id=user.id,
        name=name,
        entries='[{"id": "main", "content": "g"}]',
        config='{"temperature": 0.7}',
    )
    db_session.add(preset)
    db_session.commit()
    db_session.refresh(preset)
    return preset


def _write_overlay(db_session, user, session_id: str, preset: PromptPreset) -> dict:
    """走**生产写入路径**产生覆盖层行（不手搓 ChatVariable）。"""
    return write_overlay(
        db_session,
        user.id,
        session_id,
        entries=[{"id": "main", "content": "session-only"}],
        base_preset_id=preset.id,
    )


# ---------------------------------------------------------------------------
# ① 卡可见变量集
# ---------------------------------------------------------------------------
def test_card_visible_variables_exclude_internal_overlay_row(db_session, test_user):
    """`_chat_header` 是 getContext().chat_metadata.variables 的唯一构造点。"""
    from app.api.silly_tavern import _chat_header

    character = _mk_character(db_session, test_user)
    session = _mk_session(db_session, test_user, character, "sess-p21-header")
    preset = _mk_preset(db_session, test_user, "global-p21")
    # 一条正常的用户变量（对照组：它必须还在，否则"全跳过"也能让下面的断言绿）
    db_session.add(ChatVariable(session_id=session.id, key="好感度", value="12"))
    db_session.commit()

    _write_overlay(db_session, test_user, session.id, preset)
    # 生产路径确实落了覆盖层行（前置条件，防止"其实没写进去"导致假绿）
    overlay_row = (
        db_session.query(ChatVariable)
        .filter(ChatVariable.session_id == session.id, ChatVariable.key == OVERLAY_KEY)
        .first()
    )
    assert overlay_row is not None

    header = _chat_header(db_session, session, character, test_user, None)
    variables = header["chat_metadata"]["variables"]

    assert OVERLAY_KEY not in variables
    assert not any(str(key).startswith(INTERNAL_KEY_PREFIX) for key in variables)
    # 用户变量不受影响
    assert variables["好感度"] == 12


def test_card_visible_variables_still_carry_metadata_keys(db_session, test_user):
    """防"顺手把整个 variables 段删掉"：metadata 的既有键必须原样还在。"""
    from app.api.silly_tavern import _chat_header

    character = _mk_character(db_session, test_user)
    session = _mk_session(db_session, test_user, character, "sess-p21-meta")
    preset = _mk_preset(db_session, test_user, "global-p21-meta")
    _write_overlay(db_session, test_user, session.id, preset)

    header = _chat_header(db_session, session, character, test_user, None)
    metadata = header["chat_metadata"]
    assert metadata["palink_session_id"] == session.id
    assert metadata["palink_character_id"] == character.id
    assert metadata["bg"] == "__transparent.png"


# ---------------------------------------------------------------------------
# ② 变量列表 / 删除接口
# ---------------------------------------------------------------------------
def test_local_variable_list_hides_internal_rows(db_session, client, test_user):
    """变量面板（`/api/variables/local/{sid}`）不许把内部簿记行当用户变量列出来。"""
    character = _mk_character(db_session, test_user)
    session = _mk_session(db_session, test_user, character, "sess-p21-list")
    preset = _mk_preset(db_session, test_user, "global-p21-list")
    db_session.add(ChatVariable(session_id=session.id, key="心情", value="平静"))
    db_session.commit()
    _write_overlay(db_session, test_user, session.id, preset)

    res = client.get("/api/variables/local/" + session.id)
    assert res.status_code == 200, res.text
    body = res.json()
    assert OVERLAY_KEY not in body
    assert not any(str(key).startswith(INTERNAL_KEY_PREFIX) for key in body)
    assert body["心情"] == "平静"


def test_internal_row_cannot_be_deleted_or_overwritten_via_variables_api(db_session, client, test_user):
    """覆盖层有专属端点；变量面板的 PUT/DELETE 必须拒绝内部键（否则静默破坏副本）。"""
    character = _mk_character(db_session, test_user)
    session = _mk_session(db_session, test_user, character, "sess-p21-write")
    preset = _mk_preset(db_session, test_user, "global-p21-write")
    _write_overlay(db_session, test_user, session.id, preset)

    before = (
        db_session.query(ChatVariable)
        .filter(ChatVariable.session_id == session.id, ChatVariable.key == OVERLAY_KEY)
        .first()
        .value
    )

    deleted = client.delete("/api/variables/local/" + session.id + "/" + OVERLAY_KEY)
    assert deleted.status_code == 400, deleted.text
    overwritten = client.put(
        "/api/variables/local/" + session.id + "/" + OVERLAY_KEY,
        json={"value": "{}"},
    )
    assert overwritten.status_code == 400, overwritten.text

    db_session.expire_all()
    after = (
        db_session.query(ChatVariable)
        .filter(ChatVariable.session_id == session.id, ChatVariable.key == OVERLAY_KEY)
        .first()
        .value
    )
    assert after == before
    # 专属端点仍然能删（"关掉变量面板"不等于"关掉覆盖层"）
    dropped = client.delete("/api/prompt-manager/sessions/" + session.id + "/preset")
    assert dropped.status_code == 200, dropped.text
    assert dropped.json()["dropped"] is True


# ---------------------------------------------------------------------------
# ③ 前缀用常量，不是各处手写
# ---------------------------------------------------------------------------
def test_internal_prefix_is_a_single_constant_not_a_literal():
    """生产码里 `__palink_internal_` 只能出现在常量定义处（preset_overlay.py）。"""
    def read(path: str) -> str:
        with open(path, "r", encoding="utf-8") as handle:
            return handle.read()

    overlay_src = read(_PRESET_OVERLAY)
    assert 'INTERNAL_KEY_PREFIX = "__palink_internal_"' in overlay_src

    for path in (_SILLY_TAVERN, _VARIABLES_API):
        src = read(path)
        # 字面量（带引号）一处都不许有
        assert '"__palink_internal_"' not in src, path
        assert "'__palink_internal_'" not in src, path
        # 而是从常量导入并用于前缀判定
        assert "INTERNAL_KEY_PREFIX" in src, path
        assert re.search(r"startswith\(INTERNAL_KEY_PREFIX\)", src), path

    # 全 backend/app 扫一遍：只有常量定义那一处允许出现该字面量
    offenders = []
    literal = re.compile(r"""["']__palink_internal_["']""")
    for root, _dirs, files in os.walk(_APP_DIR):
        for name in files:
            if not name.endswith(".py"):
                continue
            full = os.path.join(root, name)
            if os.path.normpath(full) == os.path.normpath(_PRESET_OVERLAY):
                continue
            with open(full, "r", encoding="utf-8") as handle:
                if literal.search(handle.read()):
                    offenders.append(os.path.relpath(full, _BACKEND_DIR))
    assert offenders == []
