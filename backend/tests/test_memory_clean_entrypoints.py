"""[MEM-CLEAN] 防复发：所有 assistant 记忆写入入口必须经过清洗。

背景：`MemoryService.store_memory()` **内部不做任何清洗**，剥离 `<thinking>` 思维链与
`<UpdateVariable>` 功能块的责任落在每个调用点自己身上。

2026-09-23 实测发现 `app/api/chat.py`（普通聊天）漏了这一层，`result.full_content`
直接入库 —— 推理模型的整个思维链会被当成记忆存下来；而角色聊天链路的
websocket / character_ext 入口都做了。本用例扫描全仓调用点，防止同类遗漏再次发生。

判定规则：
- 只看 `.store_memory(...)` 调用片段里**字面量**出现 `"assistant"` 的；
- 该片段内必须出现 `clean_memory_content`；
- role 取自变量（如 `_reembed_role` / `metadata.get("role")`）的调用点跳过——
  这类调用方在片段外自行按 role 分支清洗，静态无法判定，不作为失败。
"""

import os
import re
import sys

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

_APP_DIR = os.path.join(_BACKEND_DIR, "app")


def _iter_source_files():
    for root, _dirs, files in os.walk(_APP_DIR):
        for name in files:
            if name.endswith(".py"):
                yield os.path.join(root, name)


def _extract_call(src: str, paren_pos: int) -> str:
    """从 ``(`` 位置起按括号平衡截取整个调用片段。"""
    depth = 0
    for i in range(paren_pos, len(src)):
        ch = src[i]
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return src[paren_pos:i + 1]
    return src[paren_pos:]


def _offending_calls():
    offenders = []
    for path in _iter_source_files():
        with open(path, encoding="utf-8") as fh:
            src = fh.read()
        for m in re.finditer(r"\.store_memory\(", src):
            call = _extract_call(src, m.start() + len(".store_memory"))
            if '"assistant"' not in call and "'assistant'" not in call:
                continue
            if "clean_memory_content" in call:
                continue
            line = src[:m.start()].count("\n") + 1
            offenders.append(f"{os.path.relpath(path, _BACKEND_DIR)}:{line}")
    return offenders


def test_every_assistant_memory_write_is_cleaned():
    offenders = _offending_calls()
    assert not offenders, (
        "以下 assistant 记忆写入未经过 clean_memory_content（思维链/功能块会进记忆）: "
        + ", ".join(offenders)
    )


def test_scanner_can_detect_an_offender():
    """扫描器自证：故意喂一段未清洗的调用，必须被抓出来。"""
    sample = '''
    def f(mem_svc, uid, sid, full_content):
        mem_svc.store_memory(
            user_id=uid,
            session_id=sid,
            role="assistant",
            content=full_content,
        )
    '''
    hits = []
    for m in re.finditer(r"\.store_memory\(", sample):
        call = _extract_call(sample, m.start() + len(".store_memory"))
        if '"assistant"' in call and "clean_memory_content" not in call:
            hits.append(call)
    assert hits, "扫描器应能识别未清洗的 assistant 写入"


def test_store_memory_itself_does_not_clean():
    """固化前提：清洗是调用方责任，核心存储函数不做清洗。

    若将来把清洗下沉到 store_memory 内部（更稳妥的做法），本用例会失败，
    正好提示可以放宽上面的入口扫描。
    """
    from app.memory_module import service as mem_service_mod

    src = open(mem_service_mod.__file__, encoding="utf-8").read()
    marker = "def store_memory("
    start = src.index(marker)
    end = src.index("\n    async def ", start) if "\n    async def " in src[start:] else len(src)
    body = src[start:start + 3000]
    assert "clean_memory_content" not in body, (
        "store_memory 现已内部清洗，调用点扫描可放宽"
    )
