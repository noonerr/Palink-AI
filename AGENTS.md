# AGENTS.md — Palink-AI 开发方向声明

> 所有 agent（Claude Code / Codex / TRAE / 其他）在修改本项目前，请先阅读本文件。
> 本文件描述**当前主攻方向**，避免误解代码意图。

## 当前主攻：palink-native 模式

本项目目前**只维护和优化** **`palink-native`** **模式**（Palink 原生提示词装配 + Palink 前端插件体系）。

### 三种 silly\_tavern\_mode 的状态

| 模式              | 含义                                                 | 状态                                  |
| --------------- | -------------------------------------------------- | ----------------------------------- |
| `palink-native` | Palink 原生提示词装配（后端 `build_character_chat_messages`） | **主攻、唯一维护、唯一可达**                    |
| `st-compat`     | 服务端 ST 1.18 对齐装配（后端 `build_st_compat_messages`）    | **已于 2026-09-03 删除**（091023e）        |
| `st-native`     | iframe 嵌入完整 SillyTavern（前后端 ST sidecar 链路）         | **已于 2026-09-03 删除**（aeb8348/4eadb86） |

### 重要约定

1. **ST 双轨已于 2026-09-03 删除完毕**（用户授权，三笔 commit：`091023e` 阶段1 后端装配、`aeb8348` 阶段2 前端/静态/nginx、`4eadb86` 阶段3 路由/部署/源码副本）。权威施工 spec：`docs/SPEC_ST双轨剥离删除_st-compat与st-native_2026-09-03.md`。
   - 历史脉络：2026-08-24 运行时强制封存（MODE-SEALED）→ 2026-09-03 代码剥离删除。封存守卫（`SEALED_ST_MODES`/`_st_mode_effective`/`_is_st_compat_mode`）已随删除消失，无解封开关。
   - `silly_tavern_mode` / `silly_tavern_theme` 字段已于 2026-09-04 A1 收尾全链删除（`bbfe0f0`，alembic 0062 drop 列，DB 已迁移）。**T1 红线：`backend/app/core/migrations.py` 的 `_RUNTIME_COMPAT_COLUMNS` 补列清单禁止回填这两列**（否则后端重启把列重建回来）。PUT 请求体携带这两个旧键会被 pydantic 静默忽略（合法行为，非 bug）。
2. **残留清理未完成的部分**（后续如要动，需另立议题）：
   - `st_groups.py` 虽名为 st_ 前缀，实为 **Palink 自有群聊后端**。**勿按名字误删**。
     ⚠️ 消费链已于 2026-09-20 变更（原描述"消费方 `NativeRoleplayChat` 的 groupChatManager"已失效）：该组件已删除（其 import 在删除前早已注释于 `CharacterChat.tsx:69`）。现 `lib/group-chat/*` 的唯一存活消费者是 **`lib/sillytavern/getContext.ts:21`**（向 ST 插件提供 `groupId`/`groups`，并经 `sandbox.ts` 的 `group-chats.js` 模块名下发）。口径：**群聊数据链路仅经插件面可达，第一方群聊 UI 目前为空**；`overview.md` 记录的 ≈85% 后端群聊对齐属该插件面能力。动 `st_groups.py` 前按此评估影响面。
   - `st_sync_service.py` 为共用模块，被 character/personas/worldbook/character_ext 等主链路引用，**保留**。
   - `backend/app/core/config.py` 的 `ST_NATIVE_*` 字段仍在用（`silly_tavern.py` 的 sidecar 转发函数——现仅 elevenlabs 语音三端点消费、`st_sync_service.py`、`core/security.py` 的 N-6 HMAC 签名），2026-09-05 端点瘦身已删 extensions 死代理族；`ST_NATIVE_SERVICE_URL` 的唯一消费链是 elevenlabs 转发，后续如删 elevenlabs 需同批清理。
   - ~~`api/st/native/proxy`、`/csrf-token`、`/api/st/csrf-token` 保留~~ → **均已删除**（第三/四批端点瘦身，2026-09-04/05）。
3. **Palink 前端插件体系（插件沙箱、regex 引擎、generate\_interceptor、`st-plugins/`** **目录）全部属于** **`palink-native`**，与已删的 st-native 无关。
4. 提示词装配唯一模式是 `palink-native`（`silly_tavern_mode` 列已删，装配无模式分支），不要无授权改动装配链。
5. 遇到 `silly_tavern_mode` / `st-compat` / `st-native` 相关代码时，优先按"palink-native 主攻"的立场评估修改影响面。**命名陷阱（勿因名字删）**：`synthesize_tts_st_compat`（Palink TTS 端点，在用）、`'st-compat-v2'`（智能卡 runtime 版本标签）、`st-vec::`（记忆向量前缀）、`get_st_current_user`（共享认证依赖）、`lib/group-chat/`（第一方 UI 已删但它经 `getContext.ts` 活着，勿连带误删）。

## 待办（跨 agent 协作）

- **所有 agent 在动工前请先阅读根目录** **`TODOS.md`**（遗留任务、方向决策、进行中的工作项）。

- 它是本项目跨会话/跨 agent 的待办与决策记录，修改前先同步，完成后按其状态更新。

## 核心代码位置

- 后端提示词装配：`backend/app/services/roleplay_prompt_assembly.py`

- 后端消息构建：`backend/app/services/character_message_builder.py`

- 前端插件沙箱：`frontend/src/lib/plugin-system/`

- 前端 ST 插件 runtime：`frontend/src/utils/sillyTavernPluginRuntime.ts`

## 验证

- 后端：`cd backend && python -m pytest tests/`

- 前端：`cd frontend && npx tsc --noEmit`

- 前端自动检查：`cd frontend && npx vitest run`（2026-09-23 起为唯一入口：19 文件 / 318 用例，其中 3 例是转换前既有的 `it.skip`）

  > `npm run test:contract` 与 `frontend/src/lib/sillytavern/__tests__/_tsx-loader.mjs` **已删除**：契约测试全部转入 vitest，浏览器环境由 `vitest.config.ts` 的 `environment: 'jsdom'` + `frontend/src/test/setup-browser-globals.ts` 提供。docs/ 下 2026-09-22 及更早的 spec、报告仍把 `test:contract`（162/173 项）写成回归门禁口径，一律按本条作废并改跑 vitest。

