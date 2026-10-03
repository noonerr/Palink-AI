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

- 前端自动检查：`cd frontend && npx vitest run`（2026-09-23 起为唯一入口；2026-10-03 实测基线：**50 文件 / 665 passed + 3 skipped**，其中 3 例是转换前既有的 `it.skip`。⚠️ 文件与用例数随并行会话增长，别把固定数字当验收线，只认 `failed = 0`）

  > `npm run test:contract` 与 `frontend/src/lib/sillytavern/__tests__/_tsx-loader.mjs` **已删除**：契约测试全部转入 vitest，浏览器环境由 `vitest.config.ts` 的 `environment: 'jsdom'` + `frontend/src/test/setup-browser-globals.ts` 提供。docs/ 下 2026-09-22 及更早的 spec、报告仍把 `test:contract`（162/173 项）写成回归门禁口径，一律按本条作废并改跑 vitest。

- ⚠️ **提交 ≠ 上线**：改了后端必须 `docker compose build backend && up -d backend`，
  改了前端必须重建 dist 并确认容器在服务新指纹。**提交完不重建容器 = 用户跑的是旧代码**
  （2026-10-03 踩过：提交了 ST 世界书绑定修复却忘重建，容器内 grep 命中数为 0）。

- ⚠️ **声称「已完成」前必读** `docs/SOP_Agent交付自查清单.md`（2026-10-03 立）。
  那一轮审查发现：承诺 12 项实测 9 真修 / 2 未做 / 3 假修，另有 4 条记录本身写错、3 次日期写成次日。
  重点是这几条容易复发的：**①「文件消失」要先回原目录确认，消失≠被删（可能压根没复制）**
  **② 改数据契约后测试集体红属预期连带成本，先看同批测试在来源工作区是否绿，别急着回退源码**
  **③ 按清单改完必须再全仓 grep 一次（清单本身会漏）**。

## 备份与清理规范（强制 · 2026-09-30 起施行）

> 适用于所有 agent（Claude Code / Codex / TRAE / WorkBuddy / 其他）。违反第 1、2、4、5 条视为事故。

1. **唯一备份区**：所有代码/数据备份一律放入 `D:\项目\Palink-AI\_BACKUPS\YYYY-MM-DD_主题名\`。
   **禁止**在项目根目录、`D:\`、`D:\项目\` 或任何其他位置新建备份目录或备份文件。
   2026-09-30 之前散落在上述位置的备份已全部归置进来（详见 `_BACKUPS/_INDEX.md`），此后新出现的区外备份一律按违规残留处理。
2. **说明文件强制**：每个备份目录必须含 `BACKUP_INFO.md`，四项要素缺一不可 ——
   ① 备份日期 ② 原始来源路径 ③ 备份原因 ④ **后续待办清单**（备份之后需要修复或修改的任务）。
   **没有说明文件的备份视为无效备份**，不被承认，也不得引用其结论。
3. **台账登记**：每次备份完成后必须更新 `_BACKUPS/_INDEX.md`，登记「备份日期 / 目录名 / 原始来源 / 备份原因」。
   台账的目的是可追溯：任何人都能从新位置找回原来的东西。
4. **禁止动存量备份**：任何 agent **不得删除或改写已有备份的内容**。
   本次归置只改变位置，目录内部零改动、零重命名。需要历史文件时，**复制**出来用，不要在原备份上改。
5. **清理三步，禁止直删**：清理工作区前必须先输出明确待删清单并取得用户确认，流程固定为
   **① 列清单 → ② 隔离到 `_BACKUPS/_QUARANTINE_<日期>/`（保留原相对路径，随时可拷回）→ ③ 门禁验证通过且用户确认后再删除**。
   禁止跨过确认直接删除任何文件。
6. **红线，一律不动**：
   - `frontend/dist` —— 容器 nginx bind mount 的在用产物，**删除或改名即前端白屏**（2026-09-30 清理已确认此边界）。
   - `backend/data` —— 412MB 业务数据（上传物、历史库）。
   - 根级 `图片/`、`记忆/`、两个 `屏幕录制*.mp4` —— 用户私人素材，非产出物。
   - `.claude/` `.codex/` `.trae/` `.workbuddy/` `.githooks/` 等 agent 与钩子配置目录。
7. **git 边界**：`.gitignore` 已配置「`_BACKUPS/**` 全部排除 → 仅放行 `_INDEX.md` 与各 `BACKUP_INFO.md`」。
   备份产物（repo.bundle / *.tar.gz / *.tgz / 源码全量拷贝等约 12GB）**永不入库**，
   但台账与说明文件**必须入库**。禁止用 `git add -A` / `git add .` 绕过该规则（多 agent 合住仓库，一律逐项 pathspec 暂存）。
8. **同步范围**：本规范同步记录于 `.workbuddy/memory/MEMORY.md`，两处保持一致，改一处即改另一处。

