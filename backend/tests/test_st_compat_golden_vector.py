"""ST-Compat Golden Vector 端到端验证 (spec 3.9).

复用 scripts/st-compat/prompt_golden/diff_messages.py 的 compare_messages 逻辑，
对每个已生成的 Palink golden vector (palink_*.json) 与对应 ST 1.18.0 真实输出
(st_*.json) 做逐字段对比，要求等价率 >= 99%。

重要前提 (spec 第 4 节 / checklist Phase 0):
    Golden vector 必须来自 ST 1.18.0 浏览器端真实导出，不能用 Palink 自身预期当 golden。
    ST 侧捕获方法:
        1. python scripts/st-compat/prompt_golden/st_capture_server.py --port 8899 --output <st_xxx.json>
        2. ST 1.18.0 中配置 Custom (OpenAI-compatible) 后端指向 http://<host>:8899/v1
        3. 触发对应场景生成，捕获 messages 写入 st_xxx.json

若某场景缺少 ST 侧 golden vector，对应测试自动 SKIP（而非 FAIL），
并提示如何捕获，避免在未完成捕获前误判为回归。
"""

import json
import os
import sys
from pathlib import Path

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

# 复用现有 diff 工具的 compare_messages
_GOLDEN_DIR = Path(__file__).resolve().parents[2] / "scripts" / "st-compat" / "prompt_golden"
if str(_GOLDEN_DIR) not in sys.path:
    sys.path.insert(0, str(_GOLDEN_DIR))

try:
    from diff_messages import compare_messages  # noqa: E402
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")

_RESULTS_DIR = _GOLDEN_DIR / "results"
# spec 3.9 指定位置：backend/tests/st_compat/golden_vectors/
_SPEC_GOLDEN_DIR = Path(__file__).resolve().parent / "st_compat" / "golden_vectors"
# 两个发现目录：现有 results/ + spec 指定 golden_vectors/
_DISCOVER_DIRS = [_RESULTS_DIR, _SPEC_GOLDEN_DIR]

# 等价率阈值 (spec: 逐字段一致，允许空格/换行微差)
_EQUIVALENCE_THRESHOLD = 99.0


def _load_json(path: Path) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _discover_fixtures():
    """发现所有 palink_*.json fixture，返回 (fixture_name, palink_path, st_path_or_None)。

    扫描两个目录（现有 results/ + spec 指定 golden_vectors/），
    按 palink_X.json ↔ st_X.json 配对。同一 fixture 名去重。
    """
    fixtures = []
    seen = set()
    for directory in _DISCOVER_DIRS:
        if not directory.exists():
            continue
        for palink_path in sorted(directory.glob("palink_*.json")):
            fixture_name = palink_path.stem.replace("palink_", "")
            if fixture_name in seen:
                continue
            seen.add(fixture_name)
            st_path = directory / f"st_{fixture_name}.json"
            fixtures.append((fixture_name, palink_path, st_path if st_path.exists() else None))
    return fixtures


_FIXTURES = _discover_fixtures()


@pytest.mark.parametrize(
    "fixture_name,palink_path,st_path",
    _FIXTURES,
    ids=[f[0] for f in _FIXTURES] if _FIXTURES else ["no_fixtures"],
)
def test_golden_vector_equivalence(fixture_name, palink_path, st_path):
    """对每个场景运行 Palink 输出 vs ST 1.18.0 golden vector 对比。"""
    if st_path is None:
        pytest.skip(
            f"缺少 ST 1.18.0 golden vector: st_{fixture_name}.json\n"
            f"捕获方法:\n"
            f"  1. python scripts/st-compat/prompt_golden/st_capture_server.py "
            f"--output scripts/st-compat/prompt_golden/results/st_{fixture_name}.json\n"
            f"  2. ST 1.18.0 配置 Custom OpenAI 后端指向捕获服务器并触发对应场景生成"
        )

    palink_data = _load_json(palink_path)
    st_data = _load_json(st_path)

    report = compare_messages(
        palink_data.get("messages", []),
        st_data.get("messages", []),
        verbose=True,
    )

    # 数量必须一致
    assert report["count_match"], (
        f"[{fixture_name}] 消息数量不一致: "
        f"palink={report['palink_count']} st={report['st_count']}"
    )
    # 等价率必须达标
    assert report["equivalence_rate"] >= _EQUIVALENCE_THRESHOLD, (
        f"[{fixture_name}] 等价率 {report['equivalence_rate']}% < {_EQUIVALENCE_THRESHOLD}%\n"
        f"role 不匹配: {len(report['role_mismatches'])}\n"
        f"content 不匹配: {len(report['content_mismatches'])}\n"
        f"palink 多出: {len(report['extra_in_palink'])}\n"
        f"st 多出: {len(report['extra_in_st'])}"
    )


def test_at_least_one_fixture_discovered():
    """确保至少发现一个 Palink golden vector（防止目录路径错误导致静默通过）。"""
    if not _FIXTURES:
        pytest.fail(
            f"未在 {_RESULTS_DIR} 发现任何 palink_*.json golden vector。\n"
            f"请先在 backend 容器内运行:\n"
            f"  python /app/scripts/prompt_golden/palink_golden_vector.py --all "
            f"--output /app/scripts/prompt_golden/results/palink.json"
        )
