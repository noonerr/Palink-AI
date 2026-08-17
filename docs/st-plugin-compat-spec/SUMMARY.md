# ST 插件兼容性 Spec 完成总结

## 文档结构

```
docs/st-plugin-compat-spec/
├── README.md                              # 总览（目标、原则、Phase 概览、决策点）
├── phase-0-generate-interceptor.md        # P0: 生成拦截器接入
├── phase-1-extension-settings-global.md   # P0: extension_settings 全局共享
├── phase-2-ui-mount-points.md             # P0: UI 挂载点可见化
├── phase-3-backend-endpoints.md           # P1: 后端端点补齐
├── phase-4-palink-native-yield.md         # P1: 双轨功能让步
├── phase-5-e2e-test-and-matrix.md         # P2: 端到端测试与矩阵回填
└── SUMMARY.md                             # 本文件
```

## Phase 优先级与依赖

```
Phase 0 (generate_interceptor) ──┐
                                  ├──> Phase 3 (后端端点) ──> Phase 5 (E2E 测试)
Phase 1 (extension_settings) ────┤                              │
                                  ├──> Phase 4 (双轨让步) ───────┘
Phase 2 (UI 挂载点) ─────────────┘
```

- **Phase 0/1/2 并行**：P0 优先级，可并行执行
- **Phase 3 依赖 Phase 0**：vectors 端点补齐需先有 interceptor
- **Phase 4 依赖 Phase 1/3**：双轨让步需先有全局 extension_settings 和端点
- **Phase 5 依赖 Phase 0-4**：E2E 测试验证所有修复

## 关键改动文件汇总

### 前端（11 个文件）

| 文件 | Phase | 改动 |
|---|---|---|
| `frontend/src/services/generation-engine.ts` | 0 | 三处 generate 入口插入 interceptor 调用 |
| `frontend/src/lib/sillytavern/generation-interceptor.ts` | 0 | 新建，封装 runGenerationInterceptors |
| `frontend/src/lib/plugin-system/sandbox.ts` | 1 | extension_settings 改为全局共享 |
| `frontend/src/lib/sillytavern/extension-settings-store.ts` | 1 | 新建，统一全局 store |
| `frontend/src/lib/sillytavern/getContext.ts` | 1 | extensionSettings/writeExtensionField 委托到统一 store |
| `frontend/src/components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime.ts` | 2 | window.extension_settings 指向全局；#extensions_settings 可见化；#send_textarea 双向同步 |
| `frontend/src/components/ui/custom/CharacterCardRenderer.tsx` | 2 | #send_textarea 双向同步 |
| `frontend/src/components/st-plugin-ui-host/QrBar.tsx` | 2 | 新建，#qr_bar 可见容器 |
| `frontend/src/lib/sillytavern/st-dom-hosts.ts` | 2 | 新建，统一 DOM 挂载点管理 |
| `frontend/src/pages/settings/st-extensions.tsx` | 2 | 新建，ST 扩展设置入口 |
| `frontend/public/st/bridge.js` | 3 | 移除 /api/connection* 拦截 |
| `frontend/src/lib/slash-engine/index.ts` | 4 | 命令保护机制 |

### 后端（6 个文件）

| 文件 | Phase | 改动 |
|---|---|---|
| `backend/app/api/silly_tavern.py` | 3 | /api/extensions/* 真实代理；/api/vector/* 补齐 + 代理；/api/connection* 新增；/api/chats/attachments/* 新增 |
| `backend/app/memory_module/config.py` | 4 | 默认禁用，增加用户开关 |
| `backend/app/services/roleplay_prompt_assembly.py` | 4 | _append_memory_context 检查用户开关 |
| `backend/app/services/worldbook_vector_service.py` | 4 | ST vectors 加载时不介入 |
| `backend/app/services/slash_command_service.py` | 4 | 命令保护机制 |
| `backend/app/api/connection_profiles.py` | 4 | 保持独立，与 ST connection-manager 共存 |

## 预期最终状态

### ST 内置扩展兼容性（12 个）

| 扩展 | 当前 | Phase 0-4 后 |
|---|---|---|
| token-counter | ✅ Supported | ✅ Supported |
| regex | ⚠️ Partial | ✅ Supported（双向同步） |
| quick-reply | ⚠️ Partial | ✅ Supported（#qr_bar 可见） |
| caption | ⚠️ Partial | ⚠️ Partial（vision 需配置） |
| tts | ⚠️ Partial | ⚠️ Partial（provider 限制） |
| memory | ⚠️ Partial | ✅ Supported（Palink memory_module 降级） |
| attachments | ⚠️ Partial | ✅ Supported（后端端点补齐） |
| expressions | ❌ Native-only | ✅ Supported（sprite 端点已有） |
| vectors | ❌ Native-only | ✅ Supported（interceptor + 端点补齐） |
| gallery | ❌ Native-only | ✅ Supported（images 端点已有） |
| assets | ❌ Native-only | ✅ Supported（extensions install 真实） |
| connection-manager | ❌ Native-only | ✅ Supported（connection 端点补齐） |

### 预期完整兼容率

- **当前**：约 25% 完整兼容
- **Phase 0-4 后**：约 85% 完整兼容（10/12 内置扩展）
- **Phase 5 验证后**：约 90%+ 完整兼容（视第三方插件实际测试）

## 风险与注意事项

1. **ST sidecar 依赖**：Phase 3 多个端点依赖 ST sidecar 可用，需确保容器正常运行
2. **api_key 安全让步**：connection-manager 明文存 localStorage，接受（兼容优先）
3. **Palink 原生功能降级**：memory_module 默认禁用可能影响依赖它的 Palink 原生功能
4. **extension_settings 全局共享**：放弃隔离后插件可互相污染设置（ST 原生行为）
5. **斜杠命令覆盖**：允许 ST 覆盖大部分命令会改变 Palink 行为，用户需知晓
6. **E2E 测试稳定性**：Playwright 测试可能 flaky，需合理设置超时和重试

## 执行建议

1. **Phase 0/1/2 并行执行**（P0 优先级）
2. **Phase 3/4 顺序执行**（Phase 3 完成后执行 Phase 4）
3. **Phase 5 最后执行**（验证所有修复）
4. **每个 Phase 完成后跑全量回归**（确保不引入新问题）
5. **后端改动后重建容器**（`docker compose build backend && docker compose up -d backend`）
6. **前端改动后类型检查**（`cd frontend && npx tsc --noEmit`）

## 后续工作（不在本 Spec 范围）

- ST Native 模式完善（兜底方案）
- Palink extension-market 与 ST assets 整合
- 第三方插件的深度兼容（如向量检索、trigger 系统）
- 性能优化（interceptor 调用、extension_settings 持久化）
