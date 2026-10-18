# REPORT 包H — TavernHelper 命名空间广度（2026-10-18）

> 状态：**施工中**（段① 分类全表 + fixture 已入库；段② 全局函数面体检、段③ C 类键补齐见 §5 之后）
> 任务书：`docs/_active/HANDOFF_提示词_包H_TavernHelper广度_2026-10-18.md`
> 背景基线：`docs/_active/report/REPORT_完美兼容ST_现状天花板与路线图_2026-10-18更新版.md`
> 同文件近期改动参照：`REPORT_包F_ST命令补全_2026-10-18.md` §2（真机测法）、§3（宿主注入姿势）
> 边界：只动 `runtime-body/part-07.ts` 的 `tavernHelperCompat` 对象及其 proxy 合并段 + 本包测试文件；
> 不碰 `part-08.ts` / `Message.tsx` / `types/index.ts` / `CharacterCardRenderer.tsx` / 包F 的 `lib/slash-engine/*` / 包G 的测试。

---

## 1. 一句话结论（先纠正三个口径，本包的坑全在口径上）

1. **交接单 §1 的"真机 76 = Palink 57 ∪ 卡自带运行时自注册 ~19"这个解释是错的**。
   实测那 19 个键**来自 Palink 自己的 legacy 轨**
   （`smart-card-runtime/frame-shim/legacy-st-sim-parts/part-b.ts:701` 的
   `Object.assign(window.TavernHelper, {...})` 镜像表），**不是卡自带 TavernHelper 运行时的自注册**。
   ⇒ **B 类（卡自注册、不用补）= 0 个键**。交接单 §1.1 设计的"取差集判 B 类"方法在
   Palink 这套双层镜像下失去判别力，本包改用"逐键查实现来源"分类（见 §3）。
2. **路线图的"TavernHelper 76 / 134 = 57%"是把两个口径混了**：76 是
   `Object.keys(window.TavernHelper).length`（Palink 自有键 + ST 风格别名 + 非 134 内的键），
   而 134 是 `@types/function/index.d.ts` 里 `window.TavernHelper` 接口的权威成员数。
   **两个数不相干**。真机实测对 134 的命中只有 **13 个**（`n in window.TavernHelper`，7/7 帧一致）。
   ⇒ 真实起点是 **13/134（9.7%）**，不是 76/134。
3. ⇒ 由此得出本包最重要的判据问题：**验收线 ≥110/134 与红线"禁止假实现"在本包可改文件边界内互斥**。
   §4 给出逐族算术：能接宿主真实能力（既有 8 个世界书动作 + 4 个聊天动作 + 帧内变量表/显示管线/
   ctx 真数据）的上界是 **71/134**；剩下 63 个键的宿主能力在 Palink 结构上不存在，
   或需要新增父侧动作（本包边界禁止）。**本包按红线优先，做到 71 并逐个写明 D 类理由。**

## 2. 权威 134 键复现（命令与文件都入库）

生成命令（与交接单 §1 同一条，本包把它固化进 fixture 的 `_generated_by` 字段）：

```bash
grep -rhoE "readonly [a-zA-Z_$][a-zA-Z0-9_$]*[?]?\s*:" \
  st-plugins/third-party/JS-Slash-Runner-main/@types/function/ \
  | sed -E 's/readonly //;s/[?]?\s*:$//' | sort -u      # ⇒ 134 行，精确命中
```

入库产物：`frontend/src/components/ui/custom/smart-card-runtime/__tests__/fixtures/th134-names.json`
（`_count = 134`、`names[134]`、`_source` 指到 `index.d.ts` 的 `window.TavernHelper` 接口）。
契约测试直接读它当分母，**不再在任何地方手数**。

## 3. 134 键四分类全表（A 已在 / B 卡自注册 / C 本包补 / D 不补+理由）

分类不靠名字猜，**逐键查实现来源**：① 是否已在 `part-07.ts` 的 `tavernHelperCompat` 字面量里
（静态抽取，57 键）；② 是否已在 `part-b.ts` 的 legacy 镜像表里；③ 真机 `n in window.TavernHelper`
（§2 探针）；④ 缺的键能否落到**已存在的**父侧动作或帧内已有真实现上。

实测集合关系（真机露缇雅 7 帧逐帧相同）：

| 量 | 数 | 取法 |
|---|---|---|
| 权威面 | 134 | fixture |
| `Object.keys(window.TavernHelper)` | 76 | 帧内实测（**与 134 无包含关系**） |
| 134 中真机命中 | **13** | `TH134.filter(n => n in TavernHelper)` |
| ├ 来自 part-07 `tavernHelperCompat` | 8 | 静态抽取 ∩ fixture |
| └ 来自 part-b legacy 镜像 | 5 | 帧内键 ∩ fixture − 上面 8 |
| Palink 自有但**不在** 134 里的键 | 63 | 76 − 13（别名/ST 全局镜像，如 `getContext`、`sendMessage`、`swipe`） |

分类合计：**A = 13，B = 0，C = 58（本包补），D = 63（逐个理由）**，13 + 58 + 63 = 134，
`py .tmp_probe/H/classify.py` 现场对账（族间零重叠、零遗漏，脚本会 assert）。

| 类 | 族（判据） | 键数 | 键 | 依据 / 落点 |
|---|---|---|---|---|
| C | lorebook 族（ST 里 lorebook ≡ worldbook 同物异名，宿主 8 个世界书动作已在） | 14 | `getLorebooks`、`getLorebookEntries`、`getLorebookSettings`、`setLorebookSettings`、`createLorebook`、`createLorebookEntries`、`deleteLorebookEntries`、`replaceLorebookEntries`、`setLorebookEntries`、`updatelorebookEntriesWith`、`getCharLorebooks`、`getCurrentCharPrimaryLorebook`、`setCurrentCharLorebooks`、`getOrCreateChatLorebook` | 桥到 S1-G10 已注册的 lorebook 全局 + requestParent 的 createWorldbook/setWorldbookEntries/createWorldbookEntries/deleteWorldbookEntries/getWorldbookEntries/getCharWorldbook |
| C | worldbook 族 | 9 | `getWorldbookNames`、`getGlobalWorldbookNames`、`rebindGlobalWorldbooks`、`updateWorldbookWith`、`replaceWorldbook`、`getChatWorldbookName`、`getOrCreateChatWorldbook`、`rebindCharWorldbooks`、`importRawWorldbook` | requestParent 既有动作（getCharWorldbook / createOrReplaceWorldbook / rebindChatWorldbook）+ 帧内缓存 |
| C | variables 族 | 4 | `insertOrAssignVariables`、`insertVariables`、`updateVariablesWith`、`deleteVariable` | 帧内三个变量表 store + persistVariableStores（与 setVariables 同一条写路径） |
| C | chat_message 族 | 4 | `setChatMessages`、`createChatMessages`、`deleteChatMessages`、`rotateChatMessages` | requestParent 既有动作 setChatMessage / addOneMessage / deleteMessage + 帧内 switchSwipeCompat |
| C | displayed_message 族 | 3 | `getMessageId`、`formatAsDisplayedMessage`、`refreshOneMessage` | 帧内 compatChat 楼层解析 + messageFormattingCompat（帧内已有显示管线） |
| C | character 只读族 | 7 | `getCurrentCharacterName`、`getCurrentCharacterId`、`getCharacterNames`、`getCharacterIds`、`getCharData`、`getCharAvatarPath`、`getCharacter` | ctx.characterName / ctx.characterId + getContext().characters（构建期已内联的真数据） |
| C | 工具与全局初始化族 | 12 | `getTavernVersion`、`getTavernHelperVersion`、`initializeGlobal`、`waitGlobalInitialized`、`errorCatched`、`triggerSlash`、`substitudeMacros`、`stopAllGeneration`、`getChatHistoryBrief`、`getChatHistoryDetail`、`getAllEnabledScriptButtons`、`getModelList` | 常量版本号 / 帧内全局登记表 / runPalinkSlash 与 executeSlashCommandCompat / stopGeneration 动作 / compatChat |
| C | tavern regex 族 | 5 | `getTavernRegexes`、`replaceTavernRegexes`、`updateTavernRegexesWith`、`isCharacterTavernRegexesEnabled`、`formatAsTavernRegexedString` | 帧内正则引擎与 characterExtensions.regex_scripts（口径 c：只给数据与命令能力，不给 ST 面板） |
| A | Palink 兼容层已在 tavernHelperCompat 对象字面量里（真机帧内命中） | 8 | `createOrReplaceWorldbook`、`createWorldbookEntries`、`generate`、`generateRaw`、`getChatMessages`、`getVariables`、`rebindChatWorldbook`、`replaceVariables` | part-07 的 tavernHelperCompat 字面量，实测真机在场且非桩 |
| A | Palink legacy 轨（frame-shim/legacy-st-sim-parts/part-b.ts:701 Object.assign）已镜像 | 5 | `createWorldbook`、`deleteWorldbookEntries`、`getCharWorldbookNames`、`getWorldbook`、`getLastMessageId` | part-b.ts 的镜像表贡献了帧内 76 键里除 part-07 那 57 个之外的 19 个 |
| D | ST 预设体系（Palink 模型/预设结构不同，补了是"形状对语义错"） | 16 | `builtin`、`builtin_prompt_default_order`、`createOrReplacePreset`、`createPreset`、`default_preset`、`deletePreset`、`getLoadedPresetName`、`getPreset`、`getPresetNames`、`getProxyPresetNames`、`importRawPreset`、`loadPreset`、`renamePreset`、`replacePreset`、`setPreset`、`updatePresetWith` | 路线图 §4 天花板表明写"不建议补 getPresetManager / ST 预设体系"；本包不得自发明预设语义 |
| D | ST 角色库写侧（角色卡 CRUD 是 ST 后端概念，Palink 角色模型不同，且帧内桥无该动作） | 7 | `createCharacter`、`createOrReplaceCharacter`、`deleteCharacter`、`replaceCharacter`、`updateCharacterWith`、`importRawCharacter`、`RawCharacter` | 交接单 §3.3 点名 D 类；新增父侧动作超出本包可改文件边界（只许动 part-07） |
| D | ST 人设（persona）体系（宿主无父侧动作，Palink 人设走后端 REST 且形状不同） | 11 | `createOrReplacePersona`、`createPersona`、`deletePersona`、`getPersona`、`getPersonaAvatarPath`、`getPersonaIds`、`getPersonaNames`、`getCurrentPersonaId`、`getCurrentPersonaName`、`replacePersona`、`updatePersonaWith` | requestParent 动作清单里没有 persona 族；本包禁止新造父侧通道 |
| D | 酒馆助手音频播放器（Palink TTS 是逐条消息合成，没有曲列表/播放队列状态机） | 8 | `playAudio`、`pauseAudio`、`getCurrentAudio`、`getAudioList`、`replaceAudioList`、`appendAudioList`、`getAudioSettings`、`setAudioSettings` | 帧内无播放队列对象；实现只能返回假列表 ⇒ 违反禁止假实现红线 |
| D | ST 扩展安装体系（Palink 无扩展安装/权限模型，口径 c 已拍板） | 9 | `installExtension`、`uninstallExtension`、`reinstallExtension`、`updateExtension`、`isInstalledExtension`、`getExtensionType`、`getExtensionStatus`、`isAdmin`、`getTavernHelperExtensionId` | 路线图 §4："扩展安装体系"结构不可达；isAdmin 在 Palink 无对应权限语义 |
| D | ST 提示词注入槽位（inject 绑在 ST 的 extension prompt 链上，Palink 装配在后端） | 2 | `injectPrompts`、`uninjectPrompts` | 包F §4.2 已把 inject/flushinject/listinjects 归 C 类未补：宿主引擎无注入槽 |
| D | 世界书/lorebook 删除动作缺失（父侧只有增/改/绑，没有删书） | 2 | `deleteLorebook`、`deleteWorldbook` | SmartCardCompatController 动作链无 deleteWorldbook；映射成"清空条目"是假语义 |
| D | ST 私有 DOM / jQuery 面（未信任卡是 opaque origin，父页面 DOM 读不到） | 1 | `retrieveDisplayedMessage` | MEMORY.md「未信任卡 iframe 是 opaque origin」；返回帧内自己的 DOM 不是 ST 要的父页面消息体 |
| D | ST 宏注册器（助手宏 registerMacroLike 要写进酒馆助手自己的宏表，Palink 无该表） | 1 | `registerMacroLike` | substitudeMacros 可以复用 substituteParams，但注册自定义宏需要在装配链加钩子（属包G/后端，非本包） |
| D | 预设提示词类型判定（依附 ST 预设对象模型） | 3 | `isPresetNormalPrompt`、`isPresetPlaceholderPrompt`、`isPresetSystemPrompt` | 同 D 预设族：Palink 无 ST 的 preset prompt 结构，判定函数补了只能恒 false |
| D | ST 原始对象导入器（新建聊天 / 新建正则对象，写侧父动作不存在） | 2 | `importRawChat`、`importRawTavernRegex` | 父侧动作链无"新建聊天文件"与"写入正则库"；importRawWorldbook 有 createOrReplaceWorldbook 可依，这两条没有 |
| D | 按 generation id 中止（Palink 只有全局停止生成，无按 id 句柄） | 1 | `stopGenerationById` | requestParent 只有 stopGeneration（无 id 参数）；把"按 id"折成"全停"是语义不符 |

### 3.1 B 类为 0 的证据

帧内 76 键减去 `part-07.ts` 的 57 个 `tavernHelperCompat` 键，得 19 个差集键：
`getLastMessageId` `getCurrentChatId` `getAllVariables` `setVariables` `getWorldbook`
`setWorldbookEntries` `createWorldbook` `deleteWorldbookEntries` `getCharWorldbook`
`getCharWorldbookNames` `messageFormatting` `messageFormatter` `eventOn` `callGenericPopup`
`getExtensionPrompt` `setExtensionPrompt` `readExtensionField` `writeExtensionField`
`saveMetadataDebounced` —— 逐个都能在
`frame-shim/legacy-st-sim-parts/part-b.ts:701-756` 的镜像表里找到同名条目（`grep -c` 命中 19/19），
**没有一个需要归因给卡自带运行时**。
⇒ 结论修正：**露缇雅帧内没有任何键是卡自带 TavernHelper 自注册的**，全部 76 个都是 Palink 给的。
（卡内 `tha_helper` 脚本走的是 `window.TavernHelper` 的引用，不是重新定义。）

## 4. 为什么 ≥110/134 在本包做不到（算术，不是态度）

| 可补上限的构成 | 键数 |
|---|---|
| A：已在场（不占工作量） | 13 |
| C：本包能落到**已有**宿主能力上的 | 58 |
| **本包上界 = A + C** | **71** |
| D：无宿主能力 / 需新增父侧动作 / 结构不可达 | 63 |

D 的 63 个键按族是：预设 19、persona 11、扩展安装 9、音频 8、角色库写侧 7、
世界书删除 2、原始导入 2、inject 2、DOM/opaque-origin 1、宏注册 1、按 id 停止 1。
其中**只有"新增父侧 requestParent 动作"才可能翻盘**的族是 persona(11) + 角色库写侧(7) +
音频(8) + 删书(2) = 28 —— 即便全做，也只是 71 + 28 = 99，仍 < 110；
而且本包被明令"优先复用、别新造父侧通道"且只许改 `part-07.ts`。
⇒ **要么把 D 里 39 个键做成假实现（红线禁止），要么承认 110 这个线本身是按
"76/134 已覆盖"的错误基线定出来的**。本包选择：做满 71、把 39 个"父侧动作缺失"型 D 项
列为**下一包的明确工程项**（§7），并把口径写死在这里，防止下一个人再按 110 排活。

---

## 5. 段② 全局函数面体检（优先级 1）

_（施工中，见本文件末尾的实测记录）_

## 6. 段③ C 类键补齐与真机读数

_（施工中）_

## 7. 剩余项

_（施工中）_
