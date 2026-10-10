# HANDOFF — ST 兼容性查验交接（2026-08-23）

> 面向下一个 agent / 会话。请先读根目录 `AGENTS.md` 与 `TODOS.md`，再读本文。
> 本文只描述「已完成什么、查到了什么、下一步建议做什么」，不含代码改动（本次为纯只读排查）。

---

## 一、本次完成了什么

对项目做了一轮 **SillyTavern 1.18.0 兼容性全面排查（只读，零代码修改）**，覆盖：插件系统、角色卡、正则、世界书、提示词注入/宏、回复渲染、数据存储、变量面板(MVU)、副 AI。

**交付物（唯一权威结论文件）**：
- `docs/SILLYTAVERN_COMPAT_SPEC_2026-08-23.md` —— 各模块兼容度评级、P0~P3 分级差异点、【文件:行号】级证据索引、过时文档结论修正清单（§13）。

**总体判断**：无 P0。核心链路端到端可跑通；9 个 P1、约 20 个 P2。宏系统与后端正则引擎是对齐质量最高的两层。

## 二、9 个 P1（下一步修复的候选池，已按建议排序）

| # | 模块 | 问题 | 位置 |
|---|------|------|------|
| 1 | 世界书 | delay 条目永久沉默死锁（can_activate 拦截 → 永远到不了 record_activation） | `backend/app/services/worldbook_service.py:191-195` |
| 2 | 正则 | 前端显示管线漏 ST 三分支判定 → 普通脚本最多三重叠加（后端 persist + 前端渲染 + 前端下降沿回写） | `frontend/src/lib/regex-pipeline/pipeline.ts:248-249` + `CharacterChat.tsx:1510-1519` + `websocket.py:627` |
| 3 | 正则 | 智能卡运行时 `$N` 双反斜杠正则损坏（`\\$(\\d+)`） | `SillyTavernCompatRuntime.ts:2296` |
| 4 | 渲染 | LaTeX 流式可渲染、完成态塌回原文（formatting.ts 无 katex） | `MarkdownRenderer.tsx:28-29` vs `formatting.ts` |
| 5 | 世界书 | `/api/worldbooks/import` 只映射 8 项，order/sticky/cooldown/delay/selectiveLogic 等十余字段静默丢失 | `backend/app/api/worldbook.py:366-385` |
| 6 | 插件 | 经典轨 getContext 成员缩水（解构 eventSource 等得 undefined） | `sillyTavernPluginRuntime.ts:649-662` |
| 7 | 插件 | 沙箱内 triggerSlash/setChatMessages 等 stub，而经典轨有真桥接（能力倒挂） | `sandbox.ts:3504-3622` |
| 8 | 插件 | writeExtensionField 三轨三义（ST 语义=写角色卡 extensions） | `getContext.ts:1690` / `sandbox.ts:3243` / `sandbox.ts:4465` |
| 9 | 世界书 | 前端 scanner 把 selectiveLogic 错位作用于 primary keys（限前端插件层） | `frontend/src/lib/worldbook/scanner.ts:177-209` |

P2 批次全文见 spec §11 表格之后段落（prevent_recursion 误跳、useProbability 缺失、WI 全局设置未接线、预算基数 16000、vectorized 孤岛、mes_example 不拆块、jailbreak 不消费等）。

## 三、给下一个 agent 的注意事项

1. **勿照抄旧报告结论**，以下已证伪/过时（spec §13 有完整清单）：
   - `st_roleplay_alignment_report.md §2.6` 的"position 枚举偏移"——被仓库内 `frontend/public/st/scripts/world-info.js:855-864` 证伪，两侧枚举一致；
   - "{{banned}}/{{reverse}}/{{roll}} 缺失"——三者均已实现（macro_service.py L570/705/673）；
   - "renderExtensionTemplateAsync 缺失"——已在 sandbox.ts:96-115 完整实现。
2. **模式立场不变**：主攻 palink-native；st-compat/st-native 封存不动。但注意 st-compat 分支里的示例拆块（character_message_builder.py:758-793）、jailbreak 合并链恰是 palink-native 补 P2 时可参照的实现。
3. **分离存储交叉**：「思考/正文分离存储」另一 agent 进行中（Step 1 访问器已落地）。若它改变 content 列形态，正则 persist 层与渲染层 think 剥离消费点需同步复核；动工前先看 `.trae/specs/separate-reasoning-pipeline/tasks.md` 与 `HANDOFF_分离存储实施_2026-08-22.md`。
4. **验证命令**：后端 `cd backend && python -m pytest tests/`（当前基线约 871 过/4 存量失败）；前端 `cd frontend && npx tsc --noEmit`（已知存量类型错误清单见 `.trae/rules/project_rules.md`）。
5. 改世界书 delay（#1）时顺带评估 exclude_recursion RECURSION 轮跳过（spec D-5/b-5，P3）；改正则前端管线（#2）时建议一并处理空 placement 反义、深度豁免、trimStrings 宏三个 P2（同文件打包）。
6. 修完任一项请按惯例更新 `TODOS.md` 并备份改动文件至 `_backup/`。

## 四、证据速查

全部【文件:行号】证据集中在 spec 文末「附：证据索引」，含 ST 参照源码位置（`.codex/st-source/*` 与 `frontend/public/st/scripts/*.js`）。
