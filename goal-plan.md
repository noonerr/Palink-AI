# Goal Plan: 后端完整兼容 ST 插件（Phase 3 + 4 + 5）

## 目标
让 ST 插件在 palink-native 模式下调用的后端 API 全部可用；双轨功能（memory/slash/connection/vectors）按「ST 插件主导」原则让步；回归验证不破坏现有功能。

## 前提（已确认事实）
- 前端 Phase 0/1/2 已完成并提交（42a5ace / f545fbb），分支 `st-plugin-compat-20260727`
- `st_native_proxy` 已存在（silly_tavern.py:4254），Phase 3 复用它，不新建代理
- `/api/vector` 现有 index/query/insert/delete（memory_module 支撑），缺 list/query-multi/purge/purge-all
- `/api/extensions/install|update|delete|discover` 为 stub（:7008-7040）
- `/api/settings/save`（:2536）整体覆盖 silly_tavern_settings —— extension_settings 持久化需增量合并设计
- memory 门控：spec 的 `ENABLED=false` 方案有逻辑 bug，改为保持 env 默认 true + 用户开关门控
- 用户已确认：可直接 docker 重建；本轮跳过 regex 双向转换器（列为已知限制）

## 子任务（依赖顺序）

| # | 子任务 | 输出 | 依赖 |
|---|---|---|---|
| T1 | 通读后端代码：st_native_proxy 实现细节、memory_module 向量接口、UserSetting 模型、settings save/get 全流程；备份 silly_tavern.py / memory_module/config.py / roleplay_prompt_assembly.py | 阅读结论（写入设计文档）+ 备份文件 | 无 |
| T2 | Phase 3a：补齐 `/api/vector/list\|query-multi\|purge\|purge-all`（本地 memory_module 实现，请求/响应形状对齐 ST 1.18.0 vectors 端点） | silly_tavern.py 新增 4 端点 | T1 |
| T3 | Phase 3b：`/api/settings/save` 对 `extension_settings` 字段增量合并持久化；`/api/settings/get` 返回它 | silly_tavern.py 修改 2 端点 | T1 |
| T4 | Phase 3c：`/api/extensions/install\|update\|delete\|discover` 改为经 st_native_proxy 代理到 sidecar（sidecar 不可用时返回明确 JSON 错误，不再误导） | silly_tavern.py 修改 4 端点 | T1 |
| T5 | Phase 4a：memory 门控修正——env `MEMORY_ENABLED` 默认保持 true；新增用户级开关（默认由 ST memory 是否接管决定），`_append_memory_context` 接入 | config.py + roleplay_prompt_assembly.py | T1 |
| T6 | Phase 4b：slash `/clear` 保护（前端 slash-engine register 保护 + 后端如有对应注册表同样处理） | slash-engine/index.ts（+后端若存在） | 无（可并行） |
| T7 | Phase 5a：后端 pytest 回归 + 前端 tsc 检查 | 测试输出（0 新增失败） | T2-T6 |
| T8 | Phase 5b：docker 重建后端 + 端点冒烟（curl 新端点） | 重建日志 + 冒烟结果 | T7 |
| T9 | 回填：spec 文档修订（Phase 3/4 与实际实现对齐）+ 工作日志 + 验证报告 | 文档更新 | T8 |

## 并行性
- T2/T3/T4/T5 相互独立（同文件不同区段，串行编辑避免冲突，但无逻辑依赖）
- T6 纯前端，可穿插进行

## 所需技能
- 无需额外加载领域 skill（后端 FastAPI + 前端 TS 均为内置能力范围）

## 明确不做（已知限制）
- regex 双向转换器（用户确认跳过）
- connection-manager 后端实体端点：bridge.js Layer 2 已拦截代理，T1 核实后若确无缺口则不动
- ST iframe 跨模式 extension_settings 同步
- 前端 memory 开关 UI（spec Phase 4 第 6 点）——后端开关先行，UI 后续
