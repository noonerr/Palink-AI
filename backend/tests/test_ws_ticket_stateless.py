"""`app.core.ws_ticket` 行为测试：票据必须**无状态**（跨 worker 可自校验）。

背景（勿把实现改回进程内字典）：生产以 `uvicorn --workers 4` 运行，票据由 HTTP 端点
在 worker A 签发、由 WebSocket 握手在另一 worker 消费。旧实现把票据存 A 的内存并取一次
即 pop，于是约 3/4 的连接被 B 判为无效 → 4001 关闭 / 握手 403。现方案是 HMAC 签名的
短时令牌 `base64url("v1|{json}").base64url(hmac_sha256)`，任何 worker 无需共享存储即可校验。

这里测的是**行为**（签发→校验→拒绝），不是源码文本。
所有输出只用 ASCII 标记，不打印票据以外的敏感串。
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import importlib.util
import json
import logging
import os
import subprocess
import sys
import time
from collections import OrderedDict
from pathlib import Path

import pytest

from app.core import ws_ticket
from app.core.config import settings

_MODULE_PATH = Path(ws_ticket.__file__).resolve()
_BACKEND_DIR = Path(__file__).resolve().parents[1]
_TTL = ws_ticket._TICKET_TTL_SECONDS
_VERSION_PREFIX = f"{ws_ticket._VERSION}{ws_ticket._VERSION_SEP}"
_SECRET = settings.SECRET_KEY or ""
# 跨进程用例专用：显式固定密钥，避免 development 模式下每个进程随机生成 SECRET_KEY。
_SUBPROCESS_SECRET = "cross-worker-subprocess-secret-0123456789abcdef"


def _load_fresh_worker_module(name: str = "app.core.ws_ticket_other_worker"):
    """把同一个源文件再装载一份**独立**模块实例，模拟"另一个 worker 进程"。

    它有自己的 `_USED_JTI`（空），因此只有"不依赖签发进程内存"的令牌才可能校验通过。
    """
    sys.modules.pop(name, None)
    spec = importlib.util.spec_from_file_location(name, _MODULE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _sign_body(body: str, secret: str) -> str:
    sig = _b64(hmac.new(secret.encode("utf-8"), body.encode("utf-8"), hashlib.sha256).digest())
    return f"{body}.{sig}"


def _payload_text_of(ticket: str) -> str:
    return _b64decode(ticket.partition(".")[0]).decode("utf-8")


def _payload_of(ticket: str) -> dict:
    text = _payload_text_of(ticket)
    assert text.startswith(_VERSION_PREFIX), text[:8]
    return json.loads(text[len(_VERSION_PREFIX):])


def _token(preimage: str, secret: str = _SECRET) -> str:
    """按已知格式自行构造令牌（用于伪造/篡改用例）。"""
    return _sign_body(_b64(preimage.encode("utf-8")), secret)


def _make_token(payload: dict, secret: str = _SECRET, version: str = _VERSION_PREFIX) -> str:
    return _token(f"{version}{json.dumps(payload, separators=(',', ':'))}", secret)


# --------------------------------------------------------------------------- #
# 正常路径
# --------------------------------------------------------------------------- #


def test_ticket_returns_its_own_user_id() -> None:
    uid = ws_ticket.validate_ticket(ws_ticket.create_ticket(4242))
    assert uid == 4242
    assert type(uid) is int  # user_id 的类型语义必须是 int（websocket.py 拿它查库）


def test_ticket_carries_version_uid_exp_jti_itself() -> None:
    """令牌必须自带版本与 uid/exp/jti（无状态的前提），且 exp 就是 now+TTL。"""
    payload = _payload_of(ws_ticket.create_ticket(7))
    assert payload["uid"] == 7
    assert isinstance(payload["jti"], str) and payload["jti"]
    assert payload["exp"] - _TTL <= int(time.time()) <= payload["exp"]
    assert _payload_text_of(ws_ticket.create_ticket(7)).startswith(_VERSION_PREFIX)


def test_ticket_validates_in_fresh_module_state_without_shared_store() -> None:
    """核心用例：worker A 签发，"worker B"（全新模块实例、空 jti 集合）消费成功。"""
    other_worker = _load_fresh_worker_module()
    assert other_worker is not ws_ticket
    assert dict(other_worker._USED_JTI) == {}  # 该"进程"从未见过这张票

    before = len(ws_ticket._USED_JTI)
    ticket = ws_ticket.create_ticket(1337)
    assert len(ws_ticket._USED_JTI) == before  # 签发不写任何进程内状态
    assert other_worker.validate_ticket(ticket) == 1337
    assert len(other_worker._USED_JTI) == 1  # 消费只留下 jti，不影响可校验性


def test_ticket_validates_in_a_real_subprocess_worker(monkeypatch: pytest.MonkeyPatch) -> None:
    """真·跨 worker 回归：另一个 **Python 解释器进程** 只共享密钥就能验签。

    4001/403 的根因正是进程隔离，所以这里不只用"重载模块"近似，而是起真子进程：
    父进程签发 → 子进程（全新的解释器、空的 `_USED_JTI`、什么内存都不共享）校验。
    """
    monkeypatch.setattr(ws_ticket.settings, "SECRET_KEY", _SUBPROCESS_SECRET)
    ticket = ws_ticket.create_ticket(90210)

    script = (
        "import sys\n"
        "from app.core import ws_ticket\n"
        "uid = ws_ticket.validate_ticket(sys.argv[1])\n"
        "print('RESULT=' + ('NONE' if uid is None else repr(uid)))\n"
    )
    env = dict(os.environ)
    env["SECRET_KEY"] = _SUBPROCESS_SECRET
    env["APP_ENV"] = "development"
    try:
        proc = subprocess.run(
            [sys.executable, "-c", script, ticket],
            cwd=str(_BACKEND_DIR),
            env=env,
            capture_output=True,
            text=True,
            timeout=180,
        )
    except subprocess.TimeoutExpired:
        pytest.fail("worker subprocess did not finish")
    assert proc.returncode == 0, f"subprocess rc={proc.returncode} stderr_tail={proc.stderr[-300:]!r}"
    assert "RESULT=90210" in proc.stdout, f"subprocess stdout={proc.stdout[-300:]!r}"


def test_ticket_validates_after_used_store_is_cleared(monkeypatch: pytest.MonkeyPatch) -> None:
    """另一种"另一个 worker"模拟：签发后把本进程的已用 jti 集合清空（等价于全新进程），
    票据仍须可校验 —— 证明校验不依赖签发时留下的任何进程内状态。"""
    ticket = ws_ticket.create_ticket(2024)
    monkeypatch.setattr(ws_ticket, "_USED_JTI", OrderedDict())
    assert ws_ticket.validate_ticket(ticket) == 2024


def test_validation_depends_on_no_module_level_mutable_state(monkeypatch: pytest.MonkeyPatch) -> None:
    """穷尽式：清掉模块里**所有**模块级可变容器后，票据仍须可校验。"""
    ticket = ws_ticket.create_ticket(31337)
    containers = [
        (name, value)
        for name, value in vars(ws_ticket).items()
        # 绝不碰 dunder：模块的 `__builtins__` 就是个 dict，clear() 它等于炸掉整个会话。
        if not name.startswith("__") and isinstance(value, (dict, list, set, frozenset))
    ]
    assert "_USED_JTI" in [name for name, _ in containers], "扫描必须覆盖已用 jti 容器"
    for name, value in containers:
        monkeypatch.setattr(ws_ticket, name, type(value)())
    assert ws_ticket.validate_ticket(ticket) == 31337


def test_different_users_get_different_valid_tickets() -> None:
    t1, t2 = ws_ticket.create_ticket(11), ws_ticket.create_ticket(22)
    assert t1 != t2
    assert ws_ticket.validate_ticket(t2) == 22
    assert ws_ticket.validate_ticket(t1) == 11


def test_tickets_for_same_user_differ_by_jti() -> None:
    """同一用户两张票必须不同（jti 随机），否则可互相顶掉。"""
    a, b = ws_ticket.create_ticket(55), ws_ticket.create_ticket(55)
    assert a != b
    assert _payload_of(a)["jti"] != _payload_of(b)["jti"]
    assert ws_ticket.validate_ticket(a) == 55
    assert ws_ticket.validate_ticket(b) == 55


# --------------------------------------------------------------------------- #
# 篡改 / 伪造 / 重放
# --------------------------------------------------------------------------- #


def test_flip_one_char_in_payload_segment_is_rejected() -> None:
    """任务要求的"翻转 payload 段一个字符"：改后的票据必须拒（顺带会撞上版本/JSON 校验，
    所以**不能只靠这条**证明验签在生效 —— 见下一条构造式篡改）。"""
    body, _, sig = ws_ticket.create_ticket(99).partition(".")
    flipped = ("A" if body[0] != "A" else "B") + body[1:]
    assert ws_ticket.validate_ticket(f"{flipped}.{sig}") is None


def test_tampered_payload_uid_is_rejected_without_recomputing_signature() -> None:
    """构造式篡改（保留版本前缀、只改 uid、签名沿用原票）：拒绝理由只能是**验签**。

    自带反证：同一张未改的票用同一签名必须校验成功，否则上面绿了是假阳性。
    """
    ticket = ws_ticket.create_ticket(99)
    body, _, sig = ticket.partition(".")
    forged_json = json.dumps(dict(_payload_of(ticket), uid=999999), separators=(",", ":"))
    forged_body = _b64((_VERSION_PREFIX + forged_json).encode("utf-8"))
    assert forged_body != body
    assert ws_ticket.validate_ticket(f"{forged_body}.{sig}") is None
    assert ws_ticket.validate_ticket(ticket) == 99


def test_tampered_signature_is_rejected() -> None:
    body, _, sig = ws_ticket.create_ticket(99).partition(".")
    flipped = ("A" if sig[0] != "A" else "B") + sig[1:]
    assert ws_ticket.validate_ticket(f"{body}.{flipped}") is None
    assert ws_ticket.validate_ticket(f"{body}.{sig}") == 99  # 原样必须可用（反假阳性）


def test_truncated_signature_is_rejected() -> None:
    ticket = ws_ticket.create_ticket(99)
    assert ws_ticket.validate_ticket(ticket[:-4]) is None


def test_appended_segment_is_rejected() -> None:
    """分隔符数量必须恰好为 1：合法票据后面再挂一段也判无效。"""
    ticket = ws_ticket.create_ticket(99)
    assert ws_ticket.validate_ticket(f"{ticket}.{ticket.partition('.')[2]}") is None


def test_edited_payload_uid_is_rejected_when_signature_not_recomputed() -> None:
    """攻击者知道格式但不知道密钥：改 uid 后**沿用别的票的旧签名** → 必须拒。"""
    real = _payload_of(ws_ticket.create_ticket(1))
    forged_body = _b64(
        (_VERSION_PREFIX + json.dumps(dict(real, uid=999999), separators=(",", ":"))).encode("utf-8")
    )
    old_sig = ws_ticket.create_ticket(1).partition(".")[2]
    assert ws_ticket.validate_ticket(f"{forged_body}.{old_sig}") is None


def test_payload_signed_with_wrong_secret_is_rejected() -> None:
    """即使重算签名，密钥不对也造不出可用令牌（含空密钥）。"""
    payload = {"uid": 999999, "exp": int(ws_ticket._now()) + _TTL, "jti": "attacker-jti"}
    assert ws_ticket.validate_ticket(_make_token(payload, secret="not-the-server-secret")) is None
    assert ws_ticket.validate_ticket(_make_token(payload, secret="")) is None


@pytest.mark.parametrize(
    "version",
    ["v2|", "v0|", "V1|", "v1", "", "v11|", "v1||"],
    ids=["v2", "v0", "uppercase", "no-sep", "none", "v11", "double-sep"],
)
def test_unknown_version_prefix_is_rejected_even_when_signed(version: str) -> None:
    """版本闸门：格式升级后旧/未知版本一律无效（用真实密钥签名也不例外）。"""
    payload = {"uid": 4242, "exp": int(ws_ticket._now()) + _TTL, "jti": "ver-jti-" + (version or "x")}
    assert ws_ticket.validate_ticket(_make_token(payload, version=version)) is None


def test_replay_of_same_ticket_is_rejected_in_same_process() -> None:
    """best-effort 单次使用：同一 worker 内第二次用同一张票必须失败。"""
    ticket = ws_ticket.create_ticket(5)
    assert ws_ticket.validate_ticket(ticket) == 5
    assert ws_ticket.validate_ticket(ticket) is None


def test_used_jti_store_is_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    """已用 jti 集合有上界并会淘汰，不能无界增长。"""
    monkeypatch.setattr(ws_ticket, "_USED_JTI_MAX", 8)
    monkeypatch.setattr(ws_ticket, "_USED_JTI", OrderedDict())
    tickets = [ws_ticket.create_ticket(1000 + i) for i in range(30)]
    for t in tickets:
        assert ws_ticket.validate_ticket(t) is not None
    assert len(ws_ticket._USED_JTI) <= 8


# --------------------------------------------------------------------------- #
# 过期
# --------------------------------------------------------------------------- #


def test_expired_ticket_is_rejected_without_sleeping(monkeypatch: pytest.MonkeyPatch) -> None:
    """不动真实时钟：把时间基准整体推过 TTL（同一 token 在签发 worker 也立刻失效）。"""
    ticket = ws_ticket.create_ticket(77)
    real_now = ws_ticket._now
    monkeypatch.setattr(ws_ticket, "_now", lambda: real_now() + _TTL + 1)
    assert ws_ticket.validate_ticket(ticket) is None


def test_boundary_before_expiry_still_validates(monkeypatch: pytest.MonkeyPatch) -> None:
    """只推 TTL 内的时间不该失效（防"过期判断写反/写死"）。"""
    ticket = ws_ticket.create_ticket(78)
    real_now = ws_ticket._now
    monkeypatch.setattr(ws_ticket, "_now", lambda: real_now() + _TTL - 1)
    assert ws_ticket.validate_ticket(ticket) == 78


def test_exp_uses_wall_clock_not_monotonic() -> None:
    """跨进程可比的唯一前提是墙上时钟；monotonic 各 worker 基准不同。"""
    payload = _payload_of(ws_ticket.create_ticket(3))
    assert abs(payload["exp"] - _TTL - time.time()) <= 1


# --------------------------------------------------------------------------- #
# 畸形输入：返回 None，不得抛异常
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "garbage",
    [
        "",
        ".",
        "no-dot-here",
        "abc.",
        ".def",
        "!!!.!!!",
        "\u4e2d\u6587.\u7968\u636e",  # 非 ASCII：签名计算不得因编码异常而抛出
        "\ud800dc00.\ud800dc00",  # 代理码位：utf-8 编码会抛 UnicodeEncodeError
        "a.b.c",
        "YWJj.-",
        _b64(b"not json") + ".c2F0",
        None,  # 非 str 入参（query 参数缺失时调用方可能传 None）
        123,
    ],
    ids=[
        "empty",
        "dot-only",
        "no-dot",
        "empty-sig",
        "empty-body",
        "symbols",
        "non-ascii",
        "lone-surrogate",
        "extra-dots",
        "empty-sig2",
        "non-json-body-signed-slot",
        "none",
        "int",
    ],
)
def test_malformed_input_returns_none_without_raising(garbage: object) -> None:
    assert ws_ticket.validate_ticket(garbage) is None  # type: ignore[arg-type]


def test_structurally_valid_but_semantically_broken_payloads_rejected() -> None:
    """签名用真实密钥（过签），但 payload 内容非法 → 仍必须拒，且不得抛。"""
    now = int(ws_ticket._now())
    bad_payloads = [
        {},  # 无 uid/exp/jti
        {"uid": "1", "exp": now + _TTL, "jti": "x"},  # uid 非 int
        {"uid": True, "exp": now + _TTL, "jti": "x"},  # bool 冒充 int
        {"uid": 1.5, "exp": now + _TTL, "jti": "x"},  # uid 非整数
        {"uid": 0, "exp": now + _TTL, "jti": "x"},  # 不存在的 user 0
        {"uid": -1, "exp": now + _TTL, "jti": "x"},
        {"uid": None, "exp": now + _TTL, "jti": "x"},
        {"uid": [1], "exp": now + _TTL, "jti": "x"},
        {"uid": 1, "exp": "later", "jti": "x"},  # exp 非数值
        {"uid": 1, "exp": True, "jti": "x"},  # exp 是 bool
        {"uid": 1, "exp": None, "jti": "x"},
        {"uid": 1, "exp": now + _TTL},  # 缺 jti
        {"uid": 1, "exp": now + _TTL, "jti": ""},  # 空 jti
        {"uid": 1, "exp": now + _TTL, "jti": 12},  # jti 非 str
        {"uid": 1, "exp": now + _TTL, "jti": "x" * 5000},  # 超长 jti（撑内存）
    ]
    for payload in bad_payloads:
        assert ws_ticket.validate_ticket(_make_token(payload)) is None, payload


def test_non_finite_exp_is_rejected() -> None:
    """JSON 能写出 Infinity/NaN：`now >= NaN` 恒 False ⇒ 不挡就是永不过期，必须显式拒。"""
    for literal in ("Infinity", "-Infinity", "NaN"):
        preimage = f"{_VERSION_PREFIX}{{\"uid\":1,\"exp\":{literal},\"jti\":\"x\"}}"
        assert ws_ticket.validate_ticket(_token(preimage)) is None, literal


def test_signed_payload_that_is_json_but_not_an_object_is_rejected() -> None:
    for non_object in (b"null", b"[]", b'"text"', b"123"):
        assert ws_ticket.validate_ticket(_token(non_object.decode("utf-8"))) is None


def test_base64_garbage_with_otherwise_matching_signature_is_rejected() -> None:
    """签名对得上但 body 解不出合法 payload —— 仍不得抛（验签先于解析）。"""
    bogus_body = "-_="
    try:
        result = ws_ticket.validate_ticket(_sign_body(bogus_body, _SECRET))
    except (binascii.Error, ValueError, TypeError) as exc:
        pytest.fail(f"validate_ticket must not raise on malformed base64/JSON: {exc!r}")
    assert result is None


# --------------------------------------------------------------------------- #
# 密钥缺失：fail-closed
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("missing", ["", "   ", None])
def test_missing_secret_fails_closed(monkeypatch: pytest.MonkeyPatch, missing: object) -> None:
    """SECRET_KEY 缺失 ⇒ 签发抛错（响铃）、校验一律 None（绝不回退默认密钥）。"""
    monkeypatch.setattr(ws_ticket.settings, "SECRET_KEY", missing)
    with pytest.raises(ws_ticket.TicketSecretMissingError):
        ws_ticket.create_ticket(1)
    assert ws_ticket.validate_ticket("whatever.body") is None
    # 连"密钥还在时签好的真票"也必须拒（否则退化成用空密钥验）。
    monkeypatch.undo()
    ticket = ws_ticket.create_ticket(1)
    monkeypatch.setattr(ws_ticket.settings, "SECRET_KEY", missing)
    assert ws_ticket.validate_ticket(ticket) is None


# --------------------------------------------------------------------------- #
# 秘密不外泄
# --------------------------------------------------------------------------- #


def test_secret_never_appears_in_token() -> None:
    """令牌只含 payload 与摘要，不得泄露密钥。"""
    assert _SECRET
    ticket = ws_ticket.create_ticket(1)
    assert _SECRET not in ticket
    assert all(_SECRET not in str(v) for v in _payload_of(ticket).values())


def test_ordinary_rejections_emit_no_logs(monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
    """未鉴权握手入口的常规拒绝（错签/过期/畸形）**不写日志**：否则刷 `/api/ws/*?ticket=垃圾`
    就把日志变成了 DDOS 靶子，而这些拒绝本来在 uvicorn 访问日志里看得见。"""
    ticket = ws_ticket.create_ticket(1234)
    body, _, sig = ticket.partition(".")
    tampered = f"{body}.{('A' if sig[0] != 'A' else 'B') + sig[1:]}"
    expired = ws_ticket.create_ticket(1235)
    real_now = ws_ticket._now
    with caplog.at_level(logging.DEBUG):
        ws_ticket.validate_ticket(tampered)
        ws_ticket.validate_ticket("a.b.c")
        ws_ticket.validate_ticket("")
        monkeypatch.setattr(ws_ticket, "_now", lambda: real_now() + _TTL + 5)
        ws_ticket.validate_ticket(expired)
    assert [r.getMessage() for r in caplog.records] == []


def test_missing_secret_is_recorded_and_leaks_nothing(monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
    """配置事故必须留痕（本 bug 的教训：全被拒却一行日志都没有），但绝不打票据/密钥。"""
    ticket = ws_ticket.create_ticket(777)
    monkeypatch.setattr(ws_ticket.settings, "SECRET_KEY", "")
    with caplog.at_level(logging.DEBUG):
        assert ws_ticket.validate_ticket(ticket) is None
    text = "\n".join(r.getMessage() for r in caplog.records)
    assert "ws_ticket.secret_missing" in text
    assert ticket not in text
    assert _SECRET not in text
    assert "777" not in text


def test_unencodable_input_is_recorded_without_leaking_input(caplog: pytest.LogCaptureFixture) -> None:
    """代理码位入参：记录的是**转义后的异常摘要**（纯 ASCII），不含原始入参，也不含密钥。"""
    garbage = "\ud800dc00.\ud800dc00"
    with caplog.at_level(logging.DEBUG):
        assert ws_ticket.validate_ticket(garbage) is None
    text = "\n".join(r.getMessage() for r in caplog.records)
    assert "ws_ticket.unencodable_input" in text
    assert garbage not in text
    assert _SECRET not in text
    assert all(chunk.isascii() for chunk in text)


def test_token_is_ascii_and_url_safe() -> None:
    """票据要当 query 参数走 HTTP：必须纯 ASCII 且无需转义。"""
    ticket = ws_ticket.create_ticket(12345)
    ticket.encode("ascii")
    allowed = set(
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    ) | {"."}
    assert set(ticket) <= allowed
    assert len(ticket) < 256  # 不至于撑爆 header/query buffer
