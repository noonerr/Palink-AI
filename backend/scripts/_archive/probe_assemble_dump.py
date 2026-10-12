"""T1 零成本筛查探针：导出"下一次真正会发给模型的完整装配提示词"（不产生任何模型调用）。

承接 docs/SPEC_MVU提示词依从性零成本筛查_2026-09-28.md §1.1：
把 assemble_roleplay_prompt 的 res.messages 按 [i] role=… 原样落盘（JSON + 可读 txt 两份），
供提示词变体构造与子模型扮演筛查使用。只读装配、不写库、不改任何生产代码。

用法（容器内，workdir=/app）：python scripts/probe_assemble_dump.py
落盘：/app/data/mvu_screen/prompt_dump.json + prompt_dump.txt（backend/data 已挂载宿主）。
可选环境变量：MVU_CHAR_ID / MVU_SESSION_ID（缺省沿用取证用卡与会话）。
"""
import asyncio
import datetime
import json
import os
import sys

sys.path.insert(0, "/app")

from app.database import SessionLocal  # noqa
from app.models import Character, CharacterChatSession, User  # noqa
from app.api.character_ext import (  # noqa
    _build_char_system_prompt,
    _replace_placeholders,
    _get_full_branch_history,
    _contains_chinese,
    _apply_plugin_regex_scripts,
    _apply_regex_scripts,
    _apply_prompt_regex_to_messages,
)
from app.services.roleplay_prompt_assembly import (  # noqa
    PromptAssemblyRequest,
    PromptAssemblyDeps,
    assemble_roleplay_prompt,
)

CHAR_ID = os.environ.get("MVU_CHAR_ID", "7b064410-4fd8-4182-a720-840d3a3fe0e9")
SESSION_ID = os.environ.get("MVU_SESSION_ID", "2cb171bf-ed64-487c-8c70-1f9d9395bbaa")

OUT_DIR = "/app/data/mvu_screen"


async def main():
    db = SessionLocal()
    try:
        char = db.query(Character).filter(Character.id == CHAR_ID).first()
        sess = db.query(CharacterChatSession).filter(CharacterChatSession.id == SESSION_ID).first()
        if char is None or sess is None:
            print(f"FAIL: char={char is not None} session={sess is not None}")
            sys.exit(1)
        user = db.query(User).filter(User.id == sess.user_id).first()
        req = PromptAssemblyRequest(
            db=db, user=user, char=char, session_id=SESSION_ID, branch_id="",
            message="开始", images=[], model="deepseek-v4-flash",
            include_prompt_regex=True,
            user_nickname=user.username or "用户",
            response_length=None, max_tokens=2048,
        )
        deps = PromptAssemblyDeps(
            build_system_prompt=_build_char_system_prompt,
            replace_placeholders=_replace_placeholders,
            get_full_branch_history=_get_full_branch_history,
            get_ancestor_branch_ids=lambda *a, **k: [],
            contains_chinese=_contains_chinese,
            apply_plugin_regex_scripts=_apply_plugin_regex_scripts,
            apply_regex_scripts=_apply_regex_scripts,
            apply_prompt_regex_to_messages=_apply_prompt_regex_to_messages,
        )
        res = await assemble_roleplay_prompt(req, deps)

        os.makedirs(OUT_DIR, exist_ok=True)
        msgs = []
        for i, m in enumerate(res.messages):
            c = m.get("content")
            if not isinstance(c, str):
                c = json.dumps(c, ensure_ascii=False)
            msgs.append({"index": i, "role": m.get("role"), "content": c})

        payload = {
            "char_id": CHAR_ID,
            "session_id": SESSION_ID,
            "generated_at": datetime.datetime.now().isoformat(timespec="seconds"),
            "message_count": len(msgs),
            "total_chars": sum(len(m["content"]) for m in msgs),
            "messages": msgs,
        }
        json_path = os.path.join(OUT_DIR, "prompt_dump.json")
        with open(json_path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)

        txt_path = os.path.join(OUT_DIR, "prompt_dump.txt")
        with open(txt_path, "w", encoding="utf-8") as fh:
            for m in msgs:
                fh.write(f"[{m['index']}] role={m['role']}\n")
                fh.write(m["content"])
                fh.write("\n\n")

        print(f"OK messages={len(msgs)} total_chars={payload['total_chars']}")
        for m in msgs:
            head = m["content"].strip().replace("\n", " ")[:80]
            print(f"[{m['index']}] {m['role']} | len={len(m['content'])} | head={head!r}")
        print(f"dumped: {json_path} + {txt_path}")

        print("\n### report")
        for item in getattr(res, "report", []) or []:
            print(f"    {item.key} | {item.status} | {item.detail} | tokens~{item.tokens_estimate}")
    finally:
        db.close()


asyncio.run(main())
