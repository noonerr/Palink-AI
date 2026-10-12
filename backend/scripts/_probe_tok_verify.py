# -*- coding: utf-8 -*-
"""P96 — 改动后验收：token 计数误差 + 缓存字段解析（零付费）

验证两件事：
  1) `_estimate_tokens`（无模型回退路径）在真实语料上的误差是否从 ~95% 降到几个百分点
  2) `extract_cache_tokens` 对三家字段名的解析是否正确（DeepSeek / OpenAI-MiMo / Anthropic）
"""
import os
import sys

sys.path.insert(0, "/app")
os.environ.setdefault("DATABASE_URL", "postgresql+psycopg://ai_user:ai_pass@db:5432/ai_hub")

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


def main():
    db = sessionmaker(bind=create_engine(os.environ["DATABASE_URL"]))()

    print("=" * 96)
    print("【① 缓存字段解析】三家风格 + 缺失字段兜底")
    print("=" * 96)
    from app.services.stream_builder import extract_cache_tokens
    cases = [
        ("DeepSeek 专有", {"prompt_tokens": 1000, "prompt_cache_hit_tokens": 900,
                           "prompt_cache_miss_tokens": 100}),
        ("OpenAI / MiMo", {"prompt_tokens": 1000,
                           "prompt_tokens_details": {"cached_tokens": 800}}),
        ("Anthropic", {"prompt_tokens": 1000, "cache_read_input_tokens": 700,
                       "cache_creation_input_tokens": 50}),
        ("无缓存字段", {"prompt_tokens": 1000}),
        ("空 usage", {}),
    ]
    ok = True
    for name, u in cases:
        rd, cr, ms = extract_cache_tokens(u)
        hit = rd / (rd + ms) if (rd + ms) else 0.0
        print(f"  {name:<16} hit={rd:<6} creation={cr:<5} miss={ms:<6} 命中率={hit*100:.0f}%")
    # 断言：DeepSeek 必须能读到 900（旧代码这里恒为 0）
    rd, _, ms = extract_cache_tokens(cases[0][1])
    if rd != 900:
        ok = False
        print(f"  ❌ DeepSeek 解析失败：期望 900，实得 {rd}")
    else:
        print("  ✅ DeepSeek 专有字段已能读到（旧代码此处恒为 0）")

    print("\n" + "=" * 96)
    print("【② token 计数误差】真值 = 真实 deepseek tokenizer")
    print("=" * 96)
    from app.models.character import CharacterChatMessage
    from app.services.st_tokenizer_service import get_token_count
    from app.services.roleplay_prompt_assembly import _estimate_tokens, _local_estimate_tokens

    rows = (db.query(CharacterChatMessage.content)
            .filter(CharacterChatMessage.content.isnot(None))
            .order_by(CharacterChatMessage.id.desc()).limit(150).all())
    texts = [r[0] for r in rows if r[0] and len(r[0]) > 20]
    real = [get_token_count(t, "deepseek-flash") for t in texts]
    tot_real = sum(real)

    new_est = sum(_local_estimate_tokens(t) for t in texts)
    try:
        import tiktoken
        enc = tiktoken.get_encoding("cl100k_base")
        old_est = sum(len(enc.encode(t)) for t in texts)
    except Exception:
        old_est = None

    print(f"  语料 {len(texts)} 条 / {sum(len(t) for t in texts)} 字")
    print(f"  真值                       : {tot_real}")
    print(f"  新（中文感知启发式）        : {new_est}   ({(new_est-tot_real)/tot_real*100:+.1f}%)")
    if old_est is not None:
        print(f"  旧（cl100k_base 回退）      : {old_est}   ({(old_est-tot_real)/tot_real*100:+.1f}%)")
    print(f"  _estimate_tokens(无模型)    : {sum(_estimate_tokens(t) for t in texts)}")

    # 逐条误差分布
    errs = []
    for t, r in zip(texts, real):
        if r:
            errs.append((_local_estimate_tokens(t) - r) / r)
    errs.sort()
    n = len(errs)
    if n:
        print(f"\n  逐条误差：p10={errs[n//10]*100:+.1f}%  中位={errs[n//2]*100:+.1f}%  "
              f"p90={errs[n*9//10]*100:+.1f}%")
    try:
        db.close()
    except Exception:
        pass
    print("\n结论：" + ("✅ 通过" if ok else "❌ 未通过"))


if __name__ == "__main__":
    main()
