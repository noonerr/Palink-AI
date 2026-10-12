# -*- coding: utf-8 -*-
"""P90-debug：校正两处可疑点
 1) tail 块其实是 dynamic_context_parts 被 join 成的一条 ⇒ 用 asm.dynamic_context_parts 直接分类
 2) 支撑度指标出现「全量历史 < 24窗口+记忆」的反常 ⇒ 逐项拆解验证
只读、零付费、零本地 LLM 生成。
"""
import asyncio
import os
import re
import sys

sys.path.insert(0, "/app")
os.environ.setdefault("DATABASE_URL", "postgresql+psycopg://ai_user:ai_pass@db:5432/ai_hub")

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

TOK_PER_CHAR = 0.66
_PUNCT = re.compile(r"[\s\W_]+", re.UNICODE)
MEM_MARK = "[Relevant Memories]"
CARD_MARK = "【当前状态（系统数据，非剧情指令）】"


def tok(s): return int(len(s or "") * TOK_PER_CHAR)
def norm(s): return _PUNCT.sub("", s or "")
def grams(s, n=4):
    t = norm(s)
    if len(t) < n: return {t} if t else set()
    return {t[i:i + n] for i in range(len(t) - n + 1)}


async def main():
    db = sessionmaker(bind=create_engine(os.environ["DATABASE_URL"]))()
    from app.models.character import (Character, CharacterChatSession,
                                      CharacterChatSessionBranch, CharacterChatMessage)
    from app.models.user import User
    from app.services.roleplay_prompt_assembly import (
        PromptAssemblyDeps, PromptAssemblyRequest, assemble_roleplay_prompt)
    from app.api.character_ext import (
        _build_char_system_prompt, _get_full_branch_history, _replace_placeholders,
        _get_ancestor_branch_ids, _contains_chinese, _apply_plugin_regex_scripts,
        _apply_regex_scripts, _apply_prompt_regex_to_messages)

    sess = db.query(CharacterChatSession).filter(CharacterChatSession.id.like("f25daab6%")).first()
    char = db.query(Character).filter(Character.id == sess.character_id).first()
    user = db.query(User).filter(User.id == sess.user_id).first()
    b = db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.session_id == sess.id,
        CharacterChatSessionBranch.id.like("30251f44%")).first()

    rows = (db.query(CharacterChatMessage)
            .filter(CharacterChatMessage.session_id == sess.id,
                    CharacterChatMessage.branch_id == b.id)
            .order_by(CharacterChatMessage.created_at.asc(), CharacterChatMessage.id.asc()).all())
    msgs = [{"id": m.id, "role": m.role, "text": m.content or ""} for m in rows if not m.is_hidden]
    turn_idx = [i for i, m in enumerate(msgs) if m["role"] == "user"]
    print(f"msgs={len(msgs)} user轮={len(turn_idx)}")

    ti = turn_idx[-3]
    req = PromptAssemblyRequest(
        db=db, user=user, char=char, session_id=sess.id, branch_id=b.id,
        message=msgs[ti]["text"], images=[], model="deepseek-flash",
        user_nickname=user.username, response_length=None, max_tokens=None,
        smart_card_trigger=False, smart_card_context=None,
        context_template_name=None, include_user_message=True)
    deps = PromptAssemblyDeps(
        build_system_prompt=_build_char_system_prompt,
        replace_placeholders=_replace_placeholders,
        get_full_branch_history=_get_full_branch_history,
        get_ancestor_branch_ids=_get_ancestor_branch_ids,
        contains_chinese=_contains_chinese,
        apply_plugin_regex_scripts=_apply_plugin_regex_scripts,
        apply_regex_scripts=_apply_regex_scripts,
        apply_prompt_regex_to_messages=_apply_prompt_regex_to_messages)
    asm = await assemble_roleplay_prompt(req, deps)
    db.rollback()

    print("\n=== dynamic_context_parts 分类（真实、未 join）===")
    dps = list(asm.dynamic_context_parts or [])
    const, mem, card = [], [], []
    for p in dps:
        if MEM_MARK in p: mem.append(p)
        elif CARD_MARK in p: card.append(p)
        else: const.append(p)
    ct, mt, kt = "\n\n".join(const), "\n\n".join(mem), "\n\n".join(card)
    print(f"parts={len(dps)}  常量(世界书等)={tok(ct)}tok/{len(ct)}ch  "
          f"记忆={tok(mt)}tok/{len(mt)}ch  实体卡={tok(kt)}tok/{len(kt)}ch")
    for i, p in enumerate(dps):
        tag = "MEM" if MEM_MARK in p else ("CARD" if CARD_MARK in p else "CONST")
        print(f"  [{i}] {tag:<6} {tok(p):>6}tok {len(p):>7}ch  {p[:60]!r}")

    sys_txt = "\n\n".join(
        (m.get("content") if isinstance(m.get("content"), str) else str(m.get("content")))
        for m in asm.messages[:1])
    print(f"\nsystem(首条)={tok(sys_txt)}tok/{len(sys_txt)}ch  total_estimate={asm.total_tokens_estimate}")

    # ── 支撑度拆解 ──
    reply = None
    for j in range(ti + 1, min(ti + 3, len(msgs))):
        if msgs[j]["role"] == "assistant":
            reply = msgs[j]["text"]; break
    if not reply:
        print("no reply"); return
    full_hist = "\n".join(m["text"] for m in msgs[:ti])
    win24 = "\n".join(m["text"] for m in msgs[max(0, ti - 24):ti])
    win6 = "\n".join(m["text"] for m in msgs[max(0, ti - 6):ti])
    g = grams(reply)
    print(f"\n=== 支撑度拆解（本轮 ti={ti}, reply {len(reply)}ch, 唯一4-gram {len(g)}）===")
    for label, ctx in [("空上下文", ""), ("仅本轮 user", msgs[ti]["text"]),
                       ("6窗", win6), ("24窗", win24), ("全量历史", full_hist),
                       ("仅记忆块", mt), ("记忆+system", sys_txt + mt),
                       ("24窗+记忆", win24 + mt), ("全量+记忆", full_hist + mt)]:
        cg = grams(ctx)
        print(f"  {label:<14} 支撑度={len(g & cg)/len(g)*100:5.1f}%   上下文{len(ctx):>7}ch")

    print("\n=== 记忆块是否真的是历史子集？===")
    mc = set(grams(mt)); hc = set(grams(full_hist))
    print(f"  记忆4gram={len(mc)}  全量历史4gram={len(hc)}  交集={len(mc & hc)}  "
          f"记忆独有={len(mc - hc)}（占比 {len(mc-hc)/max(1,len(mc))*100:.1f}%）")
    print(f"  记忆文本前120字：{mt[:120]!r}")
    db.close()


asyncio.run(main())
