"""[P0-IMPORT 2026-10-03] ``_load_extension_settings_regex_scripts`` 回归。

起因：这段 loader 的 ``try`` 里原本写着 ``from ..models.user_setting import
UserSetting``，而 ``app/models/user_setting.py`` **并不存在**（``UserSetting``
定义在 ``app/models/system.py``，且已在 ``character_ext.py`` 顶层导入）。于是：

* 每次调用恒抛 ``ModuleNotFoundError``；
* 该异常被函数尾部的 ``except Exception: return []`` 吞成空列表；
* 空列表对调用方与「用户没配正则」完全无法区分 → 全程零日志。

后果不是崩溃而是**静默失效**：``roleplay_prompt_assembly._has_bubble_render_support``
的三个能力判定源之一恒为空，@bubble 格式规范是否保留就少了一条腿在说话。
另两处同样的坏 import（``silly_tavern.py`` 的 themes/save 与 stats/get）不在
try 内，会让那两个端点直接 500。

本文件的用例覆盖三件事：
1. 真的能读出来（这正是原 bug 让它失败的断言）；
2. 「本来就没有」与「读不出来」可区分（后者必须留日志）；
3. 坏 import 不会被重新引入（源码级守卫）。
"""

import os
import sys

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import json  # noqa: E402
import re  # noqa: E402

import pytest  # noqa: E402

import app.api.character_ext as character_ext  # noqa: E402
import app.services.roleplay_prompt_assembly as assembly  # noqa: E402
from app.models import UserSetting  # noqa: E402

LOADER = character_ext._load_extension_settings_regex_scripts

ST_REGEX_SCRIPT = {
    "scriptName": "对话渲染系统",
    "findRegex": "@bubble:(\\S+?)\\|(\\S+?)\\|(.+)",
    "replaceString": '<span class="bubble">$3</span>',
    "trimStrings": [],
    "placement": [1, 2],
    "disabled": False,
    "markdownOnly": False,
    "promptOnly": False,
}


def _settings_with(scripts) -> str:
    return json.dumps(
        {
            "power_user": {"themes": []},
            "extension_settings": {
                "apiUrl": "http://127.0.0.1:8000",
                "regex_scripts": scripts,
            },
        },
        ensure_ascii=False,
    )


def _make_setting(db, user_id: int, payload) -> UserSetting:
    setting = UserSetting(user_id=user_id)
    setting.silly_tavern_settings = payload
    db.add(setting)
    db.commit()
    return setting


# ---------------------------------------------------------------------------
# 1. 正路：读得出来（原 bug 下本组全红）
# ---------------------------------------------------------------------------
class TestReadsRealScripts:
    def test_reads_script_written_by_st_plugin(self, db_session, test_user):
        _make_setting(db_session, test_user.id, _settings_with([ST_REGEX_SCRIPT]))

        scripts = LOADER(db_session, test_user.id)

        assert len(scripts) == 1, "ST 插件写入 extension_settings.regex_scripts 的脚本必须读得到"
        got = scripts[0]
        assert got["scriptName"] == "对话渲染系统"
        assert got["findRegex"] == ST_REGEX_SCRIPT["findRegex"]
        assert got["replaceString"] == ST_REGEX_SCRIPT["replaceString"]

    def test_normalises_snake_case_aliases(self, db_session, test_user):
        """ST 侧 camelCase 与 Palink 内部 snake_case 两种写法都要认。"""
        _make_setting(
            db_session,
            test_user.id,
            _settings_with(
                [
                    {
                        "name": "snake 写法",
                        "find_regex": "x",
                        "replace_string": "y",
                        "disabled": False,
                    }
                ]
            ),
        )

        scripts = LOADER(db_session, test_user.id)

        assert len(scripts) == 1
        assert scripts[0]["findRegex"] == "x"
        assert scripts[0]["replaceString"] == "y"

    def test_other_users_settings_are_not_read(self, db_session, test_user):
        """按 user_id 隔离：别人的设置读不到（防水平越权）。"""
        from app.core.security import get_password_hash
        from app.models import User

        other = User(
            username="other_user_ext_settings",
            hashed_password=get_password_hash("TestPassword1"),
            role="user",
            is_active=True,
        )
        db_session.add(other)
        db_session.commit()
        db_session.refresh(other)
        _make_setting(db_session, other.id, _settings_with([ST_REGEX_SCRIPT]))

        assert LOADER(db_session, test_user.id) == []

    @pytest.mark.parametrize(
        "payload",
        [
            None,
            "",
            json.dumps({"extension_settings": {}}),
            json.dumps({"extension_settings": {"regex_scripts": "not-a-list"}}),
            json.dumps({"extension_settings": None}),
        ],
        ids=["null", "empty-str", "no-key", "wrong-type", "null-ext-settings"],
    )
    def test_absent_or_malformed_shape_yields_empty(self, db_session, test_user, payload):
        """这些是「确实没有」，返回空是正确行为，且**不该**打 warning。"""
        if payload is not None:
            _make_setting(db_session, test_user.id, payload)

        assert LOADER(db_session, test_user.id) == []

    def test_disabled_scripts_are_skipped(self, db_session, test_user):
        _make_setting(
            db_session,
            test_user.id,
            _settings_with([dict(ST_REGEX_SCRIPT, disabled=True), ST_REGEX_SCRIPT]),
        )

        assert len(LOADER(db_session, test_user.id)) == 1


# ---------------------------------------------------------------------------
# 2. 「读不出来」必须与「本来就没有」可区分
# ---------------------------------------------------------------------------
class TestFailuresAreVisible:
    def test_broken_json_logs_warning_and_returns_empty(self, db_session, test_user, caplog):
        """存了但解析不了 = 故障，必须留痕；不得静默伪装成「没有」。"""
        _make_setting(db_session, test_user.id, "{ this is not json ")
        # 该列是 Text，ORM 原样存，故这里确实是坏 JSON
        with caplog.at_level("WARNING", logger="app.api.character_ext"):
            result = LOADER(db_session, test_user.id)

        assert result == []
        warnings = [r for r in caplog.records if r.levelname == "WARNING"]
        assert warnings, "读取失败必须打 WARNING —— 这正是原 bug 让人查不到的那一层"
        assert any("ext-settings-regex" in r.getMessage() for r in warnings)

    def test_absent_setting_does_not_log(self, db_session, test_user, caplog):
        """对照组：真的没有 → 不打 warning，避免把日志刷满。"""
        with caplog.at_level("WARNING", logger="app.api.character_ext"):
            assert LOADER(db_session, test_user.id) == []

        assert not [r for r in caplog.records if r.levelname == "WARNING"]


# ---------------------------------------------------------------------------
# 3. 坏 import 不得重新引入
# ---------------------------------------------------------------------------
class TestNoPhantomModuleImport:
    """``app.models.user_setting`` 这个模块不存在，谁再 import 谁就是错的。"""

    SOURCES = ("character_ext.py", "silly_tavern.py")
    # 只认真正的 import 语句：本仓库的注释里会正面提到这个坏路径（记录成因），
    # 若按「文件里出现该字符串」判定，改注释就会红。
    BAD_IMPORT_RE = re.compile(
        r"^\s*(?:from\s+[.\w]*models\.user_setting\s+import|import\s+[.\w]*models\.user_setting\b)",
        re.M,
    )

    @pytest.mark.parametrize("filename", SOURCES)
    def test_source_does_not_import_phantom_module(self, filename):
        path = os.path.join(_BACKEND_DIR, "app", "api", filename)
        with open(path, encoding="utf-8") as fh:
            src = fh.read()

        assert not self.BAD_IMPORT_RE.search(src), (
            f"{filename} 仍在 import 不存在的 app.models.user_setting；"
            "UserSetting 在 app.models.system（顶层已导入，无需局部再导）"
        )

    def test_guard_detects_the_actual_bad_import(self):
        """反证：守卫本身认得坏写法，否则它就是个恒真的假绿。"""
        assert self.BAD_IMPORT_RE.search("    from ..models.user_setting import UserSetting")
        assert self.BAD_IMPORT_RE.search("from app.models.user_setting import UserSetting")
        # 注释与文档字符串里的提及不算
        assert not self.BAD_IMPORT_RE.search("# 曾经写成 from ..models.user_setting import X")

    def test_phantom_module_really_does_not_exist(self):
        """守卫自身的前提：确认那个模块确实不存在（将来若真的拆文件，本用例提醒同步）。"""
        assert not os.path.exists(os.path.join(_BACKEND_DIR, "app", "models", "user_setting.py"))
        # 反证：正确的类确实可从 models 包导出
        from app.models import UserSetting as _US  # noqa: F401

        assert _US.__module__ == "app.models.system"


# ---------------------------------------------------------------------------
# 4. 端到端：@bubble 能力判定真的吃到了这份数据
# ---------------------------------------------------------------------------
class TestBubbleGateConsumesIt:
    def test_bubble_capability_detected_from_extension_settings(self, db_session, test_user, monkeypatch):
        """本组是这次修复的实际意义：门控少的那条腿现在能说话了。

        宿主可用 + 用户设置里有一条提到 bubble 的显示侧正则 → 判定有配套。
        """
        monkeypatch.setenv("PALINK_BUBBLE_IFRAME_HOST", "1")
        _make_setting(db_session, test_user.id, _settings_with([ST_REGEX_SCRIPT]))

        assert assembly._has_bubble_render_support(db_session, test_user.id, None) is True

    def test_gate_still_false_when_nothing_configured(self, db_session, test_user, monkeypatch):
        """对照组：没有任何配置时不得因为修了 import 就误判为「有配套」。"""
        monkeypatch.setenv("PALINK_BUBBLE_IFRAME_HOST", "1")

        assert assembly._has_bubble_render_support(db_session, test_user.id, None) is False