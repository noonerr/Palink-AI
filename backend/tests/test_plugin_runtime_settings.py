"""经典轨扩展设置落盘（POST /api/plugins/runtime/settings）的契约测试。

对应 docs/REPORT_插件设置按卡隔离_批次0-1交付_2026-10-04.md 批次 1，以及
docs/REPORT_插件设置冲突与100%适配可行性_2026-10-04.md §6 记录的原始事故：

    前端 saveExtensionSettings() 自上线起就 POST 到 /api/plugins/runtime/settings，
    而后端**从未注册过这个路由** —— 请求被文件末尾的 fallback 当成
    plugin_id="runtime" 接住，返回 404「插件不存在」，前端 catch 掉只打一行
    console.error，于是「设置保存」是**静默死路径**。

2026-10-04 复核修复后，本文件钉住**九**条（后 4 条是复核发现原实现没做到的）：
  1. 端点存在（404 不再发生）；
  2. namespace 级合并 —— 只动本次带来的 namespace，不擦掉别的扩展的设置；
  3. value=None 表示删除；
  4. 超限的键被跳过并**列进 skipped**（不静默丢数据）；
  5. GET /runtime/config 能读回来（存了要拿得到，否则等于没存）；
  6. ★ **跨卡隔离**（SPEC 验收项 #2）：A 卡存的值，B 卡读不到；
  7. ★ 跨用户隔离 + **非本人卡返回 404 而非 403**（不泄露 id 存在性）；
  8. ★ 落点必须是独立格 —— **不得**写进 extension_settings（后端 character_ext.py
     会把 extension_settings.regex_scripts 当正则应用到提示词/显示文本上）；
  9. ★ character_id 缺失时拒绝写入（没有作用域就没有隔离）。
"""
from __future__ import annotations

import json
import uuid

from app.models.character import Character
from app.models.system import UserSetting

CARD_SETTINGS_KEY = "plugin_extension_settings_by_character"


def _make_char(db_session, user_id, label="char"):
    char = Character(
        id=f"{label}-{uuid.uuid4().hex[:8]}",
        user_id=user_id,
        name=f"CardFor{label}",
    )
    db_session.add(char)
    db_session.flush()
    return char


def _post_settings(client, extension_settings: dict, character_id: str):
    return client.post(
        "/api/plugins/runtime/settings",
        json={"character_id": character_id, "extension_settings": extension_settings},
    )


def _get_config(client, character_id=None):
    url = "/api/plugins/runtime/config"
    if character_id:
        url = f"{url}?character_id={character_id}"
    return client.get(url)


def _read_user_setting(db_session, user_id) -> dict:
    row = db_session.query(UserSetting).filter(UserSetting.user_id == user_id).first()
    if row is None or not row.silly_tavern_settings:
        return {}
    try:
        parsed = json.loads(row.silly_tavern_settings)
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


# ── 1. 端点存在（原始 404 事故的回归本体）────────────────────────────────
def test_endpoint_exists_and_returns_ok(client, test_user, db_session):
    char = _make_char(db_session, test_user.id, "card-a")
    resp = _post_settings(client, {"ns_a": {"k": 1}}, char.id)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body.get("ok") is True
    assert body.get("written") == 1
    assert body.get("character_id") == char.id


def test_empty_payload_is_noop_not_error(client, test_user, db_session):
    char = _make_char(db_session, test_user.id, "card-a")
    resp = _post_settings(client, {}, char.id)
    assert resp.status_code == 200, resp.text
    assert resp.json().get("written") == 0


# ── 2. namespace 级合并：不擦掉别的扩展的设置 ────────────────────────────
def test_merge_does_not_wipe_sibling_namespaces(client, test_user, db_session):
    char = _make_char(db_session, test_user.id, "card-a")
    _post_settings(client, {"mvu_settings": {"好感度": 10}}, char.id)
    _post_settings(client, {"other_ext": {"x": 1}}, char.id)

    stored = _read_user_setting(db_session, test_user.id)
    bucket = (stored.get(CARD_SETTINGS_KEY) or {}).get(char.id) or {}
    assert bucket.get("mvu_settings") == {"好感度": 10}, "兄弟 namespace 被擦掉了"
    assert bucket.get("other_ext") == {"x": 1}


def test_same_namespace_is_replaced_wholesale(client, test_user, db_session):
    """namespace 内是整体替换（对齐 ST 自身行为），不是深合并。"""
    char = _make_char(db_session, test_user.id, "card-a")
    _post_settings(client, {"mvu_settings": {"a": 1, "b": 2}}, char.id)
    _post_settings(client, {"mvu_settings": {"a": 99}}, char.id)

    stored = _read_user_setting(db_session, test_user.id)
    bucket = (stored.get(CARD_SETTINGS_KEY) or {}).get(char.id) or {}
    assert bucket.get("mvu_settings") == {"a": 99}, "同 namespace 应为整体替换"


# ── 3. value=None 表示删除 ───────────────────────────────────────────────
def test_none_value_removes_namespace(client, test_user, db_session):
    char = _make_char(db_session, test_user.id, "card-a")
    _post_settings(client, {"to_remove": {"k": 1}, "keep": {"k": 2}}, char.id)
    resp = _post_settings(client, {"to_remove": None}, char.id)
    assert resp.json().get("removed") == 1

    stored = _read_user_setting(db_session, test_user.id)
    bucket = (stored.get(CARD_SETTINGS_KEY) or {}).get(char.id) or {}
    assert "to_remove" not in bucket
    assert bucket.get("keep") == {"k": 2}


# ── 4. 超限的键被跳过并列入 skipped（不静默丢数据）────────────────────────
def test_oversized_namespace_is_skipped_and_reported(client, test_user, db_session):
    char = _make_char(db_session, test_user.id, "card-a")
    big = {"blob": "x" * (300 * 1024)}  # > 256KB
    resp = _post_settings(client, {"too_big": big, "ok_one": {"k": 1}}, char.id)
    body = resp.json()
    assert body.get("ok") is True
    assert "too_big" in body.get("skipped", []), "超限的键必须被列出，不能静默丢弃"
    assert body.get("written") == 1, "其余键应照常保存"


# ── 5. 存了要拿得到 ──────────────────────────────────────────────────────
def test_saved_settings_are_visible_via_runtime_config(client, test_user, db_session):
    char = _make_char(db_session, test_user.id, "card-a")
    _post_settings(client, {"mvu_settings": {"好感度": 123}}, char.id)

    resp = _get_config(client, char.id)
    assert resp.status_code == 200, resp.text
    ext = (resp.json() or {}).get("extension_settings") or {}
    assert ext.get("mvu_settings") == {"好感度": 123}, "存了但 /runtime/config 读不回来"


# ── 6. ★ 跨卡隔离（SPEC 验收项 #2，原实现完全没做）───────────────────────
def test_settings_are_isolated_between_cards(client, test_user, db_session):
    """A 卡存的值，切到 B 卡必须看不到 —— 原实现落在用户级那一格，这条会红。

    顺序刻意是「先读 A 再读 B」：A 那次读会填充 runtime/config 的 TTL 缓存，
    而缓存命中返回的是**同一个字典对象**。若合并按卡设置时就地改那个对象，
    A 的值就会留在缓存里被 B 读到（跨卡串味，实测踩过一次）。
    """
    char_a = _make_char(db_session, test_user.id, "card-a")
    char_b = _make_char(db_session, test_user.id, "card-b")

    _post_settings(client, {"mvu_settings": {"好感度": 42}}, char_a.id)

    # ① 先读 A —— 把 A 的合并结果灌进缓存
    cfg_a = _get_config(client, char_a.id).json()
    assert (cfg_a.get("extension_settings") or {}).get("mvu_settings") == {"好感度": 42}

    # ② 再读 B —— 不得看到 A 的值
    cfg_b = _get_config(client, char_b.id).json()
    ext_b = (cfg_b or {}).get("extension_settings") or {}
    assert "mvu_settings" not in ext_b, f"A 卡的设置渗到了 B 卡：{ext_b.get('mvu_settings')}"


def test_config_without_character_id_does_not_leak_any_card(client, test_user, db_session):
    """不带 character_id 的全量拉取（管理面等）不得把任何卡级设置混进来。"""
    char = _make_char(db_session, test_user.id, "card-a")
    _post_settings(client, {"mvu_settings": {"好感度": 7}}, char.id)

    ext = (_get_config(client).json() or {}).get("extension_settings") or {}
    assert "mvu_settings" not in ext


# ── 7. ★ 跨用户隔离 + 归属权 404 ─────────────────────────────────────────
def test_foreign_character_returns_404_not_403(client, db_session, test_user):
    """别人的卡：404 而非 403 —— 403 等于告诉调用方「这个 id 存在但你不配」。"""
    from app.core.security import get_password_hash
    from app.models import User

    other_user = User(
        username=f"foreign_owner-{uuid.uuid4().hex[:6]}",
        hashed_password=get_password_hash("TestPassword1"),
        role="user",
        is_active=True,
    )
    db_session.add(other_user)
    db_session.flush()

    other_char = Character(
        id=f"other-{uuid.uuid4().hex[:8]}",
        user_id=other_user.id,
        name="ForeignCard",
    )
    db_session.add(other_char)
    db_session.flush()

    resp = _post_settings(client, {"mvu_settings": {"a": 1}}, other_char.id)
    assert resp.status_code == 404, f"应返回 404（不可探测），实得 {resp.status_code}"


def test_settings_land_on_current_user_only(client, test_user, db_session):
    """归属权底线：写进的是**当前登录用户**的 UserSetting，不是全局。"""
    char = _make_char(db_session, test_user.id, "card-a")
    _post_settings(client, {"mvu_settings": {"好感度": 7}}, char.id)

    rows = db_session.query(UserSetting).all()
    hit = [r for r in rows if r.user_id == test_user.id]
    assert len(hit) == 1, "应只落在当前用户那条 UserSetting 上"
    stored = json.loads(hit[0].silly_tavern_settings)
    assert (stored.get(CARD_SETTINGS_KEY) or {}).get(char.id, {}).get("mvu_settings") == {"好感度": 7}

    for r in rows:
        if r.user_id == test_user.id:
            continue
        try:
            other = json.loads(r.silly_tavern_settings or "{}")
        except (TypeError, ValueError):
            other = {}
        assert not other.get(CARD_SETTINGS_KEY), "泄漏到别的用户了"


# ── 8. ★ 落点必须是独立格：不得触达后端正则消费路径 ──────────────────────
def test_write_never_touches_extension_settings_cell(client, test_user, db_session):
    """extension_settings.regex_scripts 会被 character_ext.py 当正则**应用到提示词**上。

    卡脚本若能写那一格，等于能改写宿主送给模型的原文。本端点必须把它隔开：
    只允许写独立的按卡那一格。
    """
    char = _make_char(db_session, test_user.id, "card-a")
    hostile = [{
        "scriptName": "inject",
        "findRegex": "/(.+)/s",
        "replaceString": "PWNED",
        "placement": "prompt",
        "disabled": False,
    }]
    resp = _post_settings(client, {"regex_scripts": hostile, "mvu_settings": {"a": 1}}, char.id)
    assert resp.status_code == 200, resp.text

    stored = _read_user_setting(db_session, test_user.id)
    # ① 那一格没被新建、也没被写入
    assert "regex_scripts" not in (stored.get("extension_settings") or {}), \
        "插件写入了后端正则消费方读的那一格"
    # ② 其他既有键（如导入自 ST 的大包）不得被本次保存改写
    bucket = (stored.get(CARD_SETTINGS_KEY) or {}).get(char.id) or {}
    assert bucket.get("regex_scripts") == hostile, "按卡那一格应照常保存（只是不被后端消费）"


def test_existing_extension_settings_cell_is_untouched(client, test_user, db_session):
    """存量保护：现网有从真 ST 导入的 extension_settings 大包，本次写入不得改写它。"""
    setting = db_session.query(UserSetting).filter(UserSetting.user_id == test_user.id).first()
    legacy = {"extension_settings": {"sd": {"enabled": True}, "apiKey": "***"}, "power_user": {"x": 1}}
    if setting is None:
        setting = UserSetting(user_id=test_user.id, silly_tavern_settings=json.dumps(legacy))
        db_session.add(setting)
    else:
        setting.silly_tavern_settings = json.dumps(legacy)
    db_session.flush()

    char = _make_char(db_session, test_user.id, "card-a")
    _post_settings(client, {"mvu_settings": {"好感度": 1}}, char.id)

    stored = _read_user_setting(db_session, test_user.id)
    assert stored["extension_settings"] == legacy["extension_settings"], "存量那一格被改写了"
    assert stored["power_user"] == legacy["power_user"], "同级其他键被擦掉了"


# ── 9. ★ 没有作用域就拒绝写入 ────────────────────────────────────────────
def test_missing_character_id_is_rejected(client, test_user):
    resp = client.post(
        "/api/plugins/runtime/settings",
        json={"extension_settings": {"mvu_settings": {"a": 1}}},
    )
    assert resp.status_code == 422, f"缺 character_id 应拒绝，实得 {resp.status_code}"


def test_blank_character_id_is_rejected(client, test_user):
    resp = _post_settings(client, {"mvu_settings": {"a": 1}}, "")
    assert resp.status_code == 422
