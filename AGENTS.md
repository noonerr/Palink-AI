# AGENTS.md — Palink-AI 开发方向声明

> 所有 agent（Claude Code / Codex / TRAE / 其他）在修改本项目前，请先阅读本文件。
> 本文件描述**当前主攻方向**，避免误解代码意图。

## 当前主攻：palink-native 模式

本项目目前**只维护和优化 `palink-native` 模式**（Palink 原生提示词装配 + Palink 前端插件体系）。

### 三种 silly_tavern_mode 的状态

| 模式 | 含义 | 状态 |
|------|------|------|
| `palink-native` | Palink 原生提示词装配（后端 `build_character_chat_messages`） | **主攻、唯一维护** |
| `st-compat` | 服务端 ST 1.18 对齐装配（后端 `build_st_compat_messages`） | **已封存、冷处理，待删除** |
| `st-native` | iframe 嵌入完整 SillyTavern（前后端 ST sidecar 链路） | **已封存、冷处理，待删除** |

### 重要约定

1. **不要新增或优化 `st-compat` / `st-native` 相关功能**，除非用户明确要求。
2. **不要删除它们**（用户计划稍后统一清理），除非用户明确要求。
3. **Palink 前端插件体系（插件沙箱、regex 引擎、generate_interceptor、`st-plugins/` 目录）全部属于 `palink-native`**，不是 st-native。前端代码中的 `if (sillyTavernMode === 'st-native') return;` 只是隔离 iframe 的守卫，不是插件功能归属。
4. 提示词装配默认值是 `palink-native`（`backend/app/models/system.py` 的 `silly_tavern_mode` 列），不要无授权改动。
5. 遇到 `silly_tavern_mode` / `st-compat` / `st-native` 相关代码时，优先按"palink-native 主攻"的立场评估修改影响面。

## 核心代码位置

- 后端提示词装配：`backend/app/services/roleplay_prompt_assembly.py`
- 后端消息构建：`backend/app/services/character_message_builder.py`
- 前端模式切换 UI：`frontend/src/components/views/SettingsView.tsx`（SillyTavernSettingsPanel）
- 前端插件沙箱：`frontend/src/lib/plugin-system/`
- 前端 ST 插件 runtime：`frontend/src/utils/sillyTavernPluginRuntime.ts`

## 验证

- 后端：`cd backend && python -m pytest tests/`
- 前端：`cd frontend && npx tsc --noEmit`
