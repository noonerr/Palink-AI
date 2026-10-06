# docs/ 文档总目录（机器可读 · 自动生成）

> ⛔ **本文件由 `scripts/docs/gen_docs_catalog.py` 生成，不要手工编辑。**
> 手工改的内容会在下次生成时被覆盖。要改内容请改生成器，或改它指向的 `_INDEX.md` / `OPEN_ISSUES.md`。
>
> 重新生成：`python scripts/docs/gen_docs_catalog.py`　｜　校验是否过期：`--check`
>
> **生成时间：2026-10-06 12:10**　｜　扫描到 **225** 份 markdown

---

## 这份文件能回答什么、不能回答什么

| 问题 | 本文件 |
|---|---|
| 有没有这份文件 | ✅ 能（第一、三节全量列出） |
| 它在哪个目录 | ✅ 能 |
| 它是 SPEC 还是 REPORT | ✅ 能（按开头前缀） |
| 它首部有没有写状态 | ⚠️ 只反映**文字出现过**，不保证是当前状态 |
| 它能不能照做 | ❌ **不能**，必须打开读首部 |
| 它可不可信 | ❌ **不能**，看 [`_INDEX.md`](./_INDEX.md) 的可信度分级 |

找不到想找的文件时，先直接搜：

```bash
find docs -name "*关键词*.md"        # 跨所有子目录
```

---

## 一、按前缀统计

| 前缀 | 顶层 | 全仓 | 含义 |
|---|---|---|---|
| `SPEC_` | 34 | 38 | 施工规格书 —— 动手前读 |
| `REPORT_` | 17 | 24 | 排查/审计结论 |
| `DIAG_` | 0 | 1 | 诊断报告 |
| `PROMPT_` | 7 | 9 | 交给 agent 的提示词 |
| `HANDOFF_` | 2 | 4 | 交接书 |
| `PLAN_` | 3 | 3 | 执行计划 |
| `ANALYSIS` | 3 | 3 | 分析报告 |
| `AUDIT` | 4 | 4 | 审计报告 |
| `OPEN_` | 2 | 2 | 长期台账 |
| `GALGAME` | 1 | 1 | 主题规格 |
| `PALINK_` | 5 | 5 | 项目级规格 |
| `QUICK_FIX` | 0 | 1 | 快速修复 |
| `SOP_` | 1 | 1 | 标准作业流程 |
| 其他（中文名/无前缀） | 46 | 129 | 混合，逐份读首部 |

> 顶级数 = `docs/` 顶层；全仓数 = 含 `_archive/` `_reference/` 等全部子目录。

## 二、首部状态标记覆盖情况

- 有标记：**52 / 225**
- 无标记：**173** —— ⚠️ 这不代表有效，只代表首部没写状态

⚠️ **文件名日期与内容日期不同月的有 7 份**（下表 ⚠️ 列标出）。归档按**内容**日期，不信文件名：

| 文件 | 文件名日期 | 内容首现日期 |
|---|---|---|
| `ST_COMPAT_FORK_AUDIT_2026-08-17.md` | 2026-08 | 2026-09-01 |
| `SPEC_palink-new合并回主区_2026-10-03.md` | 2026-10 | 2026-09-01 |
| `PLAN_ST兼容修复批次_2026-08-28.md` | 2026-08 | 2026-09-01 |
| `PROMPT_报错提示模板落地_2026-10-03.md` | 2026-10 | 2026-09-01 |
| `SPEC_ST_P2剩余六项_2026-08-26.md` | 2026-08 | 2026-09-01 |
| `SPEC_架构审查修复_2026-10-03.md` | 2026-10 | 2026-09-01 |
| `架构审查与缺陷总表_2026-10-03.md` | 2026-10 | 2026-09-01 |

## 三、按目录（四层结构）

| 层 | 目录 | 份数 | 说明 |
|---|---|---|---|
| 1 活 | `docs/` 顶层 | 125 | docs/ 顶层（有入链的活文档，按纪律不能直接搬） |
| 1 活 | `docs/_active/` | 6 | **新文档放这里**（`spec/` `report/` `prompt/`） |
| 3 参考 | `docs/_reference/` | 8 | 长期有效配置指南，不过期 |
| 4 归档 | `docs/_archive/YYYY-MM/` | 34 | 已完工过保鲜期，按**内容**日期分月 |

归档分月明细：`2026-05` 1、`2026-06` 1、`2026-07` 6、`2026-08` 10、`2026-09` 3、`2026-10` 13

另有 **51** 份散在 **8** 个别人早先建的旧子目录（本索引不搬它们）：

| 旧子目录 | 份数 |
|---|---|
| `docs/archive/` | 19 |
| `docs/backend_group_chat_spec/` | 5 |
| `docs/fullscreen-card-functional-parity/` | 1 |
| `docs/goal-groupchat/` | 5 |
| `docs/inline-card-rendering-plan/` | 4 |
| `docs/light-mode-contrast-enhancement/` | 1 |
| `docs/st-compat-handover/` | 6 |
| `docs/st-plugin-compat-spec/` | 10 |

## 四、⚠️ git 入库状态

- 已被 git 跟踪：**169**
- **未入库（只存在本机）：56**

> ⚠️ 这 56 份**只存在这台机器上**。整理/移动时一旦弄丢且没提交，就是真没了。移动任何文档前先确认它已被 git 跟踪，或先做物理备份。

## 五、全量清单（按目录 → 文件名）

### `docs/` — 125 份

| 文件 | 前缀 | 文件名日期 | 内容首现 | 状态标记 | mtime |
|---|---|---|---|---|---|
| [`ANALYSIS_ST兼容性约束下的前端优化_2026-09-21.md`](./ANALYSIS_ST兼容性约束下的前端优化_2026-09-21.md) | `ANALYSIS` | 2026-09 | 2026-09-01 | 口径已作废 | 2026-10-03 |
| [`ANALYSIS_前端性能与缓存优化_2026-09-21.md`](./ANALYSIS_前端性能与缓存优化_2026-09-21.md) | `ANALYSIS` | 2026-09 | 2026-09-01 | 口径已作废 | 2026-10-03 |
| [`ANALYSIS_项目现状与遗留清理_2026-09-20.md`](./ANALYSIS_项目现状与遗留清理_2026-09-20.md) | `ANALYSIS` | 2026-09 | 2026-09-01 | — | 2026-09-21 |
| [`AUDIT_MCP与文生图TTS支持度_2026-09-25.md`](./AUDIT_MCP与文生图TTS支持度_2026-09-25.md) | `AUDIT` | 2026-09 | 2026-09-01 | — | 2026-09-25 |
| [`AUDIT_TASK7_DEBUG_ENDPOINT_PERMISSIONS.md`](./AUDIT_TASK7_DEBUG_ENDPOINT_PERMISSIONS.md) | `AUDIT` | — | 2026-07-01 | — | 2026-07-01 |
| [`AUDIT_TASK8_FRONTEND_BACKEND_OVERLAP.md`](./AUDIT_TASK8_FRONTEND_BACKEND_OVERLAP.md) | `AUDIT` | — | 2026-07-01 | — | 2026-07-01 |
| [`AUDIT_注入体系与ST对齐_2026-09-08.md`](./AUDIT_注入体系与ST对齐_2026-09-08.md) | `AUDIT` | 2026-09 | 2026-09-01 | — | 2026-09-08 |
| [`BRIDGE_JS_REAL_API_PATHS_ALIGNMENT.md`](./BRIDGE_JS_REAL_API_PATHS_ALIGNMENT.md) | `其他` | — | 2026-07-01 | — | 2026-07-19 |
| [`DEEP_AUDIT_REPORT_2026-08-09.md`](./DEEP_AUDIT_REPORT_2026-08-09.md) | `其他` | 2026-08 | 2026-08-01 | — | 2026-08-12 |
| [`GALGAME_PLUGIN_PERFECT_COMPAT_SPEC.md`](./GALGAME_PLUGIN_PERFECT_COMPAT_SPEC.md) | `GALGAME` | — | 2026-08-01 | — | 2026-09-24 |
| [`HANDOFF_相册与渲染问题_2026-10-03.md`](./HANDOFF_相册与渲染问题_2026-10-03.md) | `HANDOFF_` | 2026-10 | 2026-10-01 | 已完成 | 2026-10-03 |
| [`HANDOFF_项目全面体检_2026-09-03.md`](./HANDOFF_项目全面体检_2026-09-03.md) | `HANDOFF_` | 2026-09 | 2026-09-01 | 口径已作废 | 2026-10-03 |
| [`HOTFIX完工报告_安全批次六项_2026-08-24.md`](./HOTFIX完工报告_安全批次六项_2026-08-24.md) | `其他` | 2026-08 | 2026-08-01 | — | 2026-08-24 |
| [`MOBILE_ST_COMPAT_VERIFY_2026-08-12.md`](./MOBILE_ST_COMPAT_VERIFY_2026-08-12.md) | `其他` | 2026-08 | 2026-08-01 | — | 2026-08-12 |
| [`OPEN_ISSUES.md`](./OPEN_ISSUES.md) | `OPEN_` | — | 2026-10-01 | 已完成 | 2026-10-05 |
| [`OPEN_ISSUES_窄屏卡片三修已上线_首屏入口包未解决_2026-10-05.md`](./OPEN_ISSUES_窄屏卡片三修已上线_首屏入口包未解决_2026-10-05.md) | `OPEN_` | 2026-10 | 2026-10-01 | — | 2026-10-05 |
| [`PALINK_ST_AGENT_TODO.md`](./PALINK_ST_AGENT_TODO.md) | `PALINK_` | — | — | — | 2026-07-23 |
| [`PALINK_ST_COMPAT_EXECUTION_SPEC.md`](./PALINK_ST_COMPAT_EXECUTION_SPEC.md) | `PALINK_` | — | 2026-06-01 | — | 2026-07-07 |
| [`PALINK_ST_HOST_CONTRACT.md`](./PALINK_ST_HOST_CONTRACT.md) | `PALINK_` | — | — | — | 2026-06-15 |
| [`PALINK_ST_PLUGIN_COMPAT_MATRIX.md`](./PALINK_ST_PLUGIN_COMPAT_MATRIX.md) | `PALINK_` | — | 2026-06-01 | — | 2026-07-07 |
| [`PALINK_ST_RUNTIME_IMPLEMENTATION_PLAN.md`](./PALINK_ST_RUNTIME_IMPLEMENTATION_PLAN.md) | `PALINK_` | — | — | — | 2026-06-15 |
| [`PERF_低风险修复批次_移交_2026-09-02.md`](./PERF_低风险修复批次_移交_2026-09-02.md) | `其他` | 2026-09 | 2026-09-01 | 已完成 | 2026-09-02 |
| [`PLAN_ST兼容修复批次_2026-08-28.md`](./PLAN_ST兼容修复批次_2026-08-28.md) | `PLAN_` | 2026-08 | 2026-09-01 | 口径已作废 | 2026-10-03 |
| [`PLAN_三坑无损修复_2026-09-05.md`](./PLAN_三坑无损修复_2026-09-05.md) | `PLAN_` | 2026-09 | 2026-09-01 | — | 2026-09-05 |
| [`PLAN_模型自主出图_2026-09-24.md`](./PLAN_模型自主出图_2026-09-24.md) | `PLAN_` | 2026-09 | 2026-09-01 | — | 2026-09-25 |
| [`PLUGIN_ISSUES_REPORT.md`](./PLUGIN_ISSUES_REPORT.md) | `其他` | — | 2026-08-01 | — | 2026-08-12 |
| [`PLUGIN_SECURITY_MODEL.md`](./PLUGIN_SECURITY_MODEL.md) | `其他` | — | 2026-08-01 | — | 2026-08-17 |
| [`PROMPT_MVU兼容补齐_交给Agent_2026-10-05.md`](./PROMPT_MVU兼容补齐_交给Agent_2026-10-05.md) | `PROMPT_` | 2026-10 | 2026-10-01 | 已完成 | 2026-10-05 |
| [`PROMPT_MVU变量结构注入修复_2026-10-05.md`](./PROMPT_MVU变量结构注入修复_2026-10-05.md) | `PROMPT_` | 2026-10 | — | — | 2026-10-05 |
| [`PROMPT_卡脚本本地存储按角色与账号隔离_2026-10-02.md`](./PROMPT_卡脚本本地存储按角色与账号隔离_2026-10-02.md) | `PROMPT_` | 2026-10 | 2026-10-01 | — | 2026-10-02 |
| [`PROMPT_报错提示模板落地_2026-10-03.md`](./PROMPT_报错提示模板落地_2026-10-03.md) | `PROMPT_` | 2026-10 | 2026-09-01 | — | 2026-10-03 |
| [`PROMPT_报错提示系统重写_2026-09-30.md`](./PROMPT_报错提示系统重写_2026-09-30.md) | `PROMPT_` | 2026-09 | 2026-09-01 | 已完成 | 2026-10-03 |
| [`PROMPT_接手批_格式规范残本与A_B重测_2026-10-02.md`](./PROMPT_接手批_格式规范残本与A_B重测_2026-10-02.md) | `PROMPT_` | 2026-10 | 2026-10-01 | — | 2026-10-02 |
| [`PROMPT_格式规范每轮必到与历史擦标签例外_2026-10-02.md`](./PROMPT_格式规范每轮必到与历史擦标签例外_2026-10-02.md) | `PROMPT_` | 2026-10 | 2026-10-01 | — | 2026-10-02 |
| [`REASONING_FIELD_MIGRATION.md`](./REASONING_FIELD_MIGRATION.md) | `其他` | — | — | — | 2026-07-19 |
| [`REPORT_D9_前后端并行注入排查_2026-08-27.md`](./REPORT_D9_前后端并行注入排查_2026-08-27.md) | `REPORT_` | 2026-08 | 2026-08-01 | — | 2026-08-27 |
| [`REPORT_MVU变量框架与Palink自有变量体系重叠专题_2026-10-04.md`](./REPORT_MVU变量框架与Palink自有变量体系重叠专题_2026-10-04.md) | `REPORT_` | 2026-10 | 2026-10-01 | — | 2026-10-05 |
| [`REPORT_MVU提示词依从性零成本筛查_2026-09-28.md`](./REPORT_MVU提示词依从性零成本筛查_2026-09-28.md) | `REPORT_` | 2026-09 | 2026-09-01 | — | 2026-09-29 |
| [`REPORT_MVU插件设置项与Palink对应关系_2026-10-05.md`](./REPORT_MVU插件设置项与Palink对应关系_2026-10-05.md) | `REPORT_` | 2026-10 | 2026-10-01 | — | 2026-10-05 |
| [`REPORT_ST兼容性深度调研_2026-08-29.md`](./REPORT_ST兼容性深度调研_2026-08-29.md) | `REPORT_` | 2026-08 | 2026-08-01 | — | 2026-08-29 |
| [`REPORT_ST插件全兼容可行性评估_2026-09-05.md`](./REPORT_ST插件全兼容可行性评估_2026-09-05.md) | `REPORT_` | 2026-09 | 2026-09-01 | 已完成 | 2026-09-05 |
| [`REPORT_安全整改跟进_2026-09-02_依赖审计与路径穿越复核.md`](./REPORT_安全整改跟进_2026-09-02_依赖审计与路径穿越复核.md) | `REPORT_` | 2026-09 | 2026-09-01 | — | 2026-09-02 |
| [`REPORT_安全检测_Mimosa深度扫描_2026-09-02.md`](./REPORT_安全检测_Mimosa深度扫描_2026-09-02.md) | `REPORT_` | 2026-09 | 2026-09-01 | 已完成 | 2026-09-03 |
| [`REPORT_安全渗透验证_2026-09-02.md`](./REPORT_安全渗透验证_2026-09-02.md) | `REPORT_` | 2026-09 | 2026-09-01 | 口径已作废 | 2026-10-03 |
| [`REPORT_插件API缺口清单_2026-10-04.md`](./REPORT_插件API缺口清单_2026-10-04.md) | `REPORT_` | 2026-10 | 2026-10-01 | — | 2026-10-04 |
| [`REPORT_插件沙箱逃逸面评估_2026-09-02.md`](./REPORT_插件沙箱逃逸面评估_2026-09-02.md) | `REPORT_` | 2026-09 | 2026-09-01 | 口径已作废 | 2026-10-03 |
| [`REPORT_插件设置冲突与100%适配可行性_2026-10-04.md`](./REPORT_插件设置冲突与100%适配可行性_2026-10-04.md) | `REPORT_` | 2026-10 | 2026-10-01 | — | 2026-10-04 |
| [`REPORT_插件设置按卡隔离_批次0-1交付_2026-10-04.md`](./REPORT_插件设置按卡隔离_批次0-1交付_2026-10-04.md) | `REPORT_` | 2026-10 | 2026-10-01 | — | 2026-10-04 |
| [`REPORT_浏览器桥接本地算力可行性调研_2026-09-28.md`](./REPORT_浏览器桥接本地算力可行性调研_2026-09-28.md) | `REPORT_` | 2026-09 | 2026-09-01 | — | 2026-09-28 |
| [`REPORT_移动端UI精致度调研_2026-09-06.md`](./REPORT_移动端UI精致度调研_2026-09-06.md) | `REPORT_` | 2026-09 | 2026-09-01 | — | 2026-09-06 |
| [`REPORT_酒馆助手API适配查验_2026-10-03.md`](./REPORT_酒馆助手API适配查验_2026-10-03.md) | `REPORT_` | 2026-10 | 2026-10-01 | — | 2026-10-04 |
| [`REPORT_项目全面体检_2026-09-05.md`](./REPORT_项目全面体检_2026-09-05.md) | `REPORT_` | 2026-09 | 2026-09-01 | 口径已作废 | 2026-10-03 |
| [`SCEP_角色扮演弱网性能优化.md`](./SCEP_角色扮演弱网性能优化.md) | `其他` | — | 2026-08-01 | 已完成 | 2026-08-14 |
| [`SECURITY_AUDIT_REPORT.md`](./SECURITY_AUDIT_REPORT.md) | `其他` | — | 2026-05-01 | — | 2026-05-15 |
| [`SILLYTAVERN_COMPAT_AUDIT.md`](./SILLYTAVERN_COMPAT_AUDIT.md) | `其他` | — | 2026-06-01 | — | 2026-07-10 |
| [`SILLYTAVERN_COMPAT_SPEC_2026-08-23.md`](./SILLYTAVERN_COMPAT_SPEC_2026-08-23.md) | `其他` | 2026-08 | 2026-08-01 | — | 2026-08-23 |
| [`SMARTCARD_VERIFY_FINDINGS_2026-08-11.md`](./SMARTCARD_VERIFY_FINDINGS_2026-08-11.md) | `其他` | 2026-08 | 2026-08-01 | — | 2026-08-11 |
| [`SOP_Agent交付自查清单.md`](./SOP_Agent交付自查清单.md) | `SOP_` | — | 2026-10-01 | 已完成 | 2026-10-03 |
| [`SPEC_MVU初始变量断链与输出tag裸显修复_2026-09-30.md`](./SPEC_MVU初始变量断链与输出tag裸显修复_2026-09-30.md) | `SPEC_` | 2026-09 | 2026-09-01 | 待施工 | 2026-09-30 |
| [`SPEC_MVU变量更新SSE侧补齐与取证_2026-09-28.md`](./SPEC_MVU变量更新SSE侧补齐与取证_2026-09-28.md) | `SPEC_` | 2026-09 | 2026-09-01 | — | 2026-09-28 |
| [`SPEC_MVU提示词依从性零成本筛查_2026-09-28.md`](./SPEC_MVU提示词依从性零成本筛查_2026-09-28.md) | `SPEC_` | 2026-09 | 2026-09-01 | — | 2026-09-28 |
| [`SPEC_MVU插件能力补齐_P0-P2_2026-10-05.md`](./SPEC_MVU插件能力补齐_P0-P2_2026-10-05.md) | `SPEC_` | 2026-10 | 2026-10-01 | — | 2026-10-05 |
| [`SPEC_N8_HttpOnly_Cookie_立项_2026-08-25.md`](./SPEC_N8_HttpOnly_Cookie_立项_2026-08-25.md) | `SPEC_` | 2026-08 | 2026-08-01 | — | 2026-08-27 |
| [`SPEC_ST_P2剩余六项_2026-08-26.md`](./SPEC_ST_P2剩余六项_2026-08-26.md) | `SPEC_` | 2026-08 | 2026-09-01 | 口径已作废 | 2026-10-03 |
| [`SPEC_ST兼容度全面审查_2026-08-28.md`](./SPEC_ST兼容度全面审查_2026-08-28.md) | `SPEC_` | 2026-08 | 2026-08-01 | — | 2026-08-28 |
| [`SPEC_ST双轨剥离删除_st-compat与st-native_2026-09-03.md`](./SPEC_ST双轨剥离删除_st-compat与st-native_2026-09-03.md) | `SPEC_` | 2026-09 | 2026-09-01 | 口径已作废 | 2026-10-03 |
| [`SPEC_世界书向量召回接通与防护_2026-09-29.md`](./SPEC_世界书向量召回接通与防护_2026-09-29.md) | `SPEC_` | 2026-09 | 2026-09-01 | 施工中 | 2026-09-30 |
| [`SPEC_二期_vectorized接线与N8止血_2026-08-25.md`](./SPEC_二期_vectorized接线与N8止血_2026-08-25.md) | `SPEC_` | 2026-08 | 2026-08-01 | — | 2026-08-27 |
| [`SPEC_修复验证与系统检查_2026-08-24.md`](./SPEC_修复验证与系统检查_2026-08-24.md) | `SPEC_` | 2026-08 | 2026-08-01 | — | 2026-08-27 |
| [`SPEC_出图提示词智能化与多设备算力路由_2026-09-29.md`](./SPEC_出图提示词智能化与多设备算力路由_2026-09-29.md) | `SPEC_` | 2026-09 | 2026-09-01 | — | 2026-09-29 |
| [`SPEC_出图桥接可用性修复批_2026-09-29.md`](./SPEC_出图桥接可用性修复批_2026-09-29.md) | `SPEC_` | 2026-09 | 2026-09-01 | — | 2026-09-29 |
| [`SPEC_出图能力预检与参考图分档_2026-09-29.md`](./SPEC_出图能力预检与参考图分档_2026-09-29.md) | `SPEC_` | 2026-09 | 2026-09-01 | — | 2026-09-29 |
| [`SPEC_分层记忆注入_2026-09-02.md`](./SPEC_分层记忆注入_2026-09-02.md) | `SPEC_` | 2026-09 | 2026-09-01 | — | 2026-09-03 |
| [`SPEC_前端缓存与加载优化_2026-09-21.md`](./SPEC_前端缓存与加载优化_2026-09-21.md) | `SPEC_` | 2026-09 | 2026-09-01 | 口径已作废 | 2026-10-03 |
| [`SPEC_副任务轨迹只读留痕与展示_2026-09-29.md`](./SPEC_副任务轨迹只读留痕与展示_2026-09-29.md) | `SPEC_` | 2026-09 | 2026-09-01 | — | 2026-09-29 |
| [`SPEC_动作流reasoning_only防护_2026-08-24.md`](./SPEC_动作流reasoning_only防护_2026-08-24.md) | `SPEC_` | 2026-08 | 2026-08-01 | — | 2026-08-27 |
| [`SPEC_卡脚本本地存储按角色与账号隔离_2026-10-02.md`](./SPEC_卡脚本本地存储按角色与账号隔离_2026-10-02.md) | `SPEC_` | 2026-10 | 2026-10-01 | 待施工 | 2026-10-02 |
| [`SPEC_变量自动清理_MVU对齐_2026-10-05.md`](./SPEC_变量自动清理_MVU对齐_2026-10-05.md) | `SPEC_` | 2026-10 | 2026-10-01 | — | 2026-10-05 |
| [`SPEC_图像生成与语音播放接线_2026-09-23.md`](./SPEC_图像生成与语音播放接线_2026-09-23.md) | `SPEC_` | 2026-09 | 2026-09-01 | 口径已作废 | 2026-10-03 |
| [`SPEC_安全加固第二批_N6_N7_N8_2026-08-24.md`](./SPEC_安全加固第二批_N6_N7_N8_2026-08-24.md) | `SPEC_` | 2026-08 | 2026-08-01 | 已完成 | 2026-08-27 |
| [`SPEC_性能与体验批次_N3_N9_N12_2026-08-24.md`](./SPEC_性能与体验批次_N3_N9_N12_2026-08-24.md) | `SPEC_` | 2026-08 | 2026-08-01 | 施工中 | 2026-08-27 |
| [`SPEC_提示词身份层ST化_删除第一第三人称切换_2026-09-27.md`](./SPEC_提示词身份层ST化_删除第一第三人称切换_2026-09-27.md) | `SPEC_` | 2026-09 | 2026-09-01 | 口径已作废 | 2026-10-03 |
| [`SPEC_插件按角色卡按需启用_2026-09-26.md`](./SPEC_插件按角色卡按需启用_2026-09-26.md) | `SPEC_` | 2026-09 | 2026-09-01 | 已作废 | 2026-09-27 |
| [`SPEC_插件设置按卡隔离适配_2026-10-04.md`](./SPEC_插件设置按卡隔离适配_2026-10-04.md) | `SPEC_` | 2026-10 | 2026-10-01 | — | 2026-10-04 |
| [`SPEC_文生图浏览器桥接执行_本机ComfyUI_2026-09-28.md`](./SPEC_文生图浏览器桥接执行_本机ComfyUI_2026-09-28.md) | `SPEC_` | 2026-09 | 2026-09-01 | — | 2026-09-28 |
| [`SPEC_架构审查修复_2026-10-03.md`](./SPEC_架构审查修复_2026-10-03.md) | `SPEC_` | 2026-10 | 2026-09-01 | 待施工 | 2026-10-03 |
| [`SPEC_注入落点对齐ST_depth下限与漏删清理_2026-09-28.md`](./SPEC_注入落点对齐ST_depth下限与漏删清理_2026-09-28.md) | `SPEC_` | 2026-09 | 2026-09-01 | 已完成 | 2026-09-28 |
| [`SPEC_测试归零批次_三契约漂移与U3_2026-08-24.md`](./SPEC_测试归零批次_三契约漂移与U3_2026-08-24.md) | `SPEC_` | 2026-08 | 2026-08-01 | — | 2026-08-27 |
| [`SPEC_消息编辑与向量记忆同步_2026-08-24.md`](./SPEC_消息编辑与向量记忆同步_2026-08-24.md) | `SPEC_` | 2026-08 | 2026-08-01 | — | 2026-08-27 |
| [`SPEC_清理批次总案_除N8_2026-08-24.md`](./SPEC_清理批次总案_除N8_2026-08-24.md) | `SPEC_` | 2026-08 | 2026-08-01 | — | 2026-08-27 |
| [`SPEC_重新生成与分支记忆隔离修复_2026-10-05.md`](./SPEC_重新生成与分支记忆隔离修复_2026-10-05.md) | `SPEC_` | 2026-10 | 2026-10-01 | 已完成 | 2026-10-05 |
| [`SPEC_首屏入口包瘦身_执行与禁则_2026-10-05.md`](./SPEC_首屏入口包瘦身_执行与禁则_2026-10-05.md) | `SPEC_` | 2026-10 | 2026-10-01 | — | 2026-10-05 |
| [`ST_BACKEND_FINAL_COMPLETION_REPORT.md`](./ST_BACKEND_FINAL_COMPLETION_REPORT.md) | `其他` | — | 2026-07-01 | 已完成 | 2026-07-19 |
| [`_INDEX.md`](./_INDEX.md) | `其他` | — | 2026-10-01 | 已完成 | 2026-10-05 |
| [`group_chat_full_audit.md`](./group_chat_full_audit.md) | `其他` | — | 2026-07-01 | — | 2026-07-23 |
| [`group_chat_remediation_plan.md`](./group_chat_remediation_plan.md) | `其他` | — | 2026-07-01 | — | 2026-07-23 |
| [`handover-plugin-system-2026-07-31.md`](./handover-plugin-system-2026-07-31.md) | `其他` | — | 2026-07-01 | — | 2026-07-31 |
| [`handover-tavern-helper-2026-07-31.md`](./handover-tavern-helper-2026-07-31.md) | `其他` | — | 2026-07-01 | — | 2026-07-31 |
| [`mvu_smartcard_full_compat_spec.md`](./mvu_smartcard_full_compat_spec.md) | `其他` | — | 2026-08-01 | — | 2026-08-01 |
| [`performance-improvements-spec.md`](./performance-improvements-spec.md) | `其他` | — | — | — | 2026-05-23 |
| [`performance_report.md`](./performance_report.md) | `其他` | — | 2026-07-01 | — | 2026-07-20 |
| [`smart-card-runtime-rewrite-spec.md`](./smart-card-runtime-rewrite-spec.md) | `其他` | — | 2026-08-01 | — | 2026-08-08 |
| [`st-compat-changelog.md`](./st-compat-changelog.md) | `其他` | — | 2026-07-01 | — | 2026-07-20 |
| [`st-compat-gap.md`](./st-compat-gap.md) | `其他` | — | — | — | 2026-07-21 |
| [`st_group_chat_gap_analysis.md`](./st_group_chat_gap_analysis.md) | `其他` | — | 2026-07-01 | — | 2026-07-22 |
| [`st_plugin_frontend_bridge_protocol.md`](./st_plugin_frontend_bridge_protocol.md) | `其他` | — | 2026-07-01 | — | 2026-07-30 |
| [`st_plugin_full_compat_feasibility.md`](./st_plugin_full_compat_feasibility.md) | `其他` | — | 2026-07-01 | — | 2026-07-29 |
| [`st_roleplay_alignment_report.md`](./st_roleplay_alignment_report.md) | `其他` | — | 2026-07-01 | — | 2026-07-22 |
| [`交接文档_角色卡面板插件渲染.md`](./交接文档_角色卡面板插件渲染.md) | `其他` | — | 2026-08-01 | — | 2026-08-04 |
| [`复核_MVU初始变量断链与输出tag裸显_2026-09-30.md`](./复核_MVU初始变量断链与输出tag裸显_2026-09-30.md) | `其他` | 2026-09 | 2026-09-01 | — | 2026-09-30 |
| [`复核_世界书向量召回P1-P5施工_2026-09-29.md`](./复核_世界书向量召回P1-P5施工_2026-09-29.md) | `其他` | 2026-09 | 2026-09-01 | — | 2026-09-30 |
| [`复核_世界书向量召回前端批A-E_2026-09-30.md`](./复核_世界书向量召回前端批A-E_2026-09-30.md) | `其他` | 2026-09 | 2026-09-01 | — | 2026-09-30 |
| [`复核_提示词身份层ST化施工_T0-T3_2026-09-28.md`](./复核_提示词身份层ST化施工_T0-T3_2026-09-28.md) | `其他` | 2026-09 | 2026-09-01 | — | 2026-09-28 |
| [`待验收项判据补齐_2026-10-03.md`](./待验收项判据补齐_2026-10-03.md) | `其他` | 2026-10 | 2026-10-01 | 已完成 | 2026-10-03 |
| [`改皮交付_报错提示原型Palink风格_2026-10-03.md`](./改皮交付_报错提示原型Palink风格_2026-10-03.md) | `其他` | 2026-10 | 2026-10-01 | 已完成 | 2026-10-03 |
| [`架构审查与缺陷总表_2026-10-03.md`](./架构审查与缺陷总表_2026-10-03.md) | `其他` | 2026-10 | 2026-09-01 | 口径已作废 | 2026-10-03 |
| [`角色卡头像尺寸修复与显示开关_计划_2026-08-12.md`](./角色卡头像尺寸修复与显示开关_计划_2026-08-12.md) | `其他` | 2026-08 | 2026-08-01 | — | 2026-08-12 |
| [`角色卡面板渲染_完整交接文档_2026-08-05.md`](./角色卡面板渲染_完整交接文档_2026-08-05.md) | `其他` | 2026-08 | 2026-08-01 | — | 2026-08-05 |
| [`评估_P0前端memo修复任务适配性与执行计划_2026-09-22.md`](./评估_P0前端memo修复任务适配性与执行计划_2026-09-22.md) | `其他` | 2026-09 | 2026-09-01 | 口径已作废 | 2026-10-03 |
| [`评估_前端渲染层待议项_2026-09-22.md`](./评估_前端渲染层待议项_2026-09-22.md) | `其他` | 2026-09 | 2026-09-01 | 已完成 | 2026-09-22 |
| [`评审_出图提示词智能化SPEC可行度_2026-09-29.md`](./评审_出图提示词智能化SPEC可行度_2026-09-29.md) | `其他` | 2026-09 | 2026-09-01 | 待施工 | 2026-09-29 |
| [`评审_出图能力预检与参考图分档SPEC可执行度_2026-09-29.md`](./评审_出图能力预检与参考图分档SPEC可执行度_2026-09-29.md) | `其他` | 2026-09 | 2026-09-01 | — | 2026-09-29 |
| [`诊断_视角错误与思考框错位与思考过长_2026-09-27.md`](./诊断_视角错误与思考框错位与思考过长_2026-09-27.md) | `其他` | 2026-09 | 2026-09-01 | — | 2026-09-27 |
| [`调查_MVU变量块2899字符差成因_2026-09-28.md`](./调查_MVU变量块2899字符差成因_2026-09-28.md) | `其他` | 2026-09 | 2026-09-01 | — | 2026-09-28 |
| [`验收体检报告_功能地图_2026-09-29.md`](./验收体检报告_功能地图_2026-09-29.md) | `其他` | 2026-09 | 2026-09-01 | — | 2026-09-29 |

### `docs/_active/` — 3 份

| 文件 | 前缀 | 文件名日期 | 内容首现 | 状态标记 | mtime |
|---|---|---|---|---|---|
| [`HANDOFF_ST卡片适配三问题_2026-10-05.md`](./_active/HANDOFF_ST卡片适配三问题_2026-10-05.md) | `HANDOFF_` | 2026-10 | 2026-10-01 | — | 2026-10-06 |
| [`HANDOFF_ST卡片适配三问题_2026-10-06.md`](./_active/HANDOFF_ST卡片适配三问题_2026-10-06.md) | `HANDOFF_` | 2026-10 | 2026-10-01 | — | 2026-10-06 |
| [`_README.md`](./_active/_README.md) | `其他` | — | 2026-10-01 | — | 2026-10-05 |

### `docs/_active/report/` — 1 份

| 文件 | 前缀 | 文件名日期 | 内容首现 | 状态标记 | mtime |
|---|---|---|---|---|---|
| [`REPORT_酒馆助手API适配度复查与100%适配判定_2026-10-06.md`](./_active/report/REPORT_酒馆助手API适配度复查与100%适配判定_2026-10-06.md) | `REPORT_` | 2026-10 | 2026-10-01 | — | 2026-10-06 |

### `docs/_active/spec/` — 2 份

| 文件 | 前缀 | 文件名日期 | 内容首现 | 状态标记 | mtime |
|---|---|---|---|---|---|
| [`SPEC_ST卡片适配核查与修复_2026-10-05.md`](./_active/spec/SPEC_ST卡片适配核查与修复_2026-10-05.md) | `SPEC_` | 2026-10 | 2026-10-01 | — | 2026-10-05 |
| [`SPEC_酒馆助手API三分类与实施指南_2026-10-06.md`](./_active/spec/SPEC_酒馆助手API三分类与实施指南_2026-10-06.md) | `SPEC_` | 2026-10 | 2026-10-01 | 待施工 | 2026-10-06 |

### `docs/_archive/` — 1 份

| 文件 | 前缀 | 文件名日期 | 内容首现 | 状态标记 | mtime |
|---|---|---|---|---|---|
| [`_README.md`](./_archive/_README.md) | `其他` | — | 2026-10-01 | 已完成 | 2026-10-05 |

### `docs/_archive/2026-05/` — 1 份

| 文件 | 前缀 | 文件名日期 | 内容首现 | 状态标记 | mtime |
|---|---|---|---|---|---|
| [`CODE_QUALITY_AUDIT_REPORT.md`](./_archive/2026-05/CODE_QUALITY_AUDIT_REPORT.md) | `其他` | — | 2026-05-01 | — | 2026-05-15 |

### `docs/_archive/2026-06/` — 1 份

| 文件 | 前缀 | 文件名日期 | 内容首现 | 状态标记 | mtime |
|---|---|---|---|---|---|
| [`DIRECTION1_ST_NATIVE_PERFECTION_PLAN.md`](./_archive/2026-06/DIRECTION1_ST_NATIVE_PERFECTION_PLAN.md) | `其他` | — | 2026-06-01 | 已完成 | 2026-06-17 |

### `docs/_archive/2026-07/` — 6 份

| 文件 | 前缀 | 文件名日期 | 内容首现 | 状态标记 | mtime |
|---|---|---|---|---|---|
| [`FREE_WEBSEARCH_SETUP.md`](./_archive/2026-07/FREE_WEBSEARCH_SETUP.md) | `其他` | — | — | — | 2026-05-15 |
| [`ST_ALIGNMENT_EVALUATION_REPORT.md`](./_archive/2026-07/ST_ALIGNMENT_EVALUATION_REPORT.md) | `其他` | — | 2026-07-01 | — | 2026-07-24 |
| [`WEBSEARCH_SETUP_COMPLETE.md`](./_archive/2026-07/WEBSEARCH_SETUP_COMPLETE.md) | `其他` | — | — | — | 2026-05-15 |
| [`group_chat_remediation_addendum.md`](./_archive/2026-07/group_chat_remediation_addendum.md) | `其他` | — | 2026-07-01 | — | 2026-07-23 |
| [`st-compat-audit.md`](./_archive/2026-07/st-compat-audit.md) | `其他` | — | — | — | 2026-07-21 |
| [`st-compat-report.md`](./_archive/2026-07/st-compat-report.md) | `其他` | — | 2026-07-01 | — | 2026-07-20 |

### `docs/_archive/2026-08/` — 10 份

| 文件 | 前缀 | 文件名日期 | 内容首现 | 状态标记 | mtime |
|---|---|---|---|---|---|
| [`QUICK_FIX_SPEC_2026-08-12.md`](./_archive/2026-08/QUICK_FIX_SPEC_2026-08-12.md) | `QUICK_FIX` | 2026-08 | 2026-08-01 | — | 2026-08-12 |
| [`SCEP_角色卡面板渲染.md`](./_archive/2026-08/SCEP_角色卡面板渲染.md) | `其他` | — | 2026-08-01 | 已完成 | 2026-08-04 |
| [`VARIABLE_PANEL_HANDOFF_2026-08-17.md`](./_archive/2026-08/VARIABLE_PANEL_HANDOFF_2026-08-17.md) | `其他` | 2026-08 | 2026-08-01 | — | 2026-08-17 |
| [`p-series-fixes-spec-2026-08-12.md`](./_archive/2026-08/p-series-fixes-spec-2026-08-12.md) | `其他` | — | 2026-08-01 | — | 2026-08-12 |
| [`smart-card-rewrite-实施计划-20260807.md`](./_archive/2026-08/smart-card-rewrite-实施计划-20260807.md) | `其他` | — | 2026-08-01 | — | 2026-08-07 |
| [`st-prompt-alignment-fix-spec.md`](./_archive/2026-08/st-prompt-alignment-fix-spec.md) | `其他` | — | 2026-08-01 | — | 2026-08-13 |
| [`st-resources-n-series-fixes-2026-08-12.md`](./_archive/2026-08/st-resources-n-series-fixes-2026-08-12.md) | `其他` | — | 2026-08-01 | — | 2026-08-12 |
| [`状态栏渲染修复_实施计划_2026-08-05.md`](./_archive/2026-08/状态栏渲染修复_实施计划_2026-08-05.md) | `其他` | 2026-08 | 2026-08-01 | — | 2026-08-05 |
| [`状态栏渲染调试_交接文件_2026-08-06.md`](./_archive/2026-08/状态栏渲染调试_交接文件_2026-08-06.md) | `其他` | 2026-08 | 2026-08-01 | — | 2026-08-06 |
| [`聊天页插件管理入口_Spec_2026-08-12.md`](./_archive/2026-08/聊天页插件管理入口_Spec_2026-08-12.md) | `其他` | 2026-08 | 2026-08-01 | — | 2026-08-12 |

### `docs/_archive/2026-09/` — 3 份

| 文件 | 前缀 | 文件名日期 | 内容首现 | 状态标记 | mtime |
|---|---|---|---|---|---|
| [`REPORT_ST适配面安全审查_2026-09-03.md`](./_archive/2026-09/REPORT_ST适配面安全审查_2026-09-03.md) | `REPORT_` | 2026-09 | 2026-09-01 | — | 2026-09-03 |
| [`ST_COMPAT_FORK_AUDIT_2026-08-17.md`](./_archive/2026-09/ST_COMPAT_FORK_AUDIT_2026-08-17.md) | `其他` | 2026-08 | 2026-09-01 | 口径已作废 | 2026-10-03 |
| [`验收体检_功能地图与测试提示词_2026-09-29.md`](./_archive/2026-09/验收体检_功能地图与测试提示词_2026-09-29.md) | `其他` | 2026-09 | 2026-09-01 | — | 2026-09-29 |

### `docs/_archive/2026-10/` — 13 份

| 文件 | 前缀 | 文件名日期 | 内容首现 | 状态标记 | mtime |
|---|---|---|---|---|---|
| [`DIAG_变量形状漂移导致状态栏回默认值_2026-10-05.md`](./_archive/2026-10/DIAG_变量形状漂移导致状态栏回默认值_2026-10-05.md) | `DIAG_` | 2026-10 | 2026-10-01 | — | 2026-10-05 |
| [`PROMPT_明日批次_网关门禁_插件标签适配_报错UI_2026-10-03.md`](./_archive/2026-10/PROMPT_明日批次_网关门禁_插件标签适配_报错UI_2026-10-03.md) | `PROMPT_` | 2026-10 | 2026-10-01 | — | 2026-10-03 |
| [`PROMPT_首屏入口包瘦身方案设计_2026-10-05.md`](./_archive/2026-10/PROMPT_首屏入口包瘦身方案设计_2026-10-05.md) | `PROMPT_` | 2026-10 | 2026-10-01 | — | 2026-10-05 |
| [`REPORT_MVU变量更新指令让位卡片自带声明_2026-10-05.md`](./_archive/2026-10/REPORT_MVU变量更新指令让位卡片自带声明_2026-10-05.md) | `REPORT_` | 2026-10 | 2026-10-01 | — | 2026-10-05 |
| [`REPORT_MVU补齐第一波_2026-10-05.md`](./_archive/2026-10/REPORT_MVU补齐第一波_2026-10-05.md) | `REPORT_` | 2026-10 | 2026-10-01 | — | 2026-10-05 |
| [`REPORT_MVU补齐第三波_2026-10-05.md`](./_archive/2026-10/REPORT_MVU补齐第三波_2026-10-05.md) | `REPORT_` | 2026-10 | 2026-10-01 | — | 2026-10-05 |
| [`REPORT_MVU补齐第二波_2026-10-05.md`](./_archive/2026-10/REPORT_MVU补齐第二波_2026-10-05.md) | `REPORT_` | 2026-10 | 2026-10-01 | — | 2026-10-05 |
| [`REPORT_重复废弃与互搏代码审查_2026-10-02.md`](./_archive/2026-10/REPORT_重复废弃与互搏代码审查_2026-10-02.md) | `REPORT_` | 2026-10 | 2026-10-01 | — | 2026-10-02 |
| [`SPEC_ST卡片输出规范丢失_2026-10-05.md`](./_archive/2026-10/SPEC_ST卡片输出规范丢失_2026-10-05.md) | `SPEC_` | 2026-10 | 2026-10-01 | — | 2026-10-05 |
| [`SPEC_palink-new合并回主区_2026-10-03.md`](./_archive/2026-10/SPEC_palink-new合并回主区_2026-10-03.md) | `SPEC_` | 2026-10 | 2026-09-01 | 口径已作废 | 2026-10-03 |
| [`交付报告_报错提示模板落地_2026-10-03.md`](./_archive/2026-10/交付报告_报错提示模板落地_2026-10-03.md) | `其他` | 2026-10 | 2026-10-01 | 已完成 | 2026-10-03 |
| [`功能审查报告_2026-10-04.md`](./_archive/2026-10/功能审查报告_2026-10-04.md) | `其他` | 2026-10 | 2026-10-01 | — | 2026-10-04 |
| [`提测_卡脚本存储隔离P0未生效_2026-10-02.md`](./_archive/2026-10/提测_卡脚本存储隔离P0未生效_2026-10-02.md) | `其他` | 2026-10 | 2026-10-01 | — | 2026-10-02 |

### `docs/_reference/` — 8 份

| 文件 | 前缀 | 文件名日期 | 内容首现 | 状态标记 | mtime |
|---|---|---|---|---|---|
| [`CASDOOR_INTEGRATION_CHECKLIST.md`](./_reference/CASDOOR_INTEGRATION_CHECKLIST.md) | `其他` | — | — | — | 2026-05-19 |
| [`CASDOOR_INTEGRATION_PRD.md`](./_reference/CASDOOR_INTEGRATION_PRD.md) | `其他` | — | — | — | 2026-05-19 |
| [`CASDOOR_INTEGRATION_TECHNICAL_ARCHITECTURE.md`](./_reference/CASDOOR_INTEGRATION_TECHNICAL_ARCHITECTURE.md) | `其他` | — | — | — | 2026-05-19 |
| [`SEARXNG_ANTI_BAN.md`](./_reference/SEARXNG_ANTI_BAN.md) | `其他` | — | — | — | 2026-05-15 |
| [`SEARXNG_GUIDE.md`](./_reference/SEARXNG_GUIDE.md) | `其他` | — | — | — | 2026-05-15 |
| [`_README.md`](./_reference/_README.md) | `其他` | — | 2026-10-01 | — | 2026-10-05 |
| [`prompt_config_guide.md`](./_reference/prompt_config_guide.md) | `其他` | — | — | — | 2026-05-15 |
| [`prompts_zh.md`](./_reference/prompts_zh.md) | `其他` | — | — | — | 2026-05-15 |

### `docs/archive/` — 19 份

| 文件 | 前缀 | 文件名日期 | 内容首现 | 状态标记 | mtime |
|---|---|---|---|---|---|
| [`App_jsx_进一步优化计划.md`](./archive/App_jsx_进一步优化计划.md) | `其他` | — | — | 已完成 | 2026-05-15 |
| [`BRANCH_REFACTOR_SUMMARY.md`](./archive/BRANCH_REFACTOR_SUMMARY.md) | `其他` | — | — | 已完成 | 2026-05-15 |
| [`CODE_REVIEW_ISSUES.md`](./archive/CODE_REVIEW_ISSUES.md) | `其他` | — | 2026-05-01 | — | 2026-05-15 |
| [`CURRENT_STORYLINE_LOGIC.md`](./archive/CURRENT_STORYLINE_LOGIC.md) | `其他` | — | — | — | 2026-05-15 |
| [`DEVELOPER_MODE_TEST_GUIDE.md`](./archive/DEVELOPER_MODE_TEST_GUIDE.md) | `其他` | — | — | — | 2026-05-15 |
| [`FEATURE_TEST_PLAN.md`](./archive/FEATURE_TEST_PLAN.md) | `其他` | — | — | — | 2026-05-15 |
| [`FRONTEND_UI_CHANGES.md`](./archive/FRONTEND_UI_CHANGES.md) | `其他` | — | — | 已完成 | 2026-05-15 |
| [`IMPLEMENTATION_PLAN.md`](./archive/IMPLEMENTATION_PLAN.md) | `其他` | — | — | — | 2026-05-15 |
| [`ROLEPLAY_REFACTOR_PLAN.md`](./archive/ROLEPLAY_REFACTOR_PLAN.md) | `其他` | — | — | — | 2026-05-15 |
| [`SETTINGS_REDESIGN_SUMMARY.md`](./archive/SETTINGS_REDESIGN_SUMMARY.md) | `其他` | — | 2026-05-01 | — | 2026-05-15 |
| [`STORYLINE_BRANCH_FIX_REPORT.md`](./archive/STORYLINE_BRANCH_FIX_REPORT.md) | `其他` | — | — | — | 2026-05-15 |
| [`STORYLINE_FIX_COMPLETE.md`](./archive/STORYLINE_FIX_COMPLETE.md) | `其他` | — | — | — | 2026-05-15 |
| [`STORYLINE_TEST_GUIDE.md`](./archive/STORYLINE_TEST_GUIDE.md) | `其他` | — | — | — | 2026-05-15 |
| [`TESTING_VERIFICATION_REPORT.md`](./archive/TESTING_VERIFICATION_REPORT.md) | `其他` | — | 2026-04-01 | — | 2026-05-15 |
| [`UPDATE_LOG.md`](./archive/UPDATE_LOG.md) | `其他` | — | 2026-03-01 | — | 2026-05-15 |
| [`silly_tavern_comparison_improvement_plan.md`](./archive/silly_tavern_comparison_improvement_plan.md) | `其他` | — | — | — | 2026-05-15 |
| [`前端加载优化计划.md`](./archive/前端加载优化计划.md) | `其他` | — | 2026-04-01 | — | 2026-05-15 |
| [`重构洞察-ChatViewMobile职责过多问题.md`](./archive/重构洞察-ChatViewMobile职责过多问题.md) | `其他` | — | — | — | 2026-05-15 |
| [`项目优化分析计划.md`](./archive/项目优化分析计划.md) | `其他` | — | 2026-04-01 | — | 2026-05-15 |

### `docs/backend_group_chat_spec/` — 5 份

| 文件 | 前缀 | 文件名日期 | 内容首现 | 状态标记 | mtime |
|---|---|---|---|---|---|
| [`01_activation_strategies.md`](./backend_group_chat_spec/01_activation_strategies.md) | `其他` | — | — | — | 2026-07-23 |
| [`02_generation_mode_and_combine.md`](./backend_group_chat_spec/02_generation_mode_and_combine.md) | `其他` | — | — | — | 2026-07-23 |
| [`03_context_macros_worldbook.md`](./backend_group_chat_spec/03_context_macros_worldbook.md) | `其他` | — | — | — | 2026-07-23 |
| [`04_streaming.md`](./backend_group_chat_spec/04_streaming.md) | `其他` | — | — | — | 2026-07-23 |
| [`README.md`](./backend_group_chat_spec/README.md) | `其他` | — | — | — | 2026-07-22 |

### `docs/fullscreen-card-functional-parity/` — 1 份

| 文件 | 前缀 | 文件名日期 | 内容首现 | 状态标记 | mtime |
|---|---|---|---|---|---|
| [`spec.md`](./fullscreen-card-functional-parity/spec.md) | `其他` | — | 2026-08-01 | — | 2026-08-11 |

### `docs/goal-groupchat/` — 5 份

| 文件 | 前缀 | 文件名日期 | 内容首现 | 状态标记 | mtime |
|---|---|---|---|---|---|
| [`.goal-state.md`](./goal-groupchat/.goal-state.md) | `其他` | — | 2026-10-01 | — | 2026-10-03 |
| [`goal-design.md`](./goal-groupchat/goal-design.md) | `其他` | — | 2026-10-01 | — | 2026-10-03 |
| [`goal-overview.md`](./goal-groupchat/goal-overview.md) | `其他` | — | 2026-10-01 | 已作废 | 2026-10-03 |
| [`goal-plan.md`](./goal-groupchat/goal-plan.md) | `其他` | — | 2026-10-01 | — | 2026-10-03 |
| [`goal-verification-report.md`](./goal-groupchat/goal-verification-report.md) | `其他` | — | 2026-07-01 | — | 2026-07-23 |

### `docs/inline-card-rendering-plan/` — 4 份

| 文件 | 前缀 | 文件名日期 | 内容首现 | 状态标记 | mtime |
|---|---|---|---|---|---|
| [`README.md`](./inline-card-rendering-plan/README.md) | `其他` | — | — | — | 2026-08-08 |
| [`spec.md`](./inline-card-rendering-plan/spec.md) | `其他` | — | 2026-08-01 | — | 2026-08-08 |
| [`todolist.md`](./inline-card-rendering-plan/todolist.md) | `其他` | — | 2026-08-01 | 已完成 | 2026-08-08 |
| [`注意事项.md`](./inline-card-rendering-plan/注意事项.md) | `其他` | — | — | — | 2026-08-08 |

### `docs/light-mode-contrast-enhancement/` — 1 份

| 文件 | 前缀 | 文件名日期 | 内容首现 | 状态标记 | mtime |
|---|---|---|---|---|---|
| [`spec.md`](./light-mode-contrast-enhancement/spec.md) | `其他` | — | 2026-08-01 | 已完成 | 2026-08-11 |

### `docs/st-compat-handover/` — 6 份

| 文件 | 前缀 | 文件名日期 | 内容首现 | 状态标记 | mtime |
|---|---|---|---|---|---|
| [`HANDOVER_DETAILED.md`](./st-compat-handover/HANDOVER_DETAILED.md) | `其他` | — | 2026-08-01 | — | 2026-08-08 |
| [`README.md`](./st-compat-handover/README.md) | `其他` | — | 2026-07-01 | — | 2026-07-21 |
| [`checklist.md`](./st-compat-handover/checklist.md) | `其他` | — | — | — | 2026-07-21 |
| [`research-notes.md`](./st-compat-handover/research-notes.md) | `其他` | — | — | — | 2026-07-21 |
| [`spec.md`](./st-compat-handover/spec.md) | `其他` | — | — | — | 2026-08-11 |
| [`tasks.md`](./st-compat-handover/tasks.md) | `其他` | — | — | — | 2026-07-21 |

### `docs/st-plugin-compat-spec/` — 10 份

| 文件 | 前缀 | 文件名日期 | 内容首现 | 状态标记 | mtime |
|---|---|---|---|---|---|
| [`README.md`](./st-plugin-compat-spec/README.md) | `其他` | — | — | — | 2026-07-29 |
| [`SUMMARY.md`](./st-plugin-compat-spec/SUMMARY.md) | `其他` | — | — | — | 2026-07-29 |
| [`backend-plugin-single-chat-audit.md`](./st-plugin-compat-spec/backend-plugin-single-chat-audit.md) | `其他` | — | 2026-07-01 | — | 2026-07-29 |
| [`group-chat-deferred-items.md`](./st-plugin-compat-spec/group-chat-deferred-items.md) | `其他` | — | 2026-07-01 | 已完成 | 2026-07-29 |
| [`phase-0-generate-interceptor.md`](./st-plugin-compat-spec/phase-0-generate-interceptor.md) | `其他` | — | — | — | 2026-07-29 |
| [`phase-1-extension-settings-global.md`](./st-plugin-compat-spec/phase-1-extension-settings-global.md) | `其他` | — | — | — | 2026-07-29 |
| [`phase-2-ui-mount-points.md`](./st-plugin-compat-spec/phase-2-ui-mount-points.md) | `其他` | — | — | — | 2026-07-29 |
| [`phase-3-backend-endpoints.md`](./st-plugin-compat-spec/phase-3-backend-endpoints.md) | `其他` | — | — | — | 2026-07-29 |
| [`phase-4-palink-native-yield.md`](./st-plugin-compat-spec/phase-4-palink-native-yield.md) | `其他` | — | — | — | 2026-07-29 |
| [`phase-5-e2e-test-and-matrix.md`](./st-plugin-compat-spec/phase-5-e2e-test-and-matrix.md) | `其他` | — | — | — | 2026-07-29 |

---

## 六、相关入口

- [`_INDEX.md`](./_INDEX.md) —— **可信度分级**，判断一份文档能不能信
- [`OPEN_ISSUES.md`](./OPEN_ISSUES.md) —— 未解决问题与优先级
- [`_active/_README.md`](./_active/_README.md) —— 新文档怎么放、怎么起名
- [`_archive/_README.md`](./_archive/_README.md) —— 归档判据
- [`../agents.md`](../agents.md) —— 所有 agent 开工必读
