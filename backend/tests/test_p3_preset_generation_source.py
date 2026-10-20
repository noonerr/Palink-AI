"""批次P3（2026-10-21）—— 预设数据源改指 `generation_presets` + **共享行红线**。

两条必须一起钉（主脑执行件 P3-B）：

  ① **数据源改指**：包P 的覆盖层、P2-2 的选中名、P2-3 的三键原先建在
     `prompt_presets` 上 —— 那张表**全库 0 行**，也没有第一方界面在用它
     （一手读数见 `docs/_active/report/REPORT_上线实测_包P与批次Q1与批次P2_2026-10-21.md` §2.2：
     `prompt_presets` = 0 行 / `generation_presets` = 27 行 / `/api/prompt-manager/presets` = `[]`）。
     用户 2026-10-20 的裁定是"默认刚进卡是**设置里自己的那份**"，而设置里那份
     就在 `generation_presets`（`PresetManager.tsx` → `/api/roleplay/presets`）
     ⇒ 不改指就违反裁定。本文件钉住"解析落到 `generation_presets`"。

  ② **共享行红线**：`backend/app/api/presets.py:114-115` 的列表条件含
     `GenerationPreset.user_id == None` ⇒ 库里存在**跨用户共享**的预设行。
     卡片侧只读本人那份的派生数据；任何"改/删"通道**严禁**落到共享行
     （改了会影响别人的账号）。越权用例 = 拿共享行的 id 去动覆盖层 ⇒ 必须被拒（404）。

  ③ **快照端点**（P3-A 的服务端算出口）：`/api/prompt-manager/presets/snapshot`
     —— 名单 + 当前生效份 + 按名索引一次给全，帧内三键同步读它。

落点约束（施工件 §3）：**零迁移** —— 不建表、不加列、不写 alembic。
"""

import os
import sys

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.core.security import get_password_hash  # noqa: E402
from app.models import ChatSession, ChatVariable, GenerationPreset, User  # noqa: E402
from app.models.prompt_preset import PromptPreset  # noqa: E402
from app.services.preset_overlay import (  # noqa: E402
    OVERLAY_KEY,
    PRESET_STORE,
    build_preset_snapshot,
    effective_preset,
    resolve_global_preset,
    write_overlay,
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


def _mk_session(db_session, user, sid: str) -> ChatSession:
    session = ChatSession(id=sid, user_id=user.id, title="t-" + sid, type="chat")
    db_session.add(session)
    db_session.commit()
    return session


def _mk_generation_preset(db_session, user, name, prompts='[{"id": "main", "content": "g"}]'):
    preset = GenerationPreset(
        user_id=user.id,
        name=name,
        prompts_data=prompts,
        temperature=0.7,
        top_p=0.95,
    )
    db_session.add(preset)
    db_session.commit()
    db_session.refresh(preset)
    return preset


def _mk_shared_preset(db_session, name="共享预设"):
    """跨用户共享行：`user_id IS NULL`（`presets.py:114-115` 会把它列给所有人）。"""
    preset = GenerationPreset(
        user_id=None,
        name=name,
        prompts_data='[{"id": "main", "content": "shared"}]',
        temperature=0.5,
    )
    db_session.add(preset)
    db_session.commit()
    db_session.refresh(preset)
    return preset


# ---------------------------------------------------------------------------
# ① 数据源改指
# ---------------------------------------------------------------------------
def test_global_base_resolves_from_generation_presets(db_session, test_user):
    """全局基座必须是 `generation_presets` 的行，且响应带 `base_store` 标明是哪张表。"""
    _mk_session(db_session, test_user, "sess-p3-src")
    own = _mk_generation_preset(db_session, test_user, "设置里那份")

    res = effective_preset(db_session, test_user.id, "sess-p3-src")
    assert res["source"] == "global"
    assert res["name"] == "设置里那份"
    assert res["base_preset_id"] == str(own.id)
    # 可读性字段：下一个人不用猜这串 id 属于哪张表
    assert res["base_store"] == PRESET_STORE == "generation_presets"


def test_prompt_presets_rows_are_ignored_by_the_overlay_chain(db_session, test_user):
    """对照组：`prompt_presets` 里就算有行，覆盖层链也**不再读它**。"""
    _mk_session(db_session, test_user, "sess-p3-decoy")
    decoy = PromptPreset(
        id="decoy-1",
        user_id=test_user.id,
        name="空表那一份",
        entries='[{"id": "main", "content": "来自空表"}]',
        config='{"temperature": 0.1}',
    )
    db_session.add(decoy)
    db_session.commit()

    res = effective_preset(db_session, test_user.id, "sess-p3-decoy")
    # 旧表不再参与 ⇒ 解析为空（而不是拿到 decoy）
    assert res["source"] == "global"
    assert res["name"] is None
    assert res["base_preset_id"] is None
    assert resolve_global_preset(db_session, test_user.id) is None


def test_overlay_write_uses_generation_preset_as_base(db_session, test_user):
    """正向锚点：拿**自己**的 `generation_presets` 行当 base 可以写（证明下面的 404 不是恒真）。"""
    _mk_session(db_session, test_user, "sess-p3-own-base")
    own = _mk_generation_preset(db_session, test_user, "我的预设")

    result = write_overlay(db_session, test_user.id, "sess-p3-own-base", base_preset_id=str(own.id))
    assert result["source"] == "session"
    assert result["base_preset_id"] == str(own.id)
    assert result["base_store"] == PRESET_STORE
    assert result["base_name"] == "我的预设"


# ---------------------------------------------------------------------------
# ② 共享行红线（越权）
# ---------------------------------------------------------------------------
def test_shared_row_cannot_be_used_as_overlay_base(db_session, client, test_user):
    """拿 `user_id IS NULL` 的共享行 id 去换基 ⇒ 404，且**不许静默生效**（不落覆盖层行）。"""
    _mk_session(db_session, test_user, "sess-p3-shared-base")
    shared = _mk_shared_preset(db_session)

    res = client.put(
        "/api/prompt-manager/sessions/sess-p3-shared-base/preset",
        json={"base_preset_id": str(shared.id)},
    )
    assert res.status_code == 404, res.text
    assert "not found" in res.json()["detail"].lower()
    rows = db_session.query(ChatVariable).filter(
        ChatVariable.session_id == "sess-p3-shared-base",
        ChatVariable.key == OVERLAY_KEY,
    ).all()
    assert rows == [], "共享行不许静默生效（覆盖层行一个都不许落）"


def test_shared_row_by_name_is_also_rejected(db_session, client, test_user):
    """按名换基同样拒（名字这条路最容易漏：`presets.py` 的列表是包含共享行的）。"""
    _mk_session(db_session, test_user, "sess-p3-shared-name")
    _mk_shared_preset(db_session, "共享预设名")

    res = client.put(
        "/api/prompt-manager/sessions/sess-p3-shared-name/preset",
        json={"base_name": "共享预设名"},
    )
    assert res.status_code == 404, res.text


def test_shared_row_is_not_selectable_as_global(db_session, client, test_user):
    """共享行不可被"选中"为全局默认（选中名必须能解析到**本人**那份）。"""
    _mk_shared_preset(db_session, "不可选的共享预设")
    res = client.put(
        "/api/prompt-manager/presets/selection",
        json={"name": "不可选的共享预设"},
    )
    assert res.status_code == 404, res.text


def test_shared_row_never_becomes_global_fallback(db_session, test_user):
    """本人一份都没有时，共享行**不许**顶上来当"回落最近更新那份"。"""
    shared = _mk_shared_preset(db_session, "共享但不回落")
    assert shared.user_id is None
    assert resolve_global_preset(db_session, test_user.id) is None


def test_shared_row_is_absent_from_snapshot(db_session, test_user):
    """快照名单只含本人那份（卡片侧只读自己那份的派生数据）。"""
    _mk_shared_preset(db_session, "共享不进名单")
    own = _mk_generation_preset(db_session, test_user, "我自己的")

    snap = build_preset_snapshot(db_session, test_user.id)
    assert snap["store"] == PRESET_STORE
    assert "共享不进名单" not in snap["names"]
    assert "共享不进名单" not in snap["presets"]
    assert snap["names"] == ["我自己的"]


# ---------------------------------------------------------------------------
# ③ 快照端点（P3-A）
# ---------------------------------------------------------------------------
def test_snapshot_shape_is_st_preset(db_session, client, test_user):
    """`Preset` 形状沿用 ST：`{settings, prompts, prompts_unused, extensions}`，
    缺的字段仍缺（不补 enabled/role/position 假默认）。"""
    _mk_generation_preset(db_session, test_user, "平衡", '[{"name": "main", "content": "c"}]')

    res = client.get("/api/prompt-manager/presets/snapshot")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["store"] == PRESET_STORE
    assert body["names"] == ["平衡"]
    assert body["loaded_name"] == "平衡"
    assert sorted(body["presets"]["平衡"].keys()) == [
        "extensions", "prompts", "prompts_unused", "settings",
    ]
    # settings 来自生成参数那一坨（真数据），prompts 来自 prompts_data
    assert body["presets"]["平衡"]["prompts"] == [{"name": "main", "content": "c"}]
    assert body["presets"]["平衡"]["settings"]["temperature"] == 0.7
    assert body["presets"]["平衡"]["settings"]["top_p"] == 0.95
    # 两个空容器必须是空容器，不是缺字段
    assert body["presets"]["平衡"]["prompts_unused"] == []
    assert body["presets"]["平衡"]["extensions"] == {}


def test_snapshot_in_use_follows_session_overlay(db_session, client, test_user):
    """给 session_id ⇒ `in_use` 是本对话当前生效那份（覆盖层优先）。"""
    _mk_session(db_session, test_user, "sess-p3-snap")
    _mk_generation_preset(db_session, test_user, "全局那份", '[{"id": "main", "content": "global"}]')
    write_overlay(
        db_session, test_user.id, "sess-p3-snap",
        entries=[{"id": "main", "content": "本对话改过"}],
    )

    res = client.get(
        "/api/prompt-manager/presets/snapshot",
        params={"session_id": "sess-p3-snap"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["source"] == "session"
    assert body["in_use"]["prompts"] == [{"id": "main", "content": "本对话改过"}]
    assert body["loaded_name"] == "全局那份"


def test_snapshot_with_no_preset_returns_null_in_use(db_session, client, test_user):
    """一份预设都没有 ⇒ `in_use` 是 null、`names` 是 []（不造 'Default'、不返 undefined）。"""
    res = client.get("/api/prompt-manager/presets/snapshot")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["names"] == []
    assert body["loaded_name"] is None
    assert body["in_use"] is None


def test_snapshot_rejects_foreign_session(db_session, client, test_user):
    """别人的会话 ⇒ 404（不静默退回全局，避免"看起来成功其实是别人的"）。"""
    other = _mk_user(db_session, "p3_snapshot_other")
    _mk_session(db_session, other, "sess-p3-foreign")
    res = client.get(
        "/api/prompt-manager/presets/snapshot",
        params={"session_id": "sess-p3-foreign"},
    )
    assert res.status_code == 404, res.text


# ---------------------------------------------------------------------------
# ④ 零迁移自证
# ---------------------------------------------------------------------------
def test_no_new_column_or_table_was_added():
    """施工件 §3：不建表、不加列、不写 alembic。

    这条读的是**源码文本**（不是运行时），一旦有人给预设链加列/加表，这里立刻红。
    """
    def read(rel: str) -> str:
        with open(os.path.join(_BACKEND_DIR, rel), "r", encoding="utf-8") as handle:
            return handle.read()

    overlay = read("app/services/preset_overlay.py")
    assert "GenerationPreset" in overlay
    # 选中名仍落在既有 JSON 列，没有新模型
    assert "SELECTION_NAMESPACE = \"palink_prompt_preset\"" in overlay
    # 服务层不许自带模型定义（加列/加表会在这里先出现 Column(）
    assert "Column(" not in overlay

    # `migrations.py` 里 `generation_presets` 只有**历史既有**那 5 条补列，
    # 本批没往里加任何一条（加一条这里就红）。
    migrations = read("app/core/migrations.py")
    existing = [
        line.strip()
        for line in migrations.splitlines()
        if "generation_presets" in line
    ]
    assert len(existing) == 5, existing
    for name in ("prompts_data", "ban_sequences", "logit_bias",
                 "context_template_name", "chat_completion_source"):
        assert any(name in line for line in existing), name
