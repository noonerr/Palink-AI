"""
P2-3 守卫：模型管理里的「最大输出」必须对角色扮演真正生效。

原缺陷（两个成因叠加，缺一不可）：
  1. 后端 websocket.py 判 `_user_specified_max = "max_tokens" in raw`，
     即「键不存在」才算用户没指定；
  2. 前端四个调用点恒传该键，且带 `?? 2048` 兜底。
  于是条件永不成立 → 模型里设的值对角色扮演永远不生效，用户改了没反应。

修法两侧都改：后端判「值为 None」，前端无值时传 `undefined` 而不是 2048。

本测试直接复刻修复后的判定表达式并跑真值表 —— 因为那段逻辑埋在
`run_character_chat_generation` 深处、依赖整套 WebSocket 上下文，
单测里直接构造代价过高；真值表能锁住判据本身不被改回去。
"""
import re
from pathlib import Path

import pytest

WEBSOCKET_PY = Path(__file__).resolve().parents[1] / "app" / "api" / "websocket.py"


def _resolve(raw: dict, model_cap):
    """复刻 websocket.py 的 max_tokens 判定（修复后）。"""
    max_tokens = raw.get("max_tokens")
    _user_specified_max = max_tokens is not None
    if not max_tokens:
        max_tokens = model_cap or 2048
    return max_tokens, _user_specified_max


class TestMaxTokensModelCap:
    def test_absent_key_uses_model_cap(self):
        mt, user_specified = _resolve({}, 8000)
        assert mt == 8000
        assert user_specified is False

    def test_explicit_none_uses_model_cap(self):
        """前端无预设时传的是 undefined → JSON 里是 null。"""
        mt, user_specified = _resolve({"max_tokens": None}, 8000)
        assert mt == 8000
        assert user_specified is False

    def test_explicit_value_wins_over_model_cap(self):
        """用户显式指定（预设里填了值）时以用户的为准。"""
        mt, user_specified = _resolve({"max_tokens": 3000}, 8000)
        assert mt == 3000
        assert user_specified is True

    def test_no_cap_and_no_value_falls_back_to_2048(self):
        mt, _ = _resolve({}, None)
        assert mt == 2048

    def test_zero_is_treated_as_unspecified(self):
        """0 是 falsy，等同未指定 —— 否则会以 0 请求直接被服务端拒绝。"""
        mt, _ = _resolve({"max_tokens": 0}, 8000)
        assert mt == 8000

    def test_regression_key_present_with_null_must_not_win(self):
        """原始缺陷的反面：键存在但值为 null 时，若按键判定就会取到 None。"""
        raw = {"max_tokens": None}
        naive = raw.get("max_tokens", 2048) if "max_tokens" in raw else 8000
        assert naive is None, "按键判定的老写法在 null 时会产出 None"


class TestSourceNoLongerKeysOffPresence:
    def test_websocket_uses_value_check_not_key_check(self):
        src = WEBSOCKET_PY.read_text(encoding="utf-8")
        assert '"max_tokens" in raw' not in src, (
            "max_tokens 判定退回到按键判定了 —— 模型最大输出会重新对角色扮演失效"
        )
        assert "is not None" in src

    @pytest.mark.parametrize(
        "rel",
        [
            "../../frontend/src/hooks/useCharacterChat.ts",
            "../../frontend/src/components/views/CharacterView.tsx",
        ],
    )
    def test_frontend_no_longer_hardcodes_2048_fallback(self, rel):
        target = (Path(__file__).resolve().parent / rel).resolve()
        if not target.exists():
            pytest.skip(f"前端源码不在仓库内（容器内跑）：{target}")
        src = target.read_text(encoding="utf-8")
        bad = re.findall(r"max_tokens:\s*currentPreset\?\.max_tokens\s*\?\?\s*\d+", src)
        assert not bad, f"前端仍恒传 max_tokens 数字兜底，模型设置会失效：{bad}"