"""[批次QR 2026-10-21] /api/quick-replies/save|delete —— 快捷回复集第一次真能存下来。

一手依据（不是推测，行号都在本仓/上游源码里）：

- 插件写侧只会打这两个地址：`st-plugins/quick-reply/src/QuickReplySet.js:377`（save）
  与 `:392`（delete），body 是 `JSON.stringify(this)`（含 `name`）。
- 插件读侧只认 `settings/get` 响应里的 `quickReplyPresets`：
  `st-plugins/quick-reply/index.js:47-55` `loadSets()` 逐条 `QuickReplySet.from(...)`
  塞进 `QuickReplySet.list`（`:92`）。
- 后端读侧 Fix-6 已经在取 `extension_settings.quickReplyV2.sets`
  （`app/api/silly_tavern.py` 的 `_extract_quick_reply_presets`），
  **但全仓没有任何代码往那个键写过** ⇒ 两侧永久错位 ⇒ 真机读数 `[QR2] sets: []` 恒空。
  插件自己的 `QuickReplySettings.toJSON()`（`src/QuickReplySettings.js:89-102`）
  只写 isEnabled/isCombined/config/characterConfigs，**不含 sets**。

本文件钉的是**闭环**，不是"端点存在"：

  ① save → `settings/get` 的 `quickReplyPresets` 真能读出那一条（读写两侧对上）；
  ② 同名覆盖不产生第二条（ST 的语义是"文件名即主键"）；
  ③ delete 按 name 删除；名字不存在也回 200（ST 是 existsSync 后才 unlink）；
  ④ `name` 缺失 / body 非对象 → 400（ST: `sendStatus(400)`）；
  ⑤ **不擦别的 extension_settings**（note 等命名空间必须原样活着）——
     这条是本类改动最容易犯的错：整包覆盖会把用户其它扩展设置抹掉；
  ⑥ 越界（sets 条数超上限）时 **409 且不落盘**（丢用户数据比报错严重）；
  ⑦ 认证与 CSRF：不带凭据的写请求不得 200（新写面必须与同族端点同一道门）；
  ⑧ 脏数据形状（sets 被存成 dict/None）不崩，按"没有"处理。

运行: cd backend && py -m pytest tests/test_qr_save_delete_endpoints.py -q
"""
import json
from typing import Any

from fastapi import status
from fastapi.testclient import TestClient

SAVE_PATH = "/api/quick-replies/save"
DELETE_PATH = "/api/quick-replies/delete"
GET_PATH = "/api/settings/get"


def _set_body(name: str, **overrides: Any) -> dict[str, Any]:
    """与 QuickReplySet.toJSON() 同形状（version 2 + qrList + idIndex）。"""
    body: dict[str, Any] = {
        "version": 2,
        "name": name,
        "disableSend": False,
        "placeBeforeInput": False,
        "injectInput": False,
        "color": "",
        "onlyBorderColor": False,
        "qrList": [{"id": 1, "label": "L1", "title": "", "message": "M1"}],
        "idIndex": 2,
    }
    body.update(overrides)
    return body


def _presets(client: TestClient, auth_headers: dict[str, str]) -> list[dict[str, Any]]:
    resp = client.post(GET_PATH, json={}, headers=auth_headers)
    assert resp.status_code == status.HTTP_200_OK, resp.text
    data = resp.json()
    got = data.get("quickReplyPresets")
    assert isinstance(got, list), f"quickReplyPresets 不是 list：{type(got)}"
    return got


def _ext_from_settings_get(client: TestClient, auth_headers: dict[str, str]) -> dict[str, Any]:
    """取 settings/get 里的 `extension_settings`。

    ⚠️ 形状陷阱（实测出来的，不是猜的）：`/api/settings/get` 的响应**没有**顶层
    `extension_settings` 键——整份用户设置是塞在 `data["settings"]` 这个 **JSON 字符串**里的
    （实测 keys=25，`extension_settings` 在其中）。第一版测试直接读 `data["extension_settings"]`
    得到 `{}`，一度被我误判成"note 命名空间被擦掉了"。判据要读对信封。
    """
    data = client.post(GET_PATH, json={}, headers=auth_headers).json()
    raw = data.get("settings")
    obj = json.loads(raw) if isinstance(raw, str) else raw
    assert isinstance(obj, dict), "settings 信封不是 JSON 对象"
    ext = obj.get("extension_settings")
    return ext if isinstance(ext, dict) else {}


def test_save_then_readback_through_settings_get(client, auth_headers):
    """① 本批的全部意义：写侧落点的键，正是读侧已经在用的键。"""
    resp = client.post(SAVE_PATH, json=_set_body("我的快捷集"), headers=auth_headers)
    assert resp.status_code == status.HTTP_200_OK, resp.text
    assert resp.json().get("ok") is True

    presets = _presets(client, auth_headers)
    assert [p.get("name") for p in presets] == ["我的快捷集"]
    # 内容原样存（插件自己管形状，后端不重排字段）
    assert presets[0]["qrList"][0]["message"] == "M1"
    assert presets[0]["version"] == 2


def test_save_same_name_replaces_and_does_not_duplicate(client, auth_headers):
    """② 同名覆盖（ST 用文件名做主键，重复 save 不该堆第二条）。"""
    client.post(SAVE_PATH, json=_set_body("dup", qrList=[{"id": 1, "label": "old"}]), headers=auth_headers)
    resp = client.post(SAVE_PATH, json=_set_body("dup", qrList=[{"id": 1, "label": "new"}]), headers=auth_headers)
    assert resp.json()["replaced"] is True
    assert resp.json()["count"] == 1

    presets = _presets(client, auth_headers)
    assert len(presets) == 1
    assert presets[0]["qrList"][0]["label"] == "new", "同名覆盖必须以后一次为准"


def test_save_two_names_coexist(client, auth_headers):
    client.post(SAVE_PATH, json=_set_body("a-set"), headers=auth_headers)
    resp = client.post(SAVE_PATH, json=_set_body("b-set"), headers=auth_headers)
    assert resp.json()["count"] == 2
    assert sorted(p["name"] for p in _presets(client, auth_headers)) == ["a-set", "b-set"]


def test_delete_removes_by_name_and_missing_name_is_not_an_error(client, auth_headers):
    """③ ST 语义：`fs.existsSync` 命中才 unlink ⇒ 删不存在的名字也不算失败。"""
    client.post(SAVE_PATH, json=_set_body("to-delete"), headers=auth_headers)
    resp = client.post(DELETE_PATH, json=_set_body("to-delete"), headers=auth_headers)
    assert resp.status_code == status.HTTP_200_OK
    assert resp.json()["removed"] == 1
    assert _presets(client, auth_headers) == []

    again = client.post(DELETE_PATH, json=_set_body("to-delete"), headers=auth_headers)
    assert again.status_code == status.HTTP_200_OK, "重复删除不该 500/404（ST 也回 200）"
    assert again.json()["removed"] == 0


def test_missing_name_or_non_object_payload_is_400(client, auth_headers):
    """④ 与 ST 同一道校验：`if (!request.body || !request.body.name) return 400`。"""
    for bad in ({"qrList": []}, {"name": ""}, {"name": "   "}, {"name": 123}, ["not", "a", "dict"]):
        resp = client.post(SAVE_PATH, json=bad, headers=auth_headers)
        assert resp.status_code == status.HTTP_400_BAD_REQUEST, f"{bad!r} 应 400，实得 {resp.status_code}"
        assert resp.json().get("ok") is False


def test_save_preserves_other_extension_settings_namespaces(client, auth_headers):
    """⑤ 只动 Palink 自有的 quickReplySets，别人的设置一个字节都不许掉。

    这是本类改动的高危项：`silly_tavern_settings` 是一整列 JSON，
    重写时忘了读旧值就会把用户其它扩展的设置抹掉（历史上同类事故是
    "预设选中名被整包覆盖"，见 [批次P2] 那条 namespace 增量保护注释）。
    """
    client.post(
        "/api/settings/save",
        json={
            "extension_settings": {
                "note": {"enabled": True, "text": "别丢掉这段作者注"},
                "memory": {"lastActive": 1},
            }
        },
        headers=auth_headers,
    )
    assert _presets(client, auth_headers) == []

    client.post(SAVE_PATH, json=_set_body("keep-me"), headers=auth_headers)

    ext = _ext_from_settings_get(client, auth_headers)
    assert isinstance(ext.get("note"), dict), "save QR 集把 note 命名空间擦掉了"
    assert ext["note"].get("text") == "别丢掉这段作者注"
    assert isinstance(ext.get("memory"), dict), "save QR 集把 memory 命名空间擦掉了"
    assert [p["name"] for p in _presets(client, auth_headers)] == ["keep-me"]

    # 反向也要成立：插件自己的 settings/save 不能擦掉刚存的 sets
    client.post(
        "/api/settings/save",
        json={"extension_settings": {"quickReplyV2": {"isEnabled": True}}},
        headers=auth_headers,
    )
    assert [p["name"] for p in _presets(client, auth_headers)] == ["keep-me"], \
        "插件保存自身设置时把 sets 整块覆盖掉了（namespace 级替换语义下必须仍活着）"


def test_limit_is_enforced_without_partial_write(client, auth_headers, db_session):
    """⑥ 超上限 → 409 **且不落盘**（宁可拒绝，也不静默丢最早那条）。"""
    from app.api.silly_tavern import _QR_SETS_MAX_COUNT, _json_dumps
    from app.models import UserSetting

    # UserSetting 是**首次访问 ST 设置端点时才建行**（_get_or_create_user_setting），
    # 所以必须先发一次请求，不能直接查表。
    client.post(GET_PATH, json={}, headers=auth_headers)
    db_session.expire_all()
    setting = db_session.query(UserSetting).first()
    assert setting is not None, "前一步的 settings/get 应建出 UserSetting"
    seeded = [{"version": 2, "name": f"seed-{i}"} for i in range(_QR_SETS_MAX_COUNT)]
    # 播种到**写侧真正管理的那个命名空间**（第一版播到 quickReplyV2 里，
    # 写侧读的是 quickReplySets ⇒ 列表被当成空的，409 分支根本没走到）
    setting.silly_tavern_settings = _json_dumps(
        {"extension_settings": {"quickReplySets": {"sets": seeded}}}
    )
    db_session.commit()

    resp = client.post(SAVE_PATH, json=_set_body("over-limit"), headers=auth_headers)
    assert resp.status_code == status.HTTP_409_CONFLICT, resp.text
    assert resp.json().get("ok") is False

    after = _presets(client, auth_headers)
    assert len(after) == _QR_SETS_MAX_COUNT, "被拒的 save 竟改动了已存列表"
    assert "over-limit" not in {p.get("name") for p in after}

    # 同名覆盖不新增条目 ⇒ 到达上限时仍应能改自己已有的那条
    existing = client.post(SAVE_PATH, json=_set_body("seed-0", color="red"), headers=auth_headers)
    assert existing.status_code == status.HTTP_200_OK, existing.text
    assert existing.json()["count"] == _QR_SETS_MAX_COUNT


def test_legacy_v2_and_v1_keys_are_still_readable(client, auth_headers, db_session):
    """兼容守卫：本批把写侧落到 quickReplySets，但**旧键的读法不能掉**。

    读侧三档优先级（`_extract_quick_reply_presets`）：quickReplySets.sets →
    quickReplyV2.sets → quickReply.sets。若哪天有人"清理旧键"，这两条会红。
    """
    from app.api.silly_tavern import _json_dumps
    from app.models import UserSetting

    client.post(GET_PATH, json={}, headers=auth_headers)
    db_session.expire_all()
    setting = db_session.query(UserSetting).first()
    assert setting is not None

    setting.silly_tavern_settings = _json_dumps(
        {"extension_settings": {"quickReplyV2": {"sets": [{"version": 2, "name": "legacy-v2"}]}}}
    )
    db_session.commit()
    assert [p["name"] for p in _presets(client, auth_headers)] == ["legacy-v2"], "V2 历史键读不到了"

    setting = db_session.query(UserSetting).first()
    setting.silly_tavern_settings = _json_dumps(
        {"extension_settings": {"quickReply": {"sets": [{"version": 1, "name": "legacy-v1"}]}}}
    )
    db_session.commit()
    assert [p["name"] for p in _presets(client, auth_headers)] == ["legacy-v1"], "V1 历史键读不到了"

    # 新键存在时**新键优先**（别让两份数据同时冒出来变成重复集）
    client.post(SAVE_PATH, json=_set_body("new-ns"), headers=auth_headers)
    assert [p["name"] for p in _presets(client, auth_headers)] == ["new-ns"]


def test_empty_new_namespace_does_not_shadow_legacy_keys(client, auth_headers, db_session):
    """空列表的语义是"这一档没东西"，不是最终答案（否则会遮蔽历史键）。

    真删光之后读到什么？读到历史档的内容。这条钉住 `_extract_quick_reply_presets`
    第一档的 `and sets` 判据 —— 去掉它，本用例即红（第一版就漏了这条，实测发现的）。
    """
    from app.api.silly_tavern import _json_dumps
    from app.models import UserSetting

    client.post(GET_PATH, json={}, headers=auth_headers)
    db_session.expire_all()
    setting = db_session.query(UserSetting).first()
    assert setting is not None
    setting.silly_tavern_settings = _json_dumps({
        "extension_settings": {
            "quickReplySets": {"sets": []},
            "quickReplyV2": {"sets": [{"version": 2, "name": "legacy-visible"}]},
        }
    })
    db_session.commit()

    names = [p["name"] for p in _presets(client, auth_headers)]
    assert names == ["legacy-visible"], f"空的 quickReplySets 把历史档遮蔽了：{names}"

    # 新档一旦有内容就优先（两档同时存在时不合并、不重复）
    client.post(SAVE_PATH, json=_set_body("new-wins"), headers=auth_headers)
    assert [p["name"] for p in _presets(client, auth_headers)] == ["new-wins"]


def test_unauthenticated_write_is_rejected(client):
    """⑦ 新增写面必须与同族端点同一道门（无凭据不得 200）。"""
    resp = client.post(SAVE_PATH, json=_set_body("anon"))
    assert resp.status_code != status.HTTP_200_OK, "未认证也能写 ⇒ 这是跨用户污染面"
    assert resp.status_code in (
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
    ), f"期望 401/403，实得 {resp.status_code}"


def test_dirty_stored_shape_degrades_to_empty(client, auth_headers, db_session):
    """⑧ 老数据/脏数据不崩：sets 存成 dict 时按"没有"处理，save 之后恢复成 list。"""
    from app.api.silly_tavern import _json_dumps
    from app.models import UserSetting

    client.post(GET_PATH, json={}, headers=auth_headers)
    db_session.expire_all()
    setting = db_session.query(UserSetting).first()
    assert setting is not None, "前一步的 settings/get 应建出 UserSetting"
    setting.silly_tavern_settings = _json_dumps(
        {"extension_settings": {"quickReplyV2": {"sets": {"0": "不是列表"}}}}
    )
    db_session.commit()

    assert _presets(client, auth_headers) == [], "非法形状应被读侧当作没有，而不是抛错"
    resp = client.post(SAVE_PATH, json=_set_body("after-dirty"), headers=auth_headers)
    assert resp.status_code == status.HTTP_200_OK, resp.text
    assert [p["name"] for p in _presets(client, auth_headers)] == ["after-dirty"]
