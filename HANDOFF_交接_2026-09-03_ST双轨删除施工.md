# HANDOFF 交接 — ST 双轨（st-compat / st-native）剥离删除施工（2026-09-03）

> 本文件是**跨 agent 交接**：接手者请先读本文件，再读
> `docs/SPEC_ST双轨剥离删除_st-compat与st-native_2026-09-03.md`（权威调研 spec），
> 开工前同步 `AGENTS.md` 与 `TODOS.md`。

---

## 0. 一句话定位

后端 st-compat 装配线**已删完并拍平**（源码 + 守卫 + A 类测试已处理，均编译通过）；
剩余 = 阶段1 的 C 类用例 + 脚本 + **容器 pytest 验证 + commit**，然后是阶段2（前端/静态/nginx）与阶段3（后端端点/部署/容器）两大批，全部按 spec §8 顺序执行。

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

## 4. 未完成（按 spec §8 顺序）

### 4.1 第一阶段收尾（下一位 agent 第一件事）
1. **C 类用例精确摘除**（勿整删文件！）：
   - `test_group_speaker_selection.py` 删 3 个：`test_natural_stcompat_ignores_follower`、`test_resolve_sealed_stcompat_talkative_uses_native_selector`、`test_resolve_sealed_stcompat_voting_uses_native_selector`（前一个传 st_mode → 现在会 TypeError；后两个测已删的 group policy 回退）
   - `test_single_chat_no_group_leakage.py` 删 2 个直调 `build_st_compat_messages` 的用例（原 L118/L132）
   - `test_st_compat_group_chat_e2e.py` **保留勿删**！它跑的是 palink-native 群聊行为，且 mock 基建被 `test_single_chat_no_group_leakage.py` 跨文件 import
   - `test_d3_speaker_card_swap.py` 保留（实为 native 行为）
2. **脚本删除**：`backend/scripts/_verify_mode_sealed.py`；`scripts/st-compat/` 整目录；`scripts/extract_st_golden_vector.py`；`backend/scripts/_verify_stcompat_e2e.py`；`backend/scripts/_inspect_stcompat_tail.py`；`backend/scripts/_verify_mvu_after_fix.py`
   （删除前先 grep 确认无 import 引用，禁按文件名批量猜）
3. **run_st_acceptance.py**：仅删 WP-K（L892-896 直调 build_st_compat_messages 的部分），整文件第二批再删
4. **阶段1 验证**：`docker compose build backend && docker compose up -d` → 容器内 `python -m pytest tests/` 勾稽 **约 1221 passed**（基线 1340 − 119）→ `grep -rn "build_st_compat_messages\|_is_st_compat_mode\|_st_mode_effective\|ST_COMPAT_MODES\|SEALED_ST_MODES" backend/app` 归零
5. **git commit**（第一批一笔，消息含「阶段1 st-compat 剥离」字样）

### 4.2 第二阶段（前端 + 静态 + nginx，spec §4）
- 前端守卫删除：`SettingsView.tsx`（stMode state/loadMode/handleModeChange/模式选择器卡，L220-345 一带）、`CharacterView.tsx`、`CharacterChat.tsx`（st-native 分支行）、`App.tsx`（stNativeActive 相关 L476/487-489/1094/1105）
- 死组件整删：`SillyTavernIframe.tsx`（无引用）、`RoleplayModeSwitcher.tsx`（无引用）
- `types/index.ts` 清理 silly_tavern_mode 相关类型
- `frontend/public/st/` 整目录删除（30MB 静态 ST 副本）
- public 根三文件：`palink-silly-tavern-loader.js`、`palink-silly-tavern-theme.css`、`palink-smart-card.js`（删前 grep 确认无引用；智能卡 runtime 是 Vite 插件从源码生成，不依赖 public/st）
- nginx：删 `/st/` 块、无前缀 root-html/st fallback 块、**整个 8081 server 块**（auth_request → /api/st/native/auth）
- **`test_st_contract.py` 删 3 个 bridge.js 用例必须与 public/st 删除同批**（`test_bridge_js_file_exists`/`test_real_api_paths_non_empty`/`test_palink_owned_endpoints_in_bridge_js`），否则文件消失 FAIL
- 验证：`npx tsc --noEmit` + `npm run test:contract` + `npm run build`
- 注意 `lib/sillytavern/__tests__/` 5 个文件零改动（插件体系依赖）；仅 runtime-contract.test.ts L168 一条注释提及 SillyTavernIframe 可顺手清

### 4.3 第三阶段（后端端点 + 部署，spec §4）
- 整文件删 + 从 `backend/app/api/__init__.py` 摘挂载：`st_sync.py`、`st_groups.py`、`st_resources.py`、`openai_compat.py`（openai_compat 唯一外部消费者 = ST 容器）
- 删端点：`/api/st/native/status|auth|login`、`/api/st/version`
- `st_sync_service.py` **整文件保留**（6 个模块在用），只逐函数摘 ST 专属块
- `docker-compose.yml`：删 `sillytavern` 服务、frontend `depends_on` 里的 ST、4 个卷、backend env 里 ST_NATIVE_*
- `config.py`：删 `ST_NATIVE_*`；`.env.example`：删 L176-193
- `git rm -r SillyTavern-1.18.0/`（983 文件，441MB，`.git` 内）
- 冒烟：3000 OK、9061 已无容器、`/st/index.html` 404

### 4.4 收尾
- TODOS.md 登记 + 每批一个 commit + 更新本交接文件的状态段

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
