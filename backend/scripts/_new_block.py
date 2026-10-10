# ── [WB-INDEP 2026-10-05] 世界书六份产物相互独立 ──────────────────
        # ST getWorldInfoPrompt（script.js:4575）一次返回 worldInfoString /
        # worldInfoBefore / worldInfoAfter / worldInfoExamples / worldInfoDepth /
        # outletEntries 六个**互不依赖**的结果；at-depth 条目走扩展注册表 IN_CHAT
        # （script.js:4612 setExtensionPrompt CUSTOM_WI_DEPTH_ROLE），从不被
        # before/after 正文块是否为空所左右。
        #
        # 此前 depth / em_top / em_bottom / outlet 四段被错放在 `if wb_result.text:`
        # 内侧。正文块一旦被 token 预算裁空（默认 25% 对长书即可能裁空），整本
        # at-depth 指令随之静默丢失——表现为卡片级的格式规范（MVU 变量更新格式、
        # <cg> 立绘标签规范等）压根没进 prompt，模型自然产不出对应标签。
        # 该缺陷与具体卡无关：任何"只靠 at-depth 提供指令"的世界书都会整本失效。
        _wb_has_output = bool(
            wb_result.text
            or wb_result.depth_entries
            or wb_result.em_top_entries
            or wb_result.em_bottom_entries
            or wb_result.outlet_entries
        )
        # 报告与逐条明细不依赖 text：有 depth-only 命中时同样要报出来，
        # 否则用户看到的是误导性的 "no matched entries"。
        by_source: dict[str, list[str]] = {}
        for _meta in (wb_result.book_sources or {}).values():
            by_source.setdefault(_meta.get("source") or "global", []).append(
                _meta.get("name") or "(未命名)",
            )
        detail_parts = [
            f"entries={len([r for r in wb_result.debug_report if r.status == 'activated'])}"
        ]
        for _src in ("chat", "character", "global"):
            if by_source.get(_src):
                detail_parts.append(f"{_src}:{','.join(by_source[_src])}")
        for r in wb_result.debug_report:
            report.append(
                PromptAssemblyReportItem(
                    f"worldbook_entry_{r.entry_id}",
                    r.status,
                    detail=(
                        f"book={r.book_name}; source={r.lore_source}; "
                        f"title={r.title}; reason={r.reason}; keywords={r.matched_keywords}"
                    ),
                    tokens_estimate=r.tokens_estimate,
                )
            )
        if wb_result.text:
            wb_text = wb_result.text
            wb_text = deps.apply_plugin_regex_scripts(
                wb_text,
                req.db,
                placement=REGEX_PLACEMENT_WORLD_INFO,
                is_markdown=False,
                # C4a 修复（批次 C）: ST world-info.js:5086 WI 内容正则 isPrompt:true
                # （promptOnly 脚本作用于 WI 内容；markdownOnly 不作用于 prompt 侧）
                is_prompt=True,
                depth=0,
                skip_extensions=req.char.extensions,
                user_name=user_nickname,
                char_name=char_name or (req.char.name or "Character"),
                # P2-9 修复: 透传 user_id 以读取 extension_settings.regex_scripts
                user_id=req.user.id if req.user else None,
            )
            wb_text = deps.apply_regex_scripts(
                wb_text,
                req.char.extensions,
                placement=REGEX_PLACEMENT_WORLD_INFO,
                is_markdown=False,
                # C4a 修复（批次 C）: 同上，isPrompt=True 对齐 ST
                is_prompt=True,
                depth=0,
                user_name=user_nickname,
                char_name=char_name or (req.char.name or "Character"),
            )
            wb_text = deps.replace_placeholders(wb_text, user_nickname, req.char.name or "")
            dynamic_context_parts.append(wb_text)
            report.append(
                PromptAssemblyReportItem(
                    "worldbook",
                    "included",
                    detail="; ".join(detail_parts),
                    tokens_estimate=wb_result.total_tokens,
                )
            )
        # Collect depth entries from worldbook
        # ST 对齐: 包装为统一队列记录，key 对齐 ST customDepthWI_{depth}_{role}
        # （constants.js L53）；同 key 多条按收集序稳定排列
        for wb_depth, wb_content, wb_role in wb_result.depth_entries:
            depth_entries.append(DepthInjection(
                depth=wb_depth,
                content=balance_custom_tags(
                    deps.replace_placeholders(wb_content, user_nickname, req.char.name or "")
                ),
                role=wb_role if isinstance(wb_role, int) else _ROLE_NAME_TO_INT.get(str(wb_role).lower(), 0),
                source="worldbook_depth",
                sort_key=_KEY_WI_DEPTH_FMT.format(depth=wb_depth, role=wb_role),
                report_on_insert=True,
            ))
        # ST 1.18.0 对齐: 把 EMTop/EMBottom/outlet 条目传递给 MacroEnv
        # 通过 {{mesExamples}} 和 {{outlet::name}} 宏注入到 prompt 中
        # 注意: 这些条目也需要经过 replace_placeholders 处理 {{user}}/{{char}}
        if em_top_entries is not None:
            for content in wb_result.em_top_entries:
                em_top_entries.append(
                    balance_custom_tags(
                        deps.replace_placeholders(content, user_nickname, req.char.name or "")
                    )
                )
        if em_bottom_entries is not None:
            for content in wb_result.em_bottom_entries:
                em_bottom_entries.append(
                    balance_custom_tags(
                        deps.replace_placeholders(content, user_nickname, req.char.name or "")
                    )
                )
        if outlet_entries is not None:
            for outlet_name, contents in wb_result.outlet_entries.items():
                if outlet_name not in outlet_entries:
                    outlet_entries[outlet_name] = []
                for content in contents:
                    outlet_entries[outlet_name].append(
                        balance_custom_tags(
                            deps.replace_placeholders(content, user_nickname, req.char.name or "")
                        )
                    )
        if not _wb_has_output:
            report.append(PromptAssemblyReportItem("worldbook", "skipped", "no matched entries"))