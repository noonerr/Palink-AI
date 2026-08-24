# AGENTS.md — Palink-AI 开发方向声明

> 所有 agent（Claude Code / Codex / TRAE / 其他）在修改本项目前，请先阅读本文件。
> 本文件描述**当前主攻方向**，避免误解代码意图。

## 当前主攻：palink-native 模式

本项目目前**只维护和优化 `palink-native` 模式**（Palink 原生提示词装配 + Palink 前端插件体系）。

### 三种 silly_tavern_mode 的状态

| 模式 | 含义 | 状态 |
|------|------|------|
| `palink-native` | Palink 原生提示词装配（后端 `build_character_chat_messages`） | **主攻、唯一维护、唯一可达** |
| `st-compat` | 服务端 ST 1.18 对齐装配（后端 `build_st_compat_messages`） | **运行时强制封存（MODE-SEALED），不可调用；代码待删除** |
| `st-native` | iframe 嵌入完整 SillyTavern（前后端 ST sidecar 链路） | **运行时强制封存（MODE-SEALED），不可调用；代码待删除** |

### 重要约定

1. **`st-compat` / `st-native` 已于 2026-08-24 运行时强制封存（[MODE-SEALED] 用户拍板）**：无论 DB 存什么值，GET/PUT 归一化与装配入口一律按 `palink-native` 处理，设置 UI 入口已禁用。封存守卫位置：`roleplay_prompt_assembly.py` 的 `SEALED_ST_MODES`/`_st_mode_effective`、`users.py` 与 `silly_tavern.py` 的 `_normalize_silly_tavern_mode`。解封 = 从各 `SEALED_ST_MODES` 移除对应值。
2. **不要新增或优化 `st-compat` / `st-native` 相关功能**，除非用户明确要求。
3. **不要删除它们**（用户计划隐患排除后统一清理），除非用户明确要求。
4. **Palink 前端插件体系（插件沙箱、regex 引擎、generate_interceptor、`st-plugins/` 目录）全部属于 `palink-native`**，不是 st-native。前端代码中的 `if (sillyTavernMode === 'st-native') return;` 只是隔离 iframe 的守卫，不是插件功能归属。
5. 提示词装配默认值是 `palink-native`（`backend/app/models/system.py` 的 `silly_tavern_mode` 列），不要无授权改动。
6. 遇到 `silly_tavern_mode` / `st-compat` / `st-native` 相关代码时，优先按"palink-native 主攻"的立场评估修改影响面。

## 待办（跨 agent 协作）

- **所有 agent 在动工前请先阅读根目录 `TODOS.md`**（遗留任务、方向决策、进行中的工作项）。
- 它是本项目跨会话/跨 agent 的待办与决策记录，修改前先同步，完成后按其状态更新。

## 核心代码位置

- 后端提示词装配：`backend/app/services/roleplay_prompt_assembly.py`
- 后端消息构建：`backend/app/services/character_message_builder.py`
- 前端模式切换 UI：`frontend/src/components/views/SettingsView.tsx`（SillyTavernSettingsPanel）
- 前端插件沙箱：`frontend/src/lib/plugin-system/`
- 前端 ST 插件 runtime：`frontend/src/utils/sillyTavernPluginRuntime.ts`

## 验证

- 后端：`cd backend && python -m pytest tests/`
- 前端：`cd frontend && npx tsc --noEmit`
