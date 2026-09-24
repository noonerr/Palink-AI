"""[P4-模型自主出图] 内置工具注册表 + dispatcher 分派 + 落库后执行。

PLAN：`docs/PLAN_模型自主出图_2026-09-24.md` S1/S2/S3/S4 的可自动化验收：

1. **注册表**：`palink__` 前缀命名但**精确名**匹配——同前缀的前端插件工具
   不得被误吞（分派劫持回归）。
2. **合并决策**（S3 回滚证据）：开关关闭时 `resolve_generation_tools` 把
   tools **原对象**透传（与改前逐字节一致）；开启时合并内置出图工具并去重。
3. **分派顺序**：内置工具必须先于前端 `tool_executor` 匹配——角色 WS 主路径
   带着 executor，若内置分支在其后，`palink__*` 调用会被转发给前端而失败。
   非内置名必须照旧走 executor；无内置 handler 时行为与改前一致。
4. **S4 护栏**：每轮最多 1 张（第二次调用拒绝）、空 prompt 拒绝、超长截断；
   拒绝一律是可继续的结构化短文本，模型据此回纯文本。
5. **落库后执行**（S2 时序契约）：工具调用发生在流中、消息未落库，handler
   只暂存；真实生成走 `generate_image_for_message(prompt=...)`，采用模型
   给的 prompt（不过启发式模板），正文零污染。

测试全程不碰真实网络与真实磁盘：LLM 流 / 上游图片服务都被替换。
"""

import asyncio
import os
import re
import sys
from types import SimpleNamespace

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import pytest  # noqa: E402

import app.services.inference_dispatcher as ind  # noqa: E402
import app.services.image_generation_service as igs  # noqa: E402
from app.services import message_media_service as mms  # noqa: E402
from app.services.builtin_tools import (  # noqa: E402
    GENERATE_IMAGE_TOOL_NAME,
    MAX_IMAGE_PROMPT_CHARS,
    MAX_MERGED_TOOLS,
    ModelImageRequestGate,
    get_builtin_tools_openai_format,
    is_builtin_tool,
    make_builtin_tool_handler,
    merge_builtin_tools,
    resolve_generation_tools,
)

MESSAGE_CONTENT = "正文不该被改写——模型自主出图也只写 extra.media"
MODEL_PROMPT = "a moonlit castle on a cliff, cinematic, highly detailed"

# 出图服务商凭据：测试全程用假上游（`generate_image` 被替换，不联网不花钱），
# 配置里只需一个非空占位。写成 ${VAR} 引用形式是为了过提交前的密钥扫描——
# 仓库里不允许出现任何形状的明文 key。
FAKE_API_KEY = "${PALINK_TEST_IMAGE_API_KEY}"


def _run(coro):
    return asyncio.run(coro)


# ---------------------------------------------------------------------------
# 1. 注册表与合并
# ---------------------------------------------------------------------------

def test_builtin_tool_matches_by_exact_name_not_prefix():
    assert is_builtin_tool(GENERATE_IMAGE_TOOL_NAME)
    # 前缀相似但非精确名：可能是前端插件工具，绝不能命中内置分派
    assert not is_builtin_tool(f"{GENERATE_IMAGE_TOOL_NAME}_pro")
    assert not is_builtin_tool("palink__")
    assert not is_builtin_tool("palink__generate_imag")
    assert not is_builtin_tool("frontend_plugin_tool")


def test_schema_is_openai_function_shape():
    (schema,) = get_builtin_tools_openai_format()
    assert schema["type"] == "function"
    assert schema["function"]["name"] == GENERATE_IMAGE_TOOL_NAME
    assert schema["function"]["parameters"]["required"] == ["prompt"]
    # 返回的是副本，改了不影响注册表
    schema["function"]["name"] = "mutated"
    assert get_builtin_tools_openai_format()[0]["function"]["name"] == GENERATE_IMAGE_TOOL_NAME


def test_merge_keeps_frontend_tools_and_dedups_builtin_name():
    frontend = [
        {"type": "function", "function": {"name": "plugin_draw", "parameters": {}}},
        # 与内置同名的插件工具被去重（内置优先）
        {"type": "function", "function": {"name": GENERATE_IMAGE_TOOL_NAME, "parameters": {}}},
    ]
    merged = merge_builtin_tools(frontend)
    names = [t["function"]["name"] for t in merged]
    assert names[0] == GENERATE_IMAGE_TOOL_NAME
    assert names.count(GENERATE_IMAGE_TOOL_NAME) == 1
    assert "plugin_draw" in names
    assert len(names) == len(set(names))


def test_merge_caps_total_tools_keeping_builtin_first():
    frontend = [
        {"type": "function", "function": {"name": f"plugin_{i}", "parameters": {}}}
        for i in range(MAX_MERGED_TOOLS + 10)
    ]
    merged = merge_builtin_tools(frontend)
    assert len(merged) == MAX_MERGED_TOOLS
    assert merged[0]["function"]["name"] == GENERATE_IMAGE_TOOL_NAME


def test_resolve_off_passthrough_is_byte_identical():
    tools = [{"type": "function", "function": {"name": "plugin_draw", "parameters": {}}}]
    out, gate, handler = resolve_generation_tools(tools, image_enabled=False)
    # 原对象透传 = 与改前逐字节一致（回滚证据）
    assert out is tools
    assert gate is None and handler is None


def test_resolve_on_merges_and_wires_gate():
    tools = [{"type": "function", "function": {"name": "plugin_draw", "parameters": {}}}]
    out, gate, handler = resolve_generation_tools(tools, image_enabled=True)
    assert [t["function"]["name"] for t in out] == [GENERATE_IMAGE_TOOL_NAME, "plugin_draw"]
    assert isinstance(gate, ModelImageRequestGate) and callable(handler)


# ---------------------------------------------------------------------------
# 2. S4 护栏：handler 门控
# ---------------------------------------------------------------------------

def test_handler_strips_prompt_whitespace():
    async def _scenario():
        gate = ModelImageRequestGate()
        handler = make_builtin_tool_handler(gate)
        assert "已接受" in await handler(GENERATE_IMAGE_TOOL_NAME, {"prompt": f"  {MODEL_PROMPT}  "})
        assert gate.take() == MODEL_PROMPT

    _run(_scenario())


def test_handler_allows_resubmit_after_take_consumed():
    """take() 消费后 gate 归零：每次生成新建 gate，正常流不会走到二次提交；
    此处锁定 take 的消费语义（未消费时拒绝，见下一条）。"""
    async def _scenario():
        gate = ModelImageRequestGate()
        handler = make_builtin_tool_handler(gate)
        assert "已接受" in await handler(GENERATE_IMAGE_TOOL_NAME, {"prompt": "a"})
        assert gate.take() == "a"
        assert "已接受" in await handler(GENERATE_IMAGE_TOOL_NAME, {"prompt": "b"})
        assert gate.take() == "b"

    _run(_scenario())


def test_handler_refuses_second_request_within_one_generation():
    async def _scenario():
        gate = ModelImageRequestGate()
        handler = make_builtin_tool_handler(gate)
        assert "已接受" in await handler(GENERATE_IMAGE_TOOL_NAME, {"prompt": "a"})
        refused = await handler(GENERATE_IMAGE_TOOL_NAME, {"prompt": "b"})
        assert "忽略" in refused or "拒绝" in refused
        assert gate.take() == "a"  # 第一张仍是生效请求，第二张未覆盖

    _run(_scenario())


def test_handler_refuses_empty_prompt_and_unknown_tool():
    async def _scenario():
        gate = ModelImageRequestGate()
        handler = make_builtin_tool_handler(gate)
        empty = await handler(GENERATE_IMAGE_TOOL_NAME, {"prompt": "   "})
        assert "拒绝" in empty and gate.take() is None
        no_args = await handler(GENERATE_IMAGE_TOOL_NAME, {})
        assert "拒绝" in no_args and gate.take() is None
        unknown = await handler("palink__unknown", {"prompt": "x"})
        assert "未知内置工具" in unknown and gate.take() is None

    _run(_scenario())


def test_handler_truncates_overlong_prompt():
    async def _scenario():
        gate = ModelImageRequestGate()
        handler = make_builtin_tool_handler(gate)
        await handler(GENERATE_IMAGE_TOOL_NAME, {"prompt": "x" * (MAX_IMAGE_PROMPT_CHARS + 500)})
        assert len(gate.take()) == MAX_IMAGE_PROMPT_CHARS

    _run(_scenario())


# ---------------------------------------------------------------------------
# 3. dispatcher 分派顺序（驱动真实工具循环，LLM 流为假）
# ---------------------------------------------------------------------------

def _tool_call_chunk(name: str, arguments: str, *, with_id: bool = True):
    tc = SimpleNamespace(
        index=0,
        id="call_1" if with_id else None,
        function=SimpleNamespace(name=name, arguments=arguments),
    )
    return SimpleNamespace(usage=None, choices=[SimpleNamespace(finish_reason=None, delta=SimpleNamespace(content=None, tool_calls=[tc]))])


def _finish_chunk(finish_reason: str, content=None):
    return SimpleNamespace(usage=None, choices=[SimpleNamespace(finish_reason=finish_reason, delta=SimpleNamespace(content=content, tool_calls=None))])


class _FakeStream:
    def __init__(self, chunks):
        self._chunks = list(chunks)

    def __aiter__(self):
        self._iter = iter(self._chunks)
        return self

    async def __anext__(self):
        try:
            return next(self._iter)
        except StopIteration:
            raise StopAsyncIteration from None

    async def close(self):
        pass


class _FakeClient:
    """每轮 create() 弹出一段预置 chunk 序列。"""

    def __init__(self, rounds):
        self._rounds = list(rounds)
        self.create_kwargs = []

    @property
    def chat(self):
        return self

    @property
    def completions(self):
        return self

    async def create(self, **kwargs):
        self.create_kwargs.append(kwargs)
        round_chunks = self._rounds.pop(0)
        if not isinstance(round_chunks, list):
            round_chunks = [round_chunks]
        return _FakeStream(round_chunks)


@pytest.fixture()
def fake_llm(monkeypatch):
    """屏蔽 provider 解析 / client 获取 / 输出上限，让 dispatcher 直达工具循环。"""
    monkeypatch.setattr(
        ind, "select_provider_for_model",
        lambda model_id, preferred_provider_id=None: (
            {"provider_type": "openai", "api_key": "", "base_url": "https://fake.invalid"},
            {"id": "fake-model"},
        ),
    )
    monkeypatch.setattr(ind, "_resolve_model_output_cap", lambda model_id: None)
    holder = {}

    def _install(rounds):
        client = _FakeClient(rounds)
        monkeypatch.setattr(ind, "get_async_openai_client", lambda **kw: client)
        holder["client"] = client
        return client

    holder["install"] = _install
    return holder


async def _collect(gen):
    return [event async for event in gen]


def _tool_round(name=GENERATE_IMAGE_TOOL_NAME):
    # 模型不带正文直接发起调用（典型工具优先行为）→ 落库时序契约的触发条件。
    # 流式语义：name 只在首个 delta 出现，续传 delta 的 name 为 None
    # （dispatcher 对 name 按字符串累加）。
    return [
        _tool_call_chunk(name, '{"prompt": "'),
        _tool_call_chunk(None, f'{MODEL_PROMPT}"}}', with_id=False),
        _finish_chunk("tool_calls"),
    ]


def test_builtin_tool_wins_over_frontend_executor(fake_llm):
    """分派顺序回归：内置分支必须在 tool_executor 之前（角色 WS 主路径带 executor）。"""
    async def _scenario():
        handler_calls, executor_calls = [], []

        async def handler(name, args):
            handler_calls.append(name)
            return "配图请求已接受"

        async def executor(name, call_id, args):
            executor_calls.append(name)
            return "frontend result"

        fake_llm["install"](
            [_tool_round(), _finish_chunk("stop", " 回复正文。")]
        )
        events = await _collect(ind.stream_text_completion(
            model_id="fake-model",
            messages=[{"role": "user", "content": "画一幅画"}],
            tools=[{"type": "function", "function": {"name": GENERATE_IMAGE_TOOL_NAME, "parameters": {}}}],
            tool_executor=executor,
            builtin_tool_handler=handler,
        ))
        assert handler_calls == [GENERATE_IMAGE_TOOL_NAME]
        assert executor_calls == []
        results = [e for e in events if "tool_result" in e]
        assert results and results[0]["tool_result"]["content"] == "配图请求已接受"
        # 第二轮照常生成：工具失败/成功都不阻塞文本
        contents = [e["content"] for e in events if "content" in e]
        assert "回复正文。" in "".join(contents)

    _run(_scenario())


def test_non_builtin_name_still_goes_to_executor(fake_llm):
    """前端插件工具照旧走 executor，内置 handler 不劫持。"""
    async def _scenario():
        handler_calls, executor_calls = [], []

        async def handler(name, args):
            handler_calls.append(name)
            return "builtin"

        async def executor(name, call_id, args):
            executor_calls.append(name)
            return "frontend result"

        fake_llm["install"](
            [_tool_round("plugin_draw"), _finish_chunk("stop", " done")]
        )
        await _collect(ind.stream_text_completion(
            model_id="fake-model",
            messages=[{"role": "user", "content": "hi"}],
            tools=[{"type": "function", "function": {"name": "plugin_draw", "parameters": {}}}],
            tool_executor=executor,
            builtin_tool_handler=handler,
        ))
        assert handler_calls == []
        assert executor_calls == ["plugin_draw"]

    _run(_scenario())


def test_builtin_name_without_handler_keeps_legacy_executor_path(fake_llm):
    """未合并内置工具的路径（如通用聊天）：行为与功能上线前一致。"""
    async def _scenario():
        executor_calls = []

        async def executor(name, call_id, args):
            executor_calls.append(name)
            return "frontend result"

        fake_llm["install"](
            [_tool_round(), _finish_chunk("stop", " done")]
        )
        events = await _collect(ind.stream_text_completion(
            model_id="fake-model",
            messages=[{"role": "user", "content": "hi"}],
            tools=[{"type": "function", "function": {"name": GENERATE_IMAGE_TOOL_NAME, "parameters": {}}}],
            tool_executor=executor,
        ))
        assert executor_calls == [GENERATE_IMAGE_TOOL_NAME]
        results = [e for e in events if "tool_result" in e]
        assert results[0]["tool_result"]["content"] == "frontend result"

    _run(_scenario())


def test_handler_exception_degrades_to_error_text_and_keeps_generating(fake_llm):
    """handler 抛异常 = S4 降级：泛化错误文本回填，生成继续，不崩流。"""
    async def _scenario():
        async def handler(name, args):
            raise RuntimeError("boom")

        fake_llm["install"](
            [_tool_round(), _finish_chunk("stop", " 文本照常。")]
        )
        events = await _collect(ind.stream_text_completion(
            model_id="fake-model",
            messages=[{"role": "user", "content": "hi"}],
            tools=[{"type": "function", "function": {"name": GENERATE_IMAGE_TOOL_NAME, "parameters": {}}}],
            builtin_tool_handler=handler,
        ))
        results = [e for e in events if "tool_result" in e]
        assert results[0]["tool_result"]["content"] == "Tool error: execution failed"
        contents = [e["content"] for e in events if "content" in e]
        assert "文本照常。" in "".join(contents)

    _run(_scenario())


def test_admin_gate_untouched_when_no_handlers(fake_llm):
    """G3 回归锁：无 executor / 无内置 handler 时，非管理员仍被角色闸拦下。"""
    async def _scenario():
        fake_llm["install"](
            [_tool_round(), _finish_chunk("stop", " done")]
        )
        events = await _collect(ind.stream_text_completion(
            model_id="fake-model",
            messages=[{"role": "user", "content": "hi"}],
            tools=[{"type": "function", "function": {"name": GENERATE_IMAGE_TOOL_NAME, "parameters": {}}}],
        ))
        results = [e for e in events if "tool_result" in e]
        assert results[0]["tool_result"]["content"] == "Tool execution requires admin permission"

    _run(_scenario())


# ---------------------------------------------------------------------------
# 4. 落库后执行：generate_image_for_message(prompt=...) 采用模型 prompt
# ---------------------------------------------------------------------------

@pytest.fixture()
def image_config_enabled(tmp_path, monkeypatch):
    """把出图配置指向 tmp 的「已启用」文件（generate_image 已被替换，不碰网络）。"""
    import json as _json

    path = tmp_path / "image_generation_config.json"
    path.write_text(
        _json.dumps({
            "enabled": True,
            "active_provider_id": "openai_compatible",
            "providers": [{
                "id": "openai_compatible",
                "name": "OpenAI Compatible",
                "type": "openai_compatible",
                "enabled": True,
                "base_url": "https://images.example.invalid/v1",
                "api_key": FAKE_API_KEY,
                "model": "gpt-image-1",
                "size": "768x1024",
                "response_format": "b64_json",
                "timeout_seconds": 30,
            }],
        }),
        encoding="utf-8",
    )
    monkeypatch.setattr(igs, "_config_path", lambda: str(path))
    monkeypatch.setattr(igs, "_config_cache", None)
    monkeypatch.setattr(igs, "_config_mtime", None)


@pytest.fixture()
def make_message(db_session, test_user):
    """建一条真实落库的 CharacterChatMessage（含 FK 链）。"""

    def _make() -> object:
        import uuid as _uuid

        from app.models import Character, CharacterChatMessage, CharacterChatSession

        char = Character(
            id=f"p4char-{_uuid.uuid4().hex[:8]}",
            user_id=test_user.id,
            name="P4Char",
        )
        db_session.add(char)
        db_session.flush()

        session_id = f"p4sess-{_uuid.uuid4().hex[:8]}"
        db_session.add(
            CharacterChatSession(
                id=session_id,
                user_id=test_user.id,
                character_id=char.id,
                title="p4-builtin-tool",
            )
        )
        db_session.commit()

        message = CharacterChatMessage(
            session_id=session_id,
            role="assistant",
            content=MESSAGE_CONTENT,
        )
        db_session.add(message)
        db_session.commit()
        db_session.refresh(message)
        return message

    return _make


def test_generate_image_for_message_uses_model_prompt(
    db_session, test_user, make_message, image_config_enabled, monkeypatch
):
    """S2 验收：模型给的 prompt 直接采用（不过启发式模板），ready 落库，正文零污染。"""
    message = make_message()
    captured = {}

    async def _fake_generate_image(*, prompt, user_id, provider_id=None):
        captured["prompt"] = prompt
        captured["user_id"] = user_id
        return igs.GeneratedImage(
            image_url="/media/generated/p4.png",
            prompt=prompt,
            provider_id="prov-1",
            metadata={"seed": 7},
        )

    monkeypatch.setattr(igs, "generate_image", _fake_generate_image)

    _run(igs.generate_image_for_message(
        db_session, test_user, message, [], character=None, prompt=MODEL_PROMPT,
    ))

    assert captured["prompt"] == MODEL_PROMPT
    assert captured["user_id"] == test_user.id
    db_session.expire_all()
    media = mms.get_message_media(message)
    assert len(media) == 1
    assert media[0]["status"] == "ready"
    assert media[0]["prompt"] == MODEL_PROMPT
    assert media[0]["url"] == "/media/generated/p4.png"
    assert media[0]["seed"] == 7
    assert message.content == MESSAGE_CONTENT


def test_generate_image_for_message_without_prompt_keeps_template_path(
    db_session, test_user, make_message, image_config_enabled, monkeypatch
):
    """不传 prompt 时维持既有启发式行为（模板拼装），P1 回归保护。"""
    message = make_message()

    async def _fake_generate_image(*, prompt, user_id, provider_id=None):
        return igs.GeneratedImage(
            image_url="/media/generated/p4b.png", prompt=prompt, provider_id="prov-1",
        )

    monkeypatch.setattr(igs, "generate_image", _fake_generate_image)
    _run(igs.generate_image_for_message(db_session, test_user, message, [], character=None))
    db_session.expire_all()
    media = mms.get_message_media(message)
    assert len(media) == 1
    # 模板路径的 prompt 由 build_message_image_prompt 生成，与模型 prompt 无关
    assert media[0]["prompt"] != MODEL_PROMPT
    assert media[0]["status"] == "ready"


# ---------------------------------------------------------------------------
# 5. 服务商可用性门控
# ---------------------------------------------------------------------------

def _provider_config(enabled=True, with_provider=True):
    config = {"enabled": enabled, "providers": [], "active_provider_id": "p1"}
    if with_provider:
        config["providers"] = [{
            "id": "p1", "type": "openai_compatible", "enabled": True,
            "base_url": "https://api.example.invalid/v1",
            "api_key": FAKE_API_KEY,
            "model": "img-model",
        }]
    return config


def test_availability_true_when_enabled_and_provider_ready(monkeypatch):
    monkeypatch.setattr(igs, "_get_raw_config", lambda: _provider_config())
    assert igs.is_image_generation_available() is True


def test_availability_false_cases(monkeypatch):
    monkeypatch.setattr(igs, "_get_raw_config", lambda: _provider_config(enabled=False))
    assert igs.is_image_generation_available() is False
    # 全局开但服务商缺失 → False（不抛异常）
    monkeypatch.setattr(igs, "_get_raw_config", lambda: _provider_config(with_provider=False))
    assert igs.is_image_generation_available() is False


# ---------------------------------------------------------------------------
# 6. 暴露门控：用户级开关 + 服务商就绪（两处接线共用的唯一判定）
# ---------------------------------------------------------------------------

class _FakeQuery:
    def __init__(self, setting):
        self._setting = setting

    def filter(self, *args, **kwargs):
        return self

    def first(self):
        return self._setting


class _FakeDB:
    """只提供门控用到的 query().filter().first() 链，不连真实库。"""

    def __init__(self, setting):
        self._setting = setting

    def query(self, _model):
        return _FakeQuery(self._setting)


class _BoomDB:
    """任何查询都抛异常：门控必须吞掉异常并按「未启用」处理。"""

    def query(self, _model):
        raise RuntimeError("db down")


def _fake_db(auto_image: bool):
    return _FakeDB(SimpleNamespace(auto_generate_chat_images=auto_image))


def test_gate_requires_user_switch_and_provider(monkeypatch):
    monkeypatch.setattr(igs, "_get_raw_config", lambda: _provider_config())
    assert igs.is_image_tool_enabled_for_user(_fake_db(True), "u1") is True
    assert igs.is_image_tool_enabled_for_user(_fake_db(False), "u1") is False


def test_gate_false_when_provider_not_ready(monkeypatch):
    """用户开关开但服务商不就绪 → 不暴露工具（模型看不见比画不出图好）。"""
    monkeypatch.setattr(igs, "_get_raw_config", lambda: _provider_config(with_provider=False))
    assert igs.is_image_tool_enabled_for_user(_fake_db(True), "u1") is False


def test_gate_swallows_db_errors(monkeypatch):
    """宁可不暴露工具，不可误暴露：查库炸了按未启用处理。"""
    monkeypatch.setattr(igs, "_get_raw_config", lambda: _provider_config())
    assert igs.is_image_tool_enabled_for_user(_BoomDB(), "u1") is False


# ---------------------------------------------------------------------------
# 7. 接线契约：两处调用点的写法约束（改坏了代码不会红，只能靠源码锁）
# ---------------------------------------------------------------------------

def _read(rel_path: str) -> str:
    with open(os.path.join(_BACKEND_DIR, rel_path), encoding="utf-8") as fh:
        return fh.read()


def test_websocket_wires_frontend_executor_by_original_tools():
    """`tool_executor` 的构造条件必须是**合并前**的 tools。

    若按合并后的 tools 判定，前端未传插件工具时内置工具的合并会把 tools 从
    None 变非空、顺带点亮 executor —— 改前这条路径不存在，模型幻觉出的工具名
    会被 WS 转发给前端。
    """
    src = _read("app/api/websocket.py")
    match = re.search(
        r"tool_executor=\(.*?\)\s*if\s+(\w+)\s+else\s+None", src, re.S
    )
    assert match, "找不到 tool_executor 的条件表达式，接线形状已变"
    assert match.group(1) == "_frontend_tools"


def test_both_call_sites_consume_gate_before_early_returns():
    """两处出图钩子都必须在提前 return **之前**取走模型请求。

    取晚了：无正文 / 生成报错时 gate 里的 prompt 被静默丢弃，"模型答应了配图、
    用户看不到图"无从排查。
    """
    # 锚点必须从 gate 自身向后找：websocket.py 里普通聊天路径也有一处同形的
    # has_content 判定（在角色路径之前），从头搜会命中它而误判。
    ws = _read("app/api/websocket.py")
    gate_at = ws.index("builtin_image_gate.take()")
    assert gate_at < ws.index(
        "if assistant_message_id is None or not result.has_content", gate_at
    )
    sse = _read("app/api/character_ext.py")
    sse_gate_at = sse.index("_img_gate.take()")
    assert sse_gate_at < sse.index(
        "if not save_db or assistant_message_id is None or not result.has_content",
        sse_gate_at,
    )


# ---------------------------------------------------------------------------
# 8. 落库后出图入口：模型请求优先并**替代**启发式（防一消息双图）
# ---------------------------------------------------------------------------

def test_assistant_entry_prefers_model_prompt_over_heuristic(
    db_session, test_user, make_message, image_config_enabled, monkeypatch
):
    message = make_message()
    calls = {"model": 0, "heuristic": 0}

    async def _fake_generate_image(*, prompt, user_id, provider_id=None):
        calls["model"] += 1
        return igs.GeneratedImage(
            image_url="/media/generated/p4c.png", prompt=prompt, provider_id="prov-1"
        )

    async def _fake_heuristic(*args, **kwargs):
        calls["heuristic"] += 1
        return None

    monkeypatch.setattr(igs, "generate_image", _fake_generate_image)
    monkeypatch.setattr(igs, "maybe_generate_image_for_message", _fake_heuristic)

    _run(igs.generate_image_for_assistant_message(
        db_session, test_user, message, [], character=None, model_prompt=MODEL_PROMPT,
    ))
    assert calls == {"model": 1, "heuristic": 0}, "模型请求必须替代启发式，否则一消息双图"
    db_session.expire_all()
    media = mms.get_message_media(message)
    assert len(media) == 1
    assert media[0]["prompt"] == MODEL_PROMPT
    assert media[0]["status"] == "ready"
    assert message.content == MESSAGE_CONTENT

    # 反向：没给模型 prompt 就维持 P1 的启发式路径
    _run(igs.generate_image_for_assistant_message(
        db_session, test_user, message, [], character=None
    ))
    assert calls["heuristic"] == 1
    assert calls["model"] == 1
