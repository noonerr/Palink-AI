"""从已导入角色的 palink_raw_card_data 回填世界书关键词与启用状态。

背景: 角色卡内嵌世界书（character_book）导入时，ST 导出格式字段
（keys / secondary_keys / enabled）被按旧内部格式（key / keysecondary / disable）
读取，导致关键词全部丢失、禁用条目被错误启用（见 docs/st-prompt-alignment-fix-spec.md P2）。

本脚本遍历 characters.extensions.palink_raw_card_data（或 extensions.character_book），
按 comment 匹配同名 world_book_stages，回填 keys / secondary_keys / enabled。

幂等: 重复运行安全；只更新匹配到的条目，输出变更统计。

运行: docker exec -w /app palink-ai-backend-1 python -m scripts.backfill_worldbook_from_raw_card
"""
from __future__ import annotations

import json
import sys

sys.path.insert(0, "/app")

from app.core.database import SessionLocal  # noqa: E402
from app.models.character import Character  # noqa: E402
from app.models.worldbook import WorldBook, WorldBookStage  # noqa: E402
from app.services.worldbook_import_utils import (  # noqa: E402
    entry_is_disabled,
    entry_keys,
    entry_secondary_keys,
)


def _parse_extensions(character: Character) -> dict:
    if not character.extensions:
        return {}
    try:
        ext = json.loads(character.extensions) if isinstance(character.extensions, str) else character.extensions
        return ext if isinstance(ext, dict) else {}
    except (json.JSONDecodeError, TypeError):
        return {}


def _extract_character_book(character: Character) -> dict | None:
    ext = _parse_extensions(character)
    raw = ext.get("palink_raw_card_data")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            raw = None
    if isinstance(raw, dict):
        data = raw.get("data", raw)
        if isinstance(data, dict):
            cb = data.get("character_book")
            if isinstance(cb, str):
                try:
                    cb = json.loads(cb)
                except (json.JSONDecodeError, TypeError):
                    cb = None
            if isinstance(cb, dict):
                return cb
    cb = ext.get("character_book")
    if isinstance(cb, str):
        try:
            cb = json.loads(cb)
        except (json.JSONDecodeError, TypeError):
            cb = None
    return cb if isinstance(cb, dict) else None


def _entries_list(character_book: dict) -> list[dict]:
    entries = character_book.get("entries", {})
    if isinstance(entries, dict):
        entries = list(entries.values())
    return [e for e in entries if isinstance(e, dict)]


def main() -> None:
    db = SessionLocal()
    updated_keys = 0
    updated_enabled = 0
    matched = 0
    total_chars = 0
    try:
        characters = db.query(Character).all()
        for character in characters:
            character_book = _extract_character_book(character)
            if not character_book:
                continue
            total_chars += 1

            world_books = (
                db.query(WorldBook)
                .filter(WorldBook.character_id == str(character.id))
                .all()
            )
            stage_by_title: dict[str, WorldBookStage] = {}
            for wb in world_books:
                stages = db.query(WorldBookStage).filter(WorldBookStage.world_book_id == wb.id).all()
                for stage in stages:
                    key = (stage.title or "").strip()
                    if key:
                        stage_by_title.setdefault(key, stage)

            for entry in _entries_list(character_book):
                comment = str(entry.get("comment") or "").strip()
                if not comment:
                    continue
                stage = stage_by_title.get(comment)
                if stage is None:
                    continue
                matched += 1

                raw_keys = json.dumps(entry_keys(entry), ensure_ascii=False)
                raw_secondary = json.dumps(entry_secondary_keys(entry), ensure_ascii=False)
                target_enabled = not entry_is_disabled(entry)

                if stage.keys != raw_keys:
                    stage.keys = raw_keys
                    updated_keys += 1
                if stage.secondary_keys != raw_secondary:
                    stage.secondary_keys = raw_secondary
                    updated_keys += 1
                if bool(stage.enabled) != target_enabled:
                    stage.enabled = target_enabled
                    updated_enabled += 1

        db.commit()
    finally:
        db.close()

    print(f"characters_with_character_book={total_chars}")
    print(f"matched_stages={matched}")
    print(f"keys_or_secondary_updated={updated_keys}")
    print(f"enabled_updated={updated_enabled}")
    print("done")


if __name__ == "__main__":
    main()
