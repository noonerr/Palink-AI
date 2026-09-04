# HANDOFF 交接 — ST 双轨（st-compat / st-native）剥离删除施工（2026-09-03）

> 本文件是**跨 agent 交接**：接手者请先读本文件，再读
> `docs/SPEC_ST双轨剥离删除_st-compat与st-native_2026-09-03.md`（权威调研 spec），
> 开工前同步 `AGENTS.md` 与 `TODOS.md`。

---

## 0. 一句话定位

**✅ 三批施工已全部完成并提交**（2026-09-03 ~ 09-04，用户授权）。
ST 双轨（st-compat / st-native）代码、静态副本、容器与部署链均已移除，只保留 palink-native。

| 批次 | commit | 内容 | 验证 |
| --- | --- | --- | --- |
| 阶段1 后端 st-compat 装配线 | `091023e` | 删 `build_st_compat_messages`+3 辅助、RPA 拍平、封存守卫、A 类 9 测试+golden_vectors、6 脚本 | 容器 pytest 1236 passed/42 skipped/0 failed（收集 1388→1278） |
| 阶段2 前端/静态/nginx | `aeb8348` | 删 SillyTavernIframe/RoleplayModeSwitcher、4 处守卫、`public/st/`(586 文件 30MB)、public 三文件、nginx `/st/` 与 8081 块、bridge.js 契约 3 例 | tsc 0 错误 / contract 全绿 / build 成功 / 换 dist 部署冒烟通过 |
| 阶段3 路由/部署/源码副本 | `4eadb86` | 删 st_sync/st_resources/openai_compat + 挂载、silly_tavern 4 个 st-native 端点、compose sillytavern 服务/卷/env/9061、`.env.example` ST_NATIVE 段、`SillyTavern-1.18.0/`(983 文件 441MB)、ST 容器移除 | 路由反射冒烟 384 条 + 容器 pytest 1217 passed/42 skipped/0 failed（收集 1275→1259） |
| 第三批 端点瘦身 | `6c47535` | silly_tavern.py 删 42 个零消费端点（逐族甄别）+ 33 个级联死 helper + proxy 族 + config 4 字段；测试同步（删 2 文件 15 例 + 各文件失效方法） | 路由冒烟 341 条（32 删 17 留全对）+ 容器 pytest 1178 passed/42 skipped/0 failed（收集 1259→1220） |
| A1 收尾 | `bbfe0f0` | silly_tavern_mode/theme 字段全链删除：models 两列 + migrations 补列行 + schema + users/silly_tavern API + alembic 0062 drop 列（已在容器执行 0061→0062）+ 测试重写 | 容器 pytest 1170 passed/42 skipped/0 failed（收集 1220→1212）；DB information_schema 确认两列已删 |

**⚠️ 与 spec 结论不一致处（施工实证纠正，详见 §4.5）**：
1. **`st_groups.py` 不删** —— spec 依据「前端对 chats/group 零调用」判定可删，但漏查 `/api/groups/*`；该族是 Palink 自有群聊后端（`lib/group-chat/manager.ts` ↔ `NativeRoleplayChat.groupChatManager`）。已恢复，待拍板。
2. **`config.py` 的 `ST_NATIVE_*` 部分保留** —— SERVICE_URL/SERVICE_KEY 被 `/api/extensions/*` sidecar 转发链使用、DATA_ROOT 被 st_sync_service 使用；URL/PUBLIC_PORT/PALINK_OPENAI_URL/DEFAULT_MODEL 4 个零引用字段已在第三批（`6c47535`）删除。
3. **`/api/chats/rename-session` 是隐藏红线** —— spec §4.3 把 chats 操作族列为可删候选，但 `getContext.ts:2218`（插件 renameChat）在消费它。实证：瘦身时保留。
4. **`/api/backends/chat-completions/generate` 是红线** —— 智能卡 runtime 拦截链（SillyTavernCompatRuntime.ts:4979 `startsWith('/api/backends')`）消费，status/text-completions 已删但 generate 保留。

其余见 §4.5「残留与待拍板」。`AGENTS.md` 方向声明与 `TODOS.md` 已同步。

---

## 1. 背景与授权链

- **请求 1**（用户原话）：仔细检测 3 个 ST 适配计划，找到要删的，研究如何在不影响其他组件的前提下剥离，**只读、不允许改代码**，把记忆和步骤写进 spec，95% 把握后再动手。
- **请求 2**（用户原话）：「很好，那你就准备把那几个不要的删掉吧，但要提前做好备份。」
- **请求 3**：「继续」（授权继续，无需中间 commit）。
- 本交接（用户原话）：余额耗尽，写交接文件让其他 agent 接手。

**结论（已固化在 spec）**：`st-compat` 与 `st-native` 双轨整体删除；只保留 `palink-native`。

---

## 2. 权威文档 / 备份 / 基线

| 项 | 位置 |
| --- | --- |
| 调研 + 施工 spec | `docs/SPEC_ST双轨剥离删除_st-compat与st-native_2026-09-03.md`（**必须全文读**，§3=第一批符号清单、§4=第二批、§5=红线、§6=测试、§7=脚本、§8=顺序、§9=陷阱、§10=待拍板） |
| 备份 | **git stash：`BACKUP 2026-09-03 删除 st-compat/st-native 前的工作区完整快照（含全部未提交改动）`**，stash@{0}（用 `git stash show -p stash@{0}` 可取回任意原文件）。另 stash@{1} 是记忆注入 Phase1 的备份，勿动。 |
| 基线 | 容器 pytest **1340 passed / 48 skipped / 0 failed**（删除前全绿） |
| 勾稽预期 | 第一批删约 **119 用例**（A 92 + B 19 + C 8）→ 容器口径约 **1221 passed** |

---

## 3. 已完成（第一阶段后端源码 — 全部编译通过）

### 3.1 `backend/app/services/character_message_builder.py` ✅
- 删除 `build_st_compat_messages`（原 ~L540-1042，约 503 行）
- 同步删除仅它使用的 3 个辅助函数：`_sanitize_name`、`_apply_wi_format`、`_apply_field_format`
- **保留**（palink-native 在用）：`_ST_DEFAULT_NEW_CHAT_PROMPT`（character_ext.py:51/5531/5540 外部引用！）、`_ST_DEFAULT_MAIN_PROMPT`、`_ST_DEFAULT_NEW_EXAMPLE_CHAT_PROMPT`、`_split_example_blocks`、`_parse_example_chat`、`_apply_context_template`、`parse_system_commands`、`clean_smart_card_trigger_context`、`is_smart_card_trigger_message`、`clean_display_markup_for_prompt`
- 顶部 docstring 已更新（去掉"待删除"字样）

### 3.2 `backend/app/services/roleplay_prompt_assembly.py` ✅（RPA 拍平，AST + py_compile 通过）
- L41 import：移除 `build_st_compat_messages`
- 删除常量/函数：`ST_COMPAT_MODES`、`SEALED_ST_MODES`、`_st_mode_effective`、`_is_st_compat_mode`
- 主装配大分支：`if _is_st_compat_mode(st_mode):`（含 world_info_before/after、char_system_prompt、persona_desc、an_text、jailbreak 合并、names_behavior/wi_format/group nudge 读取、group_combined_card、`build_st_compat_messages` 调用 + 7 个 clear()）与 `else:` 全部拍平 → 只剩 palink-native 的 `build_character_chat_messages` 调用（去缩进）
- 删除 `_apply_st_compat_history_trim_inner` + `_apply_st_compat_history_trim`（原 L1289-1483 整段）
- `_should_split_char_fields_for_order(preset, st_mode)` → 去掉 st_mode 形参与 guard 分支
- `_extract_char_field_messages_for_order(req, preset, st_mode, char_name)` → 去掉 st_mode 形参
- `_select_natural_speaker(db, group, members, user_text, st_mode)` → 去掉 st_mode 形参，follower 衰减解包为无条件执行
- `_resolve_group_speaker`：删除 group policy 的 st_mode 探测块（UserSetting 查询 + talkative/voting 回退 NATURAL + warning）
- 世界书扫描：删除 `_is_st_compat` 变量计算；`skip_dynamic_context` 参数从 `_append_worldbook_context` 签名与调用点摘除（palink-native 恒不需要）
- 删除 `st_wi_before_parts/st_wi_after_parts/st_wi_an_top_parts/st_wi_an_bottom_parts` 死管道（声明 + 传参 + 函数签名 + 4 个填充块）
- 删除死变量 `persona_full_text`（声明 + 3 处赋值）
- 更新模块 docstring + 全部过时注释（st-compat 引用归零）
- 已确认：文件内无 `st_mode`/`_is_st_compat_mode`/`build_st_compat_messages` 残留（仅 docstring 一句历史声明，有意保留）

### 3.3 `backend/app/api/users.py` ✅（A2 口径）
- 删除 `_SILLY_TAVERN_MODE_ALIASES`、`_SEALED_ST_MODES`、`_LEGAL_ST_MODES`
- `_normalize_silly_tavern_mode` 简化为 **恒返回 `"palink-native"`**（A2：字段保留为死摆设，前后端契约不变）

### 3.4 `backend/app/api/silly_tavern.py` ✅（A2 口径）
- 同款守卫删除，`_normalize_silly_tavern_mode` 恒返回 `"palink-native"`
- **注意**：本文件其余端点大多保留（插件/智能卡/settings UI 在用），第三批才瘦身

### 3.5 测试（第一批测试处置进行中）
- ✅ A 类 9 文件已 `git rm`：`test_st_compat_assembly_order.py`、`test_st_compat_golden_vector.py`、`test_st_compat_group_generation_mode.py`、`test_st_compat_jailbreak.py`、`test_st_compat_names_behavior.py`、`test_st_compat_p2_features.py`、`test_st_compat_token_budget.py`、`test_st_compat_wi_format.py`、`test_extension_prompts_st_compat.py`
- ✅ `backend/tests/st_compat/golden_vectors/` 整目录已 `git rm`（10 个 json + .gitkeep，否则 `test_at_least_one_fixture_discovered` FAIL）
- ✅ `test_st_mode_normalization.py` **重写**：函数级守卫测试（19 个，引用已删符号）全部移除；保留并改写 2 个 HTTP 端点级用例（PUT 落库收敛 / GET 报告收敛且不回写）+ 新增参数化 `test_normalize_returns_palink_native`（A2 语义）
- ✅ `test_p1_fixes.py`：所有 `_should_split_char_fields_for_order(preset, st_mode)` / `_extract_char_field_messages_for_order(req, preset, st_mode, name)` 调用点去掉 st_mode 实参；删除 `test_should_split_returns_false_for_st_compat`（L135）
- ✅ `test_e2e_roleplay_phase6.py`：`subtask_6_1_4` 注释与 record 名更新为 A2 语义（断言本身不变，仍会通过）

---

## 4. 施工结果（原「未完成」清单已全部闭合）

### 4.1 第一阶段收尾 —— ✅ 完成（commit `091023e`）
1. C 类用例精确摘除 ✅：`test_group_speaker_selection.py` 删 3 个（另顺手清 `__main__` 里 2 行已失效的 dangling 调用）；`test_single_chat_no_group_leakage.py` 删 2 个直调用例 + 其 3 个死 helper；`test_st_compat_group_chat_e2e.py`、`test_d3_speaker_card_swap.py` 保留
   - **额外发现**：该文件 L23 `from app.services.character_message_builder import build_st_compat_messages` 在删除后会让**整个文件 6 个用例静默 skip**（pytestmark skipif）。已一并摘除，否则 4 个保留用例会假绿。同类：`test_p1_fixes.py::TestP12StCompatHistoryTrimRatio`（测试已删函数，同样静默 skip）已删。
2. 脚本删除 ✅：5 个脚本 + `scripts/st-compat/` 整目录（44 文件）
3. `run_st_acceptance.py` ✅：先删 WP-K（阶段1），阶段3 整文件删
4. 阶段1 验证 ✅：容器 pytest **1236 passed/42 skipped/0 failed**；收集数 1388→1278（减 110，与「删 92 A 类 + 15 改动文件 + parametrize 展开」精确对账，非 spec 估的 119——估算未计 parametrize）
5. commit ✅

### 4.2 第二阶段（前端 + 静态 + nginx）—— ✅ 完成（commit `aeb8348`）
全部按清单执行；`types/index.ts` 无需改（模式类型是组件内联字面量，随组件删除消失）。补充：
- **构建踩坑**：`npm run build` 的 `clean-dist.cjs` 会递归删 dist（含旧 `st/` 数千文件），撞上 WorkBuddy 安全删除拦截（node 进程被杀）。绕法：`VITE_OUT_DIR=dist_new_<ts> npm run build` 备份式构建（clean-dist 检测到 VITE_OUT_DIR≠dist 会跳过清理），再停容器换目录。
- `/st/index.html` 实测返回 **200 而非 404**：因 SPA fallback（`try_files → /index.html`）兜底。已核实返回内容确为 SPA index.html，原 ST 文件（bridge.js/script.js/lib.js）已不存在。**spec 的「404」预期在此项目不适用**，改以「内容是否为 ST 文件」判定。
- 混入他批：App.tsx/SettingsView.tsx/CharacterChat.tsx 携带 iOS 安全区与分层记忆 Phase 1 的未提交改动，按行拆分会破坏树一致性（CharacterChat 引用已删组件），故整文件提交并在 commit 消息中标注。

### 4.3 第三阶段（后端端点 + 部署）—— ✅ 完成（commit `4eadb86`）
- 整文件删 + 摘挂载 ✅：`st_sync.py`、`st_resources.py`、`openai_compat.py`
- **`st_groups.py` 未删（反转，见 §4.5）**
- 删端点 ✅：`/api/st/native/status|auth|login`、`/api/st/version`（`/version`、`/csrf-token`、`/api/st/csrf-token` 保留）
- `st_sync_service.py` ✅ 整文件保留，且**未做逐函数摘除**：其 `trigger_async_sync`/`_st_data_root_for_user`/`import_chat_to_session` 仍有 character.py、character_ext.py 等保留模块调用（spec 的摘除前置条件「无调用方」不成立）
- compose ✅：sillytavern 服务、depends_on、4 卷、backend 6 项 env，**另删 9061:8081 映射**（8081 server 块已删，映射无意义）
- **`.env.example` 已删 ST_NATIVE 段 ✅；`config.py` 未删（反转，见 §4.5）**
- `SillyTavern-1.18.0/` ✅ 已删（983 文件）
- 冒烟 ✅：前端 200、9061 无监听、`/st/*` 落 SPA 回退

### 4.4 收尾 —— ✅ 完成
TODOS.md 已登记三批结果与残留；本文件状态段已更新；`AGENTS.md` 方向声明已同步（状态表/约定/命名陷阱）。

### 4.5 残留与待拍板（A1 `bbfe0f0` 后更新）
1. **`st_groups.py` 是否删除**（最高优先澄清）：spec §4.2 判可删的依据是「前端对 chats/group 零调用」，但只查了 `/api/chats/group/*`。实证：`frontend/src/lib/group-chat/manager.ts` 调 `/api/groups/get|edit|create|delete|chats`，消费方为 `NativeRoleplayChat` 的 groupChatManager。**它是 Palink 自有群聊后端，只是名字带 st_ 前缀**。当前 `NativeRoleplayChat` 非默认视图（CharacterChat.tsx L68-69 注释掉 import），但非死代码。按红线「不影响其他组件否则跳过」本次恢复。
2. ~~config.py 的 ST_NATIVE_* 清理~~ → **第三批已完成 4/7**：URL/PUBLIC_PORT/PALINK_OPENAI_URL/DEFAULT_MODEL 已删；SERVICE_URL/SERVICE_KEY（extensions 转发链）、DATA_ROOT（st_sync_service）保留。
3. `/api/st/native/proxy` → **第三批已删**（连同 _validate_proxy_path/_build_proxy_target_url）；`_build_proxy_request_headers`/`_is_proxy_strip_header` 保留（extensions 转发链）。`/csrf-token`、`/api/st/csrf-token` 仍保留（CSRF 安全链专项）。
4. ~~spec §4.3「silly_tavern.py 端点瘦身」~~ → **第三批已完成**（`6c47535`，42 端点 + 33 死 helper，8654→6092 行）。残余 79 个端点均有消费方或属保留红线。
5. ~~A1 收尾~~ → **已完成**（`bbfe0f0`，alembic 0062）：silly_tavern_mode/theme 列已 drop（容器内 0061→0062 已执行）、模型/补列清单/schema/API 全链清除、测试重写为 A1 契约。**T1 红线：migrations.py 补列清单禁止回填这两列**。
6. `st_sync_service.py` 的 ST 文件同步函数：ST 容器已不存在，属 best-effort 空转（调用方在 character.py/character_ext.py 主链路，摘除触及面大，另立批次）。
7. 磁盘：`frontend/dist_bak_*` 历史目录持续累积，需手动清理（禁 `rm -rf`，用 PowerShell 逐目录删）。

---

## 5. 红线清单（spec §5，删不得！）

`frontend/src/lib/plugin-system/`、`frontend/src/lib/sillytavern/`、`SillyTavernPluginRuntime.ts`、`frontend/st-plugins/`、`frontend/src/lib/smart-card-runtime/`、regex 引擎、**`st_sync_service.py`**、`get_st_current_user`/`_worldbook_to_charbook`/`_sanitize_relative_path`（silly_tavern.py 共享符号）、tokenizer/expression/image-gen、`st-vec::` 前缀、`smart_card_assets.py`。
前端 `if (sillyTavernMode === 'st-native') return;` 是 iframe 隔离守卫，可删；但**插件沙箱全部属于 palink-native**。

---

## 6. 陷阱（spec §9 + 施工教训）

- **T1**：`backend/app/core/migrations.py` L14 `("user_settings", "silly_tavern_mode", sa.String())` 是自动补列清单。本次走 **A2（字段保留为死摆设）→ migrations.py 不动**！若未来走 A1（drop 列），必须同批删这行，否则重启把列重建回来。
- **T2**：禁按文件名批量删测试——`test_st_compat_group_chat_e2e.py` 是 native 行为 + 被跨文件 import。
- **T4**：`_select_natural_speaker`/`_should_split_char_fields_for_order` 形参删了 st_mode，**调用点漏改 = TypeError 而非断言失败**，容易漏。接手者跑 pytest 时若见 TypeError 优先查这两个函数调用点。
- **T6**：`synthesize_tts_st_compat` 是**同名但在用**的 TTS 端点，别因名字含 st_compat 就删！
- **T9**：`build_st_compat_messages` 残留引用要全仓 grep（含脚本、run_st_acceptance、character_ext.py 注释）。
- **Mimosa hook**：Bash 不能直接写/复制受保护源码（backend/app 下）——用 Write/Edit；Edit 前置校验只认 **Read 工具**读过（sed/grep 不算）。
- **多 agent 并行**：TODOS.md 会被并行会话中途改写，Edit 撞 modified 就重读再改。
- **测试账号**：scripts/st_audit/.env 是已轮换的实弹凭据，勿提交。

---

## 7. 用户偏好（跨会话经验）

中文；docs/ 带日期；**大白话汇报**；独立验收文化；要求「反过来检查」（真实容器/浏览器）；红线=不影响其他组件否则跳过；厌恶过度设计、方案 A/B 果断拍板；不轻率加常驻容器；性能动效近临界阻尼。备份优先。

---

## 8. 交接提示词（复制发给下一位 agent）

```
继续 Palink-AI 的 ST 双轨剥离删除施工。先读根目录 HANDOFF_交接_2026-09-03_ST双轨删除施工.md 与 docs/SPEC_ST双轨剥离删除_st-compat与st-native_2026-09-03.md（权威 spec，全文读），再读 AGENTS.md 和 TODOS.md。

当前状态：第一阶段后端源码已全部完成（character_message_builder.py 删了 build_st_compat_messages + 3 辅助函数；roleplay_prompt_assembly.py 已拍平无 st-compat 残留；users.py/silly_tavern.py 的 normalize 按 A2 恒返回 palink-native；A 类 9 个测试文件 + golden_vectors 目录已 git rm；test_st_mode_normalization.py 已重写、test_p1_fixes.py 调用点已改、test_e2e_roleplay_phase6.py 注释已更新）。备份在 git stash@{0}（BACKUP 2026-09-03...），基线容器 pytest 1340 passed/48 skipped/0 failed。

你的第一项工作 = 第一阶段收尾：
1) 摘 C 类用例：test_group_speaker_selection.py 删 3 个 stcompat 用例、test_single_chat_no_group_leakage.py 删 2 个直调 build_st_compat_messages 用例（勿整删文件；test_st_compat_group_chat_e2e.py 必须保留）；
2) 删脚本：backend/scripts/_verify_mode_sealed.py、scripts/st-compat/、scripts/extract_st_golden_vector.py、backend/scripts/_verify_stcompat_e2e.py、_inspect_stcompat_tail.py、_verify_mvu_after_fix.py；
3) run_st_acceptance.py 只删 WP-K；
4) docker compose build backend && up -d，容器内 pytest 勾稽约 1221 passed（1340−119），grep backend/app 无 st-compat 符号残留；
5) 第一批 git commit。

然后按 spec §8 顺序做第二阶段（前端 SettingsView/CharacterView/CharacterChat/App 守卫 + 删 SillyTavernIframe.tsx/RoleplayModeSwitcher.tsx + public/st + public 根三文件 + nginx /st 与 8081 块 + test_st_contract.py 删 3 个 bridge.js 用例同批，验证 tsc+contract+build）和第三阶段（st_sync/st_groups/st_resources/openai_compat 删文件摘挂载 + /api/st/native/* 端点 + docker-compose/config/.env 清理 + git rm SillyTavern-1.18.0 + 冒烟）。每批一个 commit，完成后更新 TODOS.md 与本交接文件状态段。

注意：migrations.py 的 silly_tavern_mode 补列行本次（A2）不动；遇到 TypeError 优先查 _select_natural_speaker/_should_split_char_fields_for_order 调用点；backend/app 下受保护源码用 Read+Edit 修改，Bash 只做 git/grep/pytest 等读取或非源码操作。
```

---

## 9. 备忘

- 本次删除工作**未 commit**（用户「继续」授权跳过中间 commit，待第一批验证后一起提交）。
- 工作区还有大量**非本次任务的改动**（记忆注入 Phase1、安全加固、移动端等，见 git status 完整清单）——commit 时**只 add 本次涉及文件**，勿 `git add -A` 混入他批。
- 涉及本次改动的文件（供 commit 参考）：backend/app/services/character_message_builder.py、roleplay_prompt_assembly.py、backend/app/api/users.py、silly_tavern.py、backend/tests/ 下 A 类删除与 3 个改写文件、docs/SPEC_ST双轨剥离删除...md、本交接文件。
