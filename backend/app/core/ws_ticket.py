"""WebSocket 接入票据：**无状态**的 HMAC 签名短时令牌（任意 worker 都能自校验）。

## 为什么必须是"无状态"的（勿回退成进程内字典）

生产后端以 `uvicorn app.main:app --workers 4` 启动（见 `backend/start-server.sh`，
按 `PERFORMANCE_PROFILE` 自动算并发数）。旧实现把 `create_ticket()` 生成的随机串
存进**模块级 dict** `_TICKET_STORE`，并在 `validate_ticket()` 里 pop（取一次即失效）。
而票据是 **HTTP 端点 `POST /api/ws/ticket` 签发**（`api/auth.py`，落在 worker A），
**WebSocket `/api/ws/character-chat` 消费**（`api/websocket.py`，4 个 worker 轮询，
约 3/4 的概率落到从没见过这张票的 worker B）→ B 返回 None → 4001 关闭 →
uvicorn 侧记为握手 403。容器日志实测成对出现：

    POST /api/ws/ticket 200 OK
    WebSocket /api/ws/character-chat?ticket=... 403

## 现在的方案

票据本身就是凭据，格式为 `base64url(payload).base64url(hmac_sha256(payload 文本))`，
其中 payload 是一段**紧凑 ASCII 文本** `"<版本>|<JSON>"`，JSON 含
`uid`（用户 id，int）/ `exp`（墙上时钟过期时间戳）/ `jti`（随机 nonce）。

任何 worker 只需用**跨进程恒定的 `settings.SECRET_KEY`**（与 `core/security.py` 里
JWT / upload-token 同一份签名密钥；同一容器的 4 个 worker 继承同一份环境）重算 HMAC
并 `hmac.compare_digest` 常量时间比对即可校验，**不依赖任何共享存储**。

之所以不引入 Redis / 新建 DB 表：为一个 30 秒 TTL、单一用途的握手凭据加一份新基建
或一次迁移，成本远大于收益；短时签名令牌正是这类凭据的标准解。

## 密钥缺失时的行为（fail-closed）

与 `core/security.py` 一致：那边把 `settings.SECRET_KEY` 直接交给 `jwt.encode`，密钥
为空时**让异常抛出**，不会悄悄签出一个"可验证"的令牌。本模块同理——
`_sign_key()` 在密钥缺失/为空时抛 `TicketSecretMissingError`：

* `create_ticket()` **向上传播该异常**（HTTP 端点 500，响铃：无法签发就是配置事故）；
* `validate_ticket()` **捕获后返回 None**（它的契约是"任何不合法输入返回 None、绝不抛"，
  因为入参直接来自 WebSocket query；且没有可信密钥时唯一安全结论就是"全部拒绝"）。

两条路径都是 fail-closed，且**绝不回退到任何硬编码默认密钥**。

## 安全边界（有意为之，不是漏项）

* **签名先于解析**：验签不通过的字节一律不当 payload 解析，绝不信任未过签内容。
* **格式严格**：恰好一个 `.` 分隔符、版本前缀必须等于 `_VERSION`，否则视为无效票据
  （版本前缀是为将来的格式升级留的"未知即拒"闸门，不是可选字段）。
* **过期即拒**：`exp` 用 `time.time()`（墙上时钟）而非 monotonic —— monotonic
  各进程基准不同，跨 worker 不可比。`exp` 还必须是**有限**数值（JSON 能解析出
  `Infinity`/`NaN`，`now >= NaN` 恒为 False，不挡住就是永不过期）。
* **单次使用 = best effort**：进程内保留有界（`_USED_JTI_MAX`）的已用 `jti` 集合，
  拦住的只是**同一 worker 内的误重复连接**。**跨 worker 在 TTL 窗口内的重放不阻止**：
  做到那一步才需要共享存储，而代价（Redis/DB）与威胁（30 秒窗口内、已持有合法票据
  者重连一次、拿到的只是自己身份的连接）不成比例。窗口过期后令牌自然作废。
  请不要把它当成"完整单次使用"来宣称。
* **日志红线**：绝不打票据本身、`uid` 或密钥 —— 票据是 30 秒内的 bearer 凭据，
  `uid` 是可关联的个人数据。
* **留痕范围**（对齐 `core/silent_failure.py` 的"吞异常必须留记录"棘轮）：只有两类
  `except` 会 `record()` —— ① 密钥缺失（配置事故，否则表现成"所有连接都被拒"而无一行
  日志）；② **已过签**却解不开的 payload（只可能是我们自己签的票与解析器不一致 = 实现
  故障）。普通的"签名不匹配/过期/版本不对/重放"都是 `if` 分支直接返回 None，**不记日志**：
  它们发生在未鉴权的握手入口，攻击者可以随意刷，记了就是把日志当 DDOS 靶子；
  而这类拒绝本来就能从 uvicorn 访问日志的 `WebSocket ... 403` 行看到。
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import logging
import math
import secrets
import threading
import time
from collections import OrderedDict
from typing import Any, Dict, Optional, Tuple

from .config import settings
from .silent_failure import record as _record_silent

# 票据有效期（秒）。刻意保持很短：它只用来把浏览器 WebSocket 握手的身份传给后端，
# 握手完成后即失效，不需要长生命周期。
_TICKET_TTL_SECONDS = 30
# 已用 jti 集合上界（防无界增长）。条目按 exp 有序淘汰，正常流量下几乎用不到上界。
_USED_JTI_MAX = 4096
# jti 长度上界（票据由本模块签发 ⇒ 16 字符 hex；留足余量只为挡住"过签但畸形"的超大 key）。
_JTI_MAX_LEN = 128
_TOKEN_SEP = "."
# 版本前缀：payload 文本形如 `v1|{"uid":1,"exp":...,"jti":"..."}`。未知版本一律拒绝。
_VERSION = "v1"
_VERSION_SEP = "|"


class TicketSecretMissingError(RuntimeError):
    """服务端签名密钥缺失或为空 ⇒ 拒签拒验（fail-closed，见模块 docstring）。"""


# jti -> 该令牌的 exp。仅用于**本进程内**的重复使用拦截（见模块 docstring）。
_USED_JTI: "OrderedDict[str, float]" = OrderedDict()
_USED_JTI_LOCK = threading.Lock()


def _now() -> float:
    """票据时间基准（墙上时钟，跨进程可比）。单测通过 monkeypatch 本函数推进时间。"""
    return time.time()


def _sign_key() -> bytes:
    """跨 worker 恒定的服务端密钥（与 JWT / upload-token 同源），绝不外泄或打印。"""
    secret = getattr(settings, "SECRET_KEY", None)
    if not isinstance(secret, str) or not secret.strip():
        raise TicketSecretMissingError(
            "SECRET_KEY is not configured; refusing to sign or verify WebSocket tickets"
        )
    return secret.encode("utf-8")


def _b64encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _digest_bytes(body: str) -> bytes:
    """对 **base64 文本本身**签名（而非解码后的 payload）。

    这样任何会改变签名字节的 payload 规范化差异（键序/空格/等价编码）都会导致验签失败。
    """
    return hmac.new(_sign_key(), body.encode("utf-8"), hashlib.sha256).digest()


def _digest_b64(body: str) -> str:
    return _b64encode(_digest_bytes(body))


def _payload_text(uid: int, exp: int, jti: str) -> str:
    """构造带版本前缀的紧凑 ASCII payload（无签名）。"""
    return (
        f"{_VERSION}{_VERSION_SEP}"
        + json.dumps({"uid": uid, "exp": exp, "jti": jti}, separators=(",", ":"), ensure_ascii=True)
    )


def _parse_payload(text: str) -> Optional[Dict[str, Any]]:
    """解析并做字段级校验；任何不合法都是 None（不是异常）。"""
    version, sep, raw_json = text.partition(_VERSION_SEP)
    if not sep or version != _VERSION:  # 未知/缺失版本 ⇒ 拒绝
        return None
    try:
        data = json.loads(raw_json)
    except (ValueError, TypeError) as exc:
        # 调用点保证已过签 ⇒ 这是我们自己签出的票却解不开：实现故障，必须留痕。
        _record_silent("ws_ticket.signed_json_broken", exc)
        return None
    if not isinstance(data, dict):
        return None

    raw_uid = data.get("uid")
    raw_exp = data.get("exp")
    jti = data.get("jti")
    # bool 是 int 子类，必须排除，否则 {"uid": true} 会被当成 user 1。
    if not isinstance(raw_uid, int) or isinstance(raw_uid, bool) or raw_uid <= 0:
        return None
    if isinstance(raw_exp, bool) or not isinstance(raw_exp, (int, float)):
        return None
    # JSON 允许 Infinity/NaN：`now >= inf` 恒 False 且 `now >= nan` 恒 False ⇒ 永不过期。
    if not math.isfinite(float(raw_exp)):
        return None
    if not isinstance(jti, str) or not jti or len(jti) > _JTI_MAX_LEN:
        return None
    return {"uid": raw_uid, "exp": float(raw_exp), "jti": jti}


def _consume_jti(jti: str, exp: float) -> bool:
    """记录 jti；本进程已用过则返回 False（best-effort 单次使用）。"""
    now = _now()
    with _USED_JTI_LOCK:
        if jti in _USED_JTI:
            return False
        _USED_JTI[jti] = exp
        # TTL 固定 ⇒ 插入顺序≈过期顺序：先清掉已过期的，仍超上界则按最旧淘汰。
        # 被淘汰的 jti 因此失去本进程内的重复拦截 —— best effort，见模块 docstring。
        expired = [k for k, k_exp in _USED_JTI.items() if k_exp <= now]
        for k in expired:
            del _USED_JTI[k]
        while len(_USED_JTI) > _USED_JTI_MAX:
            _USED_JTI.popitem(last=False)
        return True


def create_ticket(user_id: int) -> str:
    """签发一张自校验票据；不落任何进程内状态，故任意 worker 都能消费。

    密钥缺失时抛 `TicketSecretMissingError`（fail-closed，绝不回退默认密钥）。
    """
    uid = int(user_id)
    exp = int(_now()) + _TICKET_TTL_SECONDS
    jti = secrets.token_hex(8)
    body = _b64encode(_payload_text(uid, exp, jti).encode("utf-8"))
    return f"{body}{_TOKEN_SEP}{_digest_b64(body)}"


def validate_ticket(ticket: str) -> Optional[int]:
    """校验票据并返回 user_id；任何不合法输入返回 None（不抛异常）。"""
    if not isinstance(ticket, str):
        return None
    # 恰好一个分隔符：多一段少一段都是畸形票据（不靠"签名自然不匹配"兜底）。
    if ticket.count(_TOKEN_SEP) != 1:
        return None
    body, _, sig = ticket.partition(_TOKEN_SEP)
    if not body or not sig:
        return None

    # 1) 先验签（常量时间比对），未过签名的内容一律不解析、不信任。
    #    比的是 **base64url 文本**（而非解码后的摘要）：这样 `sig` 与 `sig=` 这类
    #    等价编码差异不会都被接受，篡改一定能被发现。
    #    比 bytes 而非 str：hmac.compare_digest 对含非 ASCII 的 str 会抛 TypeError，
    #    而 ticket 直接来自 WebSocket query 参数（任意字节，甚至可能带代理码位），
    #    畸形输入必须只返回 None 而不是把异常抛给握手流程。
    try:
        expected = _digest_b64(body).encode("ascii")
        provided = sig.encode("utf-8")
    except TicketSecretMissingError as exc:
        # 配置事故：不记就是"所有 WS 连接都被拒但日志一行都没有"（正是本 bug 的形态）。
        _record_silent("ws_ticket.secret_missing", exc)
        return None  # 没有可信密钥 ⇒ 任何票据都不成立
    except (UnicodeError, ValueError) as exc:
        # 只有不可编码的入参走到这里（未鉴权入口，级别压到 WARNING，且不落任何入参内容）。
        _record_silent("ws_ticket.unencodable_input", exc, level=logging.WARNING)
        return None
    if not hmac.compare_digest(expected, provided):
        return None

    # 2) 过签了才解析 payload：畸形 base64 / 未知版本 / 非 JSON / 缺字段都是"无效票据"。
    try:
        text = _b64decode(body).decode("utf-8")
    except (binascii.Error, ValueError, TypeError, UnicodeDecodeError) as exc:
        # 同上：已过签却连 base64/UTF-8 都解不开 ⇒ 实现故障，不是攻击输入。
        _record_silent("ws_ticket.signed_body_unparsable", exc)
        return None
    claims = _parse_payload(text)
    if claims is None:
        return None

    # 3) 过期拒绝（含时钟已越过 exp 的令牌）。
    if _now() >= claims["exp"]:
        return None

    # 4) 本进程内单次使用（跨 worker 重放是已接受的残余风险，见模块 docstring）。
    if not _consume_jti(claims["jti"], claims["exp"]):
        return None

    return claims["uid"]


__all__: Tuple[str, ...] = ("create_ticket", "validate_ticket")
