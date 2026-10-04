"""MVU 世界书条目筛选（2026-10-05，P3-a 第一步）。

## 为什么需要它

`merge_character_book_entries` 只是把一批**正文串**合并进 `character_extensions`，
它拿不到条目对象，因此**筛不了**。筛选必须在调用方做 —— 而调用方原先有三处，
每处都是同一段「遍历 world_books → 取 character_book 类型的 entry content」
的三重推导式，**全部不看 `enabled`**。

后果：用户在角色卡里把某条世界书点成「禁用」，我们却照旧把它喂进
schema 提取与 initvar 提取 —— 用户已经表达了「这条不要」，属明确 bug。

抽成一个函数的好处：规则只有一处、可单独测、后续加白/黑名单正则时也只改这里。

## 本文件只做第一步

第一步（本批）：跳过 `enabled is False`。零配置、零风险。
第二步（后续）：用户级 + 卡级的白/黑名单正则，照「卡影子 > 用户设置 > 默认」
三层模式接（见 `roleplay_prompt_assembly.py` 的 `_get_openai_max_context_override`）。
"""
from __future__ import annotations

from typing import Any, Iterable, List


def select_character_book_contents(world_books: Iterable[Any] | None) -> List[str]:
    """从角色的 world_books 里取出**参与 MVU 提取**的条目正文。

    筛选规则（顺序固定）：
      1. 只要 `type == "character_book"` 的世界书（其余是用户自建/导入的普通世界书，
         不参与 MVU 的 <initvar> 与 schema 提取 —— 与本函数抽取前的行为一致）；
      2. **跳过 `enabled` 显式为 False 的条目**；
      3. 跳过空正文的条目。

    `enabled` 缺省（None）视为**启用** —— `WorldBookStage.enabled` 的列默认值是 True，
    但历史行/手工构造的对象可能没有该属性，此时按启用处理以保持改前行为不变。
    """
    if not world_books:
        return []
    contents: List[str] = []
    for wb in world_books:
        if getattr(wb, "type", "") != "character_book":
            continue
        for stage in (getattr(wb, "entries", None) or []):
            if getattr(stage, "enabled", True) is False:
                continue
            content = getattr(stage, "content", None)
            if content is None:
                continue
            text = str(content)
            if not text:
                continue
            contents.append(text)
    return contents
