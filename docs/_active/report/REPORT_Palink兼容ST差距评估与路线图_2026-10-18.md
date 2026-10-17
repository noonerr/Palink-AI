# Palink 兼容 SillyTavern —— 差距评估与路线图

> 日期：2026-10-18｜性质：**只读调研 + 真机实测**，未改任何生产代码
> 权威基准：`_reference/sillytavern-1.18.0/`（ST 1.18.0 官方源码，逐个数出来，不是估的）
> 实测对象：`http://localhost:16000`（`index-Bg8Sm9hQ.js`），角色 `c28061bb…`，5 卡 / 7 iframe
> 上游文档：`st-plugins/ADAPTATION.md`（2026-07-30 逐插件适配矩阵）、
> `REPORT_Palink对ST与酒馆助手API适配度检测_2026-10-08.md`、`REPORT_S5架构重建评审_2026-10-16.md`

---

## 0. 一页速览

| 维度 | 打分 | 一句话 |
|---|---|---|
| **角色卡兼容（用户实际在用的）** | **8.5 / 10** | 卡脚本、MVU 变量、世界书、事件桥、CSS 美化全通；今天刚修掉样式被掏空 |
| **ST 插件兼容** | **5.5 / 10** | 挂载点 9/9 在，但只有 3 个挂载点真有 UI；ST Extras 后端只剩 vector 一类是真的 |
| **斜杠命令兼容** | **3.0 / 10** | **`SlashCommandParser.commands` 实测为 0 条**；ST 有 289 条，Palink 自有 92 条只与 ST 同名 29 条 |
| **getContext API 覆盖** | **83%** | 存在 135/145、真可用 120/145（15 项是 stubApi/空 class）；缺 9 键 |
| **TavernHelper 覆盖** | **57%** | 在场 76 / 权威 134；在场项真可用 72/76 |
| **整体（按生态覆盖加权）** | **6.2 / 10** | "卡能跑、插件半能跑、命令基本残废" |
| **距"完美兼容 ST"** | **不可达** | ST 的预设/人设/扩展安装/UI 体系 Palink 结构上没有，补了有害 |
| **距"生态绝大多数卡 + 常用插件能跑"** | **2~3 周** | P0 两项做完可到 ~85%（见 §5） |

**一句话结论**：你日常遇到的"角色卡显示/美化"这块已经**接近满分**（今天的样式守护是最后一块大短板）；真正拖后腿的是**插件生态**和**斜杠命令**这两块——而斜杠命令是**性价比最高、最便宜**的一块（实测 Palink 自己就有 92 条命令，只是没注册到 ST 的 `SlashCommandParser` 上，卡脚本调不到）。

---

## 1. 口径与测量方法

### 1.1 权威目标面：从 ST 源码数出来，不是估的

| 口径 | 数字 | 数法 |
|---|---|---|
| `getContext()` 顶层 key | **145** | `st-context.js:115-306` 顶层键（缩进 8 空格）逐行匹配 = 冒号键 33 + 简写键 112 |
| `parent.SillyTavern` 顶层字段 | **2** | `script.js:292`：`globalThis.SillyTavern = { libs, getContext }` |
| `SillyTavern.libs` 成员 | ~17 | lodash/Fuse/DOMPurify/hljs/localforage/Handlebars/css/Bowser/DiffMatchPatch/Readability/SVGInject/showdown/moment/seedrandom… |
| 斜杠命令（去重名） | **289** | 全目录扫 `SlashCommandParser.addCommandObject(SlashCommand.fromProps({name}))`；核心 222 + 内置扩展 67；另 175 个别名 |
| 内置扩展一级目录 | **15**（功能扩展 13） | `public/scripts/extensions/` ls |
| 扩展 DOM 挂载点 | 9 | qr/regex/tts/vectors/caption/translation/summarize/sd/expressions |

### 1.2 Palink 侧：真机探针 + 三级判据

探针脚本 `.tmp_probe/probe-st-parity2.js` / `probe-mounts.js`，在真实页面跑：

```
① 存在      —— key 在 getContext() / TavernHelper 对象里
② 真可用    —— 函数体非空、非纯 return 空值、不含 recordStubHit/stubApi( 标记
③ 桩        —— 满足②的反面
```

⚠️ 只测 `typeof` 会把桩误判成已适配——这是 2026-10-08 报告的核心教训，本次沿用。

---

## 2. Palink 实测现状（分轨）

### 2.1 iframe 单间轨（S5 后**唯一生产路径**，卡脚本/插件都在这跑）

| 项 | 实测 | 判定 |
|---|---|---|
| `getContext()` 返回总键数 | **185** | 比 ST 还多 40（含 Palink 自有扩展键） |
| 覆盖 ST 145 键 | **135 / 145 = 93%** | 缺 9 个，见下 |
| **真可用（去桩）** | **120 / 145 = 83%** | 135 存在里 **15 个非真可用**：13 个 `stubApi` 包装 + 2 个空 class |
| 非真可用明细（15） | `stubApi` 包装 13：`getRequestHeaders`、`renameChat`、`saveWorldInfo`、`reloadWorldInfoEditor`、`updateWorldInfoList`、`convertCharacterBook`、`getWorldInfoPrompt`、`getTextGenServer`、`getChatCompletionModel`、`appendMediaToMessage`、`getMediaDisplay`、`getMediaIndex`、`scrollOnMediaLoad`；空 class 2：`ChatCompletionService`、`TextCompletionService` | — |
| 合法空值（**不算缺陷**） | `groups`=`[]`、`tags`=`[]`、`tagMap`=`{}`、`groupId`=`null`、`streamingProcessor`=`null`（本角色无群组/无标签；ST 同样返回空） | — |
| 缺失的 9 键 | `timestampToMoment`、`registerHelper`、`registerDebugFunction`、`renderExtensionTemplate`、`renderExtensionTemplateAsync`、`chatCompletionSettings`、`textCompletionSettings`、`uuidv4`、`humanizedDateTime` | 其中 **3 个其实在 `TavernHelper` 上有**（`timestampToMoment`/`uuidv4`/`humanizedDateTime`），只是没挂到 getContext |
| `SillyTavern` 全局字段 | **9** | `libs, getContext, getCurrentMessageId, getChatMessages, getGroups, getGroupChat, openThirdPartyExtensionMenu` + 2 |
| `SillyTavern.libs` 成员 | **11** | toastr/$/jQuery/DOMPurify/Handlebars/_/lodash/moment/dayjs/accountStorage/localforage（ST ~17） |
| `TavernHelper` | **76 键 / 72 真可用 / 4 桩**（`messageFormatter`、`swipe`、`swipe_left`、`swipe_right`） | 权威面 134（10-08 口径）⇒ **在场率 57% / 在场项真可用 95%** |
| `Mvu` | **6 键** | events/getAllVariables/getVariable/setVariable/replaceVariables/getMvuData —— MVU beta 判据全中 |
| **`SlashCommandParser.commands`** | **0 条** | 🔴 见 §3.1 |
| 帧内第三方库 | jQuery/toastr/DOMPurify/lodash/moment/Handlebars 全在场 | 比 ST 的 7 项常用库齐 |
| **帧内样式守护** | ✅ 已上线（`__palinkStyleGuardRestored` 实测每帧补回 3 个） | 今天 `0cd3860` |

> ⚠️ **测量方法自纠**：第一版探针把 `callPopup` / `callGenericPopup` / `getCharacterCardFields` 误判为桩——它们的源码是
> `async (...) => ( showPopupCompat(...) )` 这种**圆括号表达式箭头函数**，基于花括号的空体判定会失效。
> 实测核对后三者都接了真实现（`showPopupCompat` → 宿主 `popupManager.show()`）。本报告数字已按
> `.tmp_probe/probe-cls.js`（`reportStubApi(` / 空 class / 空体三级判据）修正。

### 2.2 主页面轨（S5 删大堂后）

| 项 | 实测 | 判定 |
|---|---|---|
| `window.SillyTavern` | **3 字段**：`getExtensionPrompts`、`getContext`、`eventSource` | 与"只注册 getExtensionPrompts"一致 |
| `window.getContext()` | **13 键 / 覆盖 9 of 145** | ⚠️ 这个 getContext 来自 `runtime.ts` 的 `SillyTavernRuntime.getContext()`，返回的只是 `setContext()` 喂过的东西，**不是** `getContext.ts` 那个 145 键全量实现。实测 13 键 = `name, character, chat, chatId, onlineStatus, chatMetadata, characters, groups, extensionSettings, stat_data, characterId, characterUuid, name2` |
| `window.TavernHelper` / `Mvu` / `SlashCommandParser` | 0 / 0 / 不存在 | 主页面不再是 ST 宿主（S5 预期结果） |
| 9 个挂载点容器 | 9/9 **存在** | `qr_container` 5239 字节、`regex_container` 8705、`translation_container` 6678 **有内容**；tts/vectors/caption/summarize/sd/expressions **空** | 
| `#palink-st-plugin-host` | 不存在 | S5 删大堂的预期 |

### 2.3 后端 ST Extras 端点（2026-09-05 实弹口径，至今未变）

| 端点 | 状态 |
|---|---|
| `/api/vector/*`（8 个） | ✅ **唯一真实实现** |
| `/api/backends/chat-completions/generate` | ✅ 存在（智能卡拦截链红线端点） |
| `/api/backends/text-completions/*`、`/api/extra/{caption,classify,summarize,translate}`、`/api/sd/*`、`/api/sprites/*` | ❌ 缺失/404 |

> ST 的 Extras 全是**转发代理**（自身不生产内容），所以"缺端点"= "补一个代理"，不是原理不可行。

---

## 3. 差距逐项（按优先级）

### 🔴 P0-1 斜杠命令：`SlashCommandParser.commands` 空转（最便宜、收益最大）

**事实**：

| | 数量 |
|---|---|
| ST 注册命令 | **289**（核心 222 + 内置扩展 67）+ 175 别名 |
| Palink 帧内 `SlashCommandParser.commands` | **0** |
| Palink 自有 `slash-engine` 命令名 | **92**（commands.ts + extended-commands.ts + mod.ts） |
| Palink 92 与 ST 289 **同名**的 | **29**（abs/addvar/echo/delay/gen/getvar/if/let/model/preset/run/send/setvar/swipe/while/world…） |
| Palink 专有 9 条桥（`runPalinkSlashCommands`） | branch-create / checkpoint-* / chat-fork / getchatname / model / profile / preset / profile-list —— 其中 8 条 ST 也有同名 |

**影响**：卡脚本里 `executeSlashCommands('/echo xxx')`、`/delay`、`/popup`、`/setvar` 一律拿不到结果；依赖 `/` 控制流（`/if` `/while` `/let` `/run`）的第三方卡逻辑整体不工作。

**做法（估计 200~400 行 + 1 个契约测试）**：
1. 帧内把 `SlashCommandParser.commands` 做成**懒代理**：查不到的名字一律转给宿主 `executeSlashCommandCompat`（Palink 已有 engine，92 条命令、含 `executeSlashCommandsWithOptions` 支持）；
2. 给 ST 高频但 Palink 没有的 ~40 条补**薄实现**（多半是 echo/pass/abort/stop/addswipe/delswipe/note/sysprompt/tempchat/newchat/delchat/closechat/renamechat/messages/comment/cut/flat/match/replace/sub/mul/div/mod/pow/round/min/max/sqrt/cos/sin/rand/hide/unhide/lock/bg/beep/input/setinput/impersonate/sendas/sysname/sysgen/instruct/regenerate/start-reply-with/context/flushinject/listinjects/inject/tokenizer/speak/translate/summarize/caption/api/api-url/persona-get/persona-set）；
3. 别名补齐（`/m`→model、`/s`→style、`/save`→export、`/cls`→clear 等 175 条别名的常用子集）。

**验收**：把 289 条逐个 `/命令名` 打一遍，要求核心 222 条里 **≥180 条有确定性返回**（剩余是 ST UI 类命令，如 `/bg` `/panels`，映射到 Palink 无意义）。

### 🔴 P0-2 getContext 缺 9 键 + 15 个非真可用项

先纠正一个可能的误解：**`callPopup` / `callGenericPopup` / `getCharacterCardFields` 不是桩**（第一版探针误判，已实测源码核对），它们已经接到宿主 `popupManager.show()` 与角色卡数据。真正要动的是下面这些：

| 缺口 | 影响 | 做法 | 成本 |
|---|---|---|---|
| `renderExtensionTemplate` / `renderExtensionTemplateAsync`（**缺失**） | 插件 UI 注入主路径，卡内取不到 | 帧内已有模板渲染，挂上去即可 | ~30 行 |
| `timestampToMoment` / `uuidv4` / `humanizedDateTime`（**缺失**，但 TavernHelper 有） | 纯工具函数，卡里常用 | 从 `TavernHelper` 同名实现挪一份到 getContext | ~15 行 |
| `registerHelper` / `registerDebugFunction`（**缺失**） | Handlebars helper 注册 | 空实现但**存在**（ST 语义是注册、返回 void） | ~10 行 |
| `chatCompletionSettings` / `textCompletionSettings`（**缺失**） | 读模型参数 | 映射到 Palink 预设对象（可能不完整，但至少有形状） | ~20 行 |
| `ChatCompletionService` / `TextCompletionService`（空 class） | 很少有卡直接用，但 `instanceof`/构造会炸 | 给最小可用壳（构造 + 1 个方法） | ~20 行 |
| `getRequestHeaders`（stubApi，恒 `{}`） | 卡脚本自己发请求时无认证头 | **安全决策**：是否把真实头暴露给 opaque origin 帧 | 待拍板 |
| `saveWorldInfo` / `updateWorldInfoList` / `reloadWorldInfoEditor`（stubApi，假成功） | 世界书写操作静默失效 | 接到 Palink 世界书写端点 | ~40 行 |
| `getChatCompletionModel` / `getTextGenServer` / `convertCharacterBook`（stubApi，占位空） | 读模型名/服务端/转换角色书 | 返回 Palink 真实值（`generationEngine` 已有） | ~25 行 |
| `getMediaDisplay` / `getMediaIndex` / `appendMediaToMessage` / `scrollOnMediaLoad`（stubApi） | 消息媒体显示与追加 | 映射到 Palink `extra.media` | ~30 行 |

**合计 ~200 行 + 1 个契约测试**。做完 getContext 真可用率 **83% → ~97%**。

### 🟡 P1-1 ST Extras 后端：让"轻后端插件"真能用

按 `ADAPTATION.md` P1，缺 4 类 + 1 个别名：

| 缺口 | 插件 | 动作 |
|---|---|---|
| `/api/extra/{classify,summarize,translate}` | Summarize / Chat Translation / memory | 接 Palink 自有 LLM 走**转发代理**（同 `/api/openai/generate-image` 先例） |
| `/api/sprites/{get,delete}` | expressions | 映射到 Palink 资源服务 |
| `/api/sd/*`（只 SD WebUI + ComfyUI 2 个 provider） | stable-diffusion | 薄代理 |
| `power_user` 别名 | expressions | getContext 加 `power_user` 指向 `powerUserSettings` |
| TTS 音频源 | tts | 先确认是否可用浏览器 Web Speech（免改） |

**这是"工作量大但确定"的一段**：纯代理工程，无架构风险，但每项都要一个外部服务配置才能真跑。

### 🟡 P1-2 主页面 getContext 全量化（可选）

主页面 `window.getContext` 现在走 `runtime.ts`（13 键），`getContext.ts` 的全量 145 键**只有测试 farms 到**。如果未来还要给"主页面插件"用（S5 后已不是默认路径），把 `runtime.ts` 的 `getContext()` 改为委托 `getContext.ts` 的实现即可。**当前优先级低**——卡内轨才是生产路径。

### 🟢 P2 按资源选做

- SD 其余 28 个 provider、caption 的 horde fallback、connection-manager 全 provider
- `SillyTavern.libs` 补齐到 17 项（Fuse/hljs/DiffMatchPatch/Readability/Bowser/seedrandom/css）
- TavernHelper 从 76 补到 134（按真实卡使用频率排序，10-08 报告已列过 31 项实际使用）

---

## 4. 不建议做的事（补了有害）

| 不要补 | 原因 |
|---|---|
| 恢复大堂轨（主页面注入插件） | 安全倒退，S5 的核心收益就是干掉它 |
| 让 ST 扩展 UI 在角色卡内可见 | 口径 c 已拍板（2026-10-15），且技术上父侧对未信任卡全盲 |
| `getPresetManager` / `getChatCompletionModel` 的真实现 | Palink 模型体系与 ST 预设体系结构不同，硬补会做出"看起来对、实际错"的语义 |
| `unshallowCharacter` / `getCharacterSource` | ST 私有数据水合概念，Palink 后端一次性给全量 |
| 追求 289/289 命令 | 其中约 60 条是 ST UI 类（`/bg` `/panels` `/movingui` `/theme` `/gallery`），Palink 没有对应界面 |

---

## 5. 路线图（三阶段，可分批验收）

```
第 1 阶段（P0，约 2 周）—— 让"卡脚本里能写 ST 命令"
  P0-1  SlashCommandParser 懒代理 + 40 条高频命令补薄实现      → 命令覆盖 0 → ~200/289
  P0-2  getContext 补 9 键 + 消 15 个非真可用项              → getContext 真可用 83% → ~97%
  验收：289 条命令逐个跑，核心 222 条里 ≥180 条有确定性返回；
        getContext 契约测试 145/145 + 真机探针复跑 non-real 项 ≤ 3

第 2 阶段（P1，约 3 周）—— 让"轻后端插件"真能用
  P1-1  Extras 四类端点 + power_user 别名 + sprites + SD 2 provider
  验收：Summarize / Chat Translation / expressions / stable-diffusion 四插件端到端跑通一遍

第 3 阶段（P2，按资源）—— 补齐库与长尾
  libs 17 项、TavernHelper 76→134、SD 其余 provider
  验收：10-08 报告的"31 项实际使用"逐项跑通
```

**每阶段的门禁纪律**（照本项目既有口径）：改动必须配契约测试 + **改坏证明会红 / 还原回绿**，且 dist 重建后真机复跑同一探针（`probe-st-parity2.js`）对比数字，不允许"测试绿了就宣称扩展了"。

---

## 6. 结论

### 6.1 距离多远

| 目标 | 距离 |
|---|---|
| "**完美兼容 ST**"（289 命令 / 134 API / 15 扩展 / 预设人设扩展安装全套） | **不可达**。ST 是一整套前端产品，Palink 是另一套。硬对齐会把 Palink 拖成"半个 ST"，且与自有模型/预设体系冲突。 |
| "**角色卡完美显示 + 美化**"（你今天的痛点） | **已经到达**。今天 `0cd3860` 修掉样式被掏空后，5 卡实测 t=4.2s 与 t=11.2s 视觉/高度完全一致、0 toast。剩下的是长尾卡（依赖 SD/表情/翻译的卡）。 |
| "**生态绝大多数卡 + 常用插件能跑**" | **2~5 周**：P0 两周（命令 + getContext）解决 80% 的"卡内脚本不工作"，P1 三周解决"插件半残"。 |

### 6.2 如果只做一件事

**做 P0-1（斜杠命令懒代理）**。理由：
1. 成本最低（Palink 自己已有 92 条命令的 engine，缺的只是"注册到 ST 的 parser 上"这一层壳）；
2. 收益最直接（`/echo` `/delay` `/setvar` `/popup` 是第三方卡脚本最高频的调用）；
3. 不碰架构、不碰安全边界、可随时回滚。

### 6.3 附：本次实测的可复核产物

| 文件 | 内容 |
|---|---|
| `.tmp_probe/probe-st-parity2.js` | getContext 145 键存在性 |
| `.tmp_probe/probe-cls.js` | **精确分类**：real / empty-fn / empty-class / stubApi-wrapped / 合法空值 |
| `.tmp_probe/probe-stubs.js` / `probe-gt.js` | 逐项 dump 真实源码（核实 callPopup 等是否为桩） |
| `.tmp_probe/probe-mounts.js` | 9 挂载点 + 帧内第三方库 |
| `.tmp_probe/out-*.txt` | 原始输出 |
| `frontend/src/lib/sillytavern/__tests__/getcontext-parity.test.ts` | 145/145 契约（jsdom 口径，非真机） |
| `_reference/sillytavern-1.18.0/` | 权威基准源码（不入库） |

⚠️ **两个必须记住的口径差**：
1. `getcontext-parity.test.ts` 的 **145/145 是 jsdom 口径**（跑的是 `getContext.ts`）；真机上 iframe 轨是 **存在 135/145、真可用 120/145**，主页面轨是 **9/145**。**别把测试数字当线上数字。**
2. **桩判定不能用 `typeof === 'function'`**，也不能只按花括号判空体——`async (...) => ( expr )` 这种圆括号箭头会被误判。本次已因此误判 3 项，已用源码 dump 逐项纠正。
