# Goal 验证报告：ST 插件后端完美兼容（Phase 3+4+5）

- **分支**: `st-plugin-compat-20260727`
- **验证时间**: 2026-07-28
- **目标**: Palink 后端完整兼容 ST 1.18.0 插件所需端点与行为（Phase 3 端点补齐 + Phase 4 双轨让步 + Phase 5 验证）

## 1. 子任务完成情况（goal-plan.md T1–T9）

| 任务 | 内容 | 状态 | Commit |
|---|---|---|---|
| T1 | 备份关键文件到 `.workbuddy/backups/st-plugin-compat-20260727/` | ✅ | - |
| T2 | 8 个 `/api/vector/*` 端点 ST 双格式实现 + bridge.js 路径 | ✅ | `2bd90d2` |
| T3 | `/api/settings/save` extension_settings 命名空间合并 | ✅ | `877bc94` |
| T4 | `/api/extensions/*` 4 端点真实代理到 ST sidecar | ✅ | `6647596` |
| T5 | Palink memory 对 ST vectors 自动让步（`MEMORY_ST_YIELD`） | ✅ | `b183734` |
| T6 | `/clear` 破坏性命令确认保护（`force=true` 跳过） | ✅ | `230e446` |
| T7 | 契约测试 + tsc 验证 | ✅ | `2b6c71f` |
| T8 | Docker 重建 + 端到端冒烟 | ✅ | `f04d175` |
| T9 | 规范回填 + 本报告 | ✅ | （本次提交） |

## 2. 验证证据

### 2.1 单元/契约测试（容器内 pytest）
- `tests/test_st_vectors_full.py`：**9 passed**
  - insert→list 裸 hash 数组回读、按 hash 去重、query ST 形状 `{metadata,hashes}`、Palink 旧格式向后兼容、query-multi Record、delete 按 hash、purge 集合隔离、purge-all 不误删正常记忆、4 新路由注册探测。
- `tests/test_st_contract.py` 回归：**39 passed / 3 skipped**（无回归）。

### 2.2 端到端冒烟（重建容器后，`tests/smoke_st_vectors.py`）
**11/11 通过**：insert / list / query / query-multi / delete / purge / purge-all / Palink 旧格式 query / settings 命名空间合并（pluginA+pluginB 共存）/ extensions-discover（GET，透传 sidecar 真实系统扩展列表）/ extensions-install 代理（上游状态透传）。

### 2.3 前端类型检查
`npx tsc --noEmit`：仅 `NativeRoleplayChat.tsx` 6 个既有基线错误（233/252/277/278/530/1117 行），**无新增**。

## 3. 过程中发现并修复的真实 bug

1. **`_st_vec_query_collection` 查询恒空**（生产级 bug）：`MemoryStorage.semantic_search` 内部 `MemoryEntry.topics: List[str]` pydantic 校验对 ST dict topics 失败并静默跳过。修复：改用原始 SQL + numpy 余弦相似度（`2b6c71f`）。
2. 测试基建 3 处陷阱（记录于测试文件 docstring）：MemoryStorage 构造函数副作用致 DetachedInstanceError（monkeypatch 模块缓存绕过）；`conversation_memories` 为原生 DDL 表不在 `Base.metadata`（fixture 手动建表+清理）；路由懒挂载致 `app.routes` 仅 6 条（改 HTTP 探测）。

## 4. 已知限制（用户已确认接受）

- regex 双向同步转换器跳过（仅 ST→Palink 单向导入）。
- connection-manager 后端实现、`/api/chats/attachments/*` 未实施（无插件实际阻塞）。
- 前端 dist 中 bridge.js 为手动同步，正式发布需 `npm run build` 重新产出。

## 5. 结论

**验证通过**。8 个向量端点形状与 ST 1.18.0 `src/endpoints/vectors.js` 契约一致，extension_settings 不再被局部保存覆盖，extensions 管理链路经 sidecar 端到端打通，Palink 记忆自动让步避免双重注入，破坏性命令有保护。Phase 3/4/5 目标达成。
