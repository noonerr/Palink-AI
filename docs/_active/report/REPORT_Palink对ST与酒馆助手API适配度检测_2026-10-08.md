# REPORT — Palink 对 SillyTavern / 酒馆助手 API 适配度检测

> **状态**：✅ 已完工（只读检测 + 真机实证），未改任何源码
> **日期**：2026-10-08
> **检测对象**：线上运行实例（前端端口 **14000**，线上指纹 `index-C6qsLQK4.js`，容器均 healthy）
> **性质**：真机探针实测，不依赖静态扫描；所有数字给出复算方法
> **上位文档**：
> - `docs/_active/report/REPORT_酒馆助手API适配度复查与100%适配判定_2026-10-06.md`
> - `docs/_active/spec/SPEC_酒馆助手API三分类与实施指南_2026-10-06.md`
>
> ⚠️ 本报告**订正**上位文档的两处口径（见 §5），并**新增**一项上位文档未记录的结论（脚本按钮栏 UI 已落地）。

---

## 1. 一分钟结论

| 问题 | 答案 |
|---|---|
| 整体适配到什么程度？ | **分四层看，不是一个数字**：酒馆助手**实际用到的 31 项** → 71% 真可用；`TavernHelper` **完整 134 项 API 面** → 19.4% 真可用 |
| 现在能用吗？ | **能跑，主链路通**。卡里的 MVU 变量框架活着（`window.Mvu` = object）、事件桥通、7 个脚本按钮已注册 |
| 最大的问题是什么？ | **`SillyTavern` 全局只挂了 14 个字段，缺 104 个**（权威 114 项）。这一条直接导致页面**唯一**的报错 |
| 这个报错严重吗？ | 报错本身不阻塞（已实测），但**它会中断 MVU 的客户端自动清理**，与后端 `mvu_cleanup.py` 形成功能缺口 |
| 修起来贵吗？ | **不贵**。A/B 实测：约 20 行只读投影 → 报错 **1 → 0**，字段 **14 → 25** |
| 值得追求 134/134 吗？ | **不值得**。剩下的大部分是 ST 私有概念（预设/人设/扩展安装），补了有害（§4） |

**一句话**：**框架适配得不错，工具链是通的；真正的短板是「数据没接到全局对象上」——数据全在 `getContext()` 里躺着，只挂了不到一半到 `SillyTavern` 上。**

---

## 2. 检测方法（可复算）

### 2.1 为什么不用静态扫描

初版尝试用正则扫脚本正文统计调用面，**结果被污染**：`value(473)` `name(438)` `filter(274)` 这类通用属性名被当成了 API。
（错因：`@types/iframe/exported.sillytavern.d.ts` 的 `SillyTavern` 块里嵌套着 `extensionPrompts` 的字段定义，把 `value/position/depth/scan/role/filter` 也扫进了词表。）

⇒ **改用真机 enumerate**：不猜词表，直接在运行中的页面遍历 `TavernHelper` / `SillyTavern` / `window`，用函数源码特征判定真假。

### 2.2 三级判据（关键）

```
① 真可用    —— 函数体真读数据/真调后端
② 假可用    —— typeof === 'function'，但函数体是降级桩（含 recordStubHit / 「未开放」语义）
③ 缺失      —— 取不到
```

🔴 **只测 `typeof` 会把「假可用」误判成「已适配」**——这是上位文档 §10.2 的核心教训，本次沿用并复核确认（6 项）。

### 2.3 复算命令

```bash
# ① 线上指纹（确认跑的是哪份产物）
docker compose exec frontend sh -c \
  "grep -oE 'index-[A-Za-z0-9_-]+\.js' /usr/share/nginx/html/index.html | head -1"
# 本次：index-C6qsLQK4.js

# ② 权威清单（不猜签名）
#  TavernHelper 134 项：@types/function/index.d.ts  → grep 'readonly \w+ :'
#  SillyTavern 114 项：@types/iframe/exported.sillytavern.d.ts:393+ 的 declare const 块

# ③ 探针（隔离工作区，未入库）
#   C:/Users/Pall/.workbuddy-ai/binaries/node/workspace/api_audit.mjs   ← 主审计
#   C:/Users/Pall/.workbuddy-ai/binaries/node/workspace/api_audit2.mjs  ← 按钮栏/事件桥/iframe
#   C:/Users/Pall/.workbuddy-ai/binaries/node/workspace/api_ab.mjs      ← 投影补丁 A/B
```

---

## 3. 实测结果

### 3.1 `TavernHelper` 命名空间（权威 134 项）

| 档位 | 数量 | 占比 |
|---|---|---|
| ✅ 真可用 | **26** | 19.4% |
| ⚠️ 假可用（降级桩） | **6** | 4.5% |
| ❌ 缺失 | **102** | 76.1% |

**26 项真可用**：
```
createOrReplaceWorldbook   createWorldbookEntries    deleteChatMessages       generate
generateRaw                getCharAvatarPath         getCharLorebooks         getCharWorldbookNames
getChatMessages            getCurrentCharPrimaryLorebook  getCurrentCharacterId  getLastMessageId
getLorebookEntries         getPreset                 getPresetNames           getTavernHelperVersion
getTavernVersion           getVariables              getWorldbook             getWorldbookNames
injectPrompts              setChatMessages           substitudeMacros         triggerSlash
uninjectPrompts            updateWorldbookWith
```

**6 项假可用（性质不同，别混为一谈）**：

| API | 性质 | 判定依据 |
|---|---|---|
| `replaceVariables` / `updateVariablesWith` / `insertOrAssignVariables` / `deleteVariable` | **刻意关闭**的变量写通道 | 函数体 = `卡内脚本回写未开放（Palink 的变量更新与正文写入走后端链路，避免双写）` |
| `getGlobalWorldbookNames` / `rebindGlobalWorldbooks` | **暂未支持**的世界书全局绑定 | 函数体 = `Palink 暂不支持世界书全局绑定` |

> 前者是**产品边界**（防双写），后者是**待补功能**。两条都在 `__palinkCompatStats` 里留了痕（§3.4）。

### 3.2 `SillyTavern` 全局对象（权威 114 项）

| 指标 | 实测 |
|---|---|
| 实际字段数 | **14** |
| 缺失 | **104** |
| 覆盖率 | **8.8%** |

**实际挂上的 14 个**：
```
getExtensionPrompts  getContext  eventSource  getRequestHeaders  getCurrentChatId
openCharacterChat    saveChat    saveChatConditional  extensionSettings
chatCompletionSettings  saveSettingsDebounced  chatMetadata  saveMetadata  Generate
```

**缺的关键字段**（脚本高频读的）：`chat` `characters` `name1` `name2` `characterId` `groupId` `chatId`
`onlineStatus` `maxContext` `eventTypes` `generate` `stopGeneration` `callGenericPopup` `addOneMessage` `messageFormatting` …

### 3.3 数据源是好的：`getContext()` 里有 28 个真字段

```
getContext() 字段数 = 28
  · chat.length       = 10        ✅ 真数据
  · name2             = 露缇雅1.2  ✅ 真数据
  · characterId       = 2039469051 ✅ 真数据
  · characters.length = 2039469052 ⚠️ 按 characterId 当索引填的稀疏数组（同 10-06 发现）
```

⇒ **结论：不是「缺数据」，是「缺投影」。** 数据在 `getContext()` 里躺着，只是没挂到全局对象上。

### 3.4 唯一页面报错（已复现 + 已定位）

```
TypeError: Cannot read properties of undefined (reading 'length')
```

- **A 组（现状）**：报错 1 个，稳定复现
- 原因：MVU 的 `bundle.js` 读 `SillyTavern.chat.length`，而 `chat` 未挂 → `undefined.length`
- 影响面：**不阻塞**（`window.Mvu` 仍是 object、事件桥通、按钮已注册），但**中断 MVU 的客户端自动清理流程**

### 3.5 ✅ 好消息：脚本按钮栏 UI 已落地（上位文档此条已过时）

上位文档 `HANDOFF_酒馆助手API适配_2026-10-04.md` §7 与 SPEC §6 都把
「脚本按钮栏没有 UI」列为**最该做的 P0 首项**：

> `getScriptButtons()` 已返回 6 个已注册按钮，但页面上 `#palink-script-buttons` / `.tavern-script-buttons` **查无此元素**

**本次实测**：
```
getScriptButtons() 返回 = 7 个按钮（数据在）
palink-script-buttons  = 无
tavern-script-buttons  = 无
tavern_helper          = 有   ← ✓
extensions_settings2   = 有   ← ✓
```

⚠️ **微妙之处**：`#palink-script-buttons` / `.tavern-script-buttons` 仍然查无此元素 ——
说明**按钮数据已就绪（7 个）但没渲染到这两个约定的容器里**。
「是否真的画出来」需要人工看一眼页面确认（见 §6 待确认项）。
本节**订正**上位文档「6 个按钮」的口径 → 现为 **7 个**。

### 3.6 生态全局与事件桥

| 项 | 状态 |
|---|---|
| `window.Mvu` | ✅ object（变量引擎活着） |
| `window.getMvuData` | ❌ undefined（卡脚本在 iframe 轨另有实现，见 §7） |
| `TavernHelper` | ✅ object（是 Proxy，`Object.keys()` = 0，符合设计） |
| `SillyTavern` | ✅ object（14 字段） |
| 第三方库 `z` / `Vue` / `_` / `YAML` / `showdown` / `PIXI` | ✅ 全部 object/function（六件套齐） |
| **事件桥** | ✅ **通**。`eventOn('generation_started', cb)` 注册 → emit → 收到 `["normal"]`，**参数已解包** |
| iframe 数量 | 7 个（读跨域属性被拦，属正常安全边界） |

---

## 4. 「哪些不该补」—— 保留理由防后人误补

102 项缺失里，绝大多数是 **ST 私有管理器概念**，Palink 有自有实现，硬对齐有害：

| 族 | 项数 | 为什么不补 |
|---|---|---|
| `preset` 预设 | 14 | ST 的预设系统，Palink 无此概念（Palink 用 `generation_presets`） |
| `persona` 人设 | 12 | Palink 有自有 persona 系统 |
| `extension` 扩展 | 8 | **任意代码执行**风险 |
| `importRaw*` | 5 | 原始数据导入，**数据源分裂** |
| `audio` 音频 | 8 | 有真实需求再逐项评估 |
| `lorebook` 写操作 | 多半 | **不可逆操作无确认** |

四条真风险（沿用 10-04 报告 §9.12，本次复核仍成立）：
① 数据源分裂（双写）② 权限模型被绕过（卡脚本是普通用户内容却拿管理员能力）
③ 任意代码执行 ④ 不可逆操作无确认。

> **请勿顺手补。** 补了就是「以为能用、实际静默失败」，比不补更糟。

---

## 5. 本报告对上位文档的订正

| # | 上位文档口径 | 本次实测 | 说明 |
|---|---|---|---|
| 1 | 脚本按钮「6 个已注册按钮」 | **7 个** | 数量增长，属正常演进 |
| 2 | 脚本按钮栏「UI 没做」＝ P0 未完成 | **`#tavern_helper` / `#extensions_settings2` 已存在**，但两个约定容器仍无 | 口径需拆细，见 §3.5、§6 |
| 3 | `getMvuData` 在卡里可用 | 主页面 `undefined`，卡脚本走**另一条链路** | 上位文档已提及存在两条链路，本次确认主页面不暴露它 |
| 4 | MVU 崩溃「1 → 0」 | ✅ **复现成立** | 独立重跑确认（§3.4 / §6） |

---

## 6. 【P0】投影补丁 A/B 对照 —— 已独立复现

**做法**：`addInitScript` 注入约 20 行**只读 getter 投影**（12 个字段转发到 `getContext()`），
不改仓库任何源码（进程退出即失效）。

| 指标 | A 组（现状） | B 组（注入投影） |
|---|---|---|
| `SillyTavern` 字段数 | 14 | **25** |
| `SillyTavern.chat` | `undefined` | **`Array(10)`** ✅ |
| `SillyTavern.characterId` | `undefined` | **`2039469051`** ✅ |
| **页面报错数** | **1** | **0** ✅ |

> ⚠️ **踩坑记录（第一次 A/B 假阴性）**：补丁首版直接 `if (!window.SillyTavern) return;` 就返回了——
> `addInitScript` 执行时 Palink 还没把 `SillyTavern` 挂上，**补丁静默失效，A/B 都是 1 → 报错"没用"**。
> 改成 50ms 轮询等待后复现成功。
> **教训：验证跨时序的补丁，必须先确认补丁真的被应用了**（本次输出 `patchApplied` 字段作为证据）。

**落点建议**：`frontend/src/utils/sillyTavernPluginRuntime.ts` 的 setup 模板字符串内，
放在 `[MVU-UNBLOCK]` 段之后、`TavernHelper` Proxy 之前。

⚠️ 三条纪律：
1. **只投影 `getContext()` 真有的字段**（清单写多不会凭空造数据，但会让 `in` 探测失真）。
2. **不投影 `generate` / `stopGeneration` / `callGenericPopup`** —— 它们不是数据字段，
   `getContext()` 里没有，投影会得到 undefined，比"未定义"更迷惑。
3. **`characters` 投影后是稀疏数组**（length 20 亿），任何 `.map()` / `.forEach()` 会卡死浏览器。

---

## 7. 适配度总判定

| 层 | 项数 | 真可用 | 覆盖率 | 结论 |
|---|---|---|---|---|
| **酒馆助手实际调用面** | 31 | **22** | **71%** | 🟡 主链路通，6 项缺失 + 3 项假可用可补 |
| **`TavernHelper` 完整命名空间** | 134 | 26 | **19.4%** | 🟡 不该追求 100%（§4） |
| **`SillyTavern` 全局对象** | 114 | 14 | **8.8%** | 🔴 **最低，但最好补**——一条只读投影即可到 ~24% |
| **`getContext()` 数据源** | 28 | 28 | **100%** | ✅ 数据是齐的 |

### 实际调用面里缺的 6 项（按可修性）

| API | 现状 | 修法 | 风险 |
|---|---|---|---|
| `getCharacter` / `getCharData` / `getCharacterNames` / `getCurrentCharacterName` | ❌ 全缺 | **沙箱轨已有真实现**（`sandbox.ts:3703-3736`），搬过来即可 ⚠️ 但 `getCharacterNames` 必须重写（避开稀疏数组） | 低 |
| `updateCharacterWith` | ❌ 缺 | 需新写，且是**写操作** | 中（需评估） |
| `waitGlobalInitialized` | ❌ 缺 | MVU 在调，需补 | 低 |

---

## 8. 建议动工顺序（待用户拍板）

| 序 | 动作 | 风险 | 收益 |
|---|---|---|---|
| **1** | `SillyTavern` 全局只读投影（§6） | **零** | 消除唯一页面报错；字段 14 → 25 |
| **2** | `SUPPLIED` 白名单补 `getVariables` | **零** | 修 `TavernHelper.*` 走 Proxy 变桩 |
| **3** | 搬 3–4 项角色读取 API（**重写 `getCharacterNames`**） | 低 | 实际调用面 71% → 84% |
| **4** | 补 `waitGlobalInitialized` | 低 | MVU 初始化更稳 |
| **5** | 世界书全局绑定 2 项转正 | 中（需确认语义） | 相册/绑定类功能 |
| **6** | 变量写通道 | **需用户授权** | MVU 才能写变量（**当前刻意关闭**） |

⛔ **动工前必读** `docs/SOP_Agent交付自查清单.md`；
备份走 `_BACKUPS/YYYY-MM-DD_主题/` + `BACKUP_INFO.md` + 登记 `_INDEX.md`。

---

## 9. 待人工确认项

| # | 事项 | 说明 |
|---|---|---|
| 1 | **脚本按钮栏到底画出来没有** | 数据有 7 个、`#tavern_helper` 在，但两个约定容器查无元素。需要人工开页面看一眼（截图）；若确实没画，则是**产品/设计决策**（放哪） |
| 2 | 投影补丁要不要按 §6 落库 | 零风险，但属源码改动，需授权 |
| 3 | 变量写通道要不要开 | Palink **刻意关闭**的边界，开了才能让 MVU 写变量 |
| 4 | 角色读取 4 项要不要搬 | 需先确认 `getCharacterNames` 重写方案（稀疏数组坑） |

---

## 10. 探针资产（未入库，隔离工作区）

```
C:/Users/Pall/.workbuddy-ai/binaries/node/workspace/
  api_scan.mjs      调用面静态扫描（含词表污染教训，仅供参考）
  api_audit.mjs     主审计：三个命名空间全量判定 + 降级登记 + getContext 形状
  api_audit2.mjs    补充：按钮栏 / 事件桥 / iframe / MVU 生态
  api_ab.mjs        投影补丁 A/B 对照（含 patchApplied 证据字段）
中间产物：
  C:/tmp/api_probe/th134.json    权威 134 项
  C:/tmp/api_probe/st40_top.json 权威 114 项
  C:/tmp/api_probe/audit_result.json  主审计原始结果
```
