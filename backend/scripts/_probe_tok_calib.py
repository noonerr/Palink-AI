# -*- coding: utf-8 -*-
"""P95 — 中文感知启发式的系数校准（真实语料 + 真实 deepseek tokenizer 作真值）

背景：当前回退链在无 tokenizer 时用 tiktoken cl100k_base，实测把中文**高估 94.5%**。
本探针在真实语料上拟合一个「中文/非中文分段计数」的启发式，并对比各方案误差。
只读、零付费。
"""
import math
import os
import re
import sys

sys.path.insert(0, "/app")
os.environ.setdefault("DATABASE_URL", "postgresql+psycopg://ai_user:ai_pass@db:5432/ai_hub")

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

_CJK = re.compile(
    r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff"
    r"\u3000-\u303f\uff00-\uffef]"
)


def cjk_split(text):
    n_cjk = len(_CJK.findall(text or ""))
    return n_cjk, len(text or "") - n_cjk


def model_est(text, a, b):
    n_cjk, n_rest = cjk_split(text)
    return int(round(n_cjk * a + n_rest * b))


def guesstimate(text):
    return math.ceil(len((text or "").encode("utf-8")) / 3.35)


def main():
    db = sessionmaker(bind=create_engine(os.environ["DATABASE_URL"]))()
    from app.models.character import CharacterChatMessage
    from app.services.st_tokenizer_service import get_token_count

    rows = (db.query(CharacterChatMessage.content)
            .filter(CharacterChatMessage.content.isnot(None))
            .order_by(CharacterChatMessage.id.desc()).limit(150).all())
    texts = [r[0] for r in rows if r[0] and len(r[0]) > 20]
    print(f"[data] 语料 {len(texts)} 条 / {sum(len(t) for t in texts)} 字")

    real = [get_token_count(t, "deepseek-flash") for t in texts]
    tot_real = sum(real)
    tot_chars = sum(len(t) for t in texts)
    tot_cjk = sum(cjk_split(t)[0] for t in texts)
    print(f"[truth] 真值 = {tot_real} tok；字数={tot_chars}，其中中文={tot_cjk} "
          f"({tot_cjk/tot_chars*100:.0f}%)，非中文={tot_chars-tot_cjk}")

    # 网格搜索最优 (a=中文系数, b=非中文系数)
    best = None
    for ai in range(50, 85, 1):
        for bi in range(15, 45, 1):
            a, b = ai / 100, bi / 100
            est = sum(model_est(t, a, b) for t in texts)
            err = abs(est - tot_real) / tot_real
            if best is None or err < best[0]:
                best = (err, a, b, est)
    err, a, b, est = best
    print(f"\n[fit] 最优系数：中文 {a:.2f} tok/字，非中文 {b:.2f} tok/字  "
          f"⇒ 总量 {est}（误差 {err*100:+.2f}%）")

    # 对比各方案
    print("\n" + "=" * 92)
    print("【各计数方案在真实语料上的误差】真值 = %d tok" % tot_real)
    print("=" * 92)
    cands = [
        ("cl100k_base（当前回退）", None),
        ("ST guesstimate", lambda t: guesstimate(t)),
        ("0.66 × 字数", lambda t: int(len(t) * 0.66)),
        (f"中文感知({a:.2f}/{b:.2f})", lambda t: model_est(t, a, b)),
    ]
    try:
        import tiktoken
        enc = tiktoken.get_encoding("cl100k_base")
        cands[0] = ("cl100k_base（当前回退）", lambda t: len(enc.encode(t)))
    except Exception:
        cands[0] = ("cl100k_base（当前回退）", None)
    print(f"{'方案':<28}{'总量':>10}{'误差':>10}")
    for name, fn in cands:
        if fn is None:
            print(f"{name:<28}{'不可用':>10}{'—':>10}")
            continue
        tot = sum(fn(t) for t in texts)
        print(f"{name:<28}{tot:>10}{(tot-tot_real)/tot_real*100:>9.1f}%")

    # 分段误差（按长度分桶，检查长文本是否漂移）
    print("\n【分桶检查】中文感知启发式在各长度段的表现")
    print(f"{'长度段':<16}{'条数':>6}{'真值':>9}{'估计':>9}{'误差':>9}")
    buckets = [(0, 200), (200, 600), (600, 1500), (1500, 10**9)]
    for lo, hi in buckets:
        sel = [(t, r) for t, r in zip(texts, real) if lo <= len(t) < hi]
        if not sel:
            continue
        tr = sum(r for _, r in sel)
        te = sum(model_est(t, a, b) for t, _ in sel)
        print(f"{f'{lo}-{hi}字':<16}{len(sel):>6}{tr:>9}{te:>9}{(te-tr)/tr*100:>8.1f}%")
    try:
        db.close()
    except Exception:
        pass


if __name__ == "__main__":
    main()


def _holdout():
    """留出验证：前一半拟合、后一半评估，防止过拟合。"""
    import os as _os, sys as _sys
    _sys.path.insert(0, "/app")
    from sqlalchemy import create_engine as _ce
    from sqlalchemy.orm import sessionmaker as _sm
    from app.models.character import CharacterChatMessage as _M
    from app.services.st_tokenizer_service import get_token_count as _gc
    db = _sm(bind=_ce(_os.environ["DATABASE_URL"]))()
    rows = (db.query(_M.content).filter(_M.content.isnot(None))
            .order_by(_M.id.desc()).limit(300).all())
    texts = [r[0] for r in rows if r[0] and len(r[0]) > 20]
    real = [_gc(t, "deepseek-flash") for t in texts]
    half = len(texts) // 2
    fit_t, fit_r = texts[:half], real[:half]
    val_t, val_r = texts[half:], real[half:]
    best = None
    for ai in range(50, 85):
        for bi in range(15, 45):
            a, b = ai / 100, bi / 100
            e = abs(sum(model_est(t, a, b) for t in fit_t) - sum(fit_r)) / sum(fit_r)
            if best is None or e < best[0]:
                best = (e, a, b)
    _, a, b = best
    tr = sum(val_r); te = sum(model_est(t, a, b) for t in val_t)
    print(f"\n[留出验证] 用前 {len(fit_t)} 条拟合 ⇒ 中文 {a:.2f} / 非中文 {b:.2f}")
    print(f"           后 {len(val_t)} 条评估：真值 {tr}，估计 {te}，误差 {(te-tr)/tr*100:+.2f}%")
    print(f"           同批 cl100k 误差：{(sum(len(__import__('tiktoken').get_encoding('cl100k_base').encode(t)) for t in val_t)-tr)/tr*100:+.1f}%")


_holdout()
