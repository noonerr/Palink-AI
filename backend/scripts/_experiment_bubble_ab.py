"""A/B 对照：规范「修好吞段」vs「旧残本」对卡「正文美化」出框率的影响。

对应文档：docs/PROMPT_接手批_格式规范残本与A_B重测_2026-10-02.md §6

组别（同一张卡 / 同一模型 / 同一历史前缀，只有注入内容不同）：
  A  装配层默认（新判据，修好吞段）→ 注入完整规范
  B  PALINK_BUBBLE_LEGACY_SECTION_STRIP=1 走旧「按标题整段吞」→ 注入残本

每组在两种历史前缀下各采样 N 次：
  turn1  只带会话头 1 条（生成第 1 条 assistant 时的状态，历史里没有裸文参照）
  turn3  带前 5 条（生成第 3 条 assistant 时的状态，历史里已有 2 条无框回复）

判据是机器断言，不靠人眼：把每次输出喂给该卡「正文美化」的**真实 findRegex**
（从 characters.extensions.regex_scripts 现读），命中次数 >= 1 记为「出框」。

隐私红线：本脚本只输出长度、命中次数与布尔判定，**从不打印任何正文/生成内容**。

用法：
  docker exec palink-ai-backend-1 python /app/scripts/_experiment_bubble_ab.py --dry
  docker exec palink-ai-backend-1 python /app/scripts/_experiment_bubble_ab.py --turns 1,3 --n 5
  docker exec -e PALINK_BUBBLE_LEGACY_SECTION_STRIP=1 palink-ai-backend-1 \
      python /app/scripts/_experiment_bubble_ab.py --turns 1,3 --n 5
"""

import argparse
import asyncio
import json
import logging
import os
import re
import sys

sys.path.insert(0, "/app")

logging.basicConfig(level=logging.WARNING)

from app.core.database import SessionLocal  # noqa: E402
from app.models import User, Character  # noqa: E402
from app.services.roleplay_prompt_assembly import (  # noqa: E402
    PromptAssemblyDeps,
    PromptAssemblyRequest,
    assemble_roleplay_prompt,
)
from app.api.character_ext import (  # noqa: E402
    _apply_plugin_regex_scripts,
    _apply_regex_scripts,
    _apply_prompt_regex_to_messages,
    _get_full_branch_history,
    _get_ancestor_branch_ids,
    _contains_chinese,
    _replace_placeholders,
    _build_char_system_prompt,
)
from app.services.inference_dispatcher import stream_text_completion  # noqa: E402

SESSION_ID = "295039f9-99b6-4150-a40f-5e381246ca5d"  # 露缇雅1.2 克隆会话
BRANCH_ID = "09bcc3f1-e0a9-4134-aaa8-8e1fc350641a"
CHAR_ID = "4af0c6d3-4fc8-4ad0-b22f-8ce64f52eb44"  # 露缇雅1.2
USER_ID = 1
MODEL = "deepseek-v4-flash"
N = 5

# 历史前缀长度：生成第 k 条 assistant 时的状态，历史 = 前 (2k-1) 条（u,a,u,a,…,u）
def turn_prefix(turn: int) -> int:
    return max(1, 2 * int(turn) - 1)
CARD_REGEX_SCRIPT_NAME = "正文美化"


def _load_card_regex_pattern(db) -> str:
    """现读该卡「正文美化」的真实 findRegex（`/…/gi` 形态），返回可直接 compile 的模式。"""
    char = db.query(Character).filter(Character.id == CHAR_ID).first()
    ext = char.extensions
    if isinstance(ext, str):
        ext = json.loads(ext)
    for script in (ext or {}).get("regex_scripts") or []:
        if script.get("scriptName") != CARD_REGEX_SCRIPT_NAME:
            continue
        raw = (script.get("findRegex") or "").strip()
        if raw.startswith("/"):
            # 去掉 JS 字面量的包裹斜杠与结尾 flags
            body = raw[1:]
            cut = body.rfind("/")
            if cut != -1:
                body = body[:cut]
            raw = body
        return raw
    raise SystemExit("[FAIL] 卡内找不到「%s」正则" % CARD_REGEX_SCRIPT_NAME)


def _make_deps(prefix_len=None):
    """装配套件；prefix_len 非空时把分支历史截断成前缀（零 DB 写入造「首轮/第3轮」语境）。"""
    real_history_fn = _get_full_branch_history
    if prefix_len is not None:
        def _truncated(db, session_id, branch_id, *args, **kwargs):
            return list(
                real_history_fn(db, session_id, branch_id, *args, **kwargs)
            )[:prefix_len]
        history_fn = _truncated
    else:
        history_fn = real_history_fn

    return PromptAssemblyDeps(
        build_system_prompt=_build_char_system_prompt,
        replace_placeholders=_replace_placeholders,
        get_full_branch_history=history_fn,
        get_ancestor_branch_ids=_get_ancestor_branch_ids,
        contains_chinese=_contains_chinese,
        apply_plugin_regex_scripts=_apply_plugin_regex_scripts,
        apply_regex_scripts=_apply_regex_scripts,
        apply_prompt_regex_to_messages=_apply_prompt_regex_to_messages,
    )


async def build_messages(prefix_len=None, message="", include_user_message=False):
    db = SessionLocal()
    try:
        db.commit()
        user = db.query(User).filter(User.id == USER_ID).first()
        char = db.query(Character).filter(Character.id == CHAR_ID).first()
        req = PromptAssemblyRequest(
            db=db, user=user, char=char,
            session_id=SESSION_ID, branch_id=BRANCH_ID,
            message=message, model=MODEL,
            include_user_message=include_user_message,
            max_tokens=16384,
            extension_prompts=[],
        )
        result = await assemble_roleplay_prompt(req, _make_deps(prefix_len))
        return result.messages, getattr(result, "ext_prompts_evidence", None)
    finally:
        db.close()


async def run_once(messages: list) -> str:
    """单次采样。注意：**不做**长度提前 break —— 出框判定要求闭合标签完整。"""
    parts: list[str] = []
    async for chunk in stream_text_completion(
        model_id=MODEL, messages=messages, temperature=0.70,
        max_tokens=16384, timeout=120.0, user_id=USER_ID,
        reasoning_effort="auto",
    ):
        if chunk.get("content"):
            parts.append(chunk["content"])
    return "".join(parts)


async def run_sample(messages: list, retries: int = 2) -> tuple[str, int]:
    """带空响应重试的采样。

    `deepseek-v4-flash` 有间歇性空响应史（见 2026-09 复盘），空响应**不是**「跳壳」，
    必须重试并单独计数，否则会把网关抖动误判成规范失效。返回 (文本, 空响应次数)。
    """
    empties = 0
    text = ""
    for _ in range(retries + 1):
        text = await run_once(messages)
        if text.strip():
            return text, empties
        empties += 1
    return text, empties


def _judge(text: str, pat: re.Pattern) -> dict:
    hits = len(pat.findall(text))
    return {
        "len": len(text),
        "frames": hits,
        "boxed": hits >= 1,
        "bubble": "@bubble" in text,
        "literal_content": bool(re.search(r"</?content>", text, re.IGNORECASE)),
    }


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--turns", default="1,3", help="历史前缀语境，逗号分隔（1=首轮 3=第3轮）")
    ap.add_argument("--n", type=int, default=N, help="每格采样次数")
    ap.add_argument("--dry", action="store_true", help="只装配不采样（零成本）")
    args = ap.parse_args()

    legacy = (os.environ.get("PALINK_BUBBLE_LEGACY_SECTION_STRIP") or "").strip().lower() in {"1", "true", "on", "yes"}
    cond = "B(旧残本)" if legacy else "A(修好吞段)"
    db = SessionLocal()
    pat_src = _load_card_regex_pattern(db)
    db.close()
    pat = re.compile(pat_src, re.IGNORECASE)
    print("[ENV] condition=%s legacy_strip=%s n=%d" % (cond, legacy, args.n))
    print("[ENV] card_regex_len=%d" % len(pat_src))

    for turn in [int(t) for t in args.turns.split(",") if t.strip()]:
        prefix = turn_prefix(turn)
        messages, evidence = await build_messages(prefix_len=prefix)
        applied = (evidence or {}).get("applied") or {}
        roles = "/".join(str(m.get("role", "?"))[:1] for m in messages)
        print(
            "[ASSEMBLE] turn=%d msgs=%d roles=%s injected_chars=%s reported_chars=%s dropped_sections=%s"
            % (
                turn, len(messages), roles,
                applied.get("chars_injected"), applied.get("chars_reported"),
                applied.get("dropped_sections"),
            )
        )
        if args.dry:
            continue

        boxed = 0
        valid = 0
        empties = 0
        details = []
        for _ in range(args.n):
            text, empty_tries = await run_sample(messages)
            empties += empty_tries
            if not text.strip():
                details.append("EMPTY")
                continue
            valid += 1
            j = _judge(text, pat)
            boxed += 1 if j["boxed"] else 0
            details.append(
                "BOX(l=%d,f=%d)" % (j["len"], j["frames"]) if j["boxed"]
                else "BARE(l=%d,b=%d,c=%d)" % (j["len"], j["bubble"], j["literal_content"])
            )
        rate = 100.0 * boxed / max(1, valid)
        print(
            "[RESULT] %s turn=%d 出框 %d/%d (%.0f%%) | 有效采样=%d 空响应重试=%d"
            % (cond, turn, boxed, valid, rate, valid, empties)
        )
        print("[DETAIL] %s turn=%d %s" % (cond, turn, " ".join(details)))


if __name__ == "__main__":
    asyncio.run(main())
