"""助手回复落库统一出口（包U · 2026-10-19）。

## 为什么要有这个文件

本仓把「AI 回复写进消息表」的入口长期散在多处，每处各自手抄一遍
「解析 MVU → 剥离正文 → 剥标题」，抄漏一步就产生一种落库形状。实测病灶：

1. `websocket.run_chat_generation`（普通聊天 → ``messages`` 表）两处
   ``content=final`` 既不解析也不剥离。
2. `character_ext._character_chat_impl` 的 SSE 收尾（``finally`` 内取标题那一段）
   从 **``result.full_content``（模型原文）** 重新派生正文并回写，把
   ``persist_snapshot`` 已经剥干净的正文**覆盖回未剥离的原文** ——
   线上样本 ``character_chat_messages.id=2852``（会话 c6182e89，2198 字，
   ``extra.mvu_patch`` 17 条）即此形状：解析做了、补丁留了、正文却脏。

⇒ 结论：**「多入口各自手抄」本身就是失效成因**（F4 那轮 SSE 四入口同型）。
本文件把三步收敛成一个函数，任何写助手正文的入口都必须取它的返回值落库，
不再在路径上手抄 ``strip_update_variable_blocks``。

## 顺序契约（不可调换）

1. **先解析**：``apply_mvu_reply_to_session(db, character_id, session_id, raw_text)``
   必须吃**剥离前**的原文，否则 stat_data 拿不到补丁。
2. **再剥离**：``strip_update_variable_blocks``，作用于显示文本
   （各入口的 ``AI_OUTPUT`` 正则产物），别名面与解析层共用
   ``mvu_engine`` 同一套正则（见包Q）。
3. **最后剥标题**：``extract_response_title``。

``apply_mvu_reply_to_session`` 不 commit —— 由调用方随消息落库同事务提交。

## 覆盖的落库入口（唯一清单，改入口请同步这里）

| # | 入口 | 目标表 | 解析 | 剥离 | 补丁留存 |
|---|---|---|---|---|---|
| 1 | ``websocket.run_chat_generation.persist_snapshot`` | messages | ✗（无角色会话） | ✓ | ✗ |
| 2 | ``chat.chat_stream`` 的 SSE 收尾 | messages | ✗ | ✓ | ✗ |
| 3 | ``websocket.run_character_chat_generation.persist_snapshot`` | character_chat_messages | ✓ | ✓ | ✓ |
| 4 | ``character_ext._character_chat_impl.persist_snapshot`` | 同上 | ✓ | ✓ | ✓ |
| 5 | ``character_ext._character_chat_impl`` 收尾取标题段 | 同上 | ✗（复用 4 的产物） | ✓ | 复用 4 |
| 6 | ``character_ext.regenerate_message.persist_fn`` | 同上 | ✓ | ✓ | ✓ |
| 7 | ``character_ext.swipe_message.persist_fn`` | 同上 | ✓ | ✓ | ✓ |
| 8 | ``character_ext.continue_session.persist_fn`` | 同上 | ✓ | ✓（增量） | ✓ |

不经过本出口的（有意排除，理由见交付报告）：客户端/导入供正文的写入
（``append_character_message`` / ``edit_character_message`` / ``switch_message_swipe`` /
``sessions.create_message`` / ST 导入与 ``st_sync_service`` / 开场白与用户与 system 行）、
向量记忆（走 ``utils.clean_memory_content``，另列 R4）。
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from .character_message_builder import apply_mvu_reply_to_session
from .compact_title_service import extract_response_title
from .mvu_engine import strip_update_variable_blocks

logger = logging.getLogger(__name__)

__all__ = [
    "PersistedAssistantReply",
    "finalize_assistant_reply",
    "find_variable_block_residue",
    "assert_no_variable_block_residue",
    "VARIABLE_BLOCK_RESIDUE_RE",
]

# 残块判据：三种上游别名 + 裸 <JSONPatch>（包Q 补齐的别名面）。
# 只匹配**标签骨架**，用于断言与探针，不触碰正文内容。
VARIABLE_BLOCK_RESIDUE_RE = re.compile(
    r"</?(?:update|updatevariable|variableupdate|json_?patch)\b[^>]*>",
    re.IGNORECASE,
)


@dataclass
class PersistedAssistantReply:
    """统一出口的返回值。``content`` 是**唯一允许写进消息表正文**的值。"""

    content: str
    variables: Optional[Dict[str, Any]] = None
    patches: List[Dict[str, Any]] = field(default_factory=list)
    logs: List[str] = field(default_factory=list)
    marker_title: Optional[str] = None
    #: True = 本轮调用过 MVU 解析（无论成败）。失败时 variables 为 None，
    #: 调用方据此**不**回填 extra["variables"]，但正文照剥。
    variables_parsed: bool = False


def finalize_assistant_reply(
    db: Optional[Session],
    *,
    character_id: Optional[str] = None,
    session_id: Optional[str] = None,
    raw_text: str,
    display_text: Optional[str] = None,
    parse_variables: bool = True,
    extract_title: bool = True,
) -> PersistedAssistantReply:
    """解析 → 剥离 → 剥标题，一次做完；返回可直接落库的正文。

    参数
    ----
    raw_text:
        模型原文（**未经** AI_OUTPUT 正则、未经剥离）。MVU 解析只吃这个值。
    display_text:
        该入口已经跑过 ``_apply_persist_regex_to_display_text`` 的显示文本；
        传 None 表示「本入口不做显示正则」，直接用 ``raw_text`` 剥。
    parse_variables:
        False 时跳过 MVU（普通聊天 ``messages`` 表没有角色会话）。
        流式中间快照调用方应传 False，仅在 force 收尾时传 True。
    extract_title:
        False 时保留 ``[标题: xxx]`` 标记（调用方自己处理）。

    异常处理：MVU 解析失败只降级为「不更新变量」，**不影响剥离**
    ——正文必须始终干净，这是本函数存在的理由。
    """
    source = raw_text if raw_text is not None else ""
    body = display_text if display_text is not None else source

    variables: Optional[Dict[str, Any]] = None
    patches: List[Dict[str, Any]] = []
    logs: List[str] = []
    parsed = False

    if parse_variables and db is not None and session_id:
        parsed = True
        try:
            variables, logs, patches = apply_mvu_reply_to_session(
                db, character_id, session_id, source
            )
        except Exception as exc:  # noqa: BLE001 - 解析失败不得影响剥离
            logger.warning("MVU variable update failed: %s", exc, exc_info=True)
            variables, logs, patches = None, [], []

    content = strip_update_variable_blocks(body) or ""

    marker_title: Optional[str] = None
    if extract_title:
        marker_title, content = extract_response_title(content)

    # 运行期自查（非致命）：出口自己都没剥干净 ⇒ 一定是模型输出的块形状落在
    # mvu_engine 的**有意**保留面（未闭合的裸 <JSONPatch> 块不匹配也不剥，
    # 见 tests/test_mvu_variable_block_aliases.py::test_unclosed_bare_patch_block_not_stripped），
    # 或别名面落后于真实输出。留一条可 grep 的日志，不把异常抛进用户请求。
    residue = find_variable_block_residue(content)
    if residue:
        logger.warning(
            "[MVU-RESIDUE] 落库正文仍含变量块标签 %s（session=%s char=%s 正文长度=%d）",
            residue, session_id, character_id, len(content),
        )

    return PersistedAssistantReply(
        content=content,
        variables=variables,
        patches=patches,
        logs=logs,
        marker_title=marker_title,
        variables_parsed=parsed,
    )


def find_variable_block_residue(text: Optional[str]) -> List[str]:
    """返回正文里残留的变量块标签骨架列表（探针/断言用，不回显正文）。"""
    if not text or not isinstance(text, str):
        return []
    return [m.group(0) for m in VARIABLE_BLOCK_RESIDUE_RE.finditer(text)]


def assert_no_variable_block_residue(text: Optional[str], *, where: str = "") -> None:
    """落库正文断言：残留任何变量块标签即抛 AssertionError（供测试与入口自查）。"""
    residue = find_variable_block_residue(text)
    if residue:
        raise AssertionError(
            f"落库正文残留变量块标签 {residue}（{where or 'unknown'}）；"
            f"正文长度={len(text or '')}，请检查该入口是否绕过 "
            f"assistant_reply_persist.finalize_assistant_reply"
        )
