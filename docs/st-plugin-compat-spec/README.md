# ST 插件完美兼容 Spec

## 目标

让 SillyTavern 1.18.0 所有内置扩展（12 个）+ 主流第三方插件能导入 Palink 直接使用，覆盖 Class A/B/C 全部类型。

## 唯一优先级原则

**ST 插件兼容性是唯一优先级**。冲突时 Palink 原生功能让步：
- 不"禁用 ST 一方"
- 不"用 Palink 原生替代"
- Palink 原生功能可牺牲、可共存、可降级

## 当前基线

| 类型 | 数量 | 当前状态 |
|---|---|---|
| Class A（纯 API，如 token-counter） | 1 | supported |
| Class B（混合，如 regex/quick-reply/memory/tts） | 6 | partial（后台能跑，UI/端点缺） |
| Class C（重度依赖，如 vectors/expressions/gallery/assets） | 5 | native-only |

## 冲突处理总策略

| 冲突 | 处理方案 |
|---|---|
| generate_interceptor 未调用 | 合并（generation-engine 调用 ST runGenerationInterceptors） |
| vectors 双轨 | 让 ST vectors 主导，Palink memory_module 不介入 `/api/vector/*` |
| memory 双轨 | 让 ST memory 主导，Palink memory_module 可降级/禁用 |
| UI 挂载点隐藏 | 创建可见 `#qr_bar`/`#extensions_settings`，`#send_textarea` 双向同步 |
| connection-manager | `/api/connection*` 代理到 ST sidecar，Palink 连接管理共存 |
| assets 扩展市场 | 实现 `/api/extensions/install` 真实安装，与 Palink market 共存 |
| regex 管线 | 双向同步（ST UI 改动 ↔ Palink 后端） |
| extension_settings 持久化 | 全局共享，放弃按插件隔离 |
| 斜杠命令 | ST 命令优先，仅 `/clear` 等极少数核心命令保护 |
| chat_metadata | 已对齐，无需处理 |

## Phase 概览

| Phase | 主题 | 优先级 | 文档 |
|---|---|---|---|
| Phase 0 | generate_interceptor 接入 | P0 | [phase-0-generate-interceptor.md](./phase-0-generate-interceptor.md) |
| Phase 1 | extension_settings 全局共享 | P0 | [phase-1-extension-settings-global.md](./phase-1-extension-settings-global.md) |
| Phase 2 | UI 挂载点可见化 | P0 | [phase-2-ui-mount-points.md](./phase-2-ui-mount-points.md) |
| Phase 3 | 后端端点补齐 | P1 | [phase-3-backend-endpoints.md](./phase-3-backend-endpoints.md) |
| Phase 4 | 双轨功能让步 | P1 | [phase-4-palink-native-yield.md](./phase-4-palink-native-yield.md) |
| Phase 5 | 端到端测试与回填 | P2 | [phase-5-e2e-test-and-matrix.md](./phase-5-e2e-test-and-matrix.md) |

## 执行规则

1. 每个 Phase 必须按顺序执行，前一个 Phase 验收通过后才能开始下一个
2. 每个 Phase 完成后必须跑全量回归测试（`pytest tests/ -q`）
3. 后端代码改动后必须 `docker compose build backend && docker compose up -d backend`
4. 前端代码改动后必须 `cd frontend && npx tsc --noEmit` 验证类型
5. 所有改动必须保留备份点（git tag 或 branch）

## 关键决策点（已确认）

1. **api_key 安全让步**：ST connection-manager 明文存 localStorage，接受（兼容优先）
2. **Palink memory_module 降级**：让 ST memory 主导，Palink memory_module 可禁用
3. **extension_settings 全局共享**：放弃隔离，完全对齐 ST
4. **斜杠命令覆盖**：仅保护 `/clear` 等极少数，其余允许 ST 覆盖

## 关键文件索引

### 前端
- 生成引擎：`frontend/src/services/generation-engine.ts`
- 插件沙箱：`frontend/src/lib/plugin-system/sandbox.ts`
- getContext：`frontend/src/lib/sillytavern/getContext.ts`
- ST 兼容运行时：`frontend/src/components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime.ts`
- 角色卡渲染器：`frontend/src/components/ui/custom/CharacterCardRenderer.tsx`
- 斜杠命令引擎：`frontend/src/lib/slash-engine/index.ts`
- 斜杠命令列表：`frontend/src/lib/slash-engine/commands.ts`
- bridge.js：`frontend/public/st/bridge.js`
- ST 扩展主脚本：`frontend/public/st/scripts/extensions.js`
- vectors 扩展：`frontend/public/st/scripts/extensions/vectors/index.js`
- memory 扩展：`frontend/public/st/scripts/extensions/memory/index.js`

### 后端
- ST API 路由：`backend/app/api/silly_tavern.py`
- ST 资源路由：`backend/app/api/st_resources.py`
- memory API：`backend/app/api/memory.py`
- memory 服务：`backend/app/memory_module/service.py`
- memory 配置：`backend/app/memory_module/config.py`
- 斜杠命令服务：`backend/app/services/slash_command_service.py`
- 角色卡装配：`backend/app/services/roleplay_prompt_assembly.py`

## 验证基线

| 验证项 | 基线 |
|---|---|
| 后端全量回归 | 512 passed, 45 skipped, 0 failed |
| ST 验收脚本 | 220/220 passed |
| extension_prompts 单测 | 24 passed |
| author_note 回归 | 21 passed |
| 前端 TypeScript | 修改的文件 0 错误 |
