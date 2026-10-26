"""[SP-1 2026-10-26] 用户全局 sysprompt 接入 palink-native 装配（SPEC P0）。

三段判据（对应交付要求①②③）：

① 默认关 = 零回归硬线：``power_user.sysprompt`` 缺失 / enabled=false /
   content 空或纯空白 / 坏 JSON —— 消息序列与**不传 user_setting** 时
   **逐字节一致**（整 dict 相等，不是只比 role+content）。
② enabled=true 注入形状：只在 messages[0] 多出**一条**前置 system，
   其余段（worldInfoBefore → main → front_after → 历史 → 尾部）相对顺序
   与关闭态逐条相同；标题指令仍并进 main（_main_prompt_idx 不被位移）；
   群聊（is_group）不注入（ST 群聊是 group_sysprompt 槽，本批不接）。
   裁剪待遇：sysprompt 消息继承 main 的"不可裁"（_collect_prompt_sources）。
③ 选中通道跨用户隔离：A「设为当前」只写 A 的 UserSetting.power_user；
   B 的行不受影响，B 的反向写入也不回写 A。

ST 语义锚点（power-user.js:267-272，getSettingKey('system','prompt')）与
偏差记录写在 character_message_builder.build_character_chat_messages 的
SP-1 注释块，本文件只钉行为。

运行: cd backend && py -3 -m pytest tests/test_sysprompt_native_injection.py -q
"""
from __future__ import annotations

import json
import os
import sys
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.api.dependencies import get_current_user
from app.core.preset_library_seeds import BUILTIN_SYSPROMPT_PRESETS
from app.main import app
from app.models import User, UserSetting
from app.services.character_message_builder import (
    PALINK_PROMPT_ID_SYSPROMPT,
    build_character_chat_messages,
    read_enabled_sysprompt,
)

COLLECTION = "/api/preset-library"
CURRENT_URL = f"{COLLECTION}/sysprompt/current"


# ---------------------------------------------------------------------------
# 工具（对齐 test_jailbreak_slot_wiring 的 harness）
# ---------------------------------------------------------------------------
def _mk_char(**overrides) -> SimpleNamespace:
    defaults = dict(
        id="sp-char",
        name="SPChar",
        description="D",
        personality="",
        scenario="",
        mes_example="",
        post_history_instructions=None,
        jailbreak=None,
    )
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def _pu_setting(power_user, **extra) -> SimpleNamespace:
    base = dict(jailbreak=None, power_user=power_user)
    base.update(extra)
    return SimpleNamespace(**base)


def _run(
    db_session: Session,
    char,
    *,
    user_setting=None,
    system_prompt="SYS",
    dynamic_context_parts=None,
    front_before_main=None,
    front_after_main=None,
    message="hello",
    include_title_instruction=False,
    is_group=False,
    speaker_char=None,
    replace_placeholders=None,
):
    return build_character_chat_messages(
        db=db_session,
        char=char,
        user_nickname="Tester",
        session_id="sp-sess",
        branch_id="sp-branch",
        message=message,
        images=[],
        system_prompt=system_prompt,
        dynamic_context_parts=dynamic_context_parts or [],
        prompt_lang="en",
        user_setting=user_setting,
        _replace_placeholders=replace_placeholders or (lambda text, u, c: text),
        _get_full_branch_history=lambda *a, **k: [],
        _contains_chinese=lambda t: False,
        normalize_image_url=lambda url, check_size=False: url,
        include_user_message=True,
        include_title_instruction=include_title_instruction,
        front_before_main=front_before_main,
        front_after_main=front_after_main,
        is_group=is_group,
        speaker_char=speaker_char,
    )


def _seq(msgs):
    return [(m.get("role"), m.get("content")) for m in msgs]


# ---------------------------------------------------------------------------
# ① 默认关：逐字节零回归
# ---------------------------------------------------------------------------
class TestSyspromptOffIsByteIdentical:
    OFF_FORMS = [
        ("power_user=None", _pu_setting(None)),
        ("power_user 空串", _pu_setting("")),
        ("power_user 空对象", _pu_setting("{}")),
        ("sysprompt 键缺失", _pu_setting('{"prefer_character_prompt": true}')),
        ("enabled=false 且 content 非空", _pu_setting(
            json.dumps({"sysprompt": {"enabled": False, "name": "中性对话", "content": "ACTIVE TEXT"}})
        )),
        ("enabled=true 但 content 空", _pu_setting(
            json.dumps({"sysprompt": {"enabled": True, "name": "x", "content": ""}})
        )),
        ("enabled=true 但 content 纯空白", _pu_setting(
            json.dumps({"sysprompt": {"enabled": True, "name": "x", "content": "  \n\t "}})
        )),
        ("坏 JSON", _pu_setting("{not-json")),
        ("sysprompt 非对象", _pu_setting('{"sysprompt": "oops"}')),
        ("enabled 缺省（未显式 true）", _pu_setting(
            json.dumps({"sysprompt": {"content": "TEXT WITHOUT ENABLED"}})
        )),
    ]

    def test_off_forms_identical_to_no_setting(self, db_session: Session):
        """十种关闭形态：整消息序列（含全部私有标记 dict）与不传设置逐字节相等。"""
        char = _mk_char()
        baseline_no_setting = _run(db_session, char)
        baseline_dyn = _run(
            db_session, char,
            dynamic_context_parts=["DYN"],
            front_before_main=[{"role": "system", "content": "WIB", "_palink_prompt_id": "worldInfoBefore"}],
            front_after_main=[{"role": "system", "content": "AN", "_palink_prompt_id": "author_note"}],
        )
        for label, setting in self.OFF_FORMS:
            plain = _run(db_session, char, user_setting=setting)
            assert plain == baseline_no_setting, label
            rich = _run(
                db_session, char, user_setting=setting,
                dynamic_context_parts=["DYN"],
                front_before_main=[{"role": "system", "content": "WIB", "_palink_prompt_id": "worldInfoBefore"}],
                front_after_main=[{"role": "system", "content": "AN", "_palink_prompt_id": "author_note"}],
            )
            assert rich == baseline_dyn, label

    def test_off_forms_no_system_at_front_or_tail(self, db_session: Session):
        """关闭态：既没有多出头部 system，也绝不产生尾部 system（尾部红线）。"""
        for label, setting in self.OFF_FORMS:
            msgs = _run(db_session, _mk_char(), user_setting=setting)
            assert _seq(msgs) == [("system", "SYS"), ("user", "hello")], label
            assert msgs[-1]["role"] == "user", label


# ---------------------------------------------------------------------------
# ② enabled=true：只多一条头部 system，其余顺序不变
# ---------------------------------------------------------------------------
class TestSyspromptOnInjection:
    def _on(self, db_session, content="GLOBAL SP", **kw):
        setting = _pu_setting(json.dumps(
            {"sysprompt": {"enabled": True, "name": "测试项", "content": content}}
        ))
        return _run(db_session, _mk_char(), user_setting=setting, **kw)

    def test_minimal_shape(self, db_session: Session):
        msgs = self._on(db_session)
        assert _seq(msgs) == [
            ("system", "GLOBAL SP"),
            ("system", "SYS"),
            ("user", "hello"),
        ]
        assert msgs[0]["_palink_prompt_id"] == PALINK_PROMPT_ID_SYSPROMPT
        assert msgs[1]["_palink_prompt_id"] == "main"
        assert msgs[-1]["role"] == "user", "尾部不得出现 system"

    def test_only_one_extra_message_rest_untouched(self, db_session: Session):
        """开/关两次真实装配对比：差集恰好是 messages[0] 一条，其余逐条相等。"""
        setting_off = _pu_setting(json.dumps(
            {"sysprompt": {"enabled": False, "content": "GLOBAL SP"}}
        ))
        common_kw = dict(
            dynamic_context_parts=["DYN"],
            front_before_main=[{"role": "system", "content": "WIB", "_palink_prompt_id": "worldInfoBefore"}],
            front_after_main=[{"role": "system", "content": "WA", "_palink_prompt_id": "worldInfoAfter"}],
        )
        off = _run(db_session, _mk_char(), user_setting=setting_off, **common_kw)
        on = self._on(db_session, **common_kw)
        assert len(on) == len(off) + 1
        assert on[0] == {"role": "system", "content": "GLOBAL SP",
                         "_palink_prompt_id": PALINK_PROMPT_ID_SYSPROMPT}
        assert on[1:] == off

    def test_macros_rendered(self, db_session: Session):
        msgs = self._on(db_session, content="SP for {{char}} and {{user}}",
                        replace_placeholders=lambda t, u, c: t.replace("{{char}}", c).replace("{{user}}", u))
        assert msgs[0]["content"] == "SP for SPChar and Tester"

    def test_title_instruction_still_lands_on_main(self, db_session: Session):
        """_main_prompt_idx 位移守卫：标题指令并进 main（SYS 条），不进 sysprompt 条。"""
        msgs = self._on(db_session, include_title_instruction=True)
        assert "GLOBAL SP" == msgs[0]["content"]
        assert msgs[1]["_palink_prompt_id"] == "main"
        assert msgs[1]["content"].startswith("SYS")
        assert "Title" in msgs[1]["content"] or "标题" in msgs[1]["content"]

    def test_group_chat_not_injected(self, db_session: Session):
        """群聊走 ST group_sysprompt 槽（本批未接）——is_group 时不得注入。"""
        setting = _pu_setting(json.dumps(
            {"sysprompt": {"enabled": True, "content": "GLOBAL SP"}}
        ))
        msgs = _run(db_session, _mk_char(), user_setting=setting, is_group=True,
                    speaker_char=_mk_char(id="s", name="Speaker"))
        assert "GLOBAL SP" not in [c for _, c in _seq(msgs)]

    def test_trim_priority_inherits_main(self, db_session: Session):
        """裁剪待遇：sysprompt 注入条目与 main 同为不可裁（超预算第一批裁掉 = 丢用户显式选择）。"""
        from app.services.roleplay_prompt_assembly import _collect_prompt_sources

        msgs = self._on(db_session) + [{"role": "user", "content": "hello"}]
        sources = _collect_prompt_sources(msgs, _mk_char())
        by_id = {s.identifier: s for s in sources}
        sp = by_id[PALINK_PROMPT_ID_SYSPROMPT]
        main = by_id["main"]
        assert sp.trimmable is False
        assert sp.priority == main.priority


# ---------------------------------------------------------------------------
# ③ 选中通道（API）+ 跨用户隔离
# ---------------------------------------------------------------------------
@pytest.fixture()
def as_user(client: TestClient):
    original = app.dependency_overrides.get(get_current_user)

    def _set(user: User):
        app.dependency_overrides[get_current_user] = lambda: user

    yield _set
    app.dependency_overrides.pop(get_current_user, None)
    if original is not None:
        app.dependency_overrides[get_current_user] = original


def _mk_user(db_session, username: str) -> User:
    user = User(username=username, hashed_password="x", role="user", is_active=True)
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


def _row(db_session, user_id) -> UserSetting | None:
    return db_session.query(UserSetting).filter(UserSetting.user_id == user_id).first()


class TestSyspromptCurrentEndpoint:
    def test_default_off_in_library_view(self, client: TestClient, auth_headers):
        data = client.get(COLLECTION).json()
        assert data["sysprompt_current"] == {"enabled": False, "name": "", "has_content": False}

    def test_select_builtin_writes_power_user_selection(self, client: TestClient, db_session: Session, test_user, auth_headers):
        seed = next(s for s in BUILTIN_SYSPROMPT_PRESETS if s["name"] == "入戏扮演")
        resp = client.post(CURRENT_URL, json={"name": "入戏扮演"}, headers=auth_headers)
        assert resp.status_code == 200, resp.text
        assert resp.json()["current"] == {"enabled": True, "name": "入戏扮演", "has_content": True}
        row = _row(db_session, test_user.id)
        pu = json.loads(row.power_user)
        assert pu["sysprompt"]["enabled"] is True
        assert pu["sysprompt"]["name"] == "入戏扮演"
        assert pu["sysprompt"]["content"] == seed["content"]

    def test_other_power_user_keys_preserved(self, client: TestClient, db_session: Session, test_user, auth_headers):
        row = _row(db_session, test_user.id) or UserSetting(user_id=test_user.id)
        row.power_user = json.dumps({"prefer_character_prompt": False, "sysprompt": {"enabled": False, "post_history": "PH"}})
        db_session.add(row)
        db_session.commit()
        assert client.post(CURRENT_URL, json={"name": "中性对话"}, headers=auth_headers).status_code == 200
        pu = json.loads(_row(db_session, test_user.id).power_user)
        assert pu["prefer_character_prompt"] is False
        assert pu["sysprompt"]["post_history"] == "PH"
        assert pu["sysprompt"]["enabled"] is True

    def test_clear_keeps_selection_but_disables(self, client: TestClient, db_session: Session, test_user, auth_headers):
        assert client.post(CURRENT_URL, json={"name": "轻松休闲"}, headers=auth_headers).status_code == 200
        resp = client.post(CURRENT_URL, json={"clear": True}, headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["current"] == {"enabled": False, "name": "轻松休闲", "has_content": True}
        pu = json.loads(_row(db_session, test_user.id).power_user)
        assert pu["sysprompt"]["enabled"] is False
        assert pu["sysprompt"]["content"]  # 取消启用不清正文（ST 勾选框语义）
        # 取消启用后装配读取必为 ""（默认关回到零回归）
        assert _build_text_from_setting(pu) == ""

    def test_validation(self, client: TestClient, auth_headers):
        assert client.post(CURRENT_URL, json={}, headers=auth_headers).status_code == 400
        assert client.post(CURRENT_URL, json={"name": "不存在的名"}, headers=auth_headers).status_code == 404
        assert client.post(CURRENT_URL, json={"name": "中性对话", "clear": True}, headers=auth_headers).status_code == 400

    def test_selection_is_per_user(self, client: TestClient, db_session: Session, test_user, as_user, auth_headers):
        """③ 跨用户隔离：A 的选中值不进 B 的行；B 的写入不回写 A。"""
        other = _mk_user(db_session, "sp_other_user")
        assert client.post(CURRENT_URL, json={"name": "入戏扮演"}, headers=auth_headers).status_code == 200  # A=test_user

        as_user(other)
        data_b = client.get(COLLECTION).json()
        assert data_b["sysprompt_current"] == {"enabled": False, "name": "", "has_content": False}
        assert client.post(CURRENT_URL, json={"name": "轻松休闲"}, headers=auth_headers).status_code == 200  # B 选中另一条

        pu_a = json.loads(_row(db_session, test_user.id).power_user)
        pu_b = json.loads(_row(db_session, other.id).power_user)
        assert pu_a["sysprompt"]["name"] == "入戏扮演"
        assert pu_b["sysprompt"]["name"] == "轻松休闲"

        # 装配消费按各自行读取：A 行读出 A 的正文，B 行读出 B 的正文
        assert read_enabled_sysprompt(_row(db_session, test_user.id)) == pu_a["sysprompt"]["content"]
        assert read_enabled_sysprompt(_row(db_session, other.id)) == pu_b["sysprompt"]["content"]


def _build_text_from_setting(power_user_dict) -> str:
    return read_enabled_sysprompt(SimpleNamespace(power_user=json.dumps(power_user_dict)))
