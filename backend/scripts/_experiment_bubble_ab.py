"""A/B/C 对照与稳态链路：规范强度 / 历史范例形态对卡「正文美化」出框率的影响。

对应文档：docs/PROMPT_接手批_格式规范残本与A_B重测_2026-10-02.md §6

组别（同一张卡 / 同一模型 / 同一历史前缀，只有注入内容或历史范例形态不同）：
  A  装配层默认（新判据，修好吞段）→ 注入完整规范
  B  PALINK_BUBBLE_LEGACY_SECTION_STRIP=1 走旧「按标题整段吞」→ 注入残本
  C  同 A；装配层自 2026-10-02 起**默认不再擦历史外壳**（旧开关已删，见下）

测试口径：
  --turns 1,3   历史前缀截断造「第 k 轮」语境（前缀 = 2k-1 条，零 DB 写入）
  --steady      稳态链路：把模型自己的 turn2 输出塞回历史当 a2'，得到
                「历史全带壳」的稳态语境（近似「新开会话」，同样零 DB 写入）
  --history-cell ID[,ID]  零成本：把库里指定消息当历史范例塞进装配栈，量装配产物
  --audit-stored [--audit-ids]  零成本：直接审计库内既有输出，不发任何请求
  --dry         只装配不采样

判据是机器断言，不靠人眼：把每次输出喂给该卡「正文美化」的**真实 findRegex**
（从 characters.extensions.regex_scripts 现读），命中 >= 1 记为「出框」；
并单列 `leak` = **框内**（捕获组里）混进字面 `<content>` 的命中数（消息 2466 形态）。

隐私红线：本脚本只输出长度、命中次数与布尔判定，**从不打印任何正文/生成内容**。

用法：
  docker exec palink-ai-backend-1 python /app/scripts/_experiment_bubble_ab.py --audit-stored
  docker exec palink-ai-backend-1 python /app/scripts/_experiment_bubble_ab.py --history-cell 2466,2497
  docker exec palink-ai-backend-1 python /app/scripts/_experiment_bubble_ab.py --steady --n 8
  docker exec -e PALINK_BUBBLE_LEGACY_SECTION_STRIP=1 palink-ai-backend-1 \
      python /app/scripts/_experiment_bubble_ab.py --turns 1,2,3 --n 5
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
from app.models import User, Character, CharacterChatMessage  # noqa: E402
from app.services.character_message_builder import (  # noqa: E402
    clean_display_markup_for_prompt,
)
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
# 外壳记号计数用（装配层自 2026-10-02 改默认后**不再擦**历史外壳，
# 故这里只用于量"历史/产物里还剩几个记号"）
SHELL_TAG_RE = re.compile(
    r"</?(?:now_plot|content|story|Lnterleaving|正文|cg|background)\b[^>]*/?>",
    re.IGNORECASE,
)


class _SynthRow:
    """历史行替身：只暴露装配层会读到的属性（role/content/id/name/is_hidden/extra），
    其余一律 AttributeError。用于把模型自己生成的输出塞进历史做「稳态」对照，
    零 DB 写入。"""

    def __init__(self, role, content, id=None, name=None, is_hidden=False):
        self.role = role
        self.content = content
        self.id = id
        self.name = name
        self.is_hidden = is_hidden
        self.extra = None

    def __getattr__(self, item):
        raise AttributeError(item)


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


def _make_deps(prefix_len=None, override_last_assistant=None):
    """装配套件。

    prefix_len            非空时把分支历史截断成前缀（零 DB 写入造「第 k 轮」语境）。
    override_last_assistant 非空时把前缀里**最后一条 assistant** 换成本次模型自己的输出
                        （零 DB 写入造「历史全带外壳」的稳态语境）。
    """
    real_history_fn = _get_full_branch_history
    if prefix_len is not None or override_last_assistant is not None:
        def _patched(db, session_id, branch_id, *args, **kwargs):
            rows = list(real_history_fn(db, session_id, branch_id, *args, **kwargs))
            if prefix_len is not None:
                rows = rows[:prefix_len]
            if override_last_assistant is not None:
                for i in range(len(rows) - 1, -1, -1):
                    if getattr(rows[i], "role", None) == "assistant":
                        rows[i] = _SynthRow(
                            "assistant", override_last_assistant, id="synth-assistant"
                        )
                        break
            return rows
        history_fn = _patched
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


async def build_messages(
    prefix_len=None, message="", include_user_message=False, override_last_assistant=None
):
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
        result = await assemble_roleplay_prompt(
            req, _make_deps(prefix_len, override_last_assistant)
        )
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
    """机器断言。`frame_leak` = **框内**（卡正则的捕获组里）混进字面 `<content>` 的命中数。

    这才是消息 2466「正文上下各露一对 content 记号」的成因形态：卡正则是单层反向引用，
    配到外层时内层 `<content>` 原样落进捕获组、被 replaceString 渲进框里。
    只看「全文有没有 content」不足以判定（规范文本里出现这个词不算漏）。
    """
    matches = pat.findall(text)
    leaks = 0
    for m in matches:
        cap = m[1] if isinstance(m, tuple) and len(m) > 1 else (m if isinstance(m, str) else "")
        if re.search(r"</?content>", str(cap), re.IGNORECASE):
            leaks += 1
    return {
        "len": len(text),
        "frames": len(matches),
        "frame_leak": leaks,
        "boxed": len(matches) >= 1,
        "bubble": "@bubble" in text,
        "literal_content": bool(re.search(r"</?content>", text, re.IGNORECASE)),
    }


def _detail(j: dict) -> str:
    if j["boxed"]:
        return "BOX(l=%d,f=%d,leak=%d)" % (j["len"], j["frames"], j["frame_leak"])
    return "BARE(l=%d,b=%d,c=%d)" % (j["len"], j["bubble"], j["literal_content"])


async def _sample_cell(label: str, messages: list, pat: re.Pattern, n: int) -> list[str]:
    """采样 n 次并打印一格结果。返回所有非空输出原文（供链路串联，不落盘、不打印）。"""
    boxed = 0
    valid = 0
    empties = 0
    leaks = 0
    details = []
    texts: list[str] = []
    for _ in range(n):
        text, empty_tries = await run_sample(messages)
        empties += empty_tries
        if not text.strip():
            details.append("EMPTY")
            continue
        valid += 1
        texts.append(text)
        j = _judge(text, pat)
        boxed += 1 if j["boxed"] else 0
        leaks += j["frame_leak"]
        details.append(_detail(j))
    rate = 100.0 * boxed / max(1, valid)
    leak_rate = 100.0 * leaks / max(1, boxed)
    print(
        "[RESULT] %s 出框 %d/%d (%.0f%%) | 框内漏 content %d/%d (%.0f%%) | 有效=%d 空响应重试=%d"
        % (label, boxed, valid, rate, leaks, boxed, leak_rate, valid, empties)
    )
    print("[DETAIL] %s %s" % (label, " ".join(details)))
    return texts


async def _audit_stored(pat: re.Pattern, ids=None, session_id: str = "", with_swipes: bool = False) -> None:
    """零成本：对**库内既有真实输出**跑同一套断言（不发任何模型请求）。

    素材：指定 `--audit-session <sid>` 的会话，或指定 id，或默认该卡克隆会话。
    `--with-swipes` 时把每条 assistant 消息的 swipes 数组也逐条判一遍
    （真机验收的「每格 n 次 swipe」正是存在这里）。
    自 2026-10-02「改默认」起装配层不再擦历史外壳，故只出 raw / cleaned 两个口径。
    """
    db = SessionLocal()
    try:
        q = db.query(CharacterChatMessage)
        if ids:
            rows = q.filter(CharacterChatMessage.id.in_(ids)).all()
        elif session_id:
            rows = (
                q.filter(CharacterChatMessage.session_id == session_id)
                .order_by(CharacterChatMessage.id)
                .all()
            )
        else:
            rows = (
                q.filter(CharacterChatMessage.session_id.like("295039f9%"))
                .order_by(CharacterChatMessage.id)
                .all()
            )
        print("[AUDIT] 行数=%d（只统计角色/长度/命中/漏标记，不打印正文）" % len(rows))
        tot_frames = tot_leak = tot_boxed = tot_n = 0
        for r in rows:
            if r.role != "assistant":
                continue
            raw = r.content or ""
            cleaned = clean_display_markup_for_prompt(raw)
            for mode, text in (("raw", raw), ("cleaned", cleaned)):
                j = _judge(text, pat)
                print(
                    "[AUDIT] id=%s mode=%-8s len=%5d shell=%2d frames=%d leak=%d"
                    % (r.id, mode, j["len"], len(SHELL_TAG_RE.findall(text)), j["frames"], j["frame_leak"])
                )
            if with_swipes and r.swipes:
                try:
                    swipes = json.loads(r.swipes)
                except (TypeError, ValueError):
                    swipes = []
                for k, s in enumerate(swipes):
                    text = s if isinstance(s, str) else str(s)
                    j = _judge(text, pat)
                    tot_n += 1
                    tot_boxed += 1 if j["boxed"] else 0
                    tot_frames += j["frames"]
                    tot_leak += j["frame_leak"]
                    print(
                        "[SWIPE] msg=%s k=%d len=%5d shell=%2d frames=%d leak=%d"
                        % (r.id, k, j["len"], len(SHELL_TAG_RE.findall(text)), j["frames"], j["frame_leak"])
                    )
        if with_swipes and tot_n:
            print(
                "[SWIPE-SUM] n=%d 出框 %d/%d (%.0f%%) | 框内漏 content %d/%d"
                % (tot_n, tot_boxed, tot_n, 100.0 * tot_boxed / max(1, tot_n), tot_leak, tot_boxed)
            )
    finally:
        db.close()


async def _steady_run(pat: re.Pattern, n: int) -> None:
    """稳态链路（零 DB 写入）：让历史的每一条 assistant 都带外壳。

    现有克隆会话里只有首轮那条回复带外壳（之后本来就是裸的），所以直接跑 turn3
    得到的只是**下限**。稳态做法：先跑 turn2（历史里只有那条带壳的正例）拿一条模型
    自己的输出当 a2'，再把 a2' 塞回历史跑 turn3 —— 这样 turn3 的历史 = 带壳 a1 +
    带壳 a2'，即「修好后每条回复都带壳」的近似。

    注：自 2026-10-02「改默认」起，装配层不再擦历史外壳，本模式无需任何环境变量。
    """
    m2, ev2 = await build_messages(prefix_len=turn_prefix(2))
    print(
        "[ASSEMBLE] steady turn=2 msgs=%d injected_chars=%s"
        % (len(m2), ((ev2 or {}).get("applied") or {}).get("chars_injected"))
    )
    outs2 = await _sample_cell("steady turn=2（历史 1 条 assistant，带壳）", m2, pat, n)

    seed = next((t for t in outs2 if _judge(t, pat)["boxed"]), None)
    if seed is None:
        print("[SEED] 无出框样本可用作 a2'，稳态链路中止")
        return
    sj = _judge(seed, pat)
    print(
        "[SEED] 选用 turn2 输出作 a2'：len=%d frames=%d leak=%d shell_tags=%d"
        % (sj["len"], sj["frames"], sj["frame_leak"], len(SHELL_TAG_RE.findall(seed)))
    )

    m3, ev3 = await build_messages(
        prefix_len=turn_prefix(3), override_last_assistant=seed
    )
    hist_shell = sum(
        len(SHELL_TAG_RE.findall(str(m.get("content") or "")))
        for m in m3
        if m.get("role") == "assistant"
    )
    print(
        "[ASSEMBLE] steady turn=3 msgs=%d injected_chars=%s 历史外壳记号=%d"
        % (len(m3), ((ev3 or {}).get("applied") or {}).get("chars_injected"), hist_shell)
    )
    await _sample_cell("steady turn=3（历史 2 条 assistant，全带壳）", m3, pat, n)


async def _history_cell(pat: re.Pattern, ids) -> None:
    """零成本：把库里指定 assistant 消息**当历史范例**塞进装配栈，再量装配产物自身。

    回答的是「历史里带外壳（甚至两层）的范例进了 prompt 会长什么样」——
    与生成无关，纯文本度量：外壳记号数 / 卡正则帧数 / **框内**漏 content 数。
    逐条打印每个消息槽，便于把「规范自己的脚手架帧」与「历史范例的帧」分开看。
    """
    db = SessionLocal()
    try:
        srcs = (
            db.query(CharacterChatMessage)
            .filter(CharacterChatMessage.id.in_(ids))
            .order_by(CharacterChatMessage.id)
            .all()
        )
        picked = [(r.id, r.role, r.content or "") for r in srcs if r.role == "assistant"]
    finally:
        db.close()

    for src_id, _role, content in picked:
        msgs, ev = await build_messages(
            prefix_len=turn_prefix(3), override_last_assistant=content
        )
        tot_shell = tot_frames = tot_leak = 0
        print("[CELL] src=%s（当历史范例）msgs=%d injected_chars=%s"
              % (src_id, len(msgs), ((ev or {}).get("applied") or {}).get("chars_injected")))
        for i, m in enumerate(msgs):
            c = str(m.get("content") or "")
            j = _judge(c, pat)
            sh = len(SHELL_TAG_RE.findall(c))
            tot_shell += sh
            tot_frames += j["frames"]
            tot_leak += j["frame_leak"]
            print(
                "  [CELL] src=%s #%d role=%-9s len=%5d shell=%2d frames=%d leak=%d"
                % (src_id, i, m.get("role"), j["len"], sh, j["frames"], j["frame_leak"])
            )
        print(
            "[CELL] src=%s 合计 shell=%d frames=%d **leak=%d**"
            % (src_id, tot_shell, tot_frames, tot_leak)
        )


async def _tag_skeleton(session_id: str, with_swipes: bool = True) -> None:
    """零成本：只出「长度 + 空否 + 各外壳标签出现条数」的骨架，**不依赖卡正则**。

    用途：异卡对照卡没有自己的显示正则，无法套「出框率」；改看标签分布是否漂移
    （模型有没有凭空开始写它以前不写的标签），以及有没有空响应。
    对照组 = 该卡**旧会话**（在"擦外壳"旧行为下生成）的骨架。
    """
    TAG_NAMES = ("now_plot", "content", "story", "Lnterleaving", "正文", "cg", "background")
    pats = {t: re.compile(r"</?%s\b[^>]*/?>" % re.escape(t), re.IGNORECASE) for t in TAG_NAMES}

    db = SessionLocal()
    try:
        rows = (
            db.query(CharacterChatMessage)
            .filter(CharacterChatMessage.session_id == session_id)
            .order_by(CharacterChatMessage.id)
            .all()
        )
    finally:
        db.close()

    agg = {t: 0 for t in TAG_NAMES}
    n_out = n_empty = 0
    print("[SKEL] session=%s 行数=%d" % (session_id, len(rows)))
    for r in rows:
        if r.role != "assistant":
            continue
        texts = [r.content or ""]
        if with_swipes and r.swipes:
            try:
                texts += [s if isinstance(s, str) else str(s) for s in json.loads(r.swipes)]
            except (TypeError, ValueError):
                pass
        for text in texts:
            n_out += 1
            empty = not text.strip()
            n_empty += 1 if empty else 0
            counts = {t: len(p.findall(text)) for t, p in pats.items()}
            for t, c in counts.items():
                agg[t] += c
            print(
                "[SKEL] msg=%s len=%5d empty=%d %s"
                % (
                    r.id, len(text), int(empty),
                    " ".join("%s=%d" % (t, counts[t]) for t in TAG_NAMES if counts[t]),
                )
            )
    print(
        "[SKEL-SUM] session=%s 样本=%d 空响应=%d | 标签合计 %s"
        % (session_id, n_out, n_empty, " ".join("%s=%d" % (t, agg[t]) for t in TAG_NAMES))
    )


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--turns", default="1,3", help="历史前缀语境，逗号分隔（1=首轮 3=第3轮）")
    ap.add_argument("--n", type=int, default=N, help="每格采样次数")
    ap.add_argument("--dry", action="store_true", help="只装配不采样（零成本）")
    ap.add_argument("--audit-stored", action="store_true", help="零成本：审计库内既有输出（不发请求）")
    ap.add_argument("--audit-ids", default="", help="配合 --audit-stored，指定消息 id（逗号分隔，只读）")
    ap.add_argument("--audit-session", default="", help="配合 --audit-stored，审计指定会话（真机验收用）")
    ap.add_argument("--with-swipes", action="store_true", help="配合 --audit-stored，把 swipes 数组逐条判一遍")
    ap.add_argument("--tag-skeleton", default="", help="零成本：只出指定会话的标签骨架（不依赖卡正则）")
    ap.add_argument("--steady", action="store_true", help="稳态链路：历史全带壳（零 DB 写入）")
    ap.add_argument(
        "--history-cell",
        default="",
        help="零成本：把指定 id 的 assistant 消息当历史范例塞进装配栈，量装配产物",
    )
    args = ap.parse_args()

    legacy = (os.environ.get("PALINK_BUBBLE_LEGACY_SECTION_STRIP") or "").strip().lower() in {"1", "true", "on", "yes"}
    cond = "B(旧残本)" if legacy else "A(修好吞段)"
    cond += " +历史留外壳(2026-10-02 起为默认)"
    db = SessionLocal()
    pat_src = _load_card_regex_pattern(db)
    db.close()
    pat = re.compile(pat_src, re.IGNORECASE)
    print("[ENV] condition=%s legacy_strip=%s n=%d" % (cond, legacy, args.n))
    print("[ENV] card_regex_len=%d" % len(pat_src))

    if args.tag_skeleton:
        await _tag_skeleton(args.tag_skeleton)
        return

    if args.audit_stored:
        ids = [int(x) for x in args.audit_ids.split(",") if x.strip().isdigit()] or None
        await _audit_stored(pat, ids, session_id=args.audit_session, with_swipes=args.with_swipes)
        return

    if args.history_cell:
        cell_ids = [int(x) for x in args.history_cell.split(",") if x.strip().isdigit()]
        await _history_cell(pat, cell_ids)
        return

    if args.steady:
        await _steady_run(pat, args.n)
        return

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
        await _sample_cell("turn=%d" % turn, messages, pat, args.n)


if __name__ == "__main__":
    asyncio.run(main())
