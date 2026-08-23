"""一次性脚本：character_chat_messages 存量思考/正文分离迁移（Step 3）。

背景（2026-08-23，HANDOFF_分离存储实施）：
- Step 2 起写入侧已切换为「content=纯正文 + extra.reasoning=思考」；
- 存量行仍为混合体（content 内联 think 包裹体），本脚本一次性拆分。

用户拍板的谓词（2026-08-23）：
- A 类（双写行）：extra.reasoning 非空 → 以 extra 为权威（插件正则处理过的展示版），
  content 仅剥离 think 包裹体、不回写 extra；
- B 类（单写行）：extra.reasoning 为空 → 拆分 content 内联块，思考写入 extra.reasoning
  （附 reasoning_type=thinking），swipe_info[i].extra.reasoning 同步暂存各备选思考；
- 未闭合/剥离后正文为空的行：保守跳过不动（沿用 _clean_msg_think_blocks.py 先例）；
- swipes 列同步剥离（各备选文本同样混存 think）。

用法（在 backend 容器内执行）：
    docker cp backend/scripts/_migrate_messages_separate_storage.py palink-ai-backend-1:/tmp/
    docker exec -w /app palink-ai-backend-1 python /tmp/_migrate_messages_separate_storage.py           # dry-run
    docker exec -w /app palink-ai-backend-1 python /tmp/_migrate_messages_separate_storage.py --apply   # 落库
"""

import sys
import json
import logging

sys.path.insert(0, "/app")

from sqlalchemy import text

from app.core.database import SessionLocal

try:
    from app.utils import split_inline_think, strip_inline_think_full
except ImportError:
    # 旧镜像内 app.utils 尚无 strip_inline_think_full 时就地内联同语义实现（与 utils.py 保持一致）
    import re as _re

    from app.utils import split_inline_think

    _THINK_STRIP_RE = _re.compile(r"<think[\s\S]*?</think\s*>", _re.IGNORECASE)
    _THINK_OPEN_RE = _re.compile(r"<think(?:\s[^>]*)?>", _re.IGNORECASE)

    def strip_inline_think_full(text):
        if not text:
            return text or ""
        if not _THINK_OPEN_RE.search(text):
            return text
        stripped = _THINK_STRIP_RE.sub("", text)
        leftover = _THINK_OPEN_RE.search(stripped)
        if leftover:
            stripped = stripped[: leftover.start()]
        return stripped.strip()

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("migrate_separate_storage")

THINK_MARKER = "%<think%"


def _parse_json(raw, default):
    if not raw:
        return default
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, (dict, list)) else default
    except (ValueError, TypeError):
        return default


def _has_reasoning(extra: dict) -> bool:
    value = extra.get("reasoning")
    return isinstance(value, str) and bool(value.strip())


def _plan_row(row) -> dict | None:
    """计算单行迁移计划；无需迁移返回 None。"""
    content = row["content"] or ""
    extra = _parse_json(row["extra"], {})
    swipes = _parse_json(row["swipes"], [])
    swipe_info = extra.get("swipe_info") if isinstance(extra.get("swipe_info"), list) else []

    content_has_think = "<think" in content.lower()
    swipes_has_think = any("<think" in (s or "").lower() for s in swipes)
    if not content_has_think and not swipes_has_think:
        return None

    dual = _has_reasoning(extra)
    plan = {
        "id": row["id"],
        "class": "A" if dual else "B",
        "content_before_len": len(content),
        "swipes_affected": 0,
        "reasoning_len": len(extra.get("reasoning") or ""),
        "new_content": content,
        "new_extra": extra,
        "new_swipes": swipes,
        "skip": None,
    }

    if content_has_think:
        if dual:
            new_content = strip_inline_think_full(content)
        else:
            reasoning, partial_body = split_inline_think(content)
            # 首块之外的残留闭合块/未闭合尾一并剥离（split 只摘首块）
            new_content = strip_inline_think_full(partial_body)
            if reasoning:
                plan["reasoning_len"] = len(reasoning)
        if not new_content:
            plan["skip"] = "empty-body-after-strip"
            return plan
        plan["new_content"] = new_content

    if not dual:
        reasoning, _ = split_inline_think(content) if content_has_think else ("", content)
        if reasoning:
            plan["new_extra"]["reasoning"] = reasoning
            plan["new_extra"].setdefault("reasoning_type", "thinking")

    new_swipes = []
    for i, s in enumerate(swipes):
        if s and "<think" in s.lower():
            plan["swipes_affected"] += 1
            if dual:
                new_swipes.append(strip_inline_think_full(s))
            else:
                s_reasoning, s_partial = split_inline_think(s)
                new_swipes.append(strip_inline_think_full(s_partial))
                if s_reasoning and i < len(swipe_info) and isinstance(swipe_info[i], dict):
                    entry_extra = swipe_info[i].get("extra")
                    if not isinstance(entry_extra, dict):
                        entry_extra = {}
                    entry_extra.setdefault("reasoning", s_reasoning)
                    swipe_info[i]["extra"] = entry_extra
        else:
            new_swipes.append(s)
    plan["new_swipes"] = new_swipes
    if swipe_info is not extra.get("swipe_info") and not dual:
        plan["new_extra"]["swipe_info"] = swipe_info
    return plan


def main() -> None:
    apply_mode = "--apply" in sys.argv
    db = SessionLocal()
    try:
        rows = db.execute(
            text(
                "SELECT id, role, content, extra, swipes, swipe_id "
                "FROM character_chat_messages "
                "WHERE (content LIKE :p OR swipes LIKE :p) ORDER BY id"
            ),
            {"p": THINK_MARKER},
        ).mappings().all()
        logger.info("scanned rows with think marker: %d", len(rows))

        plans = []
        for row in rows:
            if (row["role"] or "") != "assistant":
                logger.info("SKIP id=%d (role=%s, not assistant)", row["id"], row["role"])
                continue
            plan = _plan_row(row)
            if plan is None:
                continue
            plans.append(plan)

        class_a = [p for p in plans if p["class"] == "A"]
        class_b = [p for p in plans if p["class"] == "B"]
        skipped = [p for p in plans if p["skip"]]
        logger.info(
            "DRY-RUN PLAN total=%d classA_dual=%d classB_single=%d skipped=%d apply=%s",
            len(plans), len(class_a), len(class_b), len(skipped), apply_mode,
        )
        for p in plans:
            logger.info(
                "PLAN id=%d class=%s content %d -> %d reasoning_len=%s swipes_affected=%d skip=%s",
                p["id"], p["class"], p["content_before_len"], len(p["new_content"]),
                p["reasoning_len"], p["swipes_affected"], p["skip"],
            )

        if not apply_mode:
            logger.info("dry-run only, no changes written (rerun with --apply to persist)")
            return

        applied = 0
        failed = 0
        for p in plans:
            if p["skip"]:
                continue
            try:
                db.execute(
                    text(
                        "UPDATE character_chat_messages "
                        "SET content = :c, extra = :e, swipes = :s WHERE id = :i"
                    ),
                    {
                        "c": p["new_content"],
                        "e": json.dumps(p["new_extra"], ensure_ascii=False),
                        "s": json.dumps(p["new_swipes"], ensure_ascii=False)
                        if p["new_swipes"] else None,
                        "i": p["id"],
                    },
                )
                db.commit()
                applied += 1
            except Exception as exc:
                db.rollback()
                failed += 1
                logger.error("FAILED id=%d: %s", p["id"], exc)

        logger.info(
            "APPLY SUMMARY total_planned=%d applied=%d skipped=%d failed=%d",
            len(plans), applied, len(skipped), failed,
        )
    finally:
        db.close()


if __name__ == "__main__":
    main()
