# REPORT — 插件 API 缺口清单（插件需要 · Palink 未集成）

> **立档**：2026-10-04 · 作者：WorkBuddy 会话（用户提问「还有哪些是插件需要、但我们没集成的 API」触发）
> **方法**：**按当前代码重新计算**，不照抄既有报告（既有报告 §5.1 已过期，见 §8）
> **上位文档**：`docs/REPORT_酒馆助手API适配查验_2026-10-03.md`（843 行，逐项物证）
> **可复现命令**：见 §10

---

## 0. 三十秒速览

| 口径 | 数量 |
|---|---|
| 插件声明的 API 面（`TavernHelper.*` 134 + iframe 全局 30） | **164** |
| 全仓**零实现** | **87**（其中 1 项 `builtin` 有 grep 误报，实为 0） |
| 有实现 | 77 |
| **零实现 · 且被真实卡脚本调用** | **8 项** ← **这才是该修的** |
| **零实现 · 无人调用** | 79 项 ← 暂不补 |
| 已实现但**不在「主页面经典轨」**· 且被卡脚本调用 | **11 项** ← 搬运/别名即可 |

**一句话**：真正卡住卡脚本的是 **8 个"全仓没有"的 API** + **11 个"有、但没搬到插件跑的那条轨"的 API**。前者里 **5 个是纯只读**（零风险）；**唯一一个"写"是 `setLorebookSettings`**（写世界书运行设置，非条目内容）。其余 79 项是角色/预设/人设/世界书条目的 CRUD 与扩展安装 —— **实测无任何卡脚本调用**。

---

## 1. 判定口径

### 1.1 什么叫「插件需要」

按**真实调用点**判定，不按"理论上存在这个 API"：

| 证据来源 | 说明 |
|---|---|
| ① 卡脚本真实调用 | `backend/data/smart_card_assets/*.js`（磁盘上 4 个，其中 2 个是 MVU 两版）逐项计数 |
| ② 已装插件的 2 条脚本 | 上位报告 §6 的逐项对照（对话渲染系统 v7.1 / 数据库界面插件） |
| ③ 插件自带类型定义 | `st-plugins/third-party/JS-Slash-Runner-main/@types/`（权威 API 面） |

### 1.2 什么叫「未集成」

对每个 API 名，在 **6 条实现轨**里逐一查找：

| 轨 | 文件 | 插件能否到达 |
|---|---|---|
| **经典轨**（主页面） | `frontend/src/utils/sillyTavernPluginRuntime.ts` | ✅ **「酒馆助手」走这条** |
| 沙箱轨 | `frontend/src/lib/plugin-system/sandbox.ts` | ❌ 对本插件不可达 |
| iframe shim | `smart-card-runtime/frame-shim/legacy-st-sim.ts` | ❌ 不可达 |
| iframe shim2 | `smart-card-runtime/SillyTavernCompatRuntime.ts` | ❌ 不可达 |
| 内联卡 | `smart-card-runtime/inline/inline-st-globals.ts` | ⚠️ **仅当消息里有内联卡时**才挂 |
| getContext | `frontend/src/lib/sillytavern/getContext.ts` | ⚠️ 只在 `getContext()` 返回值里 |

> ⚠️ **关键**：一个 API 只要**不在「经典轨」**，对本插件就等于不存在 —— 哪怕它在沙箱/iframe 里实现得再完整。

### 1.3 数据来源与局限

- 卡脚本计数为**下界**：磁盘只有 4 个缓存脚本，完整卡库在 DB（本机 docker 未运行，无法枚举）。
- grep 法有**误报**：如 `builtin` 命中的 2 处是 `ensure-builtin` 端点名，与本 API 无关。**§3 的 A 类已逐项人工复核。**

---

## 2. 总账：164 项的三层分类

| 层 | 定义 | 数量 |
|---|---|---|
| **A** | 全仓零实现 · **被卡脚本调用** | **8** ← 要修 |
| **B** | 主页面经典轨没有 · **别的轨有** · **被卡脚本调用** | **11** ← 搬运即可 |
| **C** | 经典轨**已有** · 被卡脚本调用 | **17** ← 可用 |
| **D** | 全仓零实现 · **无人调用** | 79 ← 暂不补 |
| **E** | 有实现但**刻意降级为桩** | 见 §7 |

> 另有 `Mvu` 一项：**由卡脚本自挂**（`_.set(window.parent,'Mvu',e)`），不属缺口，不计入 A/B/C。

---

## 3. A 类 —— 卡脚本真实调用 + 全仓零实现（8 项）★该修

| # | API | 卡脚本调用 | 用途 | Palink 现状 | 风险 | 建议 |
|---|---|---|---|---|---|---|
| A1 | `getLorebookEntries` | ×2 | 读世界书条目（MVU 按 `comment` 正则找初始变量条目） | **零实现** | 🟢 纯读 | ✅ **补**（别名到已有 `getWorldbook`） |
| A2 | `getLorebookSettings` | ×2 | 读世界书运行设置 | **零实现** | 🟢 纯读 | ✅ **补** |
| A3 | `getCharLorebooks` | ×1 | 读"当前角色绑定的世界书"列表 | **零实现** | 🟢 纯读 | ✅ **补**（Palink 世界书已有 `character_id` 绑定） |
| A4 | `getCurrentCharPrimaryLorebook` | ×1 | 读"当前角色的主世界书" | **零实现** | 🟢 纯读 | ✅ **补**（同上） |
| A5 | `getPresetNames` | ×1 | 读生成预设名列表 | **零实现** | 🟢 纯读 | ✅ **补**（Palink 有 `prompt_presets` 表） |
| A6 | `builtin` | ×10 | ST 内置常量对象（`builtin.xxx`） | **零实现** | 🟢 常量 | ✅ **补**（空对象 + 按需键） |
| A7 | `stopGenerationById` | ×1 | 按 id 停止生成 | **零实现** | 🟡 接管生成生命周期 | ⚠️ **评估** |
| A8 | `setLorebookSettings` | ×1 | **写**世界书运行设置（`recursive`/`case_sensitive`…） | **零实现** | 🟡 **唯一一个"写"** | ⚠️ **单独评估**（见下） |

### 3.1 关于 A8 `setLorebookSettings`（唯一需要拍板的）

MVU 的真实调用（`_.isEqual` 守卫，只在设置不同时写）：

```js
const e = { character_first:false, include_names:false, recursive:true, case_sensitive:false,
            match_whole_words:false, use_group_scoring:false, overflow_alert:false }
const t = getLorebookSettings()
_.isEqual(_.merge({}, t, e), t) || setLorebookSettings(e)      // 仅在不等时写
```

- **写的是什么**：世界书**引擎的运行参数**，**不是**条目内容、**不是**用户数据。
- **已有先例**：Palink 经典轨**已经**提供世界书**条目**写入（`worldbookSaveEntries` → `/api/worldinfo/edit`，见 §4）。
- **要拍板的点**：Palink 的世界书设置模型与 ST 不同（ST 是全局 `lorebookSettings` 单例；Palink 目前没有这个概念）。
  **三个选项**：① 存进 Palink 的设置表并让读取方消费；② 只做**内存态**（本次会话内生效，不落库）；③ 不实现，返回 `false` + `recordStubHit` 登记降级。

> **建议**：先做 ②（内存态），成本最低、零写库风险；等确认真实卡需要持久化再升 ①。

---

## 4. B 类 —— 卡脚本在用，但只在「别的轨」实现（11 项）★搬运/别名

这些 API **Palink 已经写了**，只是没搬到「经典轨」——插件跑的正是经典轨，所以调不到。

| # | API | 卡脚本调用 | 现有实现在哪 | 缺口性质 | 建议 |
|---|---|---|---|---|---|
| B1 | `TavernHelper` | ×9 | iframe / 沙箱 | 经典轨**无该命名空间** | ✅ **补**（报告 §7 的 P0；卡脚本写 `TavernHelper.xxx` 现一律 undefined） |
| B2 | `updateVariablesWith` | ×8 | **沙箱轨**（`sandbox.ts:3902`） | 未搬运 | ⚠️ 见 §4.1（变量写有特殊结论） |
| B3 | `replaceVariables` | ×7 | 沙箱 / iframe / **内联（是 no-op）** | 未搬运 + 内联是空桩 | ⚠️ 见 §4.1 |
| B4 | `insertOrAssignVariables` | ×1 | 沙箱 / iframe | 未搬运 | ⚠️ 见 §4.1 |
| B5 | `deleteVariable` | ×1 | 沙箱 / iframe | 未搬运 | ⚠️ 见 §4.1 |
| B6 | `getVariables` | ×4 | 沙箱 / iframe / 内联 | 未搬运 | ✅ 补（只读） |
| B7 | `getCharacter` | ×1 | **沙箱轨**（`sandbox.ts:3703`） | 未搬运 | ✅ 补（只读，沙箱有现成实现） |
| B8 | `getCharWorldbookNames` | ×2 | iframe / 内联 | 未搬运 | ✅ 补（只读） |
| B9 | `getCurrentMessageId` | ×2 | iframe / 内联 | 未搬运 | ✅ 补（只读） |
| B10 | `getPreset` | ×7 | 沙箱（空实现）+ `getContext()` 的 PresetManager | 未搬到裸全局 | ✅ 补（只读） |
| B11 | `eventRemoveListener` | ×1 | 沙箱轨 | 未搬运 | ✅ 补（纯前端，零成本） |

### 4.1 ⚠️ B2–B5（变量写）有特殊结论：**不要补**

**理由**：Palink 把 MVU 的变量更新链路**搬到了后端**：

- `backend/app/services/mvu_engine.py`：解析 AI 回复里的 `<UpdateVariable>` JSON Patch → 在会话 `stat_data` 上应用
- `backend/app/api/character_ext.py:4780 / 5984 / 6129`：三处调用，并 **`strip_update_variable_blocks()` 把该块从正文里剥掉**

**后果**：AI 输出里的 `<UpdateVariable>` 块**到不了前端** → 脚本侧的写路径**天然不触发**。
**所以**：补 B2–B5 不是"让功能生效"，而是**制造第二条写路径 → 双写**（上位报告 §9.12.3 风险 ①）。

> **B2–B5 的处置：不补。** 但要在文档里写明理由，避免后续 agent 误以为遗漏而"顺手补上"。

---

## 5. C 类 —— 卡脚本在用 + 经典轨已实现（17 项）✅ 可用

无需改动，列此备查（避免重复造）。**判据：出现在经典轨 setup 注入的 `window.*` 里**（含 `(window as any).X =` 写法）：

```
SillyTavern            appendInexistentScriptButtons  replaceScriptButtons   getScriptButtons
getScriptId            getTavernHelperVersion         getButtonEvent
eventOn                eventEmit                      tavern_events
getChatMessages        setChatMessages                getLastMessageId
generate               generateRaw                    substitudeMacros
updateWorldbookWith
```

> ⚠️ 另有一批经典轨已提供、但**这 4 个卡脚本没用到**的（共 **36** 项）：`getScriptName` `getScriptInfo` `getIframeName`
> `reloadIframe` `updateScriptButtonsWith` `eventMakeFirst` `eventMakeLast` `eventOff` `eventOnButton`
> `getCurrentChatId` `getCharacters` `getCharAvatarPath` `getThumbnailUrl` `getRequestHeaders` `injectPrompts`
> `uninjectPrompts` `setExtensionPrompt` `setExtensionSettings` `getExtensionSettings` `registerMvuSchema`
> `registerVariableSchema` `registerSlashCommand` `renderExtensionTemplateAsync` `saveSettingsDebounced`
> `substituteParams` `triggerSlash` `openCharacterChat` `getWorldbook` `getWorldbookNames` `getGlobalWorldbookNames`
> `rebindGlobalWorldbooks` `createWorldbookEntries` `createOrReplaceWorldbook` `createOrReplaceCharWorldbook`
> `deleteChatMessages` `getTavernVersion`（完整清单见 §10 命令 ②）。

> ⚠️ **订正上位报告**：报告 §5.1 把 `getScriptButtons` / `replaceScriptButtons` / `appendInexistentScriptButtons` / `getScriptId` 列为"全无实现"，**已过期** —— 经典轨现已在 `sillyTavernPluginRuntime.ts:1029/1077/1080/1092` 实现（见 §8）。

### 5.1 但「脚本按钮」仍有一个 UI 缺口

- API 层 ✅ 已实现：`getScriptButtons()` 返回 **6 个已注册按钮**（MVU + 对话渲染系统都注册成功）
- **UI 层 ❌ 缺失**：页面上 `#palink-script-buttons` / `.tavern-script-buttons` **查无此元素** → 按钮数据有了、**没地方画**
- → 这是"按钮点不到"的**最后一个原因**（上位报告 §7 的 P0 首项）

---

## 6. D 类 —— 全仓零实现 + 无人调用（79 项）暂不补

按功能域归类。**判据：4 个卡脚本 + 已装 2 条脚本均零引用。**

| 功能域 | 数量 | 缺失 API |
|---|---|---|
| **角色 CRUD** | 7 | `createCharacter` `createOrReplaceCharacter` `deleteCharacter` `replaceCharacter` `updateCharacterWith` `getCharacterIds` `RawCharacter` |
| **世界书条目 / 设置** | 15 | `createLorebook` `deleteLorebook` `getLorebooks` `createLorebookEntries` `replaceLorebookEntries` `updatelorebookEntriesWith` `setLorebookEntries` `deleteLorebookEntries` `deleteWorldbook` `replaceWorldbook` `rebindCharWorldbooks` `setCurrentCharLorebooks` `getChatWorldbookName` `getOrCreateChatLorebook` `getOrCreateChatWorldbook` |
| **预设** | 12 | `createPreset` `createOrReplacePreset` `deletePreset` `renamePreset` `replacePreset` `updatePresetWith` `setPreset` `loadPreset` `getLoadedPresetName` `default_preset` `isPresetNormalPrompt` `isPresetSystemPrompt` `isPresetPlaceholderPrompt` |
| **人设** | 11 | `getPersonaNames` `getPersonaIds` `getCurrentPersonaName` `getCurrentPersonaId` `getPersonaAvatarPath` `createPersona` `createOrReplacePersona` `deletePersona` `replacePersona` `updatePersonaWith` `getPersona` |
| **扩展管理** | 6 | `getExtensionStatus` `isInstalledExtension` `installExtension` `uninstallExtension` `reinstallExtension` `updateExtension` |
| **音频** | 8 | `playAudio` `pauseAudio` `getAudioList` `replaceAudioList` `appendAudioList` `getAudioSettings` `setAudioSettings` `getCurrentAudio` |
| **导入 raw** | 5 | `importRawCharacter` `importRawChat` `importRawPreset` `importRawWorldbook` `importRawTavernRegex` |
| **生成控制** | 4 | `builtin_prompt_default_order` `getModelList` `getProxyPresetNames` `stopAllGeneration` |
| **酒馆正则** | 5 | `getTavernRegexes` `replaceTavernRegexes` `updateTavernRegexesWith` `formatAsTavernRegexedString` `isCharacterTavernRegexesEnabled` |
| **事件族（补全）** | 5 | `eventOnce` `eventEmitAndWait` `eventClearEvent` `eventClearListener` `eventClearAll` |
| **其他** | 4 | `initializeGlobal` `createChatMessages` `rotateChatMessages` `getChatHistoryBrief` `getChatHistoryDetail` `replaceScriptInfo` |

> ⚠️ 表内计数按"是否有卡脚本调用"为 0；其中**事件族 5 项**与**正则读 2 项**属"零成本可补"（纯前端），上位报告 §9.12.5 建议纳入"补"的一侧。

---

## 7. E 类 —— 已实现但**刻意降级为桩**（会静默失效）

调用后计入 `window.__palinkCompatStats`，**不报错但功能不生效**：

| API | 桩行为 | 理由 |
|---|---|---|
| `setVariable` | 函数体就是提示：`"卡内脚本回写会话变量未开放（Palink 变量更新走后端 MVU 链路）"` | 防双写 |
| `getGlobalWorldbookNames` | 返回 `[]` + 登记降级 | Palink 无"全局世界书"概念（用户已裁定） |
| `rebindGlobalWorldbooks` | 登记降级 | 同上 |
| `registerSlashCommand` | 登记降级（本轨无 SlashCommandEngine，消费入口在沙箱轨） | 未接通 |
| `slash:profile-list` | 返回空列表 | Palink 无独立 profile/preset 概念 |
| `substituteParams` | 失败回退原文 + 登记降级 | 宏引擎环境未注入时 |

> ⚠️ **A/B 类的缺口不进这个统计** —— 经典轨没有 Proxy 兜底，未实现的名字是裸 `undefined`/`ReferenceError`，`__palinkCompatStats` **看不见**（上位报告 §5.3②）。排查时必须读代码，不能只看统计。

---

## 8. 与上位报告的差异（订正 3 处）

| # | 上位报告的说法 | 实测（2026-10-04 按当前代码） | 性质 |
|---|---|---|---|
| 1 | §5.1：`getScriptButtons` / `replaceScriptButtons` / `appendInexistentScriptButtons` / `getScriptId` 等 17 项 iframe 脚本/按钮族「四层全无实现」 | **经典轨已实现**（`sillyTavernPluginRuntime.ts:1029/1077/1080/1092`） | **报告过期**（报告写于 10-03，运行时后被扩展） |
| 2 | §5.1 / §9.11.2：`getCharacter` / `getCharData` 等「全仓缺失」 | `getCharacter` **沙箱轨有实现**（`sandbox.ts:3703`），属**未搬运**而非"缺失" | 口径需区分"没有"vs"在别的轨" |
| 3 | §5.1：`updateVariablesWith` / `replaceVariables` 归入"105 项全无实现" | `updateVariablesWith` 沙箱有（`sandbox.ts:3902`）；`replaceVariables` 沙箱/iframe/内联都有（内联是 no-op） | 同上 |

> **口径**：**「主页面经典轨没有」≠「全仓没有」**。修的时候前者是"搬运"，后者才是"新写"。
> 本条与 `docs/SOP_Agent交付自查清单.md` §3.3.1（断言「X 不存在」前必须数遍所有实现路径）同源。

---

## 9. 建议的修复批次（按性价比排序）

### 批次 1（零写库风险，建议先做）
1. **A1–A6**：`getLorebookEntries` / `getLorebookSettings` / `getCharLorebooks` / `getCurrentCharPrimaryLorebook` / `getPresetNames` / `builtin`
   - A1 可直接**别名**到已有 `getWorldbook`（经典轨已有，见 §5）
   - A3/A4 走 Palink 已有的 `character_id` 世界书绑定
   - A5 走 `prompt_presets` 表
2. **B1、B6–B11**：`TavernHelper` / `getVariables` / `getCharacter` / `getCharWorldbookNames` / `getCurrentMessageId` / `getPreset` / `eventRemoveListener`
   - 全部**只读或纯前端**，沙箱轨有现成实现可搬（`sandbox.ts` 的 `sandbox` 对象是现成参考）
3. **D 类里的零成本项**：事件族 5 项（`eventOnce` / `eventEmitAndWait` / `eventClear*`）

### 批次 2（需产品拍板）
4. **A8 `setLorebookSettings`**：建议先做内存态（见 §3.1）
5. **A7 `stopGenerationById`**：接管生成生命周期，需评估

### 明确不做（写进文档防误补）
6. **B2–B5 变量写**：后端已覆盖，补 = 双写（§4.1）
7. **D 类全部**：角色/世界书条目/预设/人设的 CRUD + `importRaw*` + `installExtension`
   - 四类真风险：① 数据源双写 ② 权限模型被绕过 ③ 任意代码执行 ④ 不可逆操作无确认
   - 且该插件的**来源卡（BanG! City）已不在库** = 来源不明的 4MB 第三方脚本

### 另立议题
8. **脚本按钮栏 UI**（API 已有，缺容器）—— 属 UI 设计决策，需定"放哪里"（§5.1）

---

## 10. 复现命令

```bash
cd "D:/项目/Palink-AI"

# ① 提取插件权威 API 面（TavernHelper 134 + iframe 30）
python - <<'PY'
import io,re,glob
base="st-plugins/third-party/JS-Slash-Runner-main/@types"
th=set(); ifr=set()
for f in glob.glob(base+"/function/*.d.ts"):
    th|=set(re.findall(r"readonly\s+([A-Za-z_]\w*)\s*:", io.open(f,encoding="utf-8",errors="ignore").read()))
for f in glob.glob(base+"/iframe/*.d.ts"):
    ifr|=set(re.findall(r"declare\s+(?:function|const|let|var)\s+([A-Za-z_]\w*)", io.open(f,encoding="utf-8",errors="ignore").read()))
print(len(th),"TavernHelper +",len(ifr),"iframe")
PY

# ② 经典轨实际注入的全局（⚠️ 必须同时匹配 (window as any).X = 写法，
#    否则会漏掉 generate / generateRaw —— 本报告第一版就踩了这个坑）
grep -oE "(window\.[A-Za-z_][A-Za-z0-9_]*|window as any\)\.[A-Za-z_][A-Za-z0-9_]*)\s*=" \
     frontend/src/utils/sillyTavernPluginRuntime.ts | sort -u

# ③ 单个 API 的全仓实现情况（示例）
grep -rIn "\bgetLorebookEntries\b" frontend/src --include=*.ts --include=*.tsx | grep -v __tests__

# ④ 卡脚本真实调用计数（示例）
grep -o "updateVariablesWith" backend/data/smart_card_assets/*.js | wc -l

# ⑤ 按轨定位（判定"没有"还是"在别的轨"）
for f in frontend/src/utils/sillyTavernPluginRuntime.ts \
         frontend/src/lib/plugin-system/sandbox.ts \
         frontend/src/components/ui/custom/smart-card-runtime/frame-shim/legacy-st-sim.ts \
         frontend/src/components/ui/custom/smart-card-runtime/inline/inline-st-globals.ts; do
  echo -n "$f: "; grep -c "\bgetCharacter\b" "$f"
done
```

---

## 11. 局限与未验证项

| # | 项 | 说明 |
|---|---|---|
| 1 | **卡脚本样本有限** | 磁盘只有 4 个缓存脚本（`backend/data/smart_card_assets/*.js`）。完整卡库在 DB，本机 **docker 未运行**无法枚举 → §3 的"调用次数"是**下界**，可能还有别的卡用别的 API |
| 2 | **grep 法有误报** | 已对 A 类逐项人工复核；D 类未逐项复核（风险低，因为都是"零命中"） |
| 3 | **未做运行时验证** | 全部结论来自**静态扫描**。真机（浏览器 F12）验证需容器启动 |
| 4 | **`setLorebookSettings` 的消费方未查** | 需确认 Palink 若实现它，谁去读这些设置（否则写了没人用） |
| 5 | **未验证** | 上位报告 §6.2 提到 `replaceVariables` 在 inline 里是 no-op —— 本报告沿用该结论，未复验 |

---

## 附：本次扫描的 4 个卡脚本

| 文件 | 大小 | 内容 |
|---|---|---|
| `0c646fb31a8cd5610d22ccd26323258a430f83a09e6a0a09596b2b1875eabac2.js` | 307 KB | MVU 变量框架（版本 A） |
| `d2245aa58154920caa64b581063a8a9a39e3b538d533f6981c6a9a78f51a75ca.js` | 137 KB | MVU 变量框架（版本 B） |
| `a3133eb07bfae987565acd8dcfdda6a4f506c9d17640b188d61d5db2bebd600b.js` | 89 KB | 与本清单 API 零相关 |
| `bb11c1036bb8c5d5572bf27d0424baa7f7907f247b089c515876bd11178a4828.js` | 4.6 KB | 仅引用 `Mvu`×1 |
