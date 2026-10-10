"""副 AI 变量解析：采样参数与重试（2026-10-05 · MVU-SECONDARY-PARAMS）。

钉住三件事（都是本次新增行为，此前写死无重试）：
  1. **夹紧函数** —— temperature 0-2 / max_tokens 256-8192 / retries 0-3，
     越界夹紧、不可解析回落默认（防手滑把 token 拉到爆额度）；
  2. **重试只对"调用抛异常"生效** —— 网络抖动/超时值得重试；
     但"模型正常返回、内容为空"或"有内容但没有可解析块"**不重试**
     （重试大概率同样结果，白烧额度）；
  3. 参数确实透传给了 complete_text_completion。

注意：本仓没有 pytest-asyncio，故用 asyncio.run() 在同步用例里驱动协程。

运行: cd backend && py -3 -m pytest tests/test_mvu_secondary_params.py -q
"""
import asyncio

import pytest

import app.services.inference_dispatcher as dispatcher
from app.services.mvu_secondary import (
    DEFAULT_SECONDARY_MAX_TOKENS,
    DEFAULT_SECONDARY_RETRIES,
    DEFAULT_SECONDARY_TEMPERATURE,
    clamp_secondary_max_tokens,
    clamp_secondary_retries,
    clamp_secondary_temperature,
    run_secondary_mvu,
)

# 可被 extract_update_variable_blocks 解析出的最小块（格式取自 test_mvu_engine.py）
BLOCK_OK = (
    '<UpdateVariable><JSONPatch>'
    '[{"op":"delta","path":"/a","value":1}]'
    '</JSONPatch></UpdateVariable>'
)

STAT = {"stat_data": {"桃汐": {"好感度": 1}}}
SCHEMA = {"桃汐": {"好感度": 0}}


# ─────────────────────────────────────────────────────────────────────────────
# 1. 夹紧函数
# ─────────────────────────────────────────────────────────────────────────────


class TestClamp:
    def test_temperature_in_range_passthrough(self):
        assert clamp_secondary_temperature(0.7) == pytest.approx(0.7)
        assert clamp_secondary_temperature(0.0) == pytest.approx(0.0)
        assert clamp_secondary_temperature(2.0) == pytest.approx(2.0)

    def test_temperature_out_of_range_clamped(self):
        assert clamp_secondary_temperature(-1) == pytest.approx(0.0)
        assert clamp_secondary_temperature(9.9) == pytest.approx(2.0)

    def test_temperature_garbage_falls_back(self):
        assert clamp_secondary_temperature(None) == pytest.approx(DEFAULT_SECONDARY_TEMPERATURE)
        assert clamp_secondary_temperature("abc") == pytest.approx(DEFAULT_SECONDARY_TEMPERATURE)
        assert clamp_secondary_temperature(float("nan")) == pytest.approx(DEFAULT_SECONDARY_TEMPERATURE)

    def test_max_tokens_clamped_and_fallback(self):
        assert clamp_secondary_max_tokens(4096) == 4096
        assert clamp_secondary_max_tokens(1) == 256
        assert clamp_secondary_max_tokens(10 ** 9) == 8192
        assert clamp_secondary_max_tokens(None) == DEFAULT_SECONDARY_MAX_TOKENS

    def test_retries_clamped_and_fallback(self):
        assert clamp_secondary_retries(0) == 0
        assert clamp_secondary_retries(3) == 3
        assert clamp_secondary_retries(-5) == 0
        assert clamp_secondary_retries(99) == 3
        assert clamp_secondary_retries(None) == DEFAULT_SECONDARY_RETRIES


# ─────────────────────────────────────────────────────────────────────────────
# 2/3. 重试与参数透传
# ─────────────────────────────────────────────────────────────────────────────


class _FakeCompletion:
    """按脚本依次返回 / 抛异常，并记录每次调用的参数。"""

    def __init__(self, script):
        self.script = list(script)
        self.calls = []

    async def __call__(self, **kwargs):
        self.calls.append(kwargs)
        if not self.script:
            raise AssertionError("complete_text_completion 被调用的次数超出脚本预期")
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


@pytest.fixture
def no_sleep(monkeypatch):
    """把退避 sleep 变成 no-op，避免测试等真实秒数。"""
    async def _noop(_seconds):
        return None

    monkeypatch.setattr(asyncio, "sleep", _noop)
    return _noop


def _run(monkeypatch, fake, **overrides):
    monkeypatch.setattr(dispatcher, "complete_text_completion", fake)
    kwargs = dict(
        secondary_model="m-1",
        stat_data=STAT,
        story_text="剧情正文",
        schema_defaults=SCHEMA,
    )
    kwargs.update(overrides)
    return asyncio.run(run_secondary_mvu(**kwargs))


class TestRetry:
    def test_retries_on_exception_then_succeeds(self, monkeypatch, no_sleep):
        fake = _FakeCompletion([RuntimeError("boom"), {"content": BLOCK_OK}])
        patches, _logs = _run(monkeypatch, fake, retries=2)

        assert len(fake.calls) == 2, "第 1 次抛异常后应重试，第 2 次成功即停"
        assert patches == [{"op": "delta", "path": "/a", "value": 1}]

    def test_exhausts_retries_and_returns_empty(self, monkeypatch, no_sleep):
        fake = _FakeCompletion([RuntimeError("x"), RuntimeError("y"), RuntimeError("z")])
        patches, logs = _run(monkeypatch, fake, retries=1)

        assert len(fake.calls) == 2, "retries=1 → 总尝试 2 次，不应有第 3 次"
        assert patches == []
        assert logs == []

    def test_no_retry_when_content_empty(self, monkeypatch, no_sleep):
        """模型正常返回但内容为空 —— 不重试（重试大概率同样结果）。"""
        fake = _FakeCompletion([{"content": ""}, {"content": BLOCK_OK}])
        patches, _logs = _run(monkeypatch, fake, retries=3)

        assert len(fake.calls) == 1, "空内容不重试"
        assert patches == []

    def test_no_retry_when_no_parseable_block(self, monkeypatch, no_sleep):
        """有输出但没有可解析块 —— 不重试（模型确实认为没变化）。"""
        fake = _FakeCompletion([{"content": "一段普通剧情，没有变量块"}, {"content": BLOCK_OK}])
        patches, _logs = _run(monkeypatch, fake, retries=3)

        assert len(fake.calls) == 1, "无可解析块不重试"
        assert patches == []

    def test_zero_retries_means_single_attempt(self, monkeypatch, no_sleep):
        fake = _FakeCompletion([RuntimeError("boom")])
        patches, _logs = _run(monkeypatch, fake, retries=0)

        assert len(fake.calls) == 1
        assert patches == []

    def test_guard_skips_call_when_no_schema_and_no_stat(self, monkeypatch, no_sleep):
        """无 schema 且无 stat_data = 卡没有变量系统 → 一次都不该调。"""
        fake = _FakeCompletion([])
        patches, logs = _run(monkeypatch, fake, stat_data={}, schema_defaults={})

        assert fake.calls == []
        assert patches == []
        assert logs == []


class TestParamsForwarded:
    def test_temperature_and_max_tokens_passed_through(self, monkeypatch, no_sleep):
        fake = _FakeCompletion([{"content": BLOCK_OK}])
        _run(monkeypatch, fake, temperature=1.5, max_tokens=4096)

        assert len(fake.calls) == 1
        assert fake.calls[0]["temperature"] == pytest.approx(1.5)
        assert fake.calls[0]["max_tokens"] == 4096

    def test_defaults_match_legacy_hardcoded_values(self, monkeypatch, no_sleep):
        """不传参时必须是历史写死值 —— 存量行为零变化。"""
        fake = _FakeCompletion([{"content": BLOCK_OK}])
        _run(monkeypatch, fake)

        assert fake.calls[0]["temperature"] == pytest.approx(0.2)
        assert fake.calls[0]["max_tokens"] == 2048

    def test_out_of_range_params_clamped_before_call(self, monkeypatch, no_sleep):
        """即便调用方传了脏值，也必须夹紧后再发出去。"""
        fake = _FakeCompletion([{"content": BLOCK_OK}])
        _run(monkeypatch, fake, temperature=99.0, max_tokens=10 ** 9, retries=99)

        assert fake.calls[0]["temperature"] == pytest.approx(2.0)
        assert fake.calls[0]["max_tokens"] == 8192
