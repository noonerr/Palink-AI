# 变量面板不显示变量 —— 详细交接文件

> 日期：2026-08-17
> 状态：**未解决**。已部署两次 `getMvuData` 修复，均未让角色面板显示变量。
> 交接目的：把已查清的事实、已尝试的修复、头号阻塞点、下一步验证路径完整交代，避免接班人重复盲调。

---

## 0. 一句话现状

角色面板（Galgame / 数据库界面插件）不显示变量；但**正文（AI 输出）能看到变量文字**。
已做两次 `getMvuData` 修复（特调版 `824f9ad` + 忠实版 `dist_fix_20260817191450`），**面板依旧空白**。
根因大概率**不在"shim 缺 getMvuData 函数"这一层**，而在：① 插件源码不可得（只在 DB），无法确认面板到底读哪个字段；② 面板消费路径未厘清（可能根本不走 `getMvuData`）；③ 可能 `chatVariableStore.stat_data` 在面板渲染时尚未注入（时序）。

---

## 1. 精确症状

- 正文（AI 回复流）能看到变量文字（如好感度数值）。
- 角色面板（服饰 / 内心想法 / 头像 / 状态条等动态内容）显示空或 `---`。
- 注意：早期 memory 旧注曾称"面板显示 `---` 是后端 stat_data 为空，属正常"。**但如果 AI 确实在生成 `<UpdateVariable>`，面板应当显示**——故必须先确认后端到底有没有下发非空 `stat_data`（见假设 H4）。

---

## 2. 已验证的架构与数据流（事实，非推断）

### 2.1 后端（已读源码确认）
- `backend/app/services/mvu_engine.py`：**Palink 自有 MVU 引擎**。解析 AI 回复中的 `<UpdateVariable>` JSON Patch（RFC 6902 超集 + delta），应用到会话 `stat_data`，并从角色卡 `tavern_helper` zod schema 提取初始默认变量。`__all__` 含 `extract_update_variable_blocks` / `apply_patches` / `build_initial_stat_data` / `MvuEngine`。
- `backend/app/api/websocket.py`（约 611 行）：每条 AI 消息的 `extra.variables` 带 `stat_data`（扁平复合 key，如 `"桃汐.好感度"`）。
- 变量经 websocket 下发给前端。

### 2.2 前端（已读源码确认）
- `frontend/src/hooks/useCharacterChat.ts`：dispatch `palink:mvuVariablesUpdated`，patch `message.extra.variables`。
- `frontend/src/components/ui/custom/Message.tsx` → iframe（smart-card-runtime）→ shim。
- `frontend/src/components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime.ts`：
  - **唯一真源** `chatVariableStore`（529–591 行）；后端 `stat_data` 经 `context-update` 合并进 store（4427–4436 行），并 `emitCompatEvent('VARIABLE_UPDATE_ENDED', chatVariableStore)`。
  - `window.Mvu`（5929–5950 行）：`Object.assign` 注入 `events`（VARIABLE_UPDATE_STARTED/ENDED、CHAT_VARIABLES_UPDATED）、`getAllVariables`、`getVariable`、`setVariable`、`replaceVariables`。
  - `getMvuData`（6387–6452 行，本次新增忠实版）：`getMvuData({type, message_id})` → `{ initialized_lorebooks: {}, stat_data: 嵌套 }`；`type` 默认 `'chat'`，`message_id` 负数=深度索引、`latest`/空→`-1`。
  - `waitGlobalInitialized`（4713 行）= `async () => true`。
  - **裸全局暴露**（面板脚本裸调用所需）：`getAllVariables`/`getVariable`/`setVariable`/`replaceVariables`（5955–5958 行）、`getMvuData`（6440 行 `setCompatFunction`）。
  - **关键既有注释（5952–5954 行）**：面板脚本裸调用 `getAllVariables()` 等必须暴露为 window 全局，否则命中空桩 → 返回 `undefined` → `stat_data` 恒空 → **照片/服饰/内心想法不显示**。这与当前症状高度吻合。

### 2.3 变量 → 提示词 宏链路（已验证接通）
- `frontend/src/lib/macro-engine/definitions/variable-macros.ts`：注册 `getvar`/`setvar`/`getglobalvar`/`setglobalvar`。
- `frontend/src/components/roleplay/NativeRoleplayChat.tsx:313`：确认 `formatMessage` 支持 `{{getvar::x}}` 富宏。
- 宏引擎（2068–2070 行）读 `chatVariableStore`/`globalVariableStore`；后端 `stat_data` 合并进 `chatVariableStore`（4433/532）。→ 变量进提示词链路真实存在。

---

## 3. 已尝试的修复（含 commit / 构建）

### 3.1 特调版（commit `824f9ad`，构建 `dist_fix_20260817185017`）
- 仅 `window.Mvu.getMvuData = (option) => mvuGetAllVariablesFinal()`，**忽略 option**，返回 merged chat store（含 stat_data）。
- 问题：不符合 MVU 契约（不解析 `type`/`message_id`，`stat_data` 形状未保证嵌套）。

### 3.2 忠实版（构建 `dist_fix_20260817191450`，**已部署进容器，但 git 未提交**）
- `mvuResolveSourceVars` 按 `type`/`message_id` 解析来源；`mvuNormalizeStatData` 把后端扁平 `桃汐.好感度` → 嵌套 `stat_data['桃汐']['好感度']`（头像 UUID 绝对化）；`mvuGetMvuDataFinal` 返回 `{ initialized_lorebooks: {}, stat_data }`。
- 校验：`tsc` 零报错；引用的函数均真实存在（已核实 `getCompatChatMessages`@3903、三 store@529/530/546、`pluginGetAllVariables`@6323）。
- **部署确认**：容器 `/usr/share/nginx/html/assets/palink-smart-card-runtime-*.js` 含 `getMvuData` + `initialized_lorebooks` 符号。

### 3.3 结果
两次均**未解决**面板不显示。说明根因不在"shim 缺 `getMvuData` 函数"这一层。

---

## 4. 头号阻塞点（必须解决才能继续定位）

**Galgame / 数据库界面插件源码不在本地 `st-plugins/`**（本地只有 `LittleWhiteBox` 等第三方插件）。它存于 **DB 的 `plugin_scripts` 表**（先前日志确认：约 4MB，"数据库界面插件@bubble改造版"）。

- `.dbg/galgame_script.js` **本地不存在**。规格书 `docs/GALGAME_PLUGIN_PERFECT_COMPAT_SPEC.md:252` 引用的 `galgame_script.js:16194` 也取不到。
- 因此**无法确认面板到底调用 `getMvuData()` 后读哪个字段、还是读 `getAllVariables().stat_data`、还是直接读 `chatVariableStore`**——这是定位真因的必需信息。

---

## 5. 排名假设（下一步逐一验证）

- **H1 时序**：面板/插件在 `chatVariableStore.stat_data` 注入前就调用 `getMvuData` → 拿到空。
  - 验证：浏览器硬刷新，看 console 中 `[VAR-DBG] boot chatVariableStore.stat_data keys=...`（553 行）与 `getMvuData type=... stat_data keys=...`（6431 行）是否为空；若 boot 空但 `context-update` 后有 key，则是时序。
- **H2 形状不符**：插件读 `getMvuData().stat_data` 期望特定嵌套/字段名，与 `mvuNormalizeStatData` 产出不一致（如期望扁平 key、或按角色名分组不同）。
  - 验证：提取 DB 插件源码追消费路径（见 §6）。
- **H3 面板是 Palink 原生组件**：用户说的"角色面板"可能是 `TavernHelperPanel.tsx` 或状态栏，走 `getAllVariables().stat_data` 而非 `getMvuData`。`getAllVariables` 已裸全局暴露（5955 行），但若它读别的字段也会空。
- **H4 后端根本没下发 stat_data**：memory 旧注称"面板显示 `---` 正常，因为后端 stat_data 空"。需先确认后端是否真在生成 `<UpdateVariable>` 并下发。
  - 验证：抓 websocket 消息看 `extra.variables.stat_data` 是否非空。
- **H5 CG 触发器 ≠ 面板**：规格书 §P2-2 说 `getMvuData` 主要用于"特殊 CG 触发器跳过（仅 warn）"，面板显示可能走别的机制。**即修复 `getMvuData` 可能从一开始就打错了杠杆。**

---

## 6. 下一步具体动作（给接班人）

1. **取插件源码**：从 DB `plugin_scripts` 表查出"数据库界面插件@bubble改造版"脚本内容（表名/字段需确认；可 `docker exec` 进 backend 容器或直接查库），存到 `.dbg/galgame_script.js`，然后 `grep -n "getMvuData\|stat_data\|VARIABLE_UPDATE_ENDED\|getAllVariables"` 追它到底怎么消费变量。
2. **抓控制台**：浏览器硬刷新，收集所有 `[VAR-DBG]`、`[STATUSBAR-DBG]` 日志，确认 `stat_data` 在 boot / context-update / getMvuData 调用点各时刻是否为空。
3. **抓 websocket**：确认后端下发的 `extra.variables.stat_data` 是否非空（区分 H4）。
4. **确认面板身份**：确定"角色面板"是 Galgame 插件还是 Palink 原生组件（决定查 `getMvuData` 还是 `getAllVariables` 还是别的）。
5. **查裸全局暴露是否足够**：若面板裸调用 `getMvuData()`，已在 6440 行暴露；若它裸调用别的名字，需在 `setCompatFunction` 补。

---

## 7. 关键文件 / 行速查

| 文件 | 行 | 内容 |
|---|---|---|
| `frontend/src/components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime.ts` | 529–591 | 三 store（local/global/chat）定义 |
| 同上 | 3903 | `getCompatChatMessages` |
| 同上 | 4713 | `waitGlobalInitialized = async () => true` |
| 同上 | 532 / 4433 | 后端 `stat_data` 合并进 `chatVariableStore` |
| 同上 | 4436 | `emitCompatEvent('VARIABLE_UPDATE_ENDED', chatVariableStore)` |
| 同上 | 5929–5950 | `window.Mvu`（events + getAllVariables 等） |
| 同上 | 5952–5958 | 裸全局暴露变量 API（注释说明 stat_data 恒空→面板不显示） |
| 同上 | 6323 | `pluginGetAllVariables` 定义 |
| 同上 | 6328–6385 | `mvuNormalizeStatData`（扁平→嵌套） |
| 同上 | 6387–6452 | `getMvuData` 忠实实现（本次核心改动） |
| `backend/app/services/mvu_engine.py` | 全文 | Palink 自有 MVU 引擎（解析 `<UpdateVariable>`） |
| `backend/app/api/websocket.py` | ~611 | `extra.variables` 带 `stat_data` |
| `docs/GALGAME_PLUGIN_PERFECT_COMPAT_SPEC.md` | §P2-2 (250–259) | Mvu 桩规格（getMvuData/events/waitGlobalInitialized） |
| DB `plugin_scripts` 表 | — | 数据库界面插件源码（**本地无副本，头号阻塞**） |
| `frontend/src/lib/macro-engine/definitions/variable-macros.ts` | 全文 | getvar/setvar 宏注册 |

---

## 8. 本次（及之前）做错 / 没做好的（诚实清单）

- 两次改 `getMvuData` 都**没拿到浏览器功能验证**就宣布"已部署/修好"，把"字符串进产物"等同于"问题解决"。
- 默认根因是"shim 缺 `getMvuData`"，但规格书 §P2-2 暗示 `getMvuData` 主要用于 CG 触发器，**面板显示可能走别的机制——可能从一开始就打错杠杆**。
- 顺着用户说"ST 变量和正文分开有可折叠窗口"，但**未读 ST UI 源码证实**。
- 没先排除 H4（后端是否真下发 `stat_data`），就扎进前端改代码。
- 验证路径搞错（先 grep 容器内错误路径 `dist` 而非 `/usr/share/nginx/html` 虚惊），说明部署拓扑记忆模糊。
- 之前 `git stash -u` 把 `.git` 搞坏（已恢复，代价大）。
- 把"正文能看到变量文字"和"面板不显示"当成同一机制解释——可能错：正文文字可能是后端注入、模型原样输出，与前端无关。

---

## 9. 经验教训（可复用）

- **"代码已部署" ≠ "问题已解决"**：没功能验证不宣布解决。
- **研究结论标清来源**：读源码证实 / 推断 / 顺着用户说，三者分开写，不混。
- **该项目变量是两套 + 可能第三种**：① ST 核心 `getvar/setvar` 宏（→ `chat_metadata.variables`）；② MVU 扩展（→ `stat_data`）；③ 正文变量文字可能来自后端注入（模型原样输出）。机制不同，别混。
- **改同一函数前先让用户 / 控制台验证**，否则迭代是盲调。
- **插件源码在 DB 时，先把它捞出来追消费路径，再动手改 shim**——否则永远在猜面板读哪个字段。
- **部署拓扑**：前端容器 `dist` 实际在 `/usr/share/nginx/html`（bind mount `./frontend/dist`），nginx 服务根即此；WORKDIR 是 `/`，`ls dist` 会失败。

---

## 10. 当前 git / 部署状态（交接必读）

- **git 工作树**：`SillyTavernCompatRuntime.ts` 为 modified（忠实版改动**尚未提交**）。最后提交停在特调版 `824f9ad`。
  - ⚠️ 若有人 `git stash`/`reset` 会丢当前忠实版改动（但容器已部署，可回捞）。
  - 本环境**禁止** `git stash -u` / `git fetch` / `git clone` / 整树 `tar`（进程级 SIGKILL 会损坏 .git）；安全备份用 PowerShell `Copy-Item`。
- **已部署**：`dist_fix_20260817191450` → 容器 `/usr/share/nginx/html`。容器名 `palink-ai-frontend-1`，端口 `127.0.0.1:3000`。
- **待办**：若确认忠实版无误，记得 `git commit`（用 `/commit` 走钩子）。
