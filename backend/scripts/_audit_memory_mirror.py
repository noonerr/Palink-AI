"""[MEM-MIRROR] 记忆镜像一致性审计 + 存量残留清理。

spec: docs/SPEC_重新生成与分支记忆隔离修复_2026-10-05.md §5.1/§5.2

不变式
------
conversation_memories 中 message_id = M.id 的行集合 ≈ clean_memory_content(M 当前
显示内容) 的语义分块集合。偏离即「记忆 ≠ 消息当前内容」。

判定为什么必须清洗后比对（血泪教训，勿简化）
------------------------------------------
记忆存的是 clean_memory_content() 清洗后的文本（剥 <now_plot>/<UpdateVariable>/
思考块/样式标签），而 character_chat_messages.content 是**带标记的原文**。
清洗会删掉块中间的标记 → 直接拿记忆文本去 content 里做子串匹配**必然大面积误报**。
本轮排查曾因此得出「120 条里 118 条不一致」的假结论。
正确判据：对每个候选版本先跑同一套 clean + semantic_split，再比对块集合。
（粗筛可用「块首 20 字符 LIKE」，块首通常不含标记，但权威判据是清洗后比对。）

三种归属
--------
CURRENT  ∈ 当前选中候选的块集合        → 健康
STALE    ∉ 当前，但 ∈ 其它候选的块集合  → 残留（用户已放弃的生成版本），可安全删
UNKNOWN  两者都不属于                   → 历史编辑/改写造成，需人工判定，默认不删

安全
----
默认 --dry-run 只出清单。--apply 才删，且仅删 STALE；UNKNOWN 一律保留。
清理前应先把待删行导出（--export <path>），并遵守 AGENTS.md 备份规范第 5 条。
"""

import argparse
import json
import sys

sys.path.insert(0, "/app")

from sqlalchemy import text

from app.core.database import SessionLocal
from app.utils import clean_memory_content


def _cleaned(raw: str, role: str) -> str:
    """复刻写入侧的清洗（app.utils.clean_memory_content）。

    刻意**不**调用 semantic_split：切分块的语义是「保序，''.join(chunks) ≈ 清洗后
    原文去空白」，即每个块都是清洗后文本的子串。故对清洗后文本做子串匹配即等价，
    且省掉每行每候选一次嵌入调用（Ollama 秒级 → 本脚本原本跑不完）。
    """
    if raw is None:
        return ""
    return (clean_memory_content(raw) if role == "assistant" else raw) or ""


def _candidates(swipes_json, content: str, swipe_id) -> list:
    """返回 [(候选文本, 是否当前选中)]。当前选中由 swipe_id 决定。

    解析口径对齐 character_ext._message_swipes：swipes 列是 JSON 数组；
    缺失/非数组/为空时退化为 [content]（此时唯一候选即当前选中）。
    """
    arr = []
    if swipes_json:
        try:
            parsed = json.loads(swipes_json)
            if isinstance(parsed, list):
                arr = [str(x) for x in parsed if x is not None]
        except Exception:
            arr = []
    if not arr:
        # 无候选数组 → 只有当前正文一版
        return [(content or "", True)]
    try:
        cur = int(swipe_id or 0)
    except (TypeError, ValueError):
        cur = 0
    cur = max(0, min(cur, len(arr) - 1))
    return [(t, i == cur) for i, t in enumerate(arr)]


def audit(db, *, verbose: bool = True):
    """扫描全部带 message_id 的记忆行，输出 (memory_id, message_id, verdict)。"""
    rows = db.execute(text("""
        SELECT m.id, m.message_id, m.content, m.role, m.session_id,
               c.content, c.swipes, c.swipe_id, c.role
        FROM conversation_memories m
        JOIN character_chat_messages c
          ON c.id = m.message_id AND c.session_id = m.session_id
        WHERE m.message_id IS NOT NULL
        ORDER BY m.id
    """)).fetchall()

    per_msg: dict[int, dict] = {}
    for r in rows:
        mid = r[1]
        st = per_msg.setdefault(mid, {"current": set(), "others": set(), "none": set(), "rows": []})
        blk = r[2]
        cands = _candidates(r[6], r[5], r[7])
        cur_role = r[8] or r[3]
        hit = None
        for cand, is_cur in cands:
            cleaned = _cleaned(cand, cur_role)
            if blk and cleaned and blk in cleaned:
                hit = "current" if is_cur else "others"
                break
        if hit is None:
            # 与任何候选都对不上 → 历史编辑/改写造成，不自动删
            st["none"].add(r[0])
        else:
            st[hit].add(r[0])
        st["rows"].append(r)

    results = []
    for mid, st in per_msg.items():
        for r in st["rows"]:
            mid_row = r[0]
            if mid_row in st["current"]:
                verdict = "CURRENT"
            elif mid_row in st["others"]:
                verdict = "STALE"
            else:
                verdict = "UNKNOWN"
            results.append((mid_row, r[1], verdict, r[3], len(r[2] or ""), r[4]))
    if verbose:
        cur = sum(1 for x in results if x[2] == "CURRENT")
        stale = sum(1 for x in results if x[2] == "STALE")
        unk = sum(1 for x in results if x[2] == "UNKNOWN")
        print(f"[AUDIT] 带 message_id 的记忆行: {len(results)}  "
              f"CURRENT={cur}  STALE(残留)={stale}  UNKNOWN(待判定)={unk}")
    return results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", default=True,
                    help="只出清单（默认行为）")
    ap.add_argument("--apply", action="store_true",
                    help="实际删除 STALE 行（需先 --export 备份并取得用户确认）")
    ap.add_argument("--export", help="把待删行导出为 JSON（apply 前必做）")
    args = ap.parse_args()

    db = SessionLocal()
    try:
        results = audit(db)
        stale = [x for x in results if x[2] == "STALE"]
        unknown = [x for x in results if x[2] == "UNKNOWN"]

        if stale:
            print(f"\n--- STALE 残留行 {len(stale)} 条（来自用户已放弃的候选版本）---")
            for x in stale[:50]:
                print(f"  mem_id={x[0]} msg_id={x[1]} role={x[3]} len={x[4]} session={x[5]}")
            if len(stale) > 50:
                print(f"  ... 其余 {len(stale)-50} 条省略")
        if unknown:
            print(f"\n--- UNKNOWN 待人工判定 {len(unknown)} 条（默认不删）---")
            for x in unknown[:20]:
                print(f"  mem_id={x[0]} msg_id={x[1]} role={x[3]} len={x[4]} session={x[5]}")
            if len(unknown) > 20:
                print(f"  ... 其余 {len(unknown)-20} 条省略")

        if not args.apply:
            print("\n[dry-run] 未做任何修改。加 --apply 才会删除 STALE 行。")
            return

        if not stale:
            print("\n[apply] 无 STALE 行，无需清理。")
            return
        if not args.export:
            print("\n[apply] 中止：必须先用 --export <path> 导出待删行作为回滚依据。")
            return

        ids = [x[0] for x in stale]
        payload = db.execute(text(
            "SELECT id, user_id, session_id, branch_id, role, content, message_id, "
            "       character_id, topics, tokens_count, created_at "
            "FROM conversation_memories WHERE id = ANY(:ids)"
        ), {"ids": ids}).mappings().all()
        with open(args.export, "w", encoding="utf-8") as f:
            json.dump([dict(p) for p in payload], f, ensure_ascii=False, indent=2, default=str)
        print(f"[apply] 已导出 {len(payload)} 行 → {args.export}")

        db.execute(text("DELETE FROM conversation_memories WHERE id = ANY(:ids)"), {"ids": ids})
        db.commit()
        print(f"[apply] 已删除 {len(ids)} 条 STALE 行。"
              f"⚠️ 记忆行已删，向量随之消失；如需恢复内容记忆，"
              f"应对对应 message 按当前正文重跑 store_memory。")
    finally:
        db.close()


if __name__ == "__main__":
    main()