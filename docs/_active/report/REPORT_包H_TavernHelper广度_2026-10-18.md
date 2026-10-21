# REPORT 包H — TavernHelper 命名空间广度（2026-10-18）

> 状态：**已完工待验收**（段① 分类全表 + fixture、段② 全局函数面体检、段③ C 类补齐 + 契约测试 +
> 真机读数 全部到位；容器未重建 ⇒ 真机 :16000 仍是旧码，改后读数跑在 dev 5201 上，见 §6.2）
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
   §4 给出逐族算术：只接**已存在**的宿主能力（8 个世界书动作 + 聊天写动作 + 帧内变量表/显示管线/
   ctx 真数据）的上界是 **58/134**（本包已做到，真机 7/7 帧一致）；剩下 76 个键的宿主能力
   在 Palink 结构上不存在，或需要新增父侧动作（本包边界禁止）。
   **本包按红线优先做到 58，并逐个写明 D 类理由** —— 不是"少干了一点"，是 110 这条线的分母基线本身错了。

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

分类合计（**初稿判定**）：**A = 13，B = 0，C = 58（计划补），D = 63（逐个理由）**，
13 + 58 + 63 = 134，`py .tmp_probe/H/classify.py` 现场对账（族间零重叠、零遗漏，脚本会 assert）。
**实现期改判后的终值**：A = 13、B = 0、C = 45、D = 76 —— 初稿 C 里有 14 个键在核实"有没有宿主写通道"
时掉到 D（逐条见 §7.2），下表凡属这 14 个键的行仍以 §7.2 为准。

> **订正（2026-10-20，包AA C）**：上面这组终值里 **`registerMacroLike` 一个键从 D 挪到 C**
> ⇒ **C = 45 → 46、D = 76 → 75、本包上界 A + C = 58 → 59**（A = 13、B = 0 不变；13 + 46 + 75 = 134 仍闭合）。
> 挪动依据（不是为了让守卫变绿，是底层能力当天才真的有了）：
> ① 成员形态一手在 `st-plugins/third-party/JS-Slash-Runner-main/@types/function/index.d.ts:98`
>    （`readonly registerMacroLike` 就写在 TavernHelper 的成员清单里，与 `deleteLorebook` 同一张清单）；
> ② 实现真实存在于 `runtime-body/part-03.ts` 的 `registerMacroLikeCompat`（主脑独立复跑
>    `z-package-macro-register.test.ts` 10/10 绿），帧内成员键由 `part-07.ts` H 段
>    `th134Bridge('registerMacroLike')` 桥到**同一个**窗口全局实现，不复制第二份逻辑。
> 原文照留不改写；守卫同步改判见
> `frontend/src/components/ui/custom/smart-card-runtime/__tests__/h-tavernhelper-134-contract.test.ts`
> 的 D 名单注释，台账另见 `REPORT_包AA_别名进表与listvar照ST与宏成员键_2026-10-20.md`。
>
> **订正（2026-10-20，批次A 写桥四键）**：在包AA 那次改判的基础上再挪 **4 个键** ——
> `deleteWorldbook`、`deleteLorebook`（原 `wb_delete` 族）、`setCurrentCharLorebooks`、
> `rebindCharWorldbooks`（原 `chat_binding` 族）
> ⇒ **C = 46 → 50、D = 75 → 71、本包上界 A + C = 59 → 63**（A = 13、B = 0 不变；13 + 50 + 71 = 134 仍闭合）。
> 依据同样不是"为了让守卫变绿"，而是三层都落到实物：
> ① 存储形状：绑定在本仓是 `character_id`（归属）与 `type=='character_book'`（角色书标记）**两列合取**
>    （`backend/app/models/worldbook.py:16/:24`），后者还决定 MVU 是否抽 `<initvar>`；
> ② 缺口实打实补齐：改前 `type` 列**没有任何 API 写通道**，只改 character_id 会"绑完读不回来"，
>    现已开 `PUT /api/worldbooks/{id}` 的 type 写通道（含两个枚举的 validator），
>    并连带修掉列表缓存失效恒不匹配的既有 bug（详见 `REPORT_包AB_写桥四键_2026-10-20.md` §2）；
> ③ 行为有测试托底：帧内 G 组 7 条 + 父侧 13 条，且**反证过一次**（父侧动作短路 ⇒ 6 条转红，还原回绿）。
> 三个口径分开报（别拿 `covered_in` 当成果）：权威名 134 / 表内键 / 真实现数，见包AB 报告 §6。

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
| C：本包真正落到**已有**宿主能力上的（净增、真机实调通过） | **45** |
| **本包上界 = A + C（真机实测）** | **58** |
| D：无宿主能力 / 需新增父侧动作 / 结构不可达 | **76** |

> 本节初稿写的是"上界 71 / D 63"，那是**实现前**的判定。实现期逐个核实后，
> 有 14 个初稿标 C 的键其实没有宿主写通道，改判 D（逐条理由在 §7.2）。
> 数字以真机实测为准，不以初稿为准。

> **订正（2026-10-20，包AA C）**：上表三行数同日更新 ——
> **C 45 → 46**（`registerMacroLike` 成员形态已实现，依据与实测见 §3 下面的 2026-10-20 订正段）、
> **A + C 本包上界 58 → 59**、**D 76 → 75**。
> 下面"D 的 76 个键按族是……"一行的族计数与"58 + 30 = 88"那段算术**按订正前口径保留原文**，
> 复算时请用 D = 75：正则对象模型族少 1 个键（`registerMacroLike` 已从 D 名单移出），
> 上界算术变成 59 + 30 ≈ 89，仍 < 110 —— 本节结论（≥110 这条线本身错）不因这次改判而改变。
>
> **订正（2026-10-20，批次A 写桥四键）**：同日再更新一次 ——
> **C 46 → 50**、**A + C 本包上界 59 → 63**、**D 75 → 71**。
> 挪出去的两个族：**世界书删除 -2**（`deleteWorldbook` / `deleteLorebook`）、**聊天绑定写侧 -2**
> （`setCurrentCharLorebooks` / `rebindCharWorldbooks`）⇒ 按族口径 D 现在是
> 宏注册 0、世界书删除 0、聊天绑定写侧 0，其余族数不变。
> 上界算术随之变成 63 + 30 ≈ 93，仍 < 110 —— 本节结论不变。
> 数字以真机/测试实测为准；判据与反证原始输出见 `REPORT_包AB_写桥四键_2026-10-20.md`。

> **订正（2026-10-20，批次B 段① 人设 11 键）**：再挪 **3 个键** ——
> **C 50 → 53**、**D 71 → 68**、**A + C 本包上界 63 → 66**。
> 挪出去的是 persona 族里帧内无注册的 D 类键 `getPersona` / `createPersona` /
> `getCurrentPersonaId`；persona 族按族口径 D 11 → 8（其余 8 键改前走探测面合成函数，
> 本批换成真桥，属 C 族内部诚实度升级，三数不变）。上界算术随之变成 66 + 30 ≈ 96，
> 仍 < 110 —— 本节结论不变。
> 依据：persona.d.ts 全 11 键契约 + `personas.py` 六路由 + title/role/lorebook 补列
> （用户 2026-10-20 拍板）。判据与反证原始输出见
> `REPORT_包AC_人设与角色库写通道_2026-10-20.md`。

> **订正（2026-10-20，批次B 段② 角色库写侧 7 键）**：再挪 **5 个键** ——
> **C 53 → 58**、**D 68 → 63**、**A + C 本包上界 66 → 71**。
>
> **⚠️ 主脑复验再订正（2026-10-20 批次B）**：上面这两条 53→58 / 66→71 **少算了 10 个键**。
> 原因是执行方按"契约测试 D 名单里列了谁"来移键，而**那份 D 名单本身就漏列**：
> 报告 §3 的人设族是 **11 键**、角色库写侧族是 **7 键**（共 18），守卫里只列了 3 + 5。
> 主脑逐键核实这 18 个都有真实现（帧内成员在字面量里、且桥到父侧动作；
> `updatePersonaWith` = `getPersona`+`replacePersona`、`updateCharacterWith` =
> `getCharacterDetail`+`replaceCharacter`，属 ST 的读-改-写语义而非空壳；
> `RawCharacter` 是帧内本地类，其 `getChatsFromFiles` 诚实抛错并留 K 痕），
> ⇒ 权威计数应为 **C 50 → 68**、**D 71 → 53**、**A + C 上界 63 → 81**（13 + 68 + 53 = 134 闭合）。
> 同时已把 18 键全部钉成 `h-tavernhelper-134-contract` 的正向锚点（含"复合族必须读写两个父侧动作都在场"），
> 并反证过：把一个键名改成不存在的键 ⇒ `1 failed | 46 passed`，还原 ⇒ `47 passed`。
> **口径教训**：移键必须按**报告的族表**逐条对账，不能按守卫列表"列了几个移几个"——
> 守卫漏列的键，改判时会静默少算，而这恰恰是"下次有人把它们塞成空壳也无人发现"的那批。
> 挪出去的是角色库写侧里帧内无注册的 D 类键 `createCharacter` / `deleteCharacter` /
> `replaceCharacter` / `importRawCharacter` / `RawCharacter`；角色库写侧族按族口径 D 7 → 2
> （`createOrReplaceCharacter` / `updateCharacterWith` 本就不在 D 名单，改前走探测面合成函数，
> 本批换成真桥，属 C 族内部诚实度升级，三数不变）。上界算术变成 71 + 30 ≈ 101，仍 < 110 ——
> 本节结论不变。字段映射表（验收物）见 `REPORT_包AC_*` §7A（结论：不需要加列）；
> 删除必然级联席聊 ⇒ 必须显式 delete_chats:true 才执行。判据与反证原始输出同上报告。

D 的 76 个键按族是：预设 19、persona 11、扩展安装 9、音频 8、角色库写侧 7、正则对象模型 5、
原始导入 4（`importRawWorldbook`/`importRawChat`/`importRawTavernRegex` + 角色 1 已计入写侧族）、
世界书删除 2、inject 2、聊天绑定写侧 2（`setCurrentCharLorebooks`/`rebindCharWorldbooks`）、
DOM/opaque-origin 1、宏注册 1、按 id 停止 1、模型列表 1、脚本按钮 1、消息重排 1。
其中**只有"新增父侧 requestParent 动作"才可能翻盘**的族是 persona(11) + 角色库写侧(7) +
音频(8) + 删书(2) + 聊天绑定(2) ≈ 30 —— 即便全做，也只是 58 + 30 = 88，仍 < 110；
而且本包被明令"优先复用、别新造父侧通道"且只许改 `part-07.ts`。
⇒ **要么把 D 里 30+ 个键做成假实现（红线禁止），要么承认 110 这个线本身是按
"76/134 已覆盖"的错误基线定出来的**。本包选择：按红线做到 58、把"父侧动作缺失"型 D 项
列为**下一包的明确工程项**（§7），并把口径写死在这里，防止下一个人再按 110 排活。

---

## 5. 段② 全局函数面体检（优先级 1）结论

真机探针：`.tmp_probe/H/probe-globals.js`（对 134 个键逐个查帧内 `window[name]` 的在场性与桩痕迹）
+ `.tmp_probe/H/probe-th134.js`（7 帧逐个取 `Object.keys` / `in` / Mvu / getContext 键数）。

- **优先级 1 那批全局函数没有一个是假实现**：`eventOn` `eventEmit` `getVariables` `setVariables`
  `updateVariablesWith` `deleteVariable` `getChatMessages` `triggerSlash` `getCurrentMessageId`
  `addOneMessage` `replaceScriptButtons` `errorCatched` `waitGlobalInitialized` `generate` `generateRaw`
  逐个实测 `typeof === 'function'` 且源码文本无 `reportStubApi` / `makeMissingApiFunction` / 恒返空值的痕迹。
- 交接单 §2 的优先级 1 清单里 **`insertOrUpdateVariablesWith` 这个名字在酒馆助手运行时源码与
  @types 里都不存在**（真实名字是 `insertOrAssignVariables` / `insertVariables` /
  `updateVariablesWith`，见 `src/function/variables.ts:241/261/203`）⇒ 与包F §4.1 同一类错误，
  **不造这个名字**。
- 体检查出的 4 个**语义偏差**（不是假实现，是形状/作用域不对，均落在本包不可改的段落里，只记录不越界改）：

| # | 位置 | 偏差 | 影响 |
|---|---|---|---|
| 1 | part-07:865 `window.getVariables = () => ({...global, ...chat, ...local})` | ST 的 `getVariables(option)` 默认只给 **chat**，`{type:'global'}` 只给 global（variables.ts:56-94） | 卡用 `{type:'chat'}` 读到全局/局部变量混进来；本包的 `insertOrAssignVariables` 等新键按 ST 语义实现，两者形状不一致已在测试里写明 |
| 2 | part-07:889 `deleteVariable` 返回布尔 | ST 返回 `{ variables, delete_occurred }`（variables.d.ts:281） | 卡 `if (deleteVariable(x).delete_occurred)` 直接 TypeError |
| 3 | part-07 `tavernHelperCompat.replaceVariables = (text) => 宏替换` | ST 的 `replaceVariables(variables, option)` 是**变量表整体写入**（variables.ts:128） | 命名撞车：卡片按 ST 语义传对象会被当字符串处理。本包不敢改（A 类既有口径），已列 §7 |
| 4 | part-07:142 `normalizeCompatEntries` 的正则 | **模板串求值把 `/^\d+$/` 变成 `/^d+$/`**，实测求值后常量 `hasBrokenDPlus = true`（node 直接 import 该常量核对） | v2 requestParent 展开数组的还原分支在**生产里永远不命中**；而 `lorebook-family-contract.test.ts` 读的是**源码文本**（未经模板求值），所以本地绿、线上失效 —— 与 MEMORY.md「测试桩比生产数据更完整会掩盖真缺陷」同一类。**修法一行**（改 `regexBackslashCompat + 'd'`），但那是 S1-G11 段，不属本包可改区 |

⇒ 本包自己的代码**零裸反斜杠**（段内 `grep` 判据 0 行），并已把这条加成契约测试的守卫断言，
防止后来人在 H 段重踩第 4 项。

## 6. 段③ C 类补齐与真机读数

### 6.1 改了什么

只在允许区内动了两处：`runtime-body/part-07.ts` 的
**`>>> H-TH134 FAMILY BEGIN / <<< H-TH134 FAMILY END` 新区域**（45 个键的实现 + 一组私有 helper）
与 `tavernHelperCompat` 字面量首行的 **`...tavernHelperTh134Compat` 展开**（既有 57 键优先，A 类零改动）。
proxy 合并段本身没动 —— 它已经是 `Object.entries(tavernHelperCompat)` + `prop in tavernHelperCompat`，
加键即生效。

45 个键全部在 134 权威表内（测试有"禁止自发明名字"断言逐条拦），族分布：
变量 4、世界书/lorebook 17、角色只读 7、displayed/util/global 11、chat 写族 3、其余 3。

### 6.2 真机读数（口径：改前跑 16000 旧 dist，改后跑 dev 5201 = 当前工作区源码）

探针 `.tmp_probe/H/probe-th134.js`（改前）与 `.tmp_probe/H/probe-after.js`（改后，
分母直接从 fixture 注入，修正过一次"手抄名单只有 132 个"的口径错误 ——
**56 → 58 这一版才是对的**，判据是 `present.length + absent134.length === 134`）。
跑在哪份代码上：**改后列 = 真 Chromium + 真 iframe + 真 postMessage 桥 + 未提交前的当前工作区源码**
（`npx vite --config .tmp_probe/H/vite.hprobe.config.ts --port 5201`，`/api` 代理指 :16000，
用完已 taskkill）。零计费：只加载角色页，未触发任何生成端点。

| 指标 | 改前（:16000 旧 dist） | 改后（:5201 当前源码） |
|---|---|---|
| iframe 帧数 | 7 | **7** |
| `Object.keys(TavernHelper)` | 76 | **121** |
| **134 命中（`n in TavernHelper`）** | **13** | **58**（45 个净增全部来自本包，逐键核对 `gained not from H table = 0`） |
| `getContext` 键数（7 帧） | 194 / 194 / … | **194 / 194 / …**（零回归） |
| `Mvu` 键数（7 帧） | 6 | **6**（零回归） |
| 帧 body 字节（第 4、6 帧） | 79145 / 79593 | 79213 / 79661（+68，跨代码基线，含包F/包G 在途改动，不可归因本包） |
| 变量变化面板所依赖的事件 | — | 写 chat 作用域仍发 `CHAT_VARIABLES_UPDATED`（测试 B 组第 5 条守住） |

### 6.3 抽 20+ 高频键实调形状（同一帧内实测，不是推断）

| 键 | 实调返回形状 |
|---|---|
| `getVariables()` / `({type:'global'})` | `object{stat_data,__extension_prompts,__extension_fields,…}` |
| `getLorebooks()` / `getWorldbookNames()` / `getGlobalWorldbookNames()` | `array[0]`（该会话确实没绑全局书，空数组是真值不是桩） |
| `getLorebookSettings()` | `object{scan_depth,context_percentage,budget_cap,min_activations,max_depth,…}` |
| `getCharLorebooks()` | `promise`（与 S1-G10 的 await 口径一致） |
| `getCurrentCharPrimaryLorebook()` / `getChatWorldbookName()` | `string:'露缇雅1.2'` |
| `getCharacterNames()` / `getCharacterIds()` | `array[1]` |
| `getCurrentCharacterName()` / `getCurrentCharacterId()` | `露缇雅1.2` / `c28061bb-a9b7-46a9-a255-2692d57001fc` |
| `getCharData('current')` | `object{name,extensions,first_mes,alternate_greetings}` |
| `formatAsDisplayedMessage('台词测试')` | `string:'<span class="mes-name">露缇雅1.2</span>…'` |
| `getMessageId('TH-message--3--0')` | `number:3`；`getMessageId('palink-x')` → 抛错（与 ST 一致） |
| `substitudeMacros('{{char}}')` | `string:'露缇雅1.2'` |
| `getTavernVersion()` / `getTavernHelperVersion()` | `1.12.0` / `3.4.17`（桥到帧内既有实现，未硬编） |
| `errorCatched(() => 42)` / `errorCatched(throw)` | `number:42` / 抛错并留痕 |
| `initializeGlobal('__palinkHProbe',{v:1})` | `object{v}` 挂上 window |
| 写族（**净零探针**：写探针键后立刻删） | `insertOrAssignVariables`→object、`insertVariables`→object、`deleteVariable`→`object{variables,delete_occurred:true}`、`netZero:true` |
| 未实调的写键（会真改数据/发消息，只验在场） | `setLorebookEntries` `replaceLorebookEntries` `updatelorebookEntriesWith` `updateVariablesWith` `setChatMessages` `createChatMessages` `deleteChatMessages` `refreshOneMessage` `triggerSlash` `stopAllGeneration` `replaceWorldbook` `updateWorldbookWith` `getOrCreateChatWorldbook` `createLorebook(Entries)` `deleteLorebookEntries` `getCharacter` `waitGlobalInitialized` `getLorebookEntries` → 全部 `typeof === 'function'` |

### 6.4 门禁与反证

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` | **rc=0，0 error** |
| `npx vitest run`（全量） | **87 文件 / 1154 passed / 3 skipped / failed = 0 / errors = 0**（rc=0；本包无"非本包红"需要归因） |
| 本包契约测试 | `h-tavernhelper-134-contract.test.ts` **40 例全绿** |
| 既有相邻测试 | `generated-script-parse-guard` + `lorebook-family-contract` + `getcharworldbooknames-contract` 46 例全绿 |

反证（改坏必红 → 还原必绿），原始输出：

改坏 3 处（`insertOrAssignVariables` 摘掉注册、`getCharacterNames` 改成恒返空数组、
`setLorebookEntries` 改成空函数；备份 `.tmp_probe/H/part-07.H_backup.ts`，`cp` 还原，未走 git 破坏性命令）：

```text
 × setLorebookEntries / replaceLorebookEntries 都落到 setWorldbookEntries(target, entries, options)
 × 名字与 id 从 characters 来，id = 头像文件名去扩展名（character.ts:26-33）
 × 帧内写实现缺席时一律抛错，不返回一个假成功
 Test Files  1 failed (1)
      Tests  3 failed | 36 passed (39)
rc=1
```

还原后：

```text
 Test Files  1 passed (1)
      Tests  39 passed (39)
rc=0
```

（还原后又补了 §5 第 4 项那条"裸反斜杠"守卫断言，本包测试变成 40 例，仍全绿。）

## 7. 剩余项（下一位可直接接手）

1. **≥110/134 这条验收线要按 §4 的算术重定**：当前真实基线 13（不是 76），本包做完 58，
   剩下 76 个全是 D。要再往上走只有两条路，都要先立项：
   - **新增父侧 requestParent 动作**（可解锁 persona 11 + 角色库写侧 7 + 音频 8 + 删书 2 ≈ 28 个键）；
   - 或接受"预设 / 扩展安装 / inject"这三族永远不补（路线图 §4 天花板已拍板过一次）。
2. **报告初稿把 14 个键标成 C，实现期核实为无宿主写通道，已改判 D**（不改判就得写假实现）：
   `setCurrentCharLorebooks` `rebindCharWorldbooks`（要写角色卡 `extensions.world` /
   `world_info.charLore`，父侧无通道，且用 `createOrReplaceCharWorldbook` 顶替会把已有书清空）、
   正则族 5 键（`getTavernRegexes` `replaceTavernRegexes` `updateTavernRegexesWith`
   `isCharacterTavernRegexesEnabled` `formatAsTavernRegexedString` —— `window.getRegexScripts` 只读，
   `TavernRegex` 对象模型与 Palink `regex_scripts` 字段不同名，半程移植会造出没形状的对象）、
   `importRawWorldbook` `importRawChat` `importRawTavernRegex`（`src/function/import_raw.ts` 是
   往 ST 后端上传原始文件）、`getAllEnabledScriptButtons`（帧内根本没有脚本按钮存储，
   只有主页面 realm 的 `card-script-runner.ts:199` 有）、`getModelList`（打 ST 的
   `/api/backends/chat-completions/status`，Palink 无此端点且属计费面）。
   `rotateChatMessages`（父侧无重排消息通道）与 `getMessageId` 的兄弟 `retrieveDisplayedMessage`
   （opaque origin 读不到父页面 DOM）同理。
3. **§5 表的 4 个语义偏差**：#1 `getVariables` 的 option、#2 `deleteVariable` 的返回形状、
   #3 `replaceVariables` 的命名撞车、#4 `normalizeCompatEntries` 的 `\d` 求值丢失。
   #4 是**生产真失效**（本地测试读源码文本所以绿），改法一行，但落在 S1-G11 段，
   需要该段所有者动，并建议顺手给"模板求值后的产物"加一条守卫（本包只加了 H 段自己的）。
4. **重建 dist 后在 :16000 复跑 §6.2 那张表**（本包边界不许我 build）。判据：
   `present = 58`、`Object.keys(TavernHelper) = 121`、`getCharData('current')` 给对象、
   `getMessageId('TH-message--3--0') === 3`。命令：
   `playwright-cli -s=<名> open http://localhost:16000/` 与
   `run-code --filename=.tmp_probe/H/probe-after.js` 写在同一条 bash 命令里，输出重定向到文件再读。
5. **`docs/_CATALOG.md` 口径**：本包新增报告后立刻跑
   `py scripts/docs/gen_docs_catalog.py` + `--check` ⇒ `OK 362 docs, catalog up to date`；
   收尾时再跑 `--check` 变成 **STALE**（并行包在这半小时里又动了 docs/），
   所以该生成物**没随本包提交**（它此刻还含包F/包G 的未提交文档，我把别人的目录状态一起带走会污染
   他们的边界），由主脑收尾统一重生成并提交一次。
6. **dev 探针已收尾**：`.tmp_probe/H/vite.hprobe.config.ts`（端口 5201，与包G 的 5199 分开）
   用完已 `taskkill /PID <监听进程> /T /F`，实测端口不再响应；`.tmp_probe/` 全目录不入库。
   ⚠️ 别用 `taskkill /IM node.exe` 关自己的 dev server —— 那是全机 node，会打断并行 agent。


## 8. 订正（2026-10-21，批次Q1 本机默认放开卡片读主页面）

> **订正（2026-10-21，批次Q1）**：`retrieveDisplayedMessage` 一个键从 D 挪到 C
> ⇒ **C = 70 → 71、D = 51 → 50**（A = 13、B = 0 不变；13 + 71 + 50 = 134 仍闭合）。
> 挪动依据不是"为了让守卫变绿"，是**前提变了 + 能力真的落地**：
> ① 用户第三次裁定（SPEC_向ST学习的子系统缺口与标记方案_2026-10-19.md §2.4）：
>    本机/内网访客的卡片帧**默认给 `allow-same-origin`**，不再要求逐卡点信任；
>    公网未授信仍只给 `allow-scripts`（P1-1 对公网照旧，一个字没松）
>    ⇒ 原 D 类理由"未授信帧是 opaque origin，父页面 DOM 读不到"对本机档不再成立。
> ② 契约一手：`st-plugins/third-party/JS-Slash-Runner-main/@types/function/displayed_message.d.ts:21`
>    `declare function retrieveDisplayedMessage(message_id: number): JQuery<HTMLDivElement>`；
>    实现一手：同仓 `src/function/displayed_message.ts:87-89`
>    `$( '#chat > .mes[mesid = "<id>"]', window.parent.document ).find( 'div.mes_text' )`。
> ③ 帧内真实现：`runtime-body/part-07.ts` H 段
>    `retrieveDisplayedMessage: th134RetrieveDisplayedMessage` —— 读主页面真实节点，
>    读不到（未放开同源 / 楼层没渲染 / 没有 `.mes_text` / 帧内没有 `$`）一律**诚实返回 null**
>    + `palinkDiag` 留痕（owner 固定 `frame_compat`，不再计入缺口排行），不造任何假值。
> ④ 行为有测试托底：`__tests__/q1-retrieve-displayed-message.test.ts`（12 例，执行型，
>    用求值后载体 `COMPAT_V2_RUNTIME_ARTIFACT`）；反证过：把帧内成员摘掉 ⇒
>    `h-tavernhelper-134-contract.test.ts` 的 D 名单断言转红（1 failed | 46 passed）。
> ⑤ 守卫同步改判：D 名单移除该键 + 三条正向锚点（成员已注册 / 实现桥在场 / ST 选择器在场），
>    见 `__tests__/h-tavernhelper-134-contract.test.ts` 的批次Q1 注释块。
> 台账另见 `docs/_active/report/REPORT_批次Q1_本机默认放开卡片读主页面_2026-10-21.md`。

## 9. 订正（2026-10-21，批次P2 预设读类三键）

> **订正（2026-10-21，批次P2）**：`getPresetNames` / `getLoadedPresetName` / `getPreset`
> 三个键从 D 挪到 C ⇒ **C = 71 → 74、D = 50 → 47**（A = 13 不变；13 + 74 + 47 = 134 仍闭合）。
> 挪动依据不是"为了让守卫变绿"，是**读类能力真的落地 + 数据源真在库里**：
> ① 契约一手：`st-plugins/third-party/JS-Slash-Runner-main/@types/function/preset.d.ts`
>    —— `getPresetNames(): string[]`（无 @throws）、`getLoadedPresetName(): string`、
>    `getPreset(name: 'in_use' | string): Preset`（预设不存在 **@throws**）。
> ② 数据源：批次P2 的 P2-2 把"用户选中哪份全局预设"落进 `UserSetting.silly_tavern_settings`
>    的 `palink_prompt_preset.selected_name`（**零迁移**：不建表、不加列、不写 alembic），
>    `resolve_global_preset()` 从"取 updated_at 最新那份"改成"取选中那份 + 三层回落"；
>    会话侧仍是包AI P-1 的写时复制覆盖层。两者经 `/api/prompt-manager/sessions/{id}/preset`
>    与 `/api/prompt-manager/presets` 暴露。
> ③ 帧内真实现：`runtime-body/part-07.ts` H 段三成员 → 父侧
>    `dispatchSmartCardPresetAction`（`SmartCardCompatController.ts`）。
>    会话 id **只认宿主 `requestContext.sessionId`**，帧内 payload 里塞的 sessionId 一律不读
>    ⇒ 无跨会话越权面（有失败测试钉住）。
> ④ 形状偏差如实留痕：ST 的 `Preset = { settings, prompts, prompts_unused, extensions }`，
>    本仓 `prompt_presets` 行只有 `entries` / `config` ⇒ `prompts ← entries`（原样透传，
>    **不补 enabled/role/position 假默认**）、`settings ← config`、另两个是空容器。
>    因此 `isPresetNormalPrompt` / `isPresetPlaceholderPrompt` / `isPresetSystemPrompt`
>    三键**仍然保持 D**：缺的不是通道，是**判定字段**（本仓预设行没有 `marker` /
>    `system_prompt` / `injection_position`），补了只能恒 false —— 那是本仓红线。
> ⑤ 守卫同步改判：D 名单移除这三键 + 三条正向锚点（成员已注册 / requestParent 直连），
>    并新增一条**反向红线**（写类 9 键与 isPreset* 三键必须仍是 D）。
>    见 `__tests__/h-tavernhelper-134-contract.test.ts` 的批次P2 注释块。
> ⑥ 行为有测试托底：`__tests__/p2-preset-read-keys-frame.test.ts`（11 例，执行型，
>    用求值后载体 `COMPAT_V2_RUNTIME_ARTIFACT`）与
>    `__tests__/p2-preset-read-keys-parent.test.ts`（13 例，父侧落点 + 越权面）。
>    反证过：把帧内三成员摘掉 ⇒ 两个文件共 12 例转红。
> 台账另见 `docs/_active/report/REPORT_批次P2_预设读类与内部键守卫与全局选中名_2026-10-21.md`。

## 10. 订正（2026-10-21，批次P3 预设三键改同步 + 数据源改指）

> **订正（2026-10-21，批次P3）**：预设三键**档位不变**（仍 C），
> **C = 74 → 74、D = 47 → 47**（A = 13 不变；13 + 74 + 47 = 134 仍闭合）。
> 本批不做挪动，只订两处**接错**：
>
> ① **对外契约接错（P3-A）**：P2 把三键接成了 `async`（帧内 `requestParent` 是异步的），
>    而 ST 契约是**同步**（`preset.d.ts:150` `getPresetNames(): string[]`）
>    ⇒ 真卡按 ST 写法取 `getPresetNames().length` 拿到 `undefined`。
>    **"接错成异步"比"没接"更难发现**：不报错、不留痕、门禁全绿 —— 因为 P2 的用例都
>    `await` 了返回值，而 `await` 对同步值和 Promise **一样成立**。
>    修法（主脑定的路线）：宿主在 ctx 里带一份**预设快照**（服务端
>    `GET /api/prompt-manager/presets/snapshot` 一次算好），帧内三键**同步读快照**。
>    判据从"断值"改成"**断形状**"：`expect(v && typeof v.then).not.toBe('function')` 三条。
> ② **数据源接错（P3-B）**：整条链原先建在 `prompt_presets` 上 —— 那张表**全库 0 行**、
>    也没有第一方界面在用它（`generation_presets` 有 27 行，用户设置界面
>    `PresetManager.tsx` 走 `/api/roleplay/presets`）。用户 2026-10-20 的裁定是
>    "默认刚进卡是**设置里自己的那份**" ⇒ 不改指就违反裁定。三层回落语义一字未改，只换表。
> ③ **新增红线**：`GenerationPreset` 存在 `user_id IS NULL` 的**跨用户共享行**
>    （`api/presets.py:114-115` 的列表条件含它）⇒ 卡片侧只读本人那份，
>    写/删通道严禁落到共享行；有越权用例钉住（拿共享行 id 换基 ⇒ 404）。
> ④ 守卫改写（未删）：`h-tavernhelper-134-contract.test.ts` 里"三键有 requestParent 直连桥"
>    那条断言**必然失效**（改同步后没有直连桥了），按本仓"守卫要改写不是删"的规矩改成钉住
>    新不变量：① 键还在；② 是同步箭头（不是 `async`）；③ 不再有 `requestParent` 直连桥；
>    ④ 读的是 `ctx.presetSnapshot`。
> ⑤ `isPreset*` 三键**继续留 D**（缺判定字段，不补恒假实现）。
> 台账另见 `docs/_active/report/REPORT_批次P3_*.md` 与 SPEC §2.7。

## 11. 订正（2026-10-21，批次R1 扩展读类五键）

> **订正（2026-10-21，批次R1）**：`getExtensionStatus` / `getExtensionType` /
> `getTavernHelperExtensionId` / `isInstalledExtension` / `isAdmin`
> 五个键从 D 挪到 C ⇒ **C = 74 → 79、D = 47 → 42**（A = 13 不变；13 + 79 + 42 = 134 仍闭合）。
> 挪动依据不是"为了让守卫变绿"，是读类能力当天落地，且**逐键一手核过 ST 契约**：
> ① `getExtensionType` / `isInstalledExtension` / `getTavernHelperExtensionId` / `isAdmin`
>    在 `st-plugins/third-party/JS-Slash-Runner-main/@types/function/extension.d.ts:2/5/15/40`
>    全是**同步**；数据源 = 宿主带进 ctx 的扩展目录快照（后端 `/api/plugins/runtime/config`
>    按 user_id 作用域过滤，新增 `owner_scope` 区分 local/global）。
> ② `getExtensionStatus` **不是"启用与否"**：`@types/function/index.d.ts:47` 把它别名到
>    `getExtensionInstallationInfo`，`src/function/extension.ts:23-39` 返回
>    `Promise<{current_branch_name,current_commit_hash,is_up_to_date,remote_url}|null>`；
>    本批按该契约实现（父侧动作 `getExtensionStatus`），另附 Palink 字段 `enabled`。
>    ⚠️ 本仓没有远端版本通道（update/reinstall 属 R2）⇒ `is_up_to_date` 的语义是
>    "没有可更新到的新版本"，不是远端比对结果；R2 引入远端版本后必须重算。
> ③ `isAdmin` 的真值来源：`GET /api/users/me` 的 `role === 'admin'`（与 `App.tsx:896`
>    同口径），由 App 写入 `lib/current-user-role.ts` 快照，帧内同步读 `ctx.isAdmin`。
>    ⛔ 不从帧内 payload 取、不恒 true/false；宿主未下发时按安全默认 false 并留痕。
>    两角色测试见 `__tests__/r1-extension-read-keys-frame.test.ts`。
> ④ **启停没有新增 TavernHelper 键名**：ST 把这一族暴露成斜杠命令
>    `extension-enable` / `extension-disable` / `extension-toggle` / `extension-state` /
>    `extension-exists`（`public/scripts/extensions-slashcommands.js:89/130/171/230/266`），
>    `@types/function/` 里没有 enable/disable 成员 ⇒ 按"没有对应函数就不要自造键名"，
>    本批只补命令（宿主 slash 引擎），帧内 `triggerSlash` 可达。父侧走
>    `PUT /api/plugins/{id}/toggle`，后端作用域同步收紧：本人私有允许、全局仅管理员、
>    他人私有 404（`backend/app/api/plugins.py` 同名路由；测试
>    `backend/tests/test_plugin_toggle_scope.py`）。
> ⑤ **install / uninstall / reinstall / update 四键继续留 D**（批次R2；必须白名单源 +
>    每次显式确认）。守卫里同时钉了反向红线：这四键在本批不得被注册。
> ⑥ 守卫同步改判：D 名单移除这五键 + 两条正向锚点组（成员已注册 / 帧内实现在场）。
>    见 `__tests__/h-tavernhelper-134-contract.test.ts` 的批次R1 注释块。
> ⑦ 行为有测试托底：`__tests__/r1-extension-read-keys-frame.test.ts`（16 例，执行型，
>    用求值后载体 `COMPAT_V2_RUNTIME_ARTIFACT`）、
>    `__tests__/r1-extension-read-keys-parent.test.ts`（10 例，父侧落点 + 越权面）、
>    `src/lib/slash-engine/__tests__/r1-extension-slash-commands.test.ts`（9 例，ST 命令语义）。
> 台账另见 `docs/_active/report/REPORT_批次R1_插件只读与启停_2026-10-21.md`。
