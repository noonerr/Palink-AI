"""T3 只读探针：定位 MVU「当前变量状态」块的构成与 2899 字符差的来源。

背景（docs/SPEC_注入落点对齐ST_depth下限与漏删清理_2026-09-28.md §7 / 复核报告附录 A.6）：
同一张卡、同一会话，只改装配尾部结构，变量块长度从 12260 变成 15159（差 2899）。
已排除：token 预算裁剪、角色卡 scoped 正则深度窗、插件正则深度窗。
本探针只读取装配结果并做统计/溯源，不写库、不改任何生产代码。

用法（容器内）：docker cp 进 /app 后 `python probe_mvu_block_origin.py`。
"""
import asyncio
import json
import os
import re
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

CHAR_ID = "7b064410-4fd8-4182-a720-840d3a3fe0e9"
SESSION_ID = "2cb171bf-ed64-487c-8c70-1f9d9395bbaa"

def _adapt_legacy_build_system_prompt(*args, **kwargs):
    """兼容旧版本装配（1126b88）的 5 参调用：(char, nickname, dialogue_mode, lang, setting)。

    dialogue_mode 已整链删除（814e562），当前 ``_build_char_system_prompt`` 只收 4 参。
    仅当容器里临时换成旧版装配文件时才会命中这条分支——用于 A/B 复现实验。
    """
    if len(args) >= 5:
        args = (args[0], args[1], args[3], args[4])
    return _build_char_system_prompt(*args, **kwargs)


MARKERS = [
    "【当前变量状态】",
    "<UpdateVariable>",
    "</UpdateVariable>",
    "${new_value}",
    "positive_or_negative_delta",
    "【变量更新指令",
]


def _count(text, needle):
    return text.count(needle)


async def main():
    # ── 只读探针式插桩：包一层 build_worldbook_context，抓取世界书 depth_entries
    # 在进入 balance_custom_tags / 合并成块之前的原始长度（不改任何生产代码）。
    import app.services.roleplay_prompt_assembly as _rpa

    _orig_build_wb = getattr(_rpa, "build_worldbook_context", None)
    if _orig_build_wb is not None and os.environ.get("MVU_SPY_WB") == "1":

        def _spy_build_wb(*args, **kwargs):
            res = _orig_build_wb(*args, **kwargs)
            print("\n### 0. [SPY] build_worldbook_context depth_entries 原始长度")
            for _i, _e in enumerate(getattr(res, "depth_entries", []) or []):
                try:
                    _d, _c, _r = _e
                except (TypeError, ValueError):
                    _d, _c, _r = ("?", str(_e), "?")
                print(
                    f"    depth_entry[{_i}] depth={_d} role={_r} len={len(_c)} "
                    f"positive_or_negative_delta={_c.count('positive_or_negative_delta')} "
                    f"head={_c.strip()[:60]!r}"
                )
            print(f"    [SPY] wb_result.text len={len(getattr(res, 'text', '') or '')}")
            return res

        _rpa.build_worldbook_context = _spy_build_wb

    if os.environ.get("MVU_SPY_STAGES") == "1":
        # 阶段 1：depth 注入合并刚完成时
        _orig_ins = getattr(_rpa, "_insert_depth_prompt", None)
        if _orig_ins is not None:

            def _spy_ins(messages, req, deps, entries, report, *a, **kw):
                out = _orig_ins(messages, req, deps, entries, report, *a, **kw)
                if os.environ.get("MVU_WATCH") == "1":
                    # 给变量块那条消息套一个会打调用栈的 dict 子类，抓"谁改了它"
                    import traceback as _tb

                    class _Watched(dict):
                        def __setitem__(self, _k, _v):
                            if _k == "content":
                                print("\n### W [SPY] 变量块 content 被就地改写:")
                                _tb.print_stack()
                            super().__setitem__(_k, _v)

                    for _i, _m in enumerate(out):
                        _c = _m.get("content") or ""
                        if "positive_or_negative_delta" in _c:
                            out[_i] = _Watched(_m)
                print("\n### S1 [SPY] _insert_depth_prompt 之后:")
                for _i, _m in enumerate(out):
                    _c = _m.get("content") or ""
                    print(f"    [{_i}] {_m.get('role')} | len={len(_c)} | "
                          f"delta={_c.count('positive_or_negative_delta')}")
                return out

            _rpa._insert_depth_prompt = _spy_ins

        # 阶段 2：宏展开之后
        _orig_em = getattr(_rpa, "evaluate_macros_in_messages", None)
        if _orig_em is not None:

            def _spy_em(messages, env):
                print("\n### S2-in [SPY] evaluate_macros_in_messages 入参:")
                for _i, _m in enumerate(messages):
                    _c = _m.get("content") or ""
                    print(f"    [{_i}] {_m.get('role')} | len={len(_c)} | "
                          f"delta={_c.count('positive_or_negative_delta')}")
                out = _orig_em(messages, env)
                print("\n### S2 [SPY] evaluate_macros_in_messages 之后:")
                for _i, _m in enumerate(out):
                    _c = _m.get("content") or ""
                    print(f"    [{_i}] {_m.get('role')} | len={len(_c)} | "
                          f"delta={_c.count('positive_or_negative_delta')}")
                return out

            _rpa.evaluate_macros_in_messages = _spy_em

    db = SessionLocal()
    try:
        char = db.query(Character).filter(Character.id == CHAR_ID).first()
        sess = db.query(CharacterChatSession).filter(CharacterChatSession.id == SESSION_ID).first()
        user = db.query(User).filter(User.id == sess.user_id).first()
        req = PromptAssemblyRequest(
            db=db, user=user, char=char, session_id=SESSION_ID, branch_id="",
            message="开始", images=[], model="deepseek-v4-flash",
            # MVU_NO_PROMPT_REGEX=1 → 关掉消息级正则（验证 [不发送]去除变量更新 的 depth 窗）
            include_prompt_regex=(os.environ.get("MVU_NO_PROMPT_REGEX") != "1"),
            user_nickname=user.username or "用户",
            response_length=None, max_tokens=2048,
        )
        deps = PromptAssemblyDeps(
            build_system_prompt=_adapt_legacy_build_system_prompt,
            replace_placeholders=_replace_placeholders,
            get_full_branch_history=_get_full_branch_history,
            get_ancestor_branch_ids=lambda *a, **k: [],
            contains_chinese=_contains_chinese,
            apply_plugin_regex_scripts=_apply_plugin_regex_scripts,
            apply_regex_scripts=_apply_regex_scripts,
            apply_prompt_regex_to_messages=_apply_prompt_regex_to_messages,
        )
        res = await assemble_roleplay_prompt(req, deps)

        _block_text_for_probe = ""
        print("### 1. 消息总览 (idx | role | len | 是否含【当前变量状态】)")
        for i, m in enumerate(res.messages):
            c = m.get("content")
            c = c if isinstance(c, str) else json.dumps(c, ensure_ascii=False)
            print(f"[{i}] {m.get('role')} | {len(c)} | {'YES' if '【当前变量状态】' in c else '-'}")

        print("\n### 2. 变量块内各标记出现次数")
        for i, m in enumerate(res.messages):
            c = m.get("content")
            if not isinstance(c, str) or "【当前变量状态】" not in c:
                continue
            print(f"[block at {i}] len={len(c)}")
            _block_text_for_probe = c
            for mk in MARKERS:
                print(f"    {mk!r}: {_count(c, mk)}")
            _dump_path = os.environ.get("MVU_DUMP_PATH")
            if _dump_path:
                with open(_dump_path, "w", encoding="utf-8") as fh:
                    fh.write(c)
                print(f"    (block dumped to {_dump_path})")

            print("\n### 3. 变量块中 <UpdateVariable> 首次出现的上下文（前后 400 字符）")
            pos = c.find("<UpdateVariable>")
            if pos >= 0:
                print(repr(c[max(0, pos - 400):pos + 400]))

            print("\n### 4. 变量块尾部 600 字符（看模板是否挂在末尾）")
            print(repr(c[-600:]))

            print("\n### 5. 变量块去掉所有 <UpdateVariable>...</UpdateVariable> 后的长度")
            stripped = re.sub(r"<UpdateVariable>[\s\S]*?</UpdateVariable>", "", c, flags=re.I)
            print(f"stripped_len={len(stripped)}  (原 {len(c)}，差 {len(c) - len(stripped)})")

        print("\n### 6. 装配 report（各来源是否被 include / 体量）")
        for item in getattr(res, "report", []) or []:
            print(f"    {item.key} | {item.status} | {item.detail} | tokens~{item.tokens_estimate}")

        print("\n### 8. 世界书条目溯源：哪些条目的正文真的进了变量块")
        from sqlalchemy import text as _sa_text
        _rows = db.execute(
            _sa_text("SELECT id, raw_content FROM world_books WHERE character_id = :cid"),
            {"cid": CHAR_ID},
        ).fetchall()
        for _wb_id, _raw in _rows:
            try:
                _book = json.loads(_raw)
            except (json.JSONDecodeError, TypeError):
                continue
            _entries = _book.get("entries") if isinstance(_book, dict) else None
            if not isinstance(_entries, list):
                continue
            print(f"    world_book {_wb_id} entries={len(_entries)}")
            for _e in _entries:
                if not isinstance(_e, dict):
                    continue
                _c = _e.get("content") or ""
                _title = _e.get("comment") or _e.get("name") or _e.get("title") or ""
                _eid = _e.get("id") or _e.get("uid") or ""
                # 取正文前 120 字符做锚点，判断它是否出现在变量块里
                _anchor = _c.strip()[:120]
                _in_block = bool(_anchor) and (_anchor in _block_text_for_probe)
                _flag = ""
                if "positive_or_negative_delta" in _c:
                    _flag = "  <<< 含 UpdateVariable JSONPatch 模板"
                print(
                    f"    [{_eid}] {_title!r} len={len(_c)} pos={_e.get('position')} "
                    f"depth={_e.get('depth')} order={_e.get('order')} enabled={_e.get('enabled')} "
                    f"in_block={_in_block}{_flag}"
                )

        print("\n### 7. 卡 extensions.depth_prompt / regex_scripts 概览")
        try:
            ext = json.loads(char.extensions) if isinstance(char.extensions, str) else (char.extensions or {})
        except (json.JSONDecodeError, TypeError):
            ext = {}
        print(f"    extensions keys: {sorted(ext.keys()) if isinstance(ext, dict) else type(ext)}")
        rs = ext.get("regex_scripts") if isinstance(ext, dict) else None
        if isinstance(rs, list):
            for k, s in enumerate(rs):
                name = s.get("scriptName") or s.get("name") or ""
                rs_text = s.get("replaceString") or ""
                hit = "HAS_MVU_TEMPLATE" if "positive_or_negative_delta" in rs_text else "-"
                print(f"    regex_scripts[{k}] {name!r} enabled={s.get('disabled') is not True} "
                      f"place={s.get('placement')} minD={s.get('min_depth')} maxD={s.get('max_depth')} "
                      f"len(rs)={len(rs_text)} depth={s.get('depth')} {hit}")
    finally:
        db.close()


asyncio.run(main())
