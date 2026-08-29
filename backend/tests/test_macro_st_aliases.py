"""ST 1.18.0 宏命名兼容四件套 + {{if}}/{{else}} 条件块测试（批次 A2）。

ST 1.18.0 真值:
- macros/definitions/variable-macros.js:119-136  {{hasvar::name}} -> "true"/"false"
- macros/definitions/variable-macros.js:267-284  {{hasglobalvar::name}} -> "true"/"false"
- macros/definitions/variable-macros.js:139-156  {{deletevar::name}} -> ""（删除 local 变量）
- macros/definitions/variable-macros.js:287-304  {{deleteglobalvar::name}} -> ""
- macros/definitions/core-macros.js:134-213      {{if cond}}then{{else}}other{{/if}}：
  falsy = 空串 或 isFalseBoolean（"off"/"false"/"0"，utils.js:1020-1022）；
  支持 ! 取反、变量简写 .name（getvar）/$name（getglobalvar）、嵌套宏条件、
  裸简单宏名条件、嵌套 if 块；delayArgResolution——未选分支的宏不求值。
- 旧名 {{exists}}/{{delvar}}（Palink 既有）保留不回归。

运行: cd backend && python -m pytest tests/test_macro_st_aliases.py -v
"""
from __future__ import annotations

import os
import sys

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import pytest

from app.models.chat_variable import ChatVariable, GlobalVariable
from app.services.macro_service import MacroEnv, evaluate_macros

SESSION_ID = "sess-macro-aliases"
USER_ID = 1


def _make_env(db) -> MacroEnv:
    return MacroEnv(
        db=db,
        session_id=SESSION_ID,
        user_id=USER_ID,
        user_name="Alice",
        char_name="Rex",
    )


def _set_chat_var(db, key: str, value: str) -> None:
    db.add(ChatVariable(session_id=SESSION_ID, key=key, value=value))
    db.flush()


def _set_global_var(db, key: str, value: str) -> None:
    db.add(GlobalVariable(user_id=USER_ID, key=key, value=value))
    db.flush()


# ============================================================
# 一、命名别名四件套
# ============================================================

class TestHasVar:
    def test_hasvar_true_when_exists(self, db_session):
        _set_chat_var(db_session, "flag", "1")
        out = evaluate_macros("{{hasvar::flag}}", _make_env(db_session))
        assert out == "true"

    def test_hasvar_false_when_missing(self, db_session):
        out = evaluate_macros("{{hasvar::no_such_var}}", _make_env(db_session))
        assert out == "false"


class TestHasGlobalVar:
    def test_hasglobalvar_true_when_exists(self, db_session):
        _set_global_var(db_session, "gflag", "on")
        out = evaluate_macros("{{hasglobalvar::gflag}}", _make_env(db_session))
        assert out == "true"

    def test_hasglobalvar_false_when_missing(self, db_session):
        out = evaluate_macros("{{hasglobalvar::no_such_global}}", _make_env(db_session))
        assert out == "false"


class TestDeleteVar:
    def test_deletevar_removes_chat_var(self, db_session):
        _set_chat_var(db_session, "tmp", "x")
        out = evaluate_macros("{{deletevar::tmp}}", _make_env(db_session))
        assert out == ""
        after = evaluate_macros("{{hasvar::tmp}}", _make_env(db_session))
        assert after == "false"

    def test_deleteglobalvar_removes_global_var(self, db_session):
        _set_global_var(db_session, "gtmp", "y")
        out = evaluate_macros("{{deleteglobalvar::gtmp}}", _make_env(db_session))
        assert out == ""
        after = evaluate_macros("{{hasglobalvar::gtmp}}", _make_env(db_session))
        assert after == "false"


# ============================================================
# 二、{{if}}/{{else}}/{{/if}} 条件块
# ============================================================

class TestIfBlock:
    def test_if_true_takes_then_branch(self, db_session):
        _set_chat_var(db_session, "flag", "1")
        out = evaluate_macros("A{{if {{getvar::flag}}}}then-part{{else}}else-part{{/if}}B", _make_env(db_session))
        assert out == "Athen-partB"

    def test_if_false_takes_else_branch(self, db_session):
        out = evaluate_macros("A{{if {{getvar::no_flag}}}}then-part{{else}}else-part{{/if}}B", _make_env(db_session))
        assert out == "Aelse-partB"

    def test_if_false_without_else_is_empty(self, db_session):
        out = evaluate_macros("A{{if {{getvar::no_flag}}}}then-part{{/if}}B", _make_env(db_session))
        assert out == "AB"

    def test_if_true_without_else_keeps_then(self, db_session):
        _set_chat_var(db_session, "flag", "1")
        out = evaluate_macros("A{{if {{getvar::flag}}}}then-part{{/if}}B", _make_env(db_session))
        assert out == "Athen-partB"

    def test_if_condition_with_nested_macro_value(self, db_session):
        _set_chat_var(db_session, "name", "小明")
        out = evaluate_macros("{{if {{getvar::name}}}}hello {{getvar::name}}{{/if}}", _make_env(db_session))
        assert out == "hello 小明"

    def test_if_var_shorthand_local(self, db_session):
        _set_chat_var(db_session, "shorthand", "1")
        out = evaluate_macros("{{if .shorthand}}L{{else}}N{{/if}}", _make_env(db_session))
        assert out == "L"

    def test_if_var_shorthand_global(self, db_session):
        _set_global_var(db_session, "gshorthand", "1")
        out = evaluate_macros("{{if $gshorthand}}G{{else}}N{{/if}}", _make_env(db_session))
        assert out == "G"

    def test_if_negation(self, db_session):
        out = evaluate_macros("{{if !{{getvar::no_flag}}}}negated-true{{/if}}", _make_env(db_session))
        assert out == "negated-true"

    def test_if_literal_string_is_truthy(self, db_session):
        out = evaluate_macros("{{if hello}}lit-kept{{/if}}", _make_env(db_session))
        assert out == "lit-kept"

    def test_if_falsy_boolean_strings(self, db_session):
        for lit in ("0", "false", "off"):
            out = evaluate_macros("{{if " + lit + "}}T{{else}}F{{/if}}", _make_env(db_session))
            assert out == "F"

    def test_if_nested_blocks(self, db_session):
        _set_chat_var(db_session, "outer", "1")
        _set_chat_var(db_session, "inner", "")
        template = "{{if {{getvar::outer}}}}O{{if {{getvar::inner}}}}I{{else}}not-i{{/if}}{{/if}}"
        out = evaluate_macros(template, _make_env(db_session))
        assert out == "Onot-i"

    def test_if_delay_arg_resolution_side_effect_skipped(self, db_session):
        """未选中分支的副作用宏不得执行（ST delayArgResolution 语义）。"""
        out = evaluate_macros(
            "{{if {{getvar::no_flag}}}}{{setvar::side::on}}{{else}}skipped{{/if}}",
            _make_env(db_session),
        )
        assert out == "skipped"
        assert evaluate_macros("{{hasvar::side}}", _make_env(db_session)) == "false"

    def test_if_inline_form(self, db_session):
        """ST 行内形态 {{if cond::content}}（core-macros.js unnamedArgs[1]）。"""
        _set_chat_var(db_session, "flag", "1")
        out = evaluate_macros("{{if {{getvar::flag}}::inline-shown}}", _make_env(db_session))
        assert out == "inline-shown"
        out2 = evaluate_macros("{{if {{getvar::no_flag}}::inline-shown}}", _make_env(db_session))
        assert out2 == ""

    def test_if_unclosed_left_untouched(self, db_session):
        """未闭合的 {{if（无 {{/if}} 配对）不消费、不崩溃（体内用非宏文本隔离）。"""
        raw = "prefix {{if unknown}} dangling"
        out = evaluate_macros(raw, _make_env(db_session))
        assert out == raw


# ============================================================
# 三、防御与兼容
# ============================================================

class TestGuards:
    def test_unknown_macro_untouched(self, db_session):
        raw = "keep {{definitely_not_a_macro_here}} as-is"
        out = evaluate_macros(raw, _make_env(db_session))
        assert out == raw

    def test_unknown_name_inside_if_is_truthy_literal(self, db_session):
        """条件为未注册名字面量时不误伤：非空即 truthy，分支保留。"""
        out = evaluate_macros("{{if unknownWord}}kept{{/if}}", _make_env(db_session))
        assert out == "kept"

    def test_legacy_exists_still_works(self, db_session):
        _set_chat_var(db_session, "legacy", "v")
        assert evaluate_macros("{{exists::legacy}}", _make_env(db_session)) == "true"
        assert evaluate_macros("{{exists::missing}}", _make_env(db_session)) == "false"

    def test_legacy_delvar_still_works(self, db_session):
        _set_chat_var(db_session, "legacy", "v")
        assert evaluate_macros("{{delvar::legacy}}", _make_env(db_session)) == ""
        assert evaluate_macros("{{hasvar::legacy}}", _make_env(db_session)) == "false"

    def test_if_block_converges_within_iterations(self, db_session):
        """多个/多层 if 块求值必须收敛，不得死循环（max_iterations 兜底）。"""
        _set_chat_var(db_session, "a", "1")
        _set_chat_var(db_session, "b", "1")
        template = (
            "{{if {{getvar::a}}}}A{{else}}x{{/if}}"
            "{{if {{getvar::b}}}}B{{else}}y{{/if}}"
            "{{if {{getvar::a}}}}{{if {{getvar::b}}}}AB{{/if}}{{/if}}"
        )
        out = evaluate_macros(template, _make_env(db_session))
        assert out == "ABAB"
