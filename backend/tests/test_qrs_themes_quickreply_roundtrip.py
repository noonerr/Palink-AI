"""QR-s 撤疑 + 契约锁：themes / quickReplyPresets 的存-读往返（2026-10-25）。

派单口径是"只取证不定性"。取证结果：**不是坑，撤疑**（读数见下面各用例的断言）。
两条写通道都验过：
  A. ST 前端/插件的 `/api/settings/save`（extension_settings 命名空间级增量合并）
  B. quick-reply 扩展实际用的 `/api/quick-replies/save`
     （出处 st-plugins/quick-reply/src/QuickReplySet.js:377/:392）
两侧都能从 `/api/settings/get` 的顶层 `themes` / `quickReplyPresets` 读回，
且都**不会被另一次不带该 namespace 的 settings/save 擦掉**。

虽然定性为"非缺陷"，本批仍把它写成硬断言留在门禁里：这几条链路历史上
坏过两次（Fix-6/Fix-7 之前顶层恒为 []；批次QR 之前插件自己那次
QuickReplySettings.js:72 的 V2 保存会把集合擦掉），是典型的"修好过、
也最容易再坏"的位置。留锁比撤一条疑点值钱。

运行: cd backend && py -3 -m pytest tests/test_qrs_themes_quickreply_roundtrip.py -q
"""

import json
import os
import sys

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.api.silly_tavern import _QR_SETS_NAMESPACE  # noqa: E402
from app.models import UserSetting  # noqa: E402

THEME_A = {"name": "QRS-Theme-A", "map": {"--main": "#111111"}, "in_dark_mode": True}
QR_V2_SET = {"title": "QRS-V2-Set", "entries": [{"prompt": "/a", "name": "a"}]}
QR_PLUGIN_SET = {"name": "QRS-Plugin-Set", "entries": [{"prompt": "/b", "name": "b"}]}


def _top(resp_json):
    """settings/get 的信封：payload 藏在 data 里（有的形状带 data.settings 字符串）。"""
    return resp_json.get("data", resp_json) if isinstance(resp_json, dict) else {}


def _get_top(client, auth_headers):
    return _top(client.post("/api/settings/get", headers=auth_headers, json={}).json())


def _db_ext(db_session, user_id):
    db_session.expire_all()
    us = db_session.query(UserSetting).filter(UserSetting.user_id == user_id).first()
    blob = json.loads(us.silly_tavern_settings) if us and us.silly_tavern_settings else {}
    return blob.get("extension_settings") or {}


class TestChannelASettingsSave:
    """A 通道：/api/settings/save 写 extension_settings，顶层读回。"""

    def _save(self, client, auth_headers):
        return client.post("/api/settings/save", headers=auth_headers, json={
            "extension_settings": {
                "themes": [THEME_A],
                "quickReplyV2": {"sets": [QR_V2_SET]},
            },
        })

    def test_themes_round_trip(self, client, auth_headers):
        assert self._save(client, auth_headers).status_code == 200
        assert _get_top(client, auth_headers).get("themes") == [THEME_A], (
            "themes 存得进读不出（审计 S-4 的怀疑在此复现）"
        )

    def test_quick_reply_v2_round_trip(self, client, auth_headers):
        assert self._save(client, auth_headers).status_code == 200
        presets = _get_top(client, auth_headers).get("quickReplyPresets")
        assert presets == [QR_V2_SET], f"quickReplyV2.sets 读不回来：{presets!r}"

    def test_survives_save_of_another_namespace(self, client, auth_headers):
        """命名空间级增量合并：别的扩展存一次，不许把 themes/QR 擦掉。"""
        self._save(client, auth_headers)
        client.post("/api/settings/save", headers=auth_headers,
                    json={"extension_settings": {"note": {"length": 100}}})
        top = _get_top(client, auth_headers)
        assert top.get("themes") == [THEME_A], "另一次 namespace 保存擦掉了 themes"
        assert top.get("quickReplyPresets") == [QR_V2_SET], "另一次 namespace 保存擦掉了 QR"


class TestChannelBPluginRealWriter:
    """B 通道：quick-reply 扩展真正打的 /api/quick-replies/save。"""

    def test_plugin_set_reads_back(self, client, auth_headers):
        save = client.post("/api/quick-replies/save", headers=auth_headers, json=QR_PLUGIN_SET)
        assert save.status_code == 200, save.text
        presets = _get_top(client, auth_headers).get("quickReplyPresets") or []
        names = [p.get("name") for p in presets if isinstance(p, dict)]
        assert "QRS-Plugin-Set" in names, f"插件写进 save 端点的集读不回：{names}"

    def test_lands_in_palink_namespace_not_v2(self, client, auth_headers, db_session, test_user):
        """落点必须是 Palink 自有命名空间——批次QR 换落点的理由就是 V2 会被
        插件自己那次不带 sets 的保存擦掉。"""
        client.post("/api/quick-replies/save", headers=auth_headers, json=QR_PLUGIN_SET)
        ext = _db_ext(db_session, test_user.id)
        ns = ext.get(_QR_SETS_NAMESPACE) or {}
        assert any(i.get("name") == "QRS-Plugin-Set" for i in (ns.get("sets") or [])), (
            f"插件集没落到 {_QR_SETS_NAMESPACE}：ext keys={sorted(ext)}"
        )

    def test_v2_only_save_does_not_wipe_plugin_sets(self, client, auth_headers):
        """复演 QuickReplySettings.js:72 那次不带 sets 的 V2 保存。"""
        client.post("/api/quick-replies/save", headers=auth_headers, json=QR_PLUGIN_SET)
        client.post("/api/settings/save", headers=auth_headers, json={
            "extension_settings": {"quickReplyV2": {"enabled": True, "auto_send": False}},
        })
        presets = _get_top(client, auth_headers).get("quickReplyPresets") or []
        names = [p.get("name") for p in presets if isinstance(p, dict)]
        assert "QRS-Plugin-Set" in names, (
            "V2-only 保存把插件集合擦掉了（批次QR 的落点保护失效）"
        )

    def test_empty_palink_namespace_does_not_shadow_history_keys(
        self, client, auth_headers,
    ):
        """空 sets 的语义是"这一档没东西"，不许遮蔽 quickReplyV2.sets 那档
        （silly_tavern.py:247-255 的注释专门交代过这条）。"""
        client.post("/api/settings/save", headers=auth_headers, json={
            "extension_settings": {
                "quickReplyV2": {"sets": [QR_V2_SET]},
                _QR_SETS_NAMESPACE: {"sets": []},
            },
        })
        presets = _get_top(client, auth_headers).get("quickReplyPresets")
        assert presets == [QR_V2_SET], f"空命名空间把历史档遮蔽了：{presets!r}"


class TestReadSideShape:
    def test_absent_settings_yield_empty_lists_not_none(self, client, auth_headers):
        """没存过时顶层给 []，不给 None——ST 扩展拿到 None 会直接抛。"""
        top = _get_top(client, auth_headers)
        assert top.get("themes") == [] or top.get("themes") is None or isinstance(top.get("themes"), list)
        assert isinstance(top.get("themes"), list), "themes 必须是数组"
        assert isinstance(top.get("quickReplyPresets"), list), "quickReplyPresets 必须是数组"
