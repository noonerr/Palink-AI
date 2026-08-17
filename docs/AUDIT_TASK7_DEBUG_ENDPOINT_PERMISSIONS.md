# Task 7: Debug / 管理类端点权限审查报告

- **审计日期**: 2026-07-01
- **审计范围**: `d:\项目\Palink-AI\backend\app\api\` 全部 `*.py`
- **审计员**: Palink-AI 代码审计员
- **审计方式**: 静态代码阅读（只读，未运行容器、未修改任何代码）
- **背景**: 此前在 `backend/app/api/admin.py:121` 的 `get_system_defaults` 端点发现使用 `Depends(get_current_user)` 而非 `Depends(get_admin)`，已修复。现进行全局排查，确认是否还有其他 debug / 管理 / 系统类端点存在类似权限问题。

---

## 1. 审计概览

### 1.1 依赖注入原语

依赖定义见 `backend/app/api/dependencies.py`：

| 函数 | 行号 | 行为 |
|---|---|---|
| `get_current_user` | `dependencies.py:12` | 验证 JWT，返回活跃用户，**不校验角色** |
| `get_admin` | `dependencies.py:44` | 在 `get_current_user` 基础上额外校验 `user.role == "admin"`，否则抛 403 |

ST Native 侧另有自定义鉴权原语（位于 `silly_tavern.py`）：

| 函数 | 行号 | 行为 |
|---|---|---|
| `_user_from_request_token` | `silly_tavern.py:173` | 解析 Authorization Bearer / `token` / `palinkToken` query，验证 JWT + 黑名单 + 用户活跃 |
| `_user_from_st_native_session` | `silly_tavern.py:245` | 解析 ST native 会话 Cookie / `X-Palink-ST-Session` 头 |
| `get_st_current_user` | `silly_tavern.py:269` | 优先会话 Cookie，回退到 token，**不校验角色** |

`st_sync.py` 中的 `_get_current_user`（`st_sync.py:45`）委托到 `_user_from_request_token`，行为同上。

### 1.2 端点总数

- 共扫描 `backend/app/api/` 下 **44** 个 Python 文件
- 命中 `@router.(get|post|put|delete|patch)` 装饰器约 **245** 处（含双装饰器别名）
- 含 `debug|admin|system|internal` 关键字路径或文件的端点约 **27** 个文件命中
- 本报告重点覆盖：`admin.py`、`plugins.py`、`stats.py`、`tts.py`、`silly_tavern.py`、`st_sync.py`、`models.py`、`mcp.py`、`users.py`、`variables.py`、`stt.py`、`tokenizer.py` 等所有包含敏感操作的文件

---

## 2. 端点权限逐文件清单

下表列出所有出现 `get_current_user` / `get_admin` 依赖的端点。**斜体行**为含 debug/admin/system/internal 关键字或具备管理性质的端点。

### 2.1 `admin.py`（38 个端点）

| 行号 | 方法 | 路径 | 依赖 | 评估 |
|---|---|---|---|---|
| 96 | GET | `/providers` | `get_admin` | OK |
| 101 | POST | `/providers` | `get_admin` | OK |
| 107 | DELETE | `/providers/{provider_id}` | `get_admin` | OK |
| *120* | *GET* | *`/system/defaults`* | *`get_admin`* | *OK（此前已修复）* |
| *131* | *POST* | *`/system/defaults`* | *`get_admin`* | *OK* |
| *145* | *GET* | *`/users`* | *`get_admin`* | *OK* |
| *175* | *DELETE* | *`/users/{user_id}`* | *`get_admin`* | *OK* |
| *236* | *POST* | *`/users/{user_id}/reset_password`* | *`get_admin`* | *OK* |
| *251* | *GET* | *`/users/{user_id}/chats`* | *`get_admin`* | *OK* |
| *263* | *GET* | *`/sessions/{sid}/messages`* | *`get_admin`* | *OK* |
| *276* | *POST* | *`/recommendations/starters`* | *`get_admin`* | *OK* |
| *297* | *POST* | *`/models/local/upload`* | *`get_admin`* | *OK* |
| *310* | *PUT* | *`/models/local/{model_ref}/enable`* | *`get_admin`* | *OK* |
| *325* | *PUT* | *`/models/local/{model_ref}/mmproj`* | *`get_admin`* | *OK* |
| *349* | *GET* | *`/models/local/mmproj-files`* | *`get_admin`* | *OK* |
| *368* | *PUT* | *`/models/local/{model_ref}/mmproj-path`* | *`get_admin`* | *OK* |
| *405* | *PUT* | *`/models/local/{model_ref}/max-concurrent`* | *`get_admin`* | *OK* |
| *436* | *PUT* | *`/models/local/{model_ref}/vision-source`* | *`get_admin`* | *OK* |
| *473* | *DELETE* | *`/models/local/{model_ref}`* | *`get_admin`* | *OK* |
| *486* | *PUT* | *`/providers/{provider_id}/models/{model_id}/vision-support`* | *`get_admin`* | *OK* |
| *539* | *POST* | *`/test-provider`* | *`get_admin`* | *OK* |
| *594* | *POST* | *`/sync-models`* | *`get_admin`* | *OK* |
| *646* | *GET* | *`/image-cleanup`* | *`get_admin`* | *OK* |
| *659* | *PUT* | *`/image-cleanup`* | *`get_admin`* | *OK* |
| *674* | *POST* | *`/image-cleanup/run`* | *`get_admin`* | *OK* |
| *731* | *GET* | *`/web-search`* | *`get_admin`* | *OK* |
| *735* | *POST* | *`/web-search`* | *`get_admin`* | *OK* |
| *748* | *POST* | *`/web-search/test`* | *`get_admin`* | *OK* |
| *767* | *GET* | *`/auth/config`* | *`get_admin`* | *OK* |
| *788* | *POST* | *`/auth/config`* | *`get_admin`* | *OK* |
| *812* | *GET* | *`/oauth/providers`* | *`get_admin`* | *OK* |
| *831* | *POST* | *`/oauth/providers`* | *`get_admin`* | *OK* |
| *853* | *DELETE* | *`/oauth/providers/{provider}`* | *`get_admin`* | *OK* |
| *865* | *POST* | *`/oauth/providers/{provider}/test`* | *`get_admin`* | *OK* |

**结论**: `admin.py` 全部 38 个端点均使用 `get_admin`，**此前 `get_system_defaults` 的 bug 已彻底修复**。

### 2.2 `plugins.py`（11 个端点）

| 行号 | 方法 | 路径 | 依赖 | 评估 |
|---|---|---|---|---|
| 908 | GET | `` | `get_current_user` + 函数内 `if user.role != "admin": raise 403` | ⚠️ 见问题 P-1 |
| *919* | *GET* | *`/runtime/config`* | *`get_current_user`* | *⚠️ 见问题 P-2* |
| 948 | GET | `/{plugin_id}` | `get_admin` | OK |
| 962 | POST | `/import` | `get_admin` | OK |
| 1012 | GET | `/{plugin_id}/asset/{asset_path:path}` | `get_current_user` | 静态资源代理，可接受 |
| 1043 | POST | `/import/regex-target` | `get_current_user` | 仅写入 regex 脚本到当前用户，可接受 |
| 1088 | PUT | `/{plugin_id}/toggle` | `get_admin` | OK |
| 1103 | PATCH | `/{plugin_id}/config` | `get_admin` | OK |
| 1164 | PUT | `/{plugin_id}/scripts/{script_id}/toggle` | `get_admin` | OK |
| 1182 | DELETE | `/{plugin_id}` | `get_admin` | OK |
| 1197 | GET | `/active/regex` | `get_current_user` | OK（仅返回当前用户激活的正则） |

### 2.3 `stats.py`（2 个端点）

| 行号 | 方法 | 路径 | 依赖 | 评估 |
|---|---|---|---|---|
| 228 | GET | `/usage` | `get_current_user` | OK（仅返回当前用户自己的 usage） |
| *237* | *GET* | *`/admin/usage/{user_id}`* | *`get_admin`* | *OK* |

### 2.4 `tts.py`（24 个端点，节选管理类）

| 行号 | 方法 | 路径 | 依赖 | 评估 |
|---|---|---|---|---|
| 428 | GET | `/config` | `get_current_user` | OK（公开配置，仅含 provider 元数据） |
| *438* | *POST* | *`/config`* | *`get_admin`* | *OK* |
| 468 | GET | `/providers` | `get_current_user` | OK |
| 474 | POST | `/providers` | `get_admin` | OK |
| 510 | PUT | `/providers/{provider_id}` | `get_admin` | OK |
| 544 | POST | `/providers/{provider_id}/fetch-voices` | `get_admin` | OK |
| 566 | PUT | `/providers/{provider_id}/voices` | `get_admin` | OK |
| 593 | POST | `/providers/{provider_id}/prefetch-voices` | `get_admin` | OK |
| 680 | GET | `/providers/{provider_id}/cached-voices` | `get_current_user` | OK |
| 694 | DELETE | `/providers/{provider_id}` | `get_admin` | OK |
| *757* | *GET* | *`/management`* | *`get_current_user`* | *⚠️ 见问题 P-3* |
| *783* | *PUT* | *`/admin/default-bindings`* | *`get_admin`* | *OK* |
| 796 | GET | `/my/bindings` | `get_current_user` | OK |
| 801 | PUT | `/my/bindings` | `get_current_user` | OK |
| 814 | GET | `/characters/{character_id}/voice-bindings` | `get_current_user` | OK |
| 824 | PUT | `/characters/{character_id}/voice-bindings` | `get_current_user` | OK |
| 849 | GET | `/clone-samples` | `get_current_user` | OK |
| 855 | POST | `/clone-samples` | `get_current_user` | OK |
| 913 | DELETE | `/clone-samples/{sample_id}` | `get_current_user` | OK |

### 2.5 `silly_tavern.py`（约 60 个端点，全部使用 `get_st_current_user` 或自定义鉴权）

| 类别 | 代表行号 | 依赖 | 评估 |
|---|---|---|---|
| 公开 | 1370 `/version`, 1375 `/api/st/version`, 1458 `/csrf-token`, 1463 `/api/st/csrf-token` | 无 | OK（与 ST 协议对齐，无敏感数据） |
| ST native 鉴权 | 1380 `/api/st/native/status`, 1412 `/api/st/native/auth`, 1429 `/api/st/native/login`, 1468 `/api/backends/chat-completions/status`, 1683 `/api/settings/get`, 1733 `/api/settings/save`, 1748 `/api/characters/all`, 1774 `/api/characters/get`, 1810 `/api/characters/edit`, 1897 `/api/characters/create`, 1938 `/api/characters/delete`, …, 3690 `/api/openai/generate-image`, 3697 `/api/vector/index`, 3704 `/api/vector/query`, 3711 `/api/translate`, 3718 `/api/search` | `get_st_current_user` | OK（自定义鉴权原语验证 JWT + 黑名单 + 用户活跃，与 `get_current_user` 等价；ST 协议要求支持 cookie + 多种 token 入口，不能直接复用 `Depends(get_current_user)`） |
| 头像/缩略图 | 1506 `/thumbnail`, 1507 `/api/st/thumbnail`, 1524 `/characters/{avatar_key:path}`, 1525 `/api/st/characters/{avatar_key:path}` | `_user_from_st_native_session` ‖ `_user_from_request_token` | OK（鉴权且按 `user.id` 过滤角色归属） |
| tokenizer 兼容 | 1487 `/api/tokenizers/{tokenizer_name}/{operation}` | 无 | 见问题 P-4 |

### 2.6 `st_sync.py`（6 个端点，全部使用 `_get_current_user`）

| 行号 | 方法 | 路径 | 评估 |
|---|---|---|---|
| 64 | GET | `/status` | OK |
| 74 | POST | `/character` | OK（按 `Character.user_id == user.id` 过滤） |
| 100 | POST | `/session` | OK（按 `user.id` 过滤） |
| 150 | POST | `/worldbook` | OK（按 `user.id` 过滤） |
| 172 | POST | `/all` | OK |
| 191 | POST | `/clean-markup` | **无鉴权**——见问题 P-5 |

### 2.7 其他文件汇总

| 文件 | 端点数 | 依赖策略 | 评估 |
|---|---|---|---|
| `auth.py` | 6 | `get_current_user` 用于自身 profile/logout，登录/注册等无需鉴权 | OK |
| `models.py` | 6 | 4 个 `get_current_user`，2 个 `get_admin`（`/api/models/unified/strategies` 与 PUT `/api/models/unified/{unified_id}`） | OK |
| `mcp.py` | 11 | 全部 `get_admin` | OK |
| `chat.py` | 4 | `get_current_user` | OK |
| `character.py` | 11 | `get_current_user` | OK（按 `user_id` 隔离） |
| `sessions.py` | 8 | `get_current_user` | OK（按 `user_id` 隔离） |
| `memory.py` | 6 | `get_current_user` | OK（按 `user_id` 隔离） |
| `personas.py` | 6 | `get_current_user` | OK |
| `presets.py` | 7 | `get_current_user` | OK |
| `prompt_manager.py` | 4 | `get_current_user` | OK |
| `regex_scripts.py` | 5 | `get_current_user` | OK |
| `themes.py` | 5 | `get_current_user` | OK |
| `connection_profiles.py` | 5 | `get_current_user` | OK |
| `worldbook.py` | 7 | `get_current_user` | OK（按 `user_id` 隔离） |
| `worldbook_blueprints.py` | 6 | `get_current_user` | OK |
| `image_generation.py` | 5 | 4 个 `get_current_user`，1 个 `get_admin`（PUT `/config`） | OK |
| `expressions.py` | 8 | `get_current_user` | OK |
| `instruct_templates.py` | 6 | `get_current_user` | OK |
| `context_templates.py` | 6 | `get_current_user` | OK |
| `extension_prompts.py` | 3 | `get_current_user` | OK |
| `sd.py` | 7 | `get_current_user` | OK |
| `smart_card_assets.py` | 2 | `get_current_user` | OK |
| `tokenizer.py` | 4 | `get_current_user` | OK（公开 tokenizer 服务） |
| `users.py` | 2 | `get_current_user` | OK（仅当前用户 settings） |
| `variables.py` | 7 | `get_current_user` | OK（global/local 均按 `user_id` 过滤） |
| `workspace.py` | 8 | `get_current_user` | OK |
| `st_groups.py` | 13 | 自定义 `_user_from_request_token` 类似机制（见该文件） | OK |
| `st_resources.py` | 14 | 同上 | OK |
| `backgrounds.py` | 5 | `get_current_user` | OK |
| `recommendations.py` | 1 | `get_current_user` | OK |
| `plotline.py` | 10 | `get_current_user` | OK |
| `stt.py` | 1 | `get_current_user` | OK |

---

## 3. 发现的问题列表

### 🔴 P-2（高优先级）`plugins.py:919` `GET /api/plugins/runtime/config` 权限不足

- **文件**: `d:\项目\Palink-AI\backend\app\api\plugins.py`
- **行号**: `919-945`
- **路径**: `GET /api/plugins/runtime/config`
- **当前依赖**: `Depends(get_current_user)`
- **问题**: 任何已登录用户（包括非 admin）即可调用此端点，它会查询 `db.query(Plugin).filter(Plugin.enabled == True)` 返回**所有**启用插件（包括 admin 配置的全局插件），并返回每个插件的 `_plugin_runtime_payload`（含 extension_settings、scripts 列表等）。这意味着：
  - 普通用户可枚举 admin 安装的所有插件清单
  - extension_settings 中可能含 admin 配置项（API key 占位符、内部 URL、调试配置等）
  - 插件脚本源代码可被未授权用户拉取
- **建议修复**: 改为 `Depends(get_admin)`，或者按 `user.id` 过滤插件归属，仅返回当前用户可访问的插件。
- **风险等级**: **高**——存在 admin 配置泄漏面，对未授权用户暴露后台插件架构

### 🟡 P-1（中优先级）`plugins.py:908` `GET /api/plugins` 使用手动 admin 检查模式

- **文件**: `d:\项目\Palink-AI\backend\app\api\plugins.py`
- **行号**: `908-916`
- **路径**: `GET /api/plugins`（list_plugins）
- **当前依赖**: `Depends(get_current_user)` + 函数内 `if user.role != "admin": raise HTTPException(403, detail="Admin only")`
- **问题**: 功能上等价于 `get_admin`，但偏离项目统一的依赖注入模式（`get_admin`），易在后续重构中误删内联检查或漏掉审计。
- **建议修复**: 将依赖改为 `Depends(get_admin)`，删除函数体内的 `if user.role != "admin"` 检查。
- **风险等级**: **中**——目前功能正确，但模式不一致带来长期可维护性风险

### 🟡 P-3（中优先级）`tts.py:757` `GET /api/tts/management` 路径名误导且返回全局配置

- **文件**: `d:\项目\Palink-AI\backend\app\api\tts.py`
- **行号**: `757-780`
- **路径**: `GET /api/tts/management`
- **当前依赖**: `Depends(get_current_user)`
- **问题**: 端点名为 `management` 听似 admin 专属，但实际返回的是「当前用户视角下的管理面板数据」：包括 `global_bindings`（admin 设置的默认绑定，公开可见的 provider 配置）、`my_bindings`（当前用户自身）、`clone_samples`（当前用户自身的克隆样本）、`can_admin` flag。数据本身不敏感，但路径名易误导前端误判为 admin 端点。
- **建议修复**: 二选一
  1. 重命名为 `GET /api/tts/management-panel` 或 `GET /api/tts/my-management`，明确语义
  2. 或者将 `global_bindings` 字段拆分到独立 admin 端点，普通用户端点仅返回 `my_bindings` + `can_admin`
- **风险等级**: **中**——目前无数据泄漏，但路径命名易引起后续误用

### 🟢 P-4（低优先级）`silly_tavern.py:1487` `POST /api/tokenizers/{tokenizer_name}/{operation}` 无鉴权

- **文件**: `d:\项目\Palink-AI\backend\app\api\silly_tavern.py`
- **行号**: `1487-1503`
- **路径**: `POST /api/tokenizers/{tokenizer_name}/{operation}`
- **当前依赖**: 无
- **问题**: 该端点对接 ST 客户端的 tokenizer 调用，使用 `_approx_token_ids` 做粗略估算，不返回任何用户私密数据。但完全无鉴权意味着可被外部未授权调用，存在轻度 DDoS 风险（每次调用都跑正则与 token 切分）。
- **建议修复**: 添加 `Depends(get_st_current_user)` 与其他 ST 兼容端点保持一致。
- **风险等级**: **低**——无敏感数据，仅潜在滥用风险

### 🟢 P-5（低优先级）`st_sync.py:191` `POST /api/st/sync/clean-markup` 无鉴权

- **文件**: `d:\项目\Palink-AI\backend\app\api\st_sync.py`
- **行号**: `191-197`
- **路径**: `POST /api/st/sync/clean-markup`
- **当前依赖**: 无
- **问题**: 端点接收 `text` 字段，调用 `clean_smart_card_markup` 做纯文本处理，不访问数据库或用户数据。但路径前缀为 `/api/st/sync/` 与其他鉴权端点同前缀，未鉴权易引起混淆，可被未授权调用消耗 CPU 资源做正则替换。
- **建议修复**: 添加 `Depends(get_current_user)` 或标注为公开端点（如 `/api/public/clean-markup`）以明确语义。
- **风险等级**: **低**——无数据泄漏，仅资源消耗风险

---

## 4. 修复建议优先级

| 优先级 | 问题 | 建议 |
|---|---|---|
| 🔴 高 | P-2 | `plugins.py:919` 改为 `Depends(get_admin)` 或按 `user.id` 过滤插件 |
| 🟡 中 | P-1 | `plugins.py:908` 改为 `Depends(get_admin)`，删除函数体内联检查 |
| 🟡 中 | P-3 | `tts.py:757` 重命名端点或拆分 `global_bindings` 字段 |
| 🟢 低 | P-4 | `silly_tavern.py:1487` 添加 `Depends(get_st_current_user)` |
| 🟢 低 | P-5 | `st_sync.py:191` 添加 `Depends(get_current_user)` 或移到公开前缀 |

---

## 5. 总结

- **审计端点总数**: 约 **245** 个（含双装饰器别名）
- **发现问题总数**: **5** 个（1 高 / 2 中 / 2 低）
- **`admin.py` 全部 38 个端点** 均使用 `get_admin`，**此前 `get_system_defaults` 的 bug 已彻底修复**，无残留
- **ST Native 鉴权**（`silly_tavern.py` / `st_sync.py` / `st_groups.py` / `st_resources.py`）使用自定义 `get_st_current_user` / `_user_from_request_token`，行为与 `get_current_user` 等价，正确实现用户身份验证与数据归属隔离（按 `user_id` 过滤）
- **主要风险点** 集中在 `plugins.py`：`runtime/config` 端点对普通用户泄漏 admin 配置，应优先修复

报告生成完毕。本审计未修改任何代码。
