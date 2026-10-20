"""全局"选中哪份预设"的落点 —— 批次P2 / P2-2，2026-10-21。

用户裁定（2026-10-20 第 1 条）：预设 = 每对话一份分身，进卡默认用"用户在设置里选的那份"。
P-1 只做了会话覆盖层，`resolve_global_preset()` 取的是"`updated_at` 最新那份"并在
docstring 里自认是已知偏差。本文件钉住 P2-2 补上的那个落点：

  ① 选中 A ⇒ `resolve_global_preset` 返回 A（哪怕 B 更新更晚）；
  ② 改选 B ⇒ 返回 B；
  ③ **从未选过** ⇒ 回落"最近更新那份"（兼容回落，口径写死在测试里）；
  ④ 越权：用户 2 不能选中用户 1 的预设名（404），且用户 1 的选中名不受影响。

落点约束（施工件 §4）：**零迁移** —— 不建表、不加列、不写 alembic。
本文件另有一条断言直接钉住"落点就在 `UserSetting.silly_tavern_settings` 里"，
防止有人把它悄悄改成新列/新表。
"""

import json
import os
import sys

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.core.security import get_password_hash  # noqa: E402
from app.models import User, UserSetting  # noqa: E402
from app.models.prompt_preset import PromptPreset  # noqa: E402
from app.services.preset_overlay import (  # noqa: E402
    SELECTION_FIELD,
    SELECTION_NAMESPACE,
    get_selected_preset_name,
    resolve_global_preset,
    resolve_global_preset_source,
)


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


def _mk_preset(db_session, user, name: str, updated_at=None) -> PromptPreset:
    preset = PromptPreset(
        id="preset-" + name,
        user_id=user.id,
        name=name,
        entries='[{"id": "main", "content": "' + name + '"}]',
        config='{"temperature": 0.7}',
    )
    if updated_at is not None:
        preset.updated_at = updated_at
    db_session.add(preset)
    db_session.commit()
    db_session.refresh(preset)
    return preset


# ---------------------------------------------------------------------------
# ① / ② 选中 → 改选
# ---------------------------------------------------------------------------
def test_selected_preset_wins_over_newest_updated(db_session, client, test_user):
    """选中 A 后，`resolve_global_preset` 返回 A —— 即使 B 的 updated_at 更晚。"""
    from datetime import datetime, timezone

    a = _mk_preset(db_session, test_user, "预设A", datetime(2026, 10, 1, tzinfo=timezone.utc))
    b = _mk_preset(db_session, test_user, "预设B", datetime(2026, 10, 20, tzinfo=timezone.utc))

    # 选之前：旧口径（最近更新）会拿到 B —— 这是对照组，证明下面的断言不是恒真
    assert resolve_global_preset(db_session, test_user.id).id == b.id
    assert resolve_global_preset_source(db_session, test_user.id) == "fallback"

    res = client.put("/api/prompt-manager/presets/selection", json={"name": "预设A"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["selected_name"] == "预设A"
    assert body["resolved_name"] == "预设A"
    assert body["resolved_id"] == a.id
    assert body["source"] == "selected"

    assert resolve_global_preset(db_session, test_user.id).id == a.id

    # 改选 B ⇒ 返回 B
    res = client.put("/api/prompt-manager/presets/selection", json={"name": "预设B"})
    assert res.status_code == 200, res.text
    assert res.json()["resolved_id"] == b.id
    assert resolve_global_preset(db_session, test_user.id).id == b.id

    # 查询面与写入面一致
    got = client.get("/api/prompt-manager/presets/selection")
    assert got.status_code == 200, got.text
    assert got.json()["selected_name"] == "预设B"
    assert got.json()["resolved_id"] == b.id


def test_selection_is_stored_in_existing_user_setting_json_column(db_session, client, test_user):
    """零迁移的正面锚点：名字落在 `UserSetting.silly_tavern_settings` 的命名空间里。

    这条断言故意读**列里的原文**而不是调 getter —— 有人把落点改成新列/新表时，
    这里立刻红（施工件 §4：不许建表加列）。
    """
    _mk_preset(db_session, test_user, "预设C")
    client.put("/api/prompt-manager/presets/selection", json={"name": "预设C"})

    setting = db_session.query(UserSetting).filter(UserSetting.user_id == test_user.id).first()
    assert setting is not None
    blob = json.loads(setting.silly_tavern_settings or "{}")
    assert blob[SELECTION_NAMESPACE][SELECTION_FIELD] == "预设C"
    # `prompt_presets` 那行一个字节都没动（选中名不是预设内容）
    preset = db_session.query(PromptPreset).filter(PromptPreset.name == "预设C").first()
    assert preset.entries == '[{"id": "main", "content": "预设C"}]'


# ---------------------------------------------------------------------------
# ③ 从未选过 ⇒ 回落
# ---------------------------------------------------------------------------
def test_never_selected_falls_back_to_newest_updated(db_session, client, test_user):
    """从未选过 ⇒ 回落"最近更新那份"（P-1 旧口径原样保留为兼容回落）。"""
    from datetime import datetime, timezone

    _mk_preset(db_session, test_user, "旧预设", datetime(2026, 9, 1, tzinfo=timezone.utc))
    newest = _mk_preset(db_session, test_user, "新预设", datetime(2026, 10, 19, tzinfo=timezone.utc))

    assert get_selected_preset_name(db_session, test_user.id) is None
    assert resolve_global_preset(db_session, test_user.id).id == newest.id
    assert resolve_global_preset_source(db_session, test_user.id) == "fallback"

    body = client.get("/api/prompt-manager/presets/selection").json()
    assert body["selected_name"] is None
    assert body["resolved_name"] == "新预设"
    assert body["source"] == "fallback"


def test_selection_pointing_at_deleted_preset_falls_back(db_session, client, test_user):
    """选中名失效（预设被删）⇒ 回落，不是 500、也不是 None。"""
    from datetime import datetime, timezone

    keep = _mk_preset(db_session, test_user, "留下", datetime(2026, 10, 2, tzinfo=timezone.utc))
    gone = _mk_preset(db_session, test_user, "会被删", datetime(2026, 10, 3, tzinfo=timezone.utc))
    client.put("/api/prompt-manager/presets/selection", json={"name": "会被删"})
    assert resolve_global_preset(db_session, test_user.id).id == gone.id

    client.delete("/api/prompt-manager/presets/" + gone.id)
    # 选中名还在（没被偷偷清掉），但解析落到剩下的那份
    assert get_selected_preset_name(db_session, test_user.id) == "会被删"
    assert resolve_global_preset(db_session, test_user.id).id == keep.id
    assert resolve_global_preset_source(db_session, test_user.id) == "fallback"


def test_no_preset_at_all_resolves_to_none(db_session, client, test_user):
    """一份预设都没有 ⇒ None，且不因为"选过"就造出东西来。"""
    assert resolve_global_preset(db_session, test_user.id) is None
    assert resolve_global_preset_source(db_session, test_user.id) == "none"
    body = client.get("/api/prompt-manager/presets/selection").json()
    assert body["resolved_id"] is None


def test_clearing_selection_returns_to_fallback(db_session, client, test_user):
    """`{"name": null}` = 清除选择 ⇒ 回到"从未选过"的回落口径。"""
    from datetime import datetime, timezone

    _mk_preset(db_session, test_user, "甲", datetime(2026, 10, 4, tzinfo=timezone.utc))
    newest = _mk_preset(db_session, test_user, "乙", datetime(2026, 10, 5, tzinfo=timezone.utc))
    client.put("/api/prompt-manager/presets/selection", json={"name": "甲"})
    assert resolve_global_preset(db_session, test_user.id).name == "甲"

    res = client.put("/api/prompt-manager/presets/selection", json={"name": None})
    assert res.status_code == 200, res.text
    assert res.json()["selected_name"] is None
    assert resolve_global_preset(db_session, test_user.id).id == newest.id


# ---------------------------------------------------------------------------
# ④ 越权
# ---------------------------------------------------------------------------
def test_user_cannot_select_another_users_preset(db_session, client, test_user):
    """用户 1 的预设名对用户 2 不可选（404），且用户 1 的选中名不受影响。"""
    other = _mk_user(db_session, "preset_selection_other")
    _mk_preset(db_session, test_user, "用户1的预设")

    res = client.put("/api/prompt-manager/presets/selection", json={"name": "用户1的预设"})
    assert res.status_code == 200, res.text
    assert get_selected_preset_name(db_session, test_user.id) == "用户1的预设"

    # 换成"用户 2"的身份去打同一个端点：越权必须 404，不是静默成功
    from app.api.dependencies import get_current_user
    from app.main import app

    async def _as_other():
        return other

    app.dependency_overrides[get_current_user] = _as_other
    try:
        blocked = client.put("/api/prompt-manager/presets/selection", json={"name": "用户1的预设"})
        assert blocked.status_code == 404, blocked.text
        assert get_selected_preset_name(db_session, other.id) is None
        # 查询面也不泄露别人的选择
        assert client.get("/api/prompt-manager/presets/selection").json()["selected_name"] is None
    finally:
        app.dependency_overrides.pop(get_current_user, None)

    # 用户 1 的选中名原样还在
    db_session.expire_all()
    assert get_selected_preset_name(db_session, test_user.id) == "用户1的预设"
