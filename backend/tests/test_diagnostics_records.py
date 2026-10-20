"""包AG · 批次D — 服务端留痕端点契约测试（开发期取证管道）。

钉住六件事（对应派包「验收」与三条硬线）：
  1. 未鉴权 401；带会话 Cookie 但不带 X-CSRF-Token 的写请求 403。
  2. 超大体积 413、非 JSON 415/400 —— 公网可达时的灌盘闸门。
  3. 同一 batchId 重复上传不重复计数（幂等），文件行数不涨。
  4. 白名单之外的键不落盘；detail / stack **原文一个字都不写**，只留长度与摘要。
  5. 限流到顶 429（站点注册开关仍开着，服务端必须自己兜）。
  6. 落盘位置 = DATA_DIR/diagnostics/records-<UTC 日期>.jsonl，只追加不删。

运行：cd backend && py -m pytest tests/test_diagnostics_records.py -q
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.api import diagnostics as diag_api

URL = "/api/diagnostics/records"


@pytest.fixture()
def diag_dir(tmp_path, monkeypatch):
    """把留痕目录指到 tmp_path，并清空内存态（去重窗口 / 限流桶 / 行数缓存）。"""
    monkeypatch.setattr(diag_api.settings, "DATA_DIR", str(tmp_path), raising=False)
    diag_api._reset_state_for_test()
    yield Path(tmp_path) / "diagnostics"
    diag_api._reset_state_for_test()


def _records(client, headers, records, batch_id="batch-1"):
    return client.post(URL, json={"batchId": batch_id, "records": records}, headers=headers)


def _read_lines(directory: Path):
    files = sorted(directory.glob("records-*.jsonl"))
    assert len(files) == 1, f"应当只有当天一个文件，实际 {[f.name for f in files]}"
    return [json.loads(line) for line in files[0].read_text(encoding="utf-8").splitlines() if line.strip()]


def _no_records_written(directory: Path) -> bool:
    return not (directory.exists() and any(directory.glob("records-*.jsonl")))


SAMPLE = {
    "owner": "host_capability",
    "kind": "slash_command_unimplemented",
    "name": "translate",
    "count": 3,
    "filename": "inline",
    "lineno": 12,
    "colno": 4,
    "missingStSubsystem": "unknown",
    "frameId": "frame-1",
    "cardId": "card-1",
    "textLength": 88,
}


def test_unauthenticated_write_is_rejected(client, diag_dir):
    """无任何凭据的写请求被拒（403），且一个字节都不落盘。

    为什么是 403 而不是 401：端点级 `csrf_guard` 先于 `get_current_user` 执行
    （与仓内其它挂 csrf_guard 的 router 同序），无 Authorization 头且无
    X-CSRF-Token 的写请求在守卫这一层就被挡下。真正的 401 见下一条用例。
    """
    resp = client.post(URL, json={"batchId": "b-403", "records": [SAMPLE]})
    assert resp.status_code == 403
    assert _no_records_written(diag_dir)


def test_invalid_bearer_is_401(client, diag_dir):
    """带 Bearer 但令牌无效 ⇒ 守卫放行（Bearer 免疫 CSRF），认证层给 401。"""
    from app.api.dependencies import get_current_user
    from app.main import app

    saved = app.dependency_overrides.pop(get_current_user)
    try:
        resp = client.post(
            URL,
            json={"batchId": "b-401", "records": [SAMPLE]},
            headers={"Authorization": "Bearer not-a-real-jwt"},
        )
    finally:
        app.dependency_overrides[get_current_user] = saved
    assert resp.status_code == 401
    assert _no_records_written(diag_dir)


def test_session_cookie_without_csrf_header_is_403(client, diag_dir):
    """纯 Cookie 写请求缺 X-CSRF-Token ⇒ 403，且一个字节都不落盘。"""
    resp = client.post(
        URL,
        json={"batchId": "b-403", "records": [SAMPLE]},
        cookies={"palink_session": "forged-or-real-but-no-csrf-header"},
    )
    assert resp.status_code == 403
    assert _no_records_written(diag_dir)


def test_oversized_body_is_413(client, auth_headers, diag_dir):
    """超过单请求体上限直接拒收（不让公网访客把 4MB 的日文件一次灌满）。"""
    fat = dict(SAMPLE, name="x" * (diag_api.DIAG_MAX_BODY_BYTES + 1024))
    resp = _records(client, auth_headers, [fat], batch_id="b-fat")
    assert resp.status_code == 413
    assert _no_records_written(diag_dir)


def test_non_json_rejected(client, auth_headers, diag_dir):
    """Content-Type 不对 415；JSON 解析不了 400。两条都不得落盘。"""
    plain = client.post(URL, content=b"hello", headers={**auth_headers, "Content-Type": "text/plain"})
    assert plain.status_code == 415

    broken = client.post(URL, content=b"{not json", headers={**auth_headers, "Content-Type": "application/json"})
    assert broken.status_code == 400

    assert _no_records_written(diag_dir)


def test_duplicate_batch_is_not_double_counted(client, auth_headers, diag_dir):
    """同一 batchId 重复上传：第二次返回 duplicate=True，文件行数不涨。"""
    first = _records(client, auth_headers, [SAMPLE, dict(SAMPLE, name="abs")], batch_id="b-dup")
    assert first.status_code == 200
    assert first.json()["written"] == 2
    assert first.json()["duplicate"] is False

    second = _records(client, auth_headers, [SAMPLE, dict(SAMPLE, name="abs")], batch_id="b-dup")
    assert second.status_code == 200
    assert second.json()["duplicate"] is True
    assert second.json()["written"] == 0

    assert len(_read_lines(diag_dir)) == 2


def test_detail_and_stack_are_never_stored_raw(client, auth_headers, diag_dir):
    """正文面第二道闸：即使客户端发了 detail/stack，也只落长度与摘要。"""
    secret = "这是一段绝不能落盘的卡正文：变量结构 {hp: 100}"
    payload = dict(SAMPLE, detail=secret, stack="    at card (inline:1:1) " + secret)
    resp = _records(client, auth_headers, [payload], batch_id="b-text")
    assert resp.status_code == 200

    raw = "".join(path.read_text(encoding="utf-8") for path in diag_dir.glob("records-*.jsonl"))
    assert secret not in raw
    assert "绝不能落盘" not in raw

    record = _read_lines(diag_dir)[0]["record"]
    assert record["detailLength"] == len(secret.encode("utf-8"))
    assert len(record["detailHash"]) == 16
    assert "stackHash" in record and "stackLength" in record
    assert "detail" not in record and "stack" not in record


def test_whitelist_drops_unknown_keys(client, auth_headers, diag_dir):
    """白名单外的键（卡正文/任意对象）一律丢弃，不落盘。"""
    resp = _records(
        client,
        auth_headers,
        [dict(SAMPLE, hacked="<script>alert(1)</script>", payload={"hp": 100})],
        batch_id="b-extra",
    )
    assert resp.status_code == 200
    record = _read_lines(diag_dir)[0]["record"]
    assert set(record.keys()) == set(diag_api.DIAG_UPLOAD_FIELDS)
    assert "hacked" not in record and "payload" not in record


def test_rate_limit_returns_429(client, auth_headers, diag_dir, monkeypatch):
    """限流：窗口内超过上限 ⇒ 429（服务端自己兜住公网灌入）。"""
    monkeypatch.setattr(diag_api, "DIAG_RATE_LIMIT_REQUESTS", 2)
    assert _records(client, auth_headers, [SAMPLE], batch_id="b-rl-1").status_code == 200
    assert _records(client, auth_headers, [SAMPLE], batch_id="b-rl-2").status_code == 200
    assert _records(client, auth_headers, [SAMPLE], batch_id="b-rl-3").status_code == 429


def test_file_is_daily_named_and_append_only(client, auth_headers, diag_dir):
    """文件名按 UTC 日期切分；追加写在同一天是同一份文件（不覆盖、不轮转删除）。"""
    _records(client, auth_headers, [SAMPLE], batch_id="b-a")
    _records(client, auth_headers, [dict(SAMPLE, name="echo")], batch_id="b-b")
    files = list(diag_dir.glob("records-*.jsonl"))
    assert len(files) == 1
    assert files[0].name.startswith("records-") and files[0].name.endswith(".jsonl")
    assert len(_read_lines(diag_dir)) == 2


def test_browser_path_cookie_plus_csrf_token_writes(client, diag_dir):
    """前端真实通道：palink_session Cookie + X-CSRF-Token（不是 Bearer）。

    这是前端 fetch 的实际形状（`credentials:'include'` + 双提交头），
    与上一条"只带 Cookie 缺头 ⇒ 403"成对，证明放行条件确实是"配对正确"。
    """
    resp = client.post(
        URL,
        json={"batchId": "b-browser", "records": [SAMPLE, dict(SAMPLE, name="abs")]},
        cookies={"palink_session": "session-value", "palink_csrf": "palink-csrf"},
        headers={"X-CSRF-Token": "palink-csrf"},
    )
    assert resp.status_code == 200
    assert resp.json()["written"] == 2
    assert len(_read_lines(diag_dir)) == 2
