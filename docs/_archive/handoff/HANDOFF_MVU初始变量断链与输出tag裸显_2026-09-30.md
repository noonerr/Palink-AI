# HANDOFF：MVU 初始变量断链（过度思考根因）与输出 tag 裸显修复

> 交接日期：2026-09-30。本文自包含，接手 Agent 无需原会话上下文。
> 权威施工 SPEC：`docs/SPEC_MVU初始变量断链与输出tag裸显修复_2026-09-30.md`（含全部取证证据与可复现命令，动工前先读它）。

---

## 给接手 Agent 的任务提示词（可直接使用）

你在 D:\项目\Palink-AI 仓库（分支以 `git status` 实查为准，当前 st-plugin-compat-20260727）施工一个已取证闭环的修复批。动工前先读根目录 `AGENTS.md` 和 `TODOS.md`，并按其惯例登记本任务。

### 背景一句话

用户实机对话发现：模型思考长度达正文 10 倍、回复里裸显 `@bubble:`、`<now_plot>`/`<cg>` 等 tag 和【声音：…】行。已实库取证定位根因，你的任务是按 SPEC §4 完成 T1/T2/T3 三项修复并通过门禁。

### 根因速览（细节与证据见 SPEC）

| 任务 | 根因 | 优先级 |
| --- | --- | --- |
| T1 | `build_initial_stat_data`（backend/app/services/mvu_engine.py:1051）只从 extensions **顶层**取 `first_mes`/`alternate_greetings`/`character_book` 提取 `<initvar>`，而「露缇雅1.2」这类卡（palink_raw_card_data 结构）的 first_mes 在 `palink_raw_card_data.data.first_mes` 嵌套层 → 提取扑空 → 卡 schema 的 zod prefault 占位值（年=1/月=1/魔力=100/饥饿=0/位置=未知）成了会话初始变量 → 注入提示词后与剧情上下文全面矛盾 → 模型思考死循环（实测 10605 reasoning tokens / 93.9s，正文仅 1005 字符），且真实初始值（爱意5/魔力60/饥饿60）永久丢失 | **P0** |
| T2 | 渲染脚本「对话渲染系统 v7.1」只认 `@bubble:角色名\|情绪\|[对白]` 方括号格式，模型偶发输出中文引号格式 → 裸显。先做提示词强化（T2a），前端兜底（T2b）待拍板默认不做 | P1 |
| T3 | 后端提示词（default_prompts.py:55-59）要求模型每条回复末尾输出【声音：描述】给 TTS 提取声线，但前端只在播放语音时剥除（tts.ts:199-210），显示层不剥 → 必然裸显 | P1 |

T1 是根治项：它同时解决「过度思考」和「变量基线错乱」。R4（now_plot/cg 裸显，与正文美化卡渲染排查同源）与 R5（流式瞬态 `<\connect>`，持久数据全链无踪已证）**不立项**，SPEC §4 T4 有说明。

### 施工清单

1. **T1**：`mvu_engine.py` 的 `build_initial_stat_data` 与 `_extract_initvar_from_character_book` 补 `palink_raw_card_data.data.*` 嵌套 fallback；深合并顺序不变（initvar 必须覆盖 prefault）；核对全部调用点（character_message_builder.py:512 的 `apply_mvu_reply_to_session` 行 584 兜底 init、character_ext.py:4370 附近、mvu_engine.py:1107/1125）。**不做存量会话自动迁移**（防 scope 膨胀，SPEC 已明示）。
2. **T2a**：给 @bubble 格式规则加「内容必须方括号 `[...]`，禁止引号包裹」的显式约束。落点二选一：`plugin_scripts` 表「对话渲染系统 v7.1」content 的提示词段（缺点：卡更新会丢）或 Palink 装配链纯增量追加（动装配链需谨慎），评估后选一个并在汇报中说明理由。
3. **T3**：前端显示层加 `/【(?:声音|语音)[：:]\s*[^】]+】/g` 隐藏（与 tts.ts 同源正则；完整闭合才隐藏，流式半截不匹配属正确）。落点在 `Message.tsx:853-864` 附近兜底剥离区或 `formatting.ts` 现有标签隐藏列表，**按现有架构选其一，不要两处都加**。不得影响 `tts.ts` 从原文提取声线的路径。
4. 补测试：T1 加 pytest 用例（嵌套 palink_raw_card_data 结构的 initvar 提取 + 顶层结构回归）；T3 加 vitest 用例。

### 验收（实弹，不是跑通就行）

- 新建会话（露缇雅1.2 卡）生成开场卡 → 首条消息后会话 `chat_metadata.variables.stat_data` 等于 initvar（年=2026/月=7/爱意=5/魔力值=60/饥饿度=60/位置=哥哥的卧室）；首轮 reasoning_tokens 对比基线 10605 显著回落，思考原文不再出现「变量与剧情冲突」调和段。
- 消息 UI 不再显示【声音：…】；点播放语音声线提取仍生效。
- MVU 四入口（对话/regenerate/swipe/continue）+ WS 的「先解析后剥标签」契约不回归；顶层 first_mes 的老结构卡行为不变。

### 门禁

- `cd backend && python -m pytest tests/`（基线约 1566 过 / 42 skip，以实跑为准）
- `cd frontend && npx tsc --noEmit`；`cd frontend && npx vitest run`

### 红线与坑（历史实测，违反代价高）

- MVU 装配链只做纯增量，不做结构性改动（AGENTS.md 红线）。
- 多 agent 合住仓库：git 一律逐项 pathspec 暂存，禁止 `git add -A`/`git add .`；`TODOS.md` 是并行会话共享文件，Edit 冲突就重读再改。
- Mimosa hook 拦一切触碰 `.py` 的备份/copy 操作：同步代码走 `compose build`，容器内探针走 stdin heredoc；Mimosa 对 git commit 报 scanner_no_output 属已知兼容放行。
- 局部导入 + try/except 吞 NameError = 静默失效（如 `_card_has_mvu_scripts` 先例）：T1 改动后必须实弹跑一次完整生成链验证，不许只跑单测。
- 备份一律进 `_BACKUPS/日期_主题/` 且必须带 BACKUP_INFO.md（AGENTS.md 备份规范，违反视为事故）。
- `frontend/dist`、`backend/data`、根目录用户私人素材一律不动。

### 汇报要求

完成后用大白话汇报：改了哪些文件、每项任务验收结果（带实测数字，如新会话首轮 reasoning_tokens）、门禁结果、T2a 落点选择的理由、以及你发现的任何与 SPEC 结论不符之处（如实报，勿强行圆）。
