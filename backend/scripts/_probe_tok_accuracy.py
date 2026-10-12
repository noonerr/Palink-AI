# -*- coding: utf-8 -*-
"""P94 — token 计数准确性实测：对比「真实 tokenizer」与「当前回退链/启发式」

目的：量化 `_estimate_tokens` 现在到底有多不准，以及修好能拿到什么。
只读、零付费。
"""
import json
import os
import sys
import time

sys.path.insert(0, "/app")
os.environ.setdefault("DATABASE_URL", "postgresql+psycopg://ai_user:ai_pass@db:5432/ai_hub")

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

SAMPLES = [
    ("纯中文叙事", "她沿着走廊小跑，来到隔壁紧闭的房门前，抬起手却又停住了。"),
    ("中文长段", "露缇雅抿着嘴，把睡裙的一角又往下拽了拽，露出小腹上那道正在发热微光的粉色纹路。她想说些什么，可喉咙里像是被什么堵住了，最后只是轻轻地喊了一声哥哥。"),
    ("中英混排", "她看到了 <UpdateVariable> 标记里的 new_value: 42，然后说了一句 OK。"),
    ("纯英文", "The quick brown fox jumps over the lazy dog and runs into the forest."),
    ("代码/JSON", '{"name": "露缇雅", "stats": {"好感度": 15, "hp": 100}}'),
    ("标签/标记", "<thinking>她在犹豫</thinking><UpdateVariable><status>time=2026年7月8日</status></UpdateVariable>"),
]


def real_count(text, model="deepseek"):
    from app.services.st_tokenizer_service import get_token_count as count_tokens
    return count_tokens(text, model)


def fallback_count(text):
    """当前回退链：tiktoken cl100k_base（若可用）。"""
    try:
        import tiktoken
        enc = tiktoken.get_encoding("cl100k_base")
        return len(enc.encode(text))
    except Exception as e:
        return None


def guesstimate(text):
    """ST 的 guesstimate：ceil(utf8_bytes / 3.35)。"""
    import math
    return math.ceil(len(text.encode("utf-8")) / 3.35)


def heuristic_066(text):
    return int(len(text) * 0.66)


def main():
    db = sessionmaker(bind=create_engine(os.environ["DATABASE_URL"]))()

    print("=" * 104)
    print("【token 计数准确性实测】真值 = 真实 deepseek tokenizer")
    print("=" * 104)
    print(f"{'样本':<14}{'字数':>6}{'真值':>7}{'cl100k':>9}{'错误':>9}"
          f"{'guesstimate':>12}{'错误':>9}{'0.66×字数':>11}{'错误':>9}")
    rows = []
    for name, text in SAMPLES:
        try:
            real = real_count(text, "deepseek")
        except Exception as e:
            print(f"  tokenizer 不可用: {e}")
            real = None
        fb = fallback_count(text)
        gs = guesstimate(text)
        h6 = heuristic_066(text)
        if real is None:
            print(f"{name:<14}{len(text):>6}{'—':>7}"
                  f"{fb if fb else '—':>9}{'—':>9}{gs:>12}{'—':>9}{h6:>11}{'—':>9}")
            continue
        def err(v):
            return f"{(v-real)/real*100:+.0f}%" if v is not None else "—"
        print(f"{name:<14}{len(text):>6}{real:>7}{fb if fb else '—':>9}{err(fb):>9}"
              f"{gs:>12}{err(gs):>9}{h6:>11}{err(h6):>9}")
        rows.append((name, len(text), real, fb, gs, h6))

    # ── 真实语料上的对比 ──
    try:
        from app.models.character import CharacterChatMessage
        rows_db = (db.query(CharacterChatMessage.content)
                   .filter(CharacterChatMessage.session_id.like("f25daab6%"))
                   .limit(60).all())
        texts = [r[0] or "" for r in rows_db if r[0]]
        if texts and real is not None:
            tot_real = sum(real_count(t, "deepseek") for t in texts)
            tot_fb = sum(fallback_count(t) or 0 for t in texts)
            tot_gs = sum(guesstimate(t) for t in texts)
            tot_h6 = sum(heuristic_066(t) for t in texts)
            n_chars = sum(len(t) for t in texts)
            print("\n" + "=" * 104)
            print(f"【真实语料】{len(texts)} 条消息 / {n_chars} 字")
            print("=" * 104)
            print(f"  真值(deepseek tokenizer) : {tot_real}")
            print(f"  cl100k_base 回退        : {tot_fb}   ({(tot_fb-tot_real)/tot_real*100:+.1f}%)")
            print(f"  ST guesstimate          : {tot_gs}   ({(tot_gs-tot_real)/tot_real*100:+.1f}%)")
            print(f"  0.66 × 字数              : {tot_h6}   ({(tot_h6-tot_real)/tot_real*100:+.1f}%)")
            print(f"  ⇒ 实测每字 token 数      : {tot_real/n_chars:.3f}")
    except Exception as e:
        print("  [db] 跳过:", e)
    try:
        db.close()
    except Exception:
        pass


if __name__ == "__main__":
    main()
