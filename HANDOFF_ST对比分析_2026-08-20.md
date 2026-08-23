# HANDOFF — ST 1.18.0 对比分析（2026-08-20）

> 交接人：主 agent（手读分析）
> 交接日期：2026-08-20
> 接手者：后续任何 agent（Claude Code / Codex / TRAE / 其他）

## 1. 本次会话完成了什么

**任务**：用户要求主 agent 亲自逐文件阅读，细致对比 Palink-AI 与 SillyTavern 1.18.0 的全部差异（注入、上下文、插件、世界书、宏、斜杠命令、变量、正则等），输出中文对比报告。

**交付物**：`PALINK_VS_SILLYTAVERN_COMPARISON.md`（项目根目录，212+ 行）
- `## 0. 快速图版`：装配流程一图流（ST vs Palink 最终消息结构 + 3 个关键差异）
- `## 1-9`：装配顺序 / 扩展提示词注入 / 世界书 / AN / 宏 / 斜杠命令 / 变量 / 正则 / 插件体系逐项对比
- `## 10`：缺失项清单（10 项）
- `## 11`：后续建议（6 条，含优先级）

## 2. 关键结论（接手者必读）

1. **已对齐**：世界书 8 位置注入、预算、排序策略、定时效果、min_activations；宏求值 4 步（含 pick 确定性种子）；AN 位置/深度/默认值；persona 注入 4 位置
2. **核心差异（对 AI 影响最大）**：ST 用**一条统一注入管线**（depth → injection_order 降序 → role 排序 → reverse），Palink 用**多条并行队列**（depth_entries / ext_depth_entries / AN parts / 世界书 8 位置）手动合并——最终顺序对齐时效果等价，但 Palink 同 depth 时 AN/persona/世界书/插件的先后**无明确 order 语义**，存在顺序漂移风险
3. **缺失**：nsfw/jailbreak 槽位、overridden/control 提示词、chara note 三态、`{{time}}` 时区（Palink 用 UTC，ST 用本地）、变量 `as` 转换与 index 语法。**更正**：`{{banned}}`/`{{reverse}}`/`{{roll}}` 宏经核对均已实现（`macro_service.py` L570/705/673），不属缺失项
4. **用户已确认的决策**：st-compat 已封存（AGENTS.md），`skip_dynamic_context` 去重逻辑保持冻结；对比以 palink-native 为主

## 3. 后续建议（优先级排序，来自报告 §11）

1. 仅补 `{{time}}` 本地时区（低成本高兼容）；`{{banned}}`/`{{reverse}}`/`{{roll}}` 已确认实现，无需补
2. 补 chara note 三态（数据模型已具备 chat_metadata）
3. **为 depth 队列补 ST 一致的顺序权重**（depth 主键 + 同 depth 按 order 语义排序）——对模型效果影响最直接
4. 核对 `setExtensionPrompt` 沙箱签名与 ST 七参一致性（运行时测试）
5. 补齐未覆盖对比：`memory_module/`、`worldbook_vector_service.py`、前端 regex 引擎、`sillyTavernPluginRuntime.ts`、`st-plugins/`、`backend/app/api/plugins.py`
6. st-compat 保持冻结

## 4. 未完成 / 待续对比项（本次未覆盖）

- ST `chat.js`（消息截断/上下文深度计算）、`textgen.js`（text completion 装配）
- ST `openai.js` 前部 ChatCompletion/MessageCollection 类
- ST `slash-commands/` 全量命令清单 vs Palink 26 个
- Palink 记忆模块 vs ST vectors 链路
- Palink 前端 regex / 插件 runtime 逐项钩子核对

## 5. 关键代码位置（供接手者引用）

| 主题 | ST | Palink |
|---|---|---|
| 装配入口 | `openai.js` populateChatCompletion L1204-1338 | `roleplay_prompt_assembly.py` `_assemble_roleplay_prompt_impl` L2936+ |
| 深度注入 | `openai.js` populationInjectionPrompts L801-875 | 装配内 depth_entries/ext_depth_entries（L3273-3450） |
| 世界书 | `world-info.js` checkWorldInfo L4597-5163 | `worldbook_service.py` build_worldbook_context L1358-1607 |
| AN | `authors-note.js`（metadata_keys L30-36, interval L360-392） | 装配 AN 解析 L3025-3102 / 注入 L3157-3182 |
| 宏 | `macros.js` evaluateMacros L610-715 | `macro_service.py` evaluate_macros L776-863 |
| 插件注册 | `script.js` setExtensionPrompt L8866 | `plugin-system/sandbox.ts` 沙箱全局 L2715+ |

## 6. 环境提示

- ST 源码位于项目文件夹内：`SillyTavern-1.18.0/SillyTavern-1.18.0/public/scripts/`
- backend 曾内存飙升卡死（1.975GiB），分析/调试时避免触发（详见 `HANDOFF_Ollama部署与无限加载排查_2026-08-19.md`）
- 本任务为只读分析，未修改任何业务代码