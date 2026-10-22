"""统一「静默失败」记录器 —— 让被吞掉的异常在后端留下可检索的记录。

## 为什么要有这个模块（2026-10-22 外部审计结论）

本仓 `backend/app` 里有 **562 处** `except` 分支属于「吞掉且不留任何记录」
（AST 口径：handler 体内既没有 `raise`，也没有任何 `logger.*` / 记录调用），
另有 40 处只打 `logger.debug`（INFO 级别下等于不记）。

后果是**用户看到的异常全部不可追溯**：插件密钥存不上、记忆检索失败、世界书没注入、
MVU 变量取不到 —— 全都表现成「界面没反应」，而容器日志里一行都没有。

本模块提供三件事：

1. `record()` —— 唯一的记录入口。永远不抛异常（记录器自己炸掉比不记更糟）。
2. `swallow()` —— 上下文管理器，用来替换 `except ...: pass`。**记录后吞掉**，
   语义与原来一致（调用方仍然不受影响），只是不再无声。
3. 进程内计数与最近样本，供 `/api/diagnostics/silent-failures` 读取，
   让「发生了多少次、最后一次是什么」可以从接口层查到，而不是只能翻日志。

## 使用约定

```python
# 替换 except Exception: pass
with swallow("worldbook.bind_probe"):
    book = db.query(WorldBook).get(wb_id)

# 已经手写了 except，只想补记录
except Exception as exc:
    record("mvu.replay", exc, session_id=session_id)
```

`scope` 用「模块.动作」的点分小写串，便于聚合统计。**不要**把用户输入拼进 scope。

## 红线

- 本模块**只读内存**，不写库、不发网络请求、不抛异常。
- 不允许在这里 import `app.*` 的任何模块（避免循环导入与启动期依赖）。
"""

from __future__ import annotations

import contextlib
import contextvars
import logging
import threading
import traceback
from collections import Counter
from typing import Any, Iterator, Optional

logger = logging.getLogger("PalinkAI.silent_failure")

# ── 请求上下文 ────────────────────────────────────────────────────────────
# 由 main.py 的 request_id 中间件写入，使每条静默失败记录都能对到
# 用户看到的那条错误响应里的 request_id。
_request_id: contextvars.ContextVar[str] = contextvars.ContextVar(
    "palink_silent_failure_request_id", default=""
)


def bind_request_id(request_id: str) -> contextvars.Token:
    """在请求中间件里绑定 request_id；返回 token 供 finally 里 reset。"""
    return _request_id.set(request_id or "")


def reset_request_id(token: contextvars.Token) -> None:
    with contextlib.suppress(Exception):
        _request_id.reset(token)


def current_request_id() -> str:
    try:
        return _request_id.get()
    except Exception:  # noqa: BLE001 - contextvar 取值失败不得影响调用方
        # 这里**必须**记录：走不到的分支真走到了，说明 contextvar 被弄坏了。
        with contextlib.suppress(Exception):
            logger.error("[SILENT-FAIL] request_id_contextvar_unreadable", exc_info=True)
        return ""


# ── 进程内账本 ────────────────────────────────────────────────────────────
# 有界：scope 数上限 + 每个 scope 只留最近 N 条样本，避免长跑进程内存泄漏。
_MAX_SCOPES = 512
_MAX_SAMPLES_PER_SCOPE = 3

_lock = threading.Lock()
_counts: Counter = Counter()
_last_seen: dict[str, dict] = {}
_logged_once: set[str] = set()
_total = 0


def record(
    scope: str,
    exc: Optional[BaseException] = None,
    *,
    level: int = logging.ERROR,
    once: bool = False,
    **context: Any,
) -> None:
    """记录一次静默失败。**永不抛异常。**

    Args:
        scope: 点分小写标识，如 ``"worldbook.bind_probe"``。
        exc: 被吞掉的异常；为 None 时表示"没有异常但这是一条失败路径"。
        level: 日志级别，默认 ERROR（要进容器日志就必须 >= INFO）。
        once: 只写**第一次**日志，后续仍计数但不刷屏。给热路径用
            （如逐 token 调用的估算函数）——那里失败一次就会失败一万次。
        **context: 附加字段（session_id / character_id 等），会拼进日志正文。
    """
    global _total
    try:
        scope = str(scope or "unknown")[:120]
        rid = current_request_id()
        emit_log = True
        if once:
            with _lock:
                if scope in _logged_once:
                    emit_log = False
                else:
                    _logged_once.add(scope)
        extra_txt = ""
        if context:
            try:
                extra_txt = " " + " ".join(
                    "%s=%r" % (k, v) for k, v in sorted(context.items())
                )
            except Exception:  # noqa: BLE001 - 上下文字符串化失败不得影响记录
                extra_txt = " <context_unprintable>"
        rid_txt = " request_id=%s" % rid if rid else ""

        if exc is None:
            if emit_log:
                logger.log(level, "[SILENT-FAIL] scope=%s%s%s", scope, rid_txt, extra_txt)
            exc_type = ""
            exc_msg = ""
        else:
            exc_type = type(exc).__name__
            exc_msg = str(exc)[:500]
            if emit_log:
                logger.log(
                    level,
                    "[SILENT-FAIL] scope=%s%s%s exc=%s: %s",
                    scope,
                    rid_txt,
                    extra_txt,
                    exc_type,
                    exc_msg,
                    exc_info=(type(exc), exc, exc.__traceback__) if level >= logging.ERROR else None,
                )

        with _lock:
            _total += 1
            _counts[scope] += 1
            if len(_counts) <= _MAX_SCOPES or scope in _counts:
                _last_seen[scope] = {
                    "count": _counts[scope],
                    "last_request_id": rid,
                    "last_exc_type": exc_type,
                    "last_exc_message": exc_msg,
                    "last_context": {k: str(v)[:120] for k, v in list(context.items())[:8]},
                }
    except Exception:  # noqa: BLE001
        # 记录器自己失败时**绝不**再抛：宁可丢一条记录，也不能把被保护的调用方拖下水。
        with contextlib.suppress(Exception):
            logger.error("[SILENT-FAIL] recorder_itself_failed scope=%r", scope)


@contextlib.contextmanager
def swallow(scope: str, **context: Any) -> Iterator[None]:
    """替换 ``except ...: pass``：记录后吞掉。

    语义与原来的 ``pass`` 完全一致（异常不外传），区别只是**留下了记录**。
    只捕获 ``Exception``，不捕 ``BaseException``（KeyboardInterrupt/SystemExit 必须继续上抛）。
    """
    try:
        yield
    except Exception as exc:  # noqa: BLE001 - 这是设计意图：吞掉但记录
        record(scope, exc, **context)


def snapshot() -> dict:
    """返回可 JSON 序列化的账本快照，供诊断端点使用。"""
    try:
        with _lock:
            return {
                "total": _total,
                "distinct_scopes": len(_counts),
                "counts": dict(_counts.most_common()),
                "last_seen": dict(_last_seen),
            }
    except Exception:  # noqa: BLE001
        with contextlib.suppress(Exception):
            logger.error("[SILENT-FAIL] snapshot_failed", exc_info=True)
        return {"total": 0, "distinct_scopes": 0, "counts": {}, "last_seen": {}, "error": "snapshot_failed"}


def reset() -> None:
    """清空账本。仅供测试使用。"""
    global _total
    with _lock:
        _counts.clear()
        _last_seen.clear()
        _logged_once.clear()
        _total = 0


def format_exc_brief(exc: BaseException, limit: int = 3) -> str:
    """把异常压成一行「类型: 消息 @ 文件:行」，用于不想打全栈的场景。"""
    try:
        tb = traceback.extract_tb(exc.__traceback__)
        tail = tb[-limit:] if tb else []
        where = " <- ".join("%s:%d" % (f.filename.rsplit("/", 1)[-1], f.lineno) for f in tail)
        return "%s: %s%s" % (type(exc).__name__, str(exc)[:300], (" @" + where) if where else "")
    except Exception:  # noqa: BLE001
        with contextlib.suppress(Exception):
            logger.error("[SILENT-FAIL] format_exc_brief_failed", exc_info=True)
        return "unprintable_exception"
