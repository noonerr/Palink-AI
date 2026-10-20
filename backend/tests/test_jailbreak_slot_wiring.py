"""批次JB：破甲（jailbreak）槽位接通测试（2026-10-21）。

背景：`UserSetting.jailbreak`（用户全局破甲，对应 ST 主界面 Jailbreak 框）此前是死列——
装配链从不读取。本批把它接进 `build_character_chat_messages` 的 jailbreak 槽，
并把槽位优先级改为与 ST 一手语义一致：

    卡片 jailbreak > 上下文模板 jailbreak > 用户全局 jailbreak

ST 一手锚点（参照树 d:/SillyTavern-release，1.18，2026-10-21 复核）：
- openai.js:103   default_jailbreak_prompt = ''（空 → 不注入，本仓空值零回归的依据）
- openai.js:684   jailbreak 进 prompt 集合（defaultPrompts）
- openai.js:1232  const systemPrompts = ['nsfw', 'jailbreak']（系统提示词家族）
- PromptManager.js:2024-2029 jailbreak prompt 名 "Post-History Instructions"，role=system
- PromptManager.js:2131-2134 默认排序 jailbreak 在 chatHistory 之后（历史后位置）
- openai.js:1496-1503 卡侧 jailbreakPromptOverride **覆盖**预设 jailbreak 内容
- script.js:3358-3362 + power-user.js:204 覆盖源 = 卡 post_history_instructions，
  受 prefer_character_jailbreak（默认 true）门控 ⇒ **卡 > 预设/全局**

测试分两组：
- TestBaselineNoJailbreak：破甲为空/未设置时消息序列与改前**逐字节一致**（零回归硬线）。
  这一组在改代码**之前**先跑绿，作为基线。
- TestGlobalJailbreakWiring：接通后的插入位置（断言完整消息序列，不只断包含）与优先级。
"""

import os
import sys
from types import SimpleNamespace

import pytest
from sqlalchemy.orm import Session

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.services.character_message_builder import (  # noqa: E402
    build_character_chat_messages,
)


def _mk_char(**overrides) -> SimpleNamespace:
    defaults = dict(
        id="jb-char",
        name="JBChar",
        description="D",
        personality="",
        scenario="",
        mes_example="",
        post_history_instructions=None,
        jailbreak=None,
    )
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def _run(db_session: Session, char, *, context_template=None, user_setting=None,
         dynamic_context_parts=None, message="hello", include_user_message=True,
         replace_placeholders=None):
    return build_character_chat_messages(
        db=db_session,
        char=char,
        user_nickname="Tester",
        session_id="jb-sess",
        branch_id="jb-branch",
        message=message,
        images=[],
        system_prompt="SYS",
        dynamic_context_parts=dynamic_context_parts or [],
        prompt_lang="en",
        user_setting=user_setting,
        _replace_placeholders=replace_placeholders or (lambda text, u, c: text),
        _get_full_branch_history=lambda *a, **k: [],
        _contains_chinese=lambda t: False,
        normalize_image_url=lambda url, check_size=False: url,
        include_user_message=include_user_message,
        include_title_instruction=False,
        context_template=context_template,
    )


def _seq(msgs):
    """把消息列表压成 (role, content) 元组序列，便于整序列断言。"""
    return [(m.get("role"), m.get("content")) for m in msgs]


def _tmpl(name="Custom", system_prompt="", jailbreak=None, chat_start=""):
    return SimpleNamespace(
        name=name, system_prompt=system_prompt, jailbreak=jailbreak, chat_start=chat_start,
    )


# ---------------------------------------------------------------------------
# 基线组：无破甲时序列与改前逐字节一致（改代码前先跑绿）
# ---------------------------------------------------------------------------
class TestBaselineNoJailbreak:
    def test_minimal_sequence(self, db_session: Session):
        """最小装配：system + user，两条，无多余消息。"""
        msgs = _run(db_session, _mk_char())
        assert _seq(msgs) == [
            ("system", "SYS"),
            ("user", "hello"),
        ]

    def test_sequence_with_dynamic_parts_and_global_none(self, db_session: Session):
        """动态上下文 + user_setting 存在但 jailbreak=None：与不传 user_setting 完全一致。"""
        expected = [
            ("system", "SYS"),
            ("system", "DYN"),
            ("user", "hello"),
        ]
        without = _run(db_session, _mk_char(), dynamic_context_parts=["DYN"])
        with_none = _run(
            db_session, _mk_char(), dynamic_context_parts=["DYN"],
            user_setting=SimpleNamespace(jailbreak=None),
        )
        assert _seq(without) == expected
        assert _seq(with_none) == expected

    def test_whitespace_only_global_jailbreak_is_noop(self, db_session: Session):
        """全局 jailbreak 只有空白字符 → 视同未设置，不插消息（边界行为确定）。"""
        msgs = _run(
            db_session, _mk_char(),
            user_setting=SimpleNamespace(jailbreak="   \n\t  "),
        )
        assert _seq(msgs) == [
            ("system", "SYS"),
            ("user", "hello"),
        ]

    def test_default_template_jailbreak_still_passthrough(self, db_session: Session):
        """Default 模板保持 passthrough（既有行为）：模板 jailbreak 不注入。"""
        msgs = _run(
            db_session, _mk_char(),
            context_template=_tmpl(name="Default", jailbreak="TMPL JB"),
        )
        assert _seq(msgs) == [
            ("system", "SYS"),
            ("user", "hello"),
        ]

    def test_v2_phi_copy_not_double_consumed(self, db_session: Session):
        """V2 卡 jailbreak==PHI：只按 PHI 注入一次（历史后），槽位不重复消费。"""
        char = _mk_char(jailbreak="SAME PHI TEXT", post_history_instructions="SAME PHI TEXT")
        msgs = _run(db_session, char)
        assert _seq(msgs) == [
            ("system", "SYS"),
            ("system", "SAME PHI TEXT"),
            ("user", "hello"),
        ]


# ---------------------------------------------------------------------------
# 接通组：全局破甲插入位置 + 优先级（卡 > 模板 > 全局）
# ---------------------------------------------------------------------------
class TestGlobalJailbreakWiring:
    def test_global_jailbreak_inserted_after_leading_system_block(self, db_session: Session):
        """有破甲时出现在预期位置：前导 system 块之后、其余消息之前（整序列断言）。"""
        msgs = _run(
            db_session, _mk_char(),
            dynamic_context_parts=["DYN"],
            user_setting=SimpleNamespace(jailbreak="GLOBAL JB"),
        )
        assert _seq(msgs) == [
            ("system", "SYS"),
            ("system", "DYN"),
            ("system", "GLOBAL JB"),
            ("user", "hello"),
        ]

    def test_card_wins_over_template_and_global(self, db_session: Session):
        """三级同时在场：只有卡 jailbreak 注入（ST openai.js:1499 覆盖语义）。"""
        msgs = _run(
            db_session, _mk_char(jailbreak="CARD JB"),
            context_template=_tmpl(jailbreak="TMPL JB"),
            user_setting=SimpleNamespace(jailbreak="GLOBAL JB"),
        )
        contents = [c for _, c in _seq(msgs)]
        assert contents.count("CARD JB") == 1
        assert "TMPL JB" not in contents
        assert "GLOBAL JB" not in contents
        # 槽位 = 前导 system 块内、user 之前
        assert _seq(msgs) == [
            ("system", "SYS"),
            ("system", "CARD JB"),
            ("user", "hello"),
        ]

    def test_template_wins_over_global(self, db_session: Session):
        """无卡 jailbreak：模板 > 全局。"""
        msgs = _run(
            db_session, _mk_char(),
            context_template=_tmpl(jailbreak="TMPL JB"),
            user_setting=SimpleNamespace(jailbreak="GLOBAL JB"),
        )
        contents = [c for _, c in _seq(msgs)]
        assert contents.count("TMPL JB") == 1
        assert "GLOBAL JB" not in contents

    def test_global_used_when_template_jailbreak_empty(self, db_session: Session):
        """Custom 模板 jailbreak 为空 → 落到全局。"""
        msgs = _run(
            db_session, _mk_char(),
            context_template=_tmpl(jailbreak="  "),
            user_setting=SimpleNamespace(jailbreak="GLOBAL JB"),
        )
        contents = [c for _, c in _seq(msgs)]
        assert contents.count("GLOBAL JB") == 1

    def test_v2_phi_copy_occupies_slot_and_suppresses_global(self, db_session: Session):
        """V2 卡（jailbreak==PHI）视为已占用破甲槽：全局不再叠加注入。

        ST 语义依据：卡 post_history_instructions 就是破甲覆盖源（script.js:3361），
        覆盖生效时预设/全局 jailbreak 内容被替换而非追加（openai.js:1500-1503）。
        """
        char = _mk_char(jailbreak="SAME PHI TEXT", post_history_instructions="SAME PHI TEXT")
        msgs = _run(db_session, char, user_setting=SimpleNamespace(jailbreak="GLOBAL JB"))
        contents = [c for _, c in _seq(msgs)]
        assert contents.count("SAME PHI TEXT") == 1, "PHI 拷贝只注入一次"
        assert "GLOBAL JB" not in contents, "卡已占用破甲槽，全局被抑制"

    def test_overlong_global_jailbreak_injected_verbatim(self, db_session: Session):
        """超长破甲：原样注入、恰好一次、不静默截断（行为确定）。"""
        text = "JB" * 25_000  # 50k 字符
        msgs = _run(db_session, _mk_char(), user_setting=SimpleNamespace(jailbreak=text))
        hits = [(r, c) for r, c in _seq(msgs) if c == text]
        assert len(hits) == 1
        assert hits[0][0] == "system"

    def test_global_jailbreak_goes_through_placeholders(self, db_session: Session):
        """全局破甲与模板/卡同权：经 replace_placeholders 渲染。"""
        msgs = _run(
            db_session, _mk_char(),
            user_setting=SimpleNamespace(jailbreak="JB for {{char}}"),
            replace_placeholders=lambda text, u, c: text.replace("{{char}}", c),
        )
        contents = [c for _, c in _seq(msgs)]
        assert contents.count("JB for JBChar") == 1

    def test_inserted_message_role_is_system(self, db_session: Session):
        """破甲属系统提示词家族（ST openai.js:1232）：注入消息 role 必须是 system。"""
        msgs = _run(db_session, _mk_char(), user_setting=SimpleNamespace(jailbreak="GLOBAL JB"))
        jb = [m for m in msgs if m.get("content") == "GLOBAL JB"]
        assert len(jb) == 1
        assert jb[0]["role"] == "system"
