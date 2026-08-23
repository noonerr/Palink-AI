"""Phase 4 P2 项: 正则脚本引擎 + 用户级缓存失效测试。

覆盖 Stage 3:
1. sanitize_regex_macro (ST 1.18.0 engine.js:304-324) 转义对齐
2. _apply_regex_scripts 的 allowed_regex_names 白名单过滤
3. invalidate_user_cache 用户级隔离（不误伤其他用户）

参考:
- SillyTavern-1.18.0/public/scripts/extensions/regex/engine.js:44 (RegexProvider maxSize=1000)
- SillyTavern-1.18.0/public/scripts/extensions/regex/engine.js:304-324 (sanitizeRegexMacro)
- SillyTavern-1.18.0/public/scripts/index.js:1395 (character_allowed_regex 白名单)
"""
from __future__ import annotations

import os
import sys
from types import SimpleNamespace

# 让 backend 目录可被导入
_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import pytest


# ---------------------------------------------------------------------------
# Test 1: sanitize_regex_macro 对齐 ST 1.18.0 engine.js:304-324
# ---------------------------------------------------------------------------

def test_sanitize_regex_macro_escapes_all_metachars():
    """ST 1.18.0 转义完整字符集: \\n \\r \\t \\v \\f \\0 + . ^ $ * + ? { } [ ] \\ / | ( """
    from app.api.character_ext import sanitize_regex_macro

    # 控制字符必须转为字面 \n \r \t \v \f \0
    assert sanitize_regex_macro("\n") == "\\n"
    assert sanitize_regex_macro("\r") == "\\r"
    assert sanitize_regex_macro("\t") == "\\t"
    assert sanitize_regex_macro("\v") == "\\v"
    assert sanitize_regex_macro("\f") == "\\f"
    assert sanitize_regex_macro("\0") == "\\0"

    # 正则元字符必须转义
    for c in (".", "^", "$", "*", "+", "?", "{", "}", "[", "]", "\\", "/", "|", "(", ")"):
        escaped = sanitize_regex_macro(c)
        assert escaped == "\\" + c, f"char {c!r} should escape to \\{c}, got {escaped!r}"


def test_sanitize_regex_macro_preserves_safe_chars():
    """字母数字、空格、常见标点（非正则元字符）应原样保留。"""
    from app.api.character_ext import sanitize_regex_macro

    assert sanitize_regex_macro("hello") == "hello"
    assert sanitize_regex_macro("User said: hello world") == "User said: hello world"
    assert sanitize_regex_macro("emoji 🎉 test") == "emoji 🎉 test"


def test_sanitize_regex_macro_handles_non_string():
    """非字符串/空值应安全返回。"""
    from app.api.character_ext import sanitize_regex_macro

    assert sanitize_regex_macro("") == ""
    assert sanitize_regex_macro(None) is None
    assert sanitize_regex_macro(123) == 123  # type: ignore[arg-type]


def test_sanitize_regex_macro_mixed_string():
    """混合字符串：仅转义正则元字符，其他原样。"""
    from app.api.character_ext import sanitize_regex_macro

    # "1.5" 中的 . 应被转义
    assert sanitize_regex_macro("1.5") == "1\\.5"
    # "a/b" 中的 / 应被转义
    assert sanitize_regex_macro("a/b") == "a\\/b"
    # 混合换行
    assert sanitize_regex_macro("a\nb") == "a\\nb"


# ---------------------------------------------------------------------------
# Test 2: _apply_regex_scripts 的 allowed_regex_names 白名单过滤
# ---------------------------------------------------------------------------

def _make_script(name: str, find: str = "foo", replace: str = "bar") -> dict:
    return {
        "scriptName": name,
        "findRegex": find,
        "replaceString": replace,
        "placement": [2],  # AI_OUTPUT = 2
        "disabled": False,
        "markdownOnly": False,
        "promptOnly": False,
        "runOnEdit": False,
        "substituteRegex": 0,
        "minDepth": None,
        "maxDepth": None,
        "order": 0,
    }


def _make_extensions(scripts: list) -> dict:
    """构造 _apply_regex_scripts 期望的 extensions_raw 格式。"""
    return {"regex_scripts": scripts}


def test_apply_regex_scripts_whitelist_allows_named_script():
    """白名单中包含 scriptName 时，脚本应被应用。"""
    from app.api.character_ext import _apply_regex_scripts

    scripts = [_make_script("allow-this")]
    result = _apply_regex_scripts(
        "foo bar",
        _make_extensions(scripts),
        placement=2,
        is_markdown=False,
        is_prompt=False,
        ephemeral="persist",
        depth=0,
        allowed_regex_names=["allow-this"],
    )
    assert result == "bar bar"


def test_apply_regex_scripts_whitelist_filters_unnamed_script():
    """白名单非空但 scriptName 不在其中时，脚本应被跳过。"""
    from app.api.character_ext import _apply_regex_scripts

    scripts = [_make_script("blocked-script")]
    result = _apply_regex_scripts(
        "foo bar",
        _make_extensions(scripts),
        placement=2,
        is_markdown=False,
        is_prompt=False,
        ephemeral="persist",
        depth=0,
        allowed_regex_names=["only-this-one"],
    )
    # 脚本被跳过，原文本不变
    assert result == "foo bar"


def test_apply_regex_scripts_whitelist_none_means_no_filter():
    """allowed_regex_names=None 表示不过滤（默认行为，向后兼容）。"""
    from app.api.character_ext import _apply_regex_scripts

    scripts = [_make_script("any-name")]
    result = _apply_regex_scripts(
        "foo bar",
        _make_extensions(scripts),
        placement=2,
        is_markdown=False,
        is_prompt=False,
        ephemeral="persist",
        depth=0,
        allowed_regex_names=None,  # 默认行为
    )
    assert result == "bar bar"


def test_apply_regex_scripts_whitelist_empty_list_blocks_all():
    """allowed_regex_names=[] 空列表表示无任何脚本被允许（严格模式）。"""
    from app.api.character_ext import _apply_regex_scripts

    scripts = [_make_script("some-script")]
    result = _apply_regex_scripts(
        "foo bar",
        _make_extensions(scripts),
        placement=2,
        is_markdown=False,
        is_prompt=False,
        ephemeral="persist",
        depth=0,
        allowed_regex_names=[],  # 空列表 = 严格禁止
    )
    assert result == "foo bar"


# ---------------------------------------------------------------------------
# Test 3: invalidate_user_cache 用户级隔离
# ---------------------------------------------------------------------------

def test_invalidate_user_cache_only_clears_target_user():
    """invalidate_user_cache(prefix, user_id) 只清当前用户缓存，不影响其他用户。

    模拟 FastAPI 调用：通过 kwargs 传入 user，使 _build_key 走 kwargs 路径
    生成 "test_list:user=<id>" 格式的 key。
    """
    from app.core.cache import cached, invalidate_user_cache, _cache

    # 清空 cache 确保测试隔离
    _cache.clear()

    call_count = {"a": 0, "b": 0}

    @cached(ttl_seconds=60, key_prefix="test_list")
    def get_list(user):
        call_count[user.role] += 1
        return [user.role]

    user_a = SimpleNamespace(id=1, role="a")
    user_b = SimpleNamespace(id=2, role="b")

    # 首次调用：两个用户都 miss（用 kwargs 调用，模拟 FastAPI 行为）
    assert get_list(user=user_a) == ["a"]
    assert get_list(user=user_b) == ["b"]
    assert call_count["a"] == 1
    assert call_count["b"] == 1

    # 二次调用：两个用户都应命中缓存
    assert get_list(user=user_a) == ["a"]
    assert get_list(user=user_b) == ["b"]
    assert call_count["a"] == 1
    assert call_count["b"] == 1

    # 失效用户 A 的缓存
    invalidate_user_cache("test_list", user_a.id)

    # 用户 A 应 miss 重算，用户 B 应继续命中缓存
    assert get_list(user=user_a) == ["a"]
    assert get_list(user=user_b) == ["b"]
    assert call_count["a"] == 2  # 重算了
    assert call_count["b"] == 1  # 仍命中缓存

    _cache.clear()


def test_invalidate_user_cache_returns_count():
    """invalidate_user_cache 返回被清除的缓存项数。"""
    from app.core.cache import cached, invalidate_user_cache, _cache

    _cache.clear()

    @cached(ttl_seconds=60, key_prefix="count_test")
    def get_items(user, page: int = 1):
        return [user.id, page]

    user = SimpleNamespace(id=42)
    # 写入 3 个不同 page 的缓存（用 kwargs 调用，模拟 FastAPI 行为）
    get_items(user=user, page=1)
    get_items(user=user, page=2)
    get_items(user=user, page=3)

    cleared = invalidate_user_cache("count_test", user.id)
    assert cleared == 3

    _cache.clear()


def test_invalidate_user_cache_isolates_users_with_same_prefix():
    """两个用户使用相同 prefix 的缓存（含分页参数），invalidate_user_cache 只影响目标用户。"""
    from app.core.cache import cached, invalidate_user_cache, _cache

    _cache.clear()

    call_count = {"u1": 0, "u2": 0}

    @cached(ttl_seconds=60, key_prefix="paged_list")
    def get_paged(user, page: int = 1):
        call_count[f"u{user.id}"] += 1
        return [user.id, page]

    user1 = SimpleNamespace(id=1)
    user2 = SimpleNamespace(id=2)

    # 两个用户都写 3 个分页缓存（用 kwargs 调用，模拟 FastAPI 行为）
    for page in (1, 2, 3):
        get_paged(user=user1, page=page)
        get_paged(user=user2, page=page)
    assert call_count["u1"] == 3
    assert call_count["u2"] == 3

    # 二次调用：全部命中缓存
    for page in (1, 2, 3):
        get_paged(user=user1, page=page)
        get_paged(user=user2, page=page)
    assert call_count["u1"] == 3
    assert call_count["u2"] == 3

    # 仅失效 user1 的所有分页缓存
    cleared = invalidate_user_cache("paged_list", user1.id)
    assert cleared == 3

    # user1 应 miss 重算，user2 仍命中缓存
    for page in (1, 2, 3):
        get_paged(user=user1, page=page)
        get_paged(user=user2, page=page)
    assert call_count["u1"] == 6  # 3 次重算
    assert call_count["u2"] == 3  # 仍命中缓存

    _cache.clear()


# ---------------------------------------------------------------------------
# Test 4: LRU 缓存容量对齐 ST 1.18.0 RegexProvider (maxSize=1000)
# ---------------------------------------------------------------------------

def test_regex_pattern_cache_capacity_is_1000():
    """_REGEX_PATTERN_CACHE_MAX 必须等于 1000，对齐 ST 1.18.0 engine.js:44。"""
    from app.api.character_ext import _REGEX_PATTERN_CACHE_MAX

    assert _REGEX_PATTERN_CACHE_MAX == 1000


# ---------------------------------------------------------------------------
# Test 5: R-6 — alternate greeting 提升时应用 AI_OUTPUT 显示正则
# ---------------------------------------------------------------------------

def test_apply_persist_regex_to_display_text_applies_ai_output_script():
    """`_apply_persist_regex_to_display_text`（AI_OUTPUT placement）应用角色卡
    extensions.regex_scripts 中的持久化脚本。

    R-6 修复链路：first_mes 为空时提升 alternate greeting 后，调用方使用与
    正常 first_mes 完全相同的此函数，确保提升的问候语占位符/正则规则展开
    （对齐 ST script.js:7690 对 alternateGreetings 逐个 getRegexedString）。
    """
    from app.api.character_ext import _apply_persist_regex_to_display_text

    char = SimpleNamespace(
        name="R6Char",
        extensions={"regex_scripts": [_make_script("r6-greet", find="Hello", replace="Greetings")]},
        preset_data=None,
        user_id=None,
    )
    result = _apply_persist_regex_to_display_text(
        "Hello, {{user}}!",
        db=None,
        char=char,
        user_name="Tester",
        placement=2,
        depth=0,
    )
    assert "Greetings" in result
    assert "Hello" not in result


def test_apply_persist_regex_to_display_text_passthrough_without_scripts():
    """无正则脚本时文本原样返回（提升分支空走，不破坏）。"""
    from app.api.character_ext import _apply_persist_regex_to_display_text

    char = SimpleNamespace(
        name="R6Char",
        extensions={},
        preset_data=None,
        user_id=None,
    )
    result = _apply_persist_regex_to_display_text(
        "Just a greeting.",
        db=None,
        char=char,
        user_name="Tester",
        placement=2,
        depth=0,
    )
    assert result == "Just a greeting."


# ---------------------------------------------------------------------------
# Test 6: P1-#2 — persist 正则结果经 _sync_message_content_to_active_swipe
#          同步后 content 与 active swipe 干净一致（无残留原文）
# ---------------------------------------------------------------------------

def test_sync_message_content_to_active_swipe_keeps_swipe_clean():
    """persist 层应用普通脚本后的最终文本写入消息时，active swipe 必须与
    content 同步为同一份已变换文本（P1-#2 三重叠加修复的持久化不变量）。
    """
    import json as _json

    from app.api.character_ext import _sync_message_content_to_active_swipe

    msg = SimpleNamespace(
        content="RAW",
        swipe_id=0,
        swipes=_json.dumps(["RAW"]),
        extra=None,
    )
    _sync_message_content_to_active_swipe(msg, "TRANSFORMED")
    assert msg.content == "TRANSFORMED"
    stored = _json.loads(msg.swipes)
    assert isinstance(stored, list) and len(stored) >= 1
    assert stored[0] == "TRANSFORMED", "active swipe 应同步为变换后的干净文本"


def test_sync_message_content_to_active_swipe_targets_active_index():
    """swipe_id>0 时同步落点必须是当前激活 swipe，其他 swipe 不被污染。"""
    import json as _json

    from app.api.character_ext import _sync_message_content_to_active_swipe

    msg = SimpleNamespace(
        content="old-active",
        swipe_id=1,
        swipes=_json.dumps(["first", "old-active"]),
        extra=None,
    )
    _sync_message_content_to_active_swipe(msg, "new-active")
    stored = _json.loads(msg.swipes)
    assert stored[0] == "first", "非激活 swipe 不得被改写"
    assert stored[1] == "new-active"
    assert msg.content == "new-active"
