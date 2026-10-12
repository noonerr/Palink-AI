# -*- coding: utf-8 -*-
"""P90 — 上下文注入「经济性 + 覆盖率」仿真（只读 / 零付费 / 零本地 LLM 生成）

回答：把最近历史从 24 条压到 4-6 条、靠向量记忆补足，能否达到/超过现在的 24 条全注入，
并拿到更长的记忆线？在 API 计费（缓存命中 vs 未命中）口径下的最优解是什么？

方法
  1) 跑真实装配入口 assemble_roleplay_prompt，量出 prompt 各真实块体积；
  2) 用真实会话全部消息做逐轮仿真，比较多种注入策略的
       - 总输入 token / 前缀缓存命中 token / 未命中 token（64 token 粒度）
       - 计费（命中 ¥0.02、未命中 ¥1.00、输出 ¥4.00 每 1M）
  3) 用真实向量检索（Ollama bge-m3，本地零付费）算证据覆盖率；
  4) 用真实 assistant 回复算「上下文支撑度」（4-gram groundedness 离线代理指标）。

不写库、不调付费 API、不做本地 LLM 生成。
"""
import argparse
import asyncio
import json
import os
import re
import sys
import time

sys.path.insert(0, "/app")
os.environ.setdefault("DATABASE_URL", "postgresql+psycopg://ai_user:ai_pass@db:5432/ai_hub")

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

# ── 计费单价（元 / 1M tokens）─────────────────────────────────────────────
# DeepSeek-V4.1-Flash 闲时 与 Xiaomi MiMo-V2.6-Flash 实时档当前口径相同：
#   命中缓存 ¥0.02 / 未命中 ¥1.00（⇒ 1:50）；输出 DeepSeek ¥4.00 / MiMo ¥2.00
PRICE = {
    "deepseek": {"hit": 0.02, "miss": 1.00, "out": 4.00},
    "mimo":     {"hit": 0.02, "miss": 1.00, "out": 2.00},
}
TOK_PER_CHAR = 0.66      # 本项目实测中文系数（见 utils.build_memory_context 注释）
CACHE_BLOCK = 64         # 前缀缓存粒度（token）

_PUNCT = re.compile(r"[\s\W_]+", re.UNICODE)
MEM_MARK = "[Relevant Memories]"
CARD_MARK = "【当前状态（系统数据，非剧情指令）】"


def tok(s: str) -> int:
    return int(len(s or "") * TOK_PER_CHAR)


def norm(s: str) -> str:
    return _PUNCT.sub("", s or "")


def grams(s: str, n: int = 4) -> set:
    t = norm(s)
    if len(t) < n:
        return {t} if t else set()
    return {t[i:i + n] for i in range(len(t) - n + 1)}


def lcp_len(a: str, b: str) -> int:
    m = min(len(a), len(b))
    lo, hi = 0, m
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if a[:mid] == b[:mid]:
            lo = mid
        else:
            hi = mid - 1
    return lo


def cost_of(hit, miss, out, who="deepseek"):
    p = PRICE[who]
    return (hit * p["hit"] + miss * p["miss"] + out * p["out"]) / 1_000_000.0


def load_messages(db, session_id, branch_id=None):
    from app.models.character import CharacterChatMessage
    q = db.query(CharacterChatMessage).filter(CharacterChatMessage.session_id == session_id)
    if branch_id:
        q = q.filter(CharacterChatMessage.branch_id == branch_id)
    else:
        q = q.filter(CharacterChatMessage.branch_id == None)  # noqa: E711
    rows = q.order_by(CharacterChatMessage.created_at.asc(), CharacterChatMessage.id.asc()).all()
    out = []
    for m in rows:
        if getattr(m, "is_hidden", False):
            continue
        out.append({"id": m.id, "role": m.role, "text": m.content or "", "chars": len(m.content or "")})
    return out


async def real_assembly_probe(db, sess, char, user, msgs, turn_idx, branch_id=None):
    from app.services.roleplay_prompt_assembly import (
        PromptAssemblyDeps, PromptAssemblyRequest, assemble_roleplay_prompt,
    )
    from app.api.character_ext import (
        _build_char_system_prompt, _get_full_branch_history, _replace_placeholders,
        _get_ancestor_branch_ids, _contains_chinese, _apply_plugin_regex_scripts,
        _apply_regex_scripts, _apply_prompt_regex_to_messages,
    )
    req = PromptAssemblyRequest(
        db=db, user=user, char=char, session_id=sess.id, branch_id=branch_id,
        message=msgs[turn_idx]["text"], images=[], model="deepseek-flash",
        user_nickname=user.username, response_length=None, max_tokens=None,
        smart_card_trigger=False, smart_card_context=None,
        context_template_name=None, include_user_message=True,
    )
    deps = PromptAssemblyDeps(
        build_system_prompt=_build_char_system_prompt,
        replace_placeholders=_replace_placeholders,
        get_full_branch_history=_get_full_branch_history,
        get_ancestor_branch_ids=_get_ancestor_branch_ids,
        contains_chinese=_contains_chinese,
        apply_plugin_regex_scripts=_apply_plugin_regex_scripts,
        apply_regex_scripts=_apply_regex_scripts,
        apply_prompt_regex_to_messages=_apply_prompt_regex_to_messages,
    )
    asm = await assemble_roleplay_prompt(req, deps)
    return asm


def split_blocks(msgs_list):
    """切成 system 段（history 之前）/ history 段 / tail 段（history 之后）。"""
    sys_blocks, hist, tail = [], [], []
    seen_hist = False
    for m in msgs_list:
        role = m.get("role")
        c = m.get("content")
        c = c if isinstance(c, str) else str(c)
        if role in ("user", "assistant"):
            seen_hist = True
            hist.append(c)
        elif seen_hist:
            tail.append(c)
        else:
            sys_blocks.append(c)
    return sys_blocks, hist, tail


def split_tail(tail):
    """tail 段 → (常量块, 记忆块, 实体卡块)。常量块含世界书/剧情线/长度提示/角色校准/PHI。"""
    const_parts, mem_parts, card_parts = [], [], []
    for t in tail:
        if MEM_MARK in t:
            mem_parts.append(t)
        elif CARD_MARK in t:
            card_parts.append(t)
        else:
            const_parts.append(t)
    return "\n\n".join(const_parts), "\n\n".join(mem_parts), "\n\n".join(card_parts)


async def retrieve_raw(db, user_id, session_id, query, exclude_ids, char_id, branch_scopes=None):
    """只做检索，**不渲染**。返回 (ContextResponse, mids)。

    ⚠️ 渲染必须交给 `app.utils.build_memory_context`（生产同一函数）——
    本探针早期版本自己写了 render_at_budget（按行切 + 超限 continue），
    会在文本中间留下空洞，导致 evidence 子串匹配失败，
    把块级命中从 77.2% 低估到 47.4%。已作废该函数的所有产出。
    """
    from app.memory_module.service import MemoryService
    svc = MemoryService(db, enable_cache=False)
    if not svc.is_available():
        return None, []
    ctx = await svc.get_context(
        user_id=user_id, query=query, session_id=session_id,
        max_tokens=20000, memory_mode="vector",
        exclude_message_ids=exclude_ids or None, character_id=char_id,
        branch_scopes=branch_scopes if branch_scopes is not None else [],
    )
    mids = [getattr(m, "message_id", None) for m in (ctx.memories or [])]
    return ctx, [m for m in mids if m is not None]


def render_real(ctx, budget):
    """用生产同一渲染器按预算渲染。budget 已含邻居附加额度。"""
    from app.utils import build_memory_context
    if ctx is None:
        return ""
    return build_memory_context(ctx, max_tokens=budget) or ""


async def retrieve_memories(db, user_id, session_id, query, exclude_ids, char_id, branch_scopes=None):
    """真实检索（Ollama bge-m3，本地零付费）。

    ⚠️ [TIME-TRAVEL 防护] 仿真第 ti 轮时，库里**已经存在** ti 之后消息的记忆行。
    若不排除，检索会把"未来"的记忆捞回来，而那些记忆正来自要预测的回复本身
    ⇒ 支撑度被系统性抬高（实测可虚高 ~20pp）。故调用方必须把
    「最近 5 条 + ti 之后全部消息 id」一并传入 exclude_message_ids。
    """
    from app.memory_module.service import MemoryService
    from app.utils import build_memory_context
    svc = MemoryService(db, enable_cache=False)
    if not svc.is_available():
        return "", []
    ctx = await svc.get_context(
        user_id=user_id, query=query, session_id=session_id,
        max_tokens=20000, memory_mode="vector",
        exclude_message_ids=exclude_ids or None, character_id=char_id,
        branch_scopes=branch_scopes if branch_scopes is not None else [],
    )
    text = build_memory_context(ctx, max_tokens=20000)
    mids = [getattr(m, "message_id", None) for m in (ctx.memories or [])]
    return text or "", [m for m in mids if m is not None]


def render_at_budget(full_mem_text, budget):
    """按内部预算（len//2 口径）截断记忆文本，模拟 build_memory_context 的整条跳过。"""
    if not full_mem_text or budget <= 0:
        return ""
    out = []
    used = 0
    for line in full_mem_text.split("\n"):
        c = len(line) // 2
        if used + c > budget:
            continue
        out.append(line)
        used += c
    return "\n".join(out)


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--session", default="f25daab6")
    ap.add_argument("--branch", default="30251f44")
    ap.add_argument("--turns", type=int, default=40)
    ap.add_argument("--qa", default="")
    ap.add_argument("--no-retrieval", action="store_true")
    args = ap.parse_args()

    eng = create_engine(os.environ["DATABASE_URL"])
    db = sessionmaker(bind=eng)()

    from app.models.character import Character, CharacterChatSession, CharacterChatSessionBranch
    from app.models.user import User

    sess = db.query(CharacterChatSession).filter(
        CharacterChatSession.id.like(args.session + "%")).first()
    char = db.query(Character).filter(Character.id == sess.character_id).first()
    user = db.query(User).filter(User.id == sess.user_id).first()
    branch_id = None
    if args.branch:
        b = db.query(CharacterChatSessionBranch).filter(
            CharacterChatSessionBranch.session_id == sess.id,
            CharacterChatSessionBranch.id.like(args.branch + "%")).first()
        branch_id = b.id if b else None
    msgs = load_messages(db, sess.id, branch_id)
    turn_idx = [i for i, m in enumerate(msgs) if m["role"] == "user"]
    print(f"[data] session={sess.id[:8]} branch={str(branch_id)[:8]} char={char.name} "
          f"msgs={len(msgs)} user轮={len(turn_idx)}")

    # ── 1) 真实装配量块 ──
    SYS_TEXT = ""
    CONST_TEXT = ""   # 世界书等常量块
    CARD_TEXT = ""
    REAL_MEM = ""
    try:
        t0 = time.time()
        asm = await real_assembly_probe(db, sess, char, user, msgs, turn_idx[-1], branch_id)
        sb, hb, tb = split_blocks(asm.messages)
        SYS_TEXT = "\n\n".join(sb)
        # ⚠️ 必须用 asm.dynamic_context_parts（未 join 的原始分块）分类：
        # 生产把这些 parts 用 "\n\n" 拼成**一条** system 消息，按整条判 MEM_MARK
        # 会把世界书（14.5k ch）整个算进"记忆"，块体积全错。
        dps = list(getattr(asm, "dynamic_context_parts", []) or [])
        const, mem, card = [], [], []
        for p in dps:
            if MEM_MARK in p:
                mem.append(p)
            elif CARD_MARK in p:
                card.append(p)
            else:
                const.append(p)
        CONST_TEXT, CARD_TEXT, REAL_MEM = "\n\n".join(const), "\n\n".join(card), "\n\n".join(mem)
        print(f"[real] {time.time()-t0:.1f}s  messages={len(asm.messages)} "
              f"total_estimate={getattr(asm,'total_tokens_estimate',0)} budget={getattr(asm,'token_budget',0)}")
        print(f"[real] 真实块体积(估算tok): system={tok(SYS_TEXT)}  常量(世界书等)={tok(CONST_TEXT)}  "
              f"history={len(hb)}条/{tok(chr(10).join(hb))}  实体卡={tok(CARD_TEXT)}  记忆={tok(REAL_MEM)}")
        print(f"[real] dynamic_context_parts={len(dps)} 块")
        db.rollback()
    except Exception as e:
        import traceback
        print("[real] FAILED:", e)
        traceback.print_exc()

    # ── 2) 逐轮真实检索 ──
    use_turns = turn_idx[-args.turns:] if len(turn_idx) > args.turns else turn_idx
    mem_cache = {}
    if not args.no_retrieval:
        t0 = time.time()
        for ti in use_turns:
            # 最近 5 条（生产行为） + ti 之后全部（TIME-TRAVEL 防护）
            excl = [msgs[j]["id"] for j in range(max(0, ti - 5), len(msgs))]
            txt, mids = await retrieve_memories(
                db, user.id, sess.id, msgs[ti]["text"], excl, str(char.id) if char else None,
                [(branch_id, None)] if branch_id else [])
            mem_cache[ti] = (txt, mids)
        print(f"[retrieval] {len(use_turns)}轮真实检索 {time.time()-t0:.1f}s，"
              f"中位记忆={sorted(tok(v[0]) for v in mem_cache.values())[len(mem_cache)//2]}tok")
        db.rollback()

    # ── 3) 策略仿真 ──
    def build_prompt(ti, hist_slice, mem_text, order):
        """order: 'prod' = system→history→常量→实体卡→记忆（生产现状）
                  'opt'  = system→常量→history→实体卡→记忆（常量块前移，缓存友好）"""
        body = "".join(h["text"] + "\n" for h in hist_slice)
        if order == "prod":
            return (SYS_TEXT + "\n" + body + CONST_TEXT + "\n" + CARD_TEXT + "\n"
                    + mem_text + "\n" + msgs[ti]["text"])
        return (SYS_TEXT + "\n" + CONST_TEXT + "\n" + body + CARD_TEXT + "\n"
                + mem_text + "\n" + msgs[ti]["text"])

    STRATS = [
        ("A 现状 24滑动+记忆4000",      "slide", 24, 4000, "prod"),
        ("B 现状+常量前移",             "slide", 24, 4000, "opt"),
        ("C 6滑动+记忆4000",            "slide",  6, 4000, "opt"),
        ("D 6滑动+记忆8000",            "slide",  6, 8000, "opt"),
        ("D2 6滑动+记忆12000",          "slide",  6, 12000, "opt"),
        ("E 4滑动+记忆6000",            "slide",  4, 6000, "opt"),
        ("F 24滑动+无记忆",             "slide", 24,    0, "opt"),
        ("G 全量追加+无记忆",           "append", 0,    0, "opt"),
        ("H 全量追加+记忆4000",         "append", 0, 4000, "opt"),
        ("I 代际追加48+记忆4000",       "gen",   48, 4000, "opt"),
        ("J 代际追加48+记忆8000",       "gen",   48, 8000, "opt"),
        ("K 代际追加24+记忆4000",       "gen",   24, 4000, "opt"),
        ("L 代际追加96+记忆4000",       "gen",   96, 4000, "opt"),
        ("M 自适应(第2轮升级)",         "adaptive",  0, 0, "opt"),
        ("N 自适应保守(第3轮升级)",     "adaptive2", 0, 0, "opt"),
        ("M24 自适应+封顶24",          "adaptive_gen", 24, 0, "opt"),
        ("M48 自适应+封顶48",          "adaptive_gen", 48, 0, "opt"),
        ("M96 自适应+封顶96",          "adaptive_gen", 96, 0, "opt"),
    ]

    def simulate(mode, k, budget, order, burst):
        """burst = 一次「连续聊 N 轮」的长度；每段第 1 轮缓存已过期（冷启动）。

        ⚠️ 这是对 2026-10-11 初版「随机概率 p」模型的**修正**：
        真实使用不是每轮独立地以概率 p 未命中，而是
            「一次会话的第 1 轮必然冷启动（隔天/隔几小时缓存过期），
              之后连续几轮都命中」。
        两者结论差别很大：随机 p 模型会低估短会话场景的代价。
        """
        prev = ""
        tin = thit = tmiss = tout = 0
        sn = sd = 0
        cold_rounds = 0
        for idx, ti in enumerate(use_turns):
            cold = bool(burst and idx % burst == 0)
            if cold:
                prev = ""
                cold_rounds += 1
            # ── 自适应：冷启动轮先「探路」（短窗口+回忆），确认在连续聊后升级为追加式 ──
            # 判据在真实系统里是「距上一条消息多久」+「该会话历史平均连聊几轮」；
            # 仿真里段边界即缓存过期点，故直接用 cold 标记。
            if mode == "adaptive":
                if cold:
                    start, budget_eff = max(0, ti - 6), 6000
                else:
                    start, budget_eff = 0, 0
            elif mode == "adaptive2":
                # 更保守：连聊到第 3 轮才升级（段内第 2 轮仍用短窗口）
                if cold or (burst and idx % burst == 1):
                    start, budget_eff = max(0, ti - 6), 6000
                else:
                    start, budget_eff = 0, 0
            elif mode == "adaptive_gen":
                # 升级后不是全量，而是**代际封顶 k 条** ⇒ 升级那轮的重读代价被锁死
                if cold:
                    start, budget_eff = max(0, ti - 6), 6000
                else:
                    start, budget_eff = (ti // k) * k, 4000
            elif mode == "slide":
                start, budget_eff = max(0, ti - k), budget
            elif mode == "append":
                start, budget_eff = 0, budget
            else:
                start, budget_eff = (ti // k) * k, budget
            hist = msgs[start:ti]
            full = mem_cache.get(ti, ("", []))[0]
            mem_text = render_at_budget(full, budget_eff)
            prompt = build_prompt(ti, hist, mem_text, order)
            lcp = lcp_len(prev, prompt) if prev else 0
            hit = (int(lcp * TOK_PER_CHAR) // CACHE_BLOCK) * CACHE_BLOCK
            total = tok(prompt)
            miss = max(0, total - hit)
            tin += total; thit += hit; tmiss += miss
            for j in range(ti + 1, min(ti + 3, len(msgs))):
                if msgs[j]["role"] == "assistant":
                    nxt = msgs[j]["text"]
                    tout += tok(nxt)
                    g = grams(nxt)
                    if g:
                        sn += len(g & grams(prompt)); sd += len(g)
                    break
            prev = prompt
        n = len(use_turns)
        return {
            "in": tin / n, "hit": thit / n, "miss": tmiss / n, "out": tout / n,
            "hit_rate": thit / tin if tin else 0,
            "cost_ds": cost_of(thit, tmiss, tout, "deepseek") / n,
            "cost_mimo": cost_of(thit, tmiss, tout, "mimo") / n,
            "support": sn / sd if sd else 0,
            "cold": cold_rounds,
        }

    results = {name: simulate(mode, k, budget, order, 0)
               for name, mode, k, budget, order in STRATS}

    print("\n" + "=" * 118)
    print("【逐轮仿真 · 计费口径】命中¥0.02/1M  未命中¥1.00/1M  输出¥4.00/1M（DeepSeek-V4.1-Flash 闲时；MiMo 仅输出档不同）")
    print("=" * 118)
    print(f"{'策略':<26}{'输入tok/轮':>10}{'命中/轮':>9}{'未命中/轮':>10}{'命中率':>8}"
          f"{'支撑度':>8}{'元/轮(DS)':>11}{'元/轮(MiMo)':>12}{'成本比':>8}")
    base = results["A 现状 24滑动+记忆4000"]["cost_ds"]
    for name, *_ in STRATS:
        r = results[name]
        print(f"{name:<26}{r['in']:>10.0f}{r['hit']:>9.0f}{r['miss']:>10.0f}{r['hit_rate']*100:>7.1f}%"
              f"{r['support']*100:>7.1f}%{r['cost_ds']:>11.5f}{r['cost_mimo']:>12.5f}"
              f"{r['cost_ds']/base:>8.2f}")
    print("-" * 118)
    print("支撑度 = 真实 assistant 回复的 4-gram 中，能在该策略上下文里找到的比例（离线 groundedness 代理）")

    # ── 3b) ★ 会话段模型（用户真实场景：隔天再来 ⇒ 每段第 1 轮必然冷启动）──
    print("\n" + "=" * 118)
    print("【★ 会话段模型】一次「来聊 N 轮」为一个会话段；**每段第 1 轮缓存已过期**（冷启动，整段按 ¥1.00/1M 计）")
    print("   例：burst=3 ⇒ 用户每次来连聊 3 轮就走，下次来是隔天 ⇒ 每 3 轮里有 1 轮全价")
    print("=" * 118)
    bursts = [1, 2, 3, 5, 10]
    print(f"{'策略':<26}" + "".join(f"{('每次聊'+str(b)+'轮'):>14}" for b in bursts)
          + f"{'连续不断':>12}")
    burst_tab = {}
    for name, mode, k, budget, order in STRATS:
        row = f"{name:<26}"
        burst_tab[name] = {}
        for b in bursts:
            r = simulate(mode, k, budget, order, b)
            burst_tab[name][b] = r["cost_ds"]
            row += f"{r['cost_ds']:>11.5f}({r['cost_ds']/base:.2f})".rjust(14)
        row += f"{results[name]['cost_ds']:>12.5f}"
        print(row)
    print("-" * 118)
    print("括号里是相对现状 A 的成本比；<1.00 就是省钱。")
    print("读法：追加式（G/H/L）在「每次只聊 1 轮」时反而更贵（整段历史白重读一遍），")
    print("      但只要一次连聊 ≥2 轮就回本；代际封顶策略（K）上下文小，冷启动代价低，最抗短会话。")

    # ── 3c) 记忆线长度：老片段自检索 ──
    # 直接回答「超过 24 段之后还能记得多远」。做法：对每一轮 ti，从 **ti-25 之前**
    # 随机抽老消息，用它的开头 25 字当查询（等价于用户回指前文），
    # 看该消息的标志性片段能否出现在注入上下文里。按"回溯距离"分桶统计召回率。
    if not args.no_retrieval:
        import random
        random.seed(7)
        print("\n[frag] 老片段自检索（测量记忆线长度）…")
        t0 = time.time()
        buckets = [(25, 40), (40, 60), (60, 80), (80, 100)]
        samples = []
        for ti in use_turns:
            pool = list(range(0, max(0, ti - 25)))
            if not pool:
                continue
            for _ in range(4):
                j = random.choice(pool)
                txt = msgs[j]["text"].strip()
                if len(txt) < 60:
                    continue
                q = txt[:25]
                gold = txt[len(txt) // 3: len(txt) // 3 + 12]
                samples.append((ti, j, ti - j, q, gold))
        # 每轮只需一次检索：把该轮所有查询串成多次检索（本地嵌入，慢但可接受）
        frag_res = {}
        for (_ti, j, dist, q, gold) in samples:
            excl = [msgs[k]["id"] for k in range(max(0, _ti - 5), len(msgs))]
            ctx, _ = await retrieve_raw(
                db, user.id, sess.id, q, excl, str(char.id) if char else None,
                [(branch_id, None)] if branch_id else [])
            frag_res[(_ti, j)] = ctx
        db.rollback()
        print(f"[frag] {len(samples)} 个样本检索完成 {time.time()-t0:.1f}s")

        print("\n" + "=" * 92)
        print("【记忆线长度】回溯 N 条之前的消息，用其首 25 字回指，证据能否进入注入上下文")
        print("=" * 92)
        print(f"{'回溯距离(条)':<16}{'样本':>6}{'24窗':>10}{'6窗':>10}{'记忆4000':>10}{'记忆8000':>10}{'记忆12000':>10}")
        for lo, hi in buckets:
            sel = [s for s in samples if lo <= s[2] < hi]
            if not sel:
                continue
            row = f"{f'{lo}-{hi}':<16}{len(sel):>6}"
            for wk in (24, 6):
                h = sum(1 for s in sel if (s[2] <= wk))
                row += f"{h/len(sel)*100:>9.0f}%"
            for bd in (4000, 8000, 12000):
                h = 0
                for s in sel:
                    mt = render_real(frag_res.get((s[0], s[1])), int(bd * 1.3))
                    if s[4] and s[4] in mt:
                        h += 1
                row += f"{h/len(sel)*100:>9.0f}%"
            print(row)
        print("  （记忆列按生产口径：预算 = 主预算 ×(1+NEIGHBOR_EXTRA_RATIO 0.3)，渲染器用 utils.build_memory_context）")
        print("-" * 92)
        print("『全量追加 / 代际追加』在窗口内的距离恒为 100%（原文就在上下文里），故未列入该表。")

    # ── 4) qa2 证据覆盖率 ──
    if args.qa and os.path.exists(args.qa) and mem_cache:
        qa = json.load(open(args.qa, encoding="utf-8"))
        last_ti = use_turns[-1]
        pos = {m["id"]: i for i, m in enumerate(msgs)}
        last_pos = pos[msgs[last_ti]["id"]]
        t0 = time.time()
        qa_mem = {}
        for item in qa:
            excl = [msgs[j]["id"] for j in range(max(0, last_ti - 5), len(msgs))]
            ctx, mids = await retrieve_raw(
                db, user.id, sess.id, item["q"], excl, str(char.id) if char else None,
                [(branch_id, None)] if branch_id else [])
            qa_mem[item["qid"]] = (ctx, set(mids))
        db.rollback()
        print(f"\n[qa] {len(qa)} 题检索完成 {time.time()-t0:.1f}s")

        def cover(window_k, budget):
            h = 0
            for item in qa:
                sid = item.get("src_msg_id")
                in_win = window_k and sid in pos and (last_pos - window_k) <= pos[sid] <= last_pos
                ev = (item.get("evidence") or "")[:12]
                in_mem = bool(ev) and ev in render_real(qa_mem[item["qid"]][0], int(budget * 1.3))
                if in_win or in_mem:
                    h += 1
            return h / len(qa)

        # 消息级命中：检索结果里有没有"证据所在那条消息"的记忆行（不看预算、不看是不是同一块）
        msg_hit = sum(1 for item in qa
                      if item.get("src_msg_id") in qa_mem[item["qid"]][1]) / len(qa)
        print(f"\n  ★ 消息级命中（只看检索捞没捞到证据所在消息）= {msg_hit*100:.1f}%")
        print(f"    下方为**块级命中**（evidence 原文是否真出现在注入文本里）—— 这才是模型实际能看到的东西。")
        print(f"    本项目 2026-10-11 报告的 93.0% 是消息级口径，会高估实际可得性。")

        print("\n" + "=" * 90)
        print(f"【qa2 证据覆盖率】n={len(qa)}（该题集证据全部落在 24 条窗口之外 ⇒ 纯窗口项贡献 0）")
        print("=" * 90)
        for label, wk, b in [("24窗+记忆4000(现状)", 24, 4000), ("24窗+无记忆", 24, 0),
                             ("6窗+记忆4000", 6, 4000), ("6窗+记忆6000", 6, 6000),
                             ("6窗+记忆8000", 6, 8000), ("6窗+记忆12000", 6, 12000),
                             ("4窗+记忆6000", 4, 6000), ("4窗+记忆12000", 4, 12000)]:
            print(f"  {label:<22} 覆盖率 = {cover(wk, b)*100:.1f}%")

    db.close()


if __name__ == "__main__":
    asyncio.run(main())
