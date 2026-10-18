# HANDOFF — 包H：TavernHelper 命名空间广度补齐（76 → 110+）

> 派发对象：子 agent｜优先级：**P1**｜预估：约 250~400 行 + 契约测试 + 离线用量分析
> 前置：`REPORT_完美兼容ST_现状天花板与路线图_2026-10-18更新版.md`（必读）
> **只做功能代码，不改 `frontend/dist`、不重建后端镜像**（收尾由主脑做）。

---

## 1. 背景：先把三个数字的口径搞清楚（本包最容易翻车的地方）

| 数字 | 含义 | 出处 |
|---|---|---|
| **134** | TavernHelper 权威键总数 | **今天重新复现验证**：`st-plugins/third-party/JS-Slash-Runner-main/@types/function/` 全目录 `grep -rho "readonly [a-zA-Z_$][a-zA-Z0-9_$]*\s*:" \| sed 's/readonly //;s://' \| sort -u` = **134**（精确命中，不是估的） |
| **57** | Palink 兼容层自己提供的键数 | `runtime-body/part-07.ts:234-318` 的 `tavernHelperCompat` 对象字面量（实测 57 个 `    key:` 行） |
| **76** | 真机帧内 `window.TavernHelper` 键数 | = 57（Palink）∪ ~19（**卡自带的 TavernHelper 运行时自注册**，露缇雅帧内实测） |

⚠️ **76 不是 Palink 的覆盖率，别拿 134−76=58 当工作量**。真机那 76 里有 ~19 个是
卡自己的酒馆助手运行时注册的；同样地，**你的目标也不是 134−57=77 个全补**——
TavernHelper 运行时会自注册一部分，剩下的是"调 ST 宿主能力"的 API，才需要 Palink 接。

### 1.1 开工第一步：把 134 个键分成三类（做完写进报告）

对每个键判定：

- **A 类：Palink 兼容层已提供且真可用**（现有 57 里的大部分）
- **B 类：卡自带 TavernHelper 运行时会自注册**（不用补；判定法见下）
- **C 类：真缺，且真实卡/插件会用** ⇒ **本包补**
- **D 类：真缺但无 Palink 对应能力 / 无生态使用** ⇒ 不补，逐个列理由

B 类判定法（可复现）：TavernHelper 运行时源码的 `initializeGlobal` 自注册段。
本地没有该源码现货时，用**真机探针**兜底：在露缇雅帧内执行
`Object.keys(window.TavernHelper)`，与 Palink 的 57 取差集 ⇒ 差集即"运行时自注册"部分
（露缇雅帧内 tha_helper 来自卡自带 scripts，见 `REPORT_真实角色卡兼容性实测` §5）。

---

## 2. 用量优先级：真实卡到底用什么（今天离线实测，别拍脑袋）

今天对**露缇雅**（`c28061bb-a9b7-46a9-a255-2692d57001fc`，th=3：MVUbeta / 露缇雅变量结构 / 相册）
和**猫娘**（`scripts/debug/.tmp_card/card_1_ccv3.json`，th=2）的脚本做了正则可视化统计，结论：

| 形态 | 露缇雅 | 说明 |
|---|---|---|
| `SillyTavern.getMvuData` / `SillyTavern.events` | 2 / 1 | MVU 专用扩展面 |
| 全局函数 `getVariables` / `getChatMessages` / `eventOn` | 各 4 | **卡脚本的主用形态** |
| `Mvu.*`、`TavernHelper.*` 直调 | 少数 | 命名空间直调很少 |

⇒ **优先级 1：全局函数面真可用**（`eventOn/eventEmit/getVariables/setVariables/
insertOrUpdateVariablesWith/deleteVariable/getChatMessages/setChatMessages/
triggerSlash/getCurrentMessageId/addOneMessage/replaceScriptButtons/...`，
即 `card-script-runner.ts:184-238` 的 `installCardScriptCompatGlobals` 与
`part-07.ts` 已挂的那批）。**逐个体检"是不是假实现"**，这比多补几个命名空间键值钱。

⇒ **优先级 2：命名空间里"插件型卡"会用的键**。从 `st-plugins/`（在仓现货，13 个内置扩展目录：
caption/regex/translate/tts/vectors/expressions/memory/quick-reply/gallery/stable-diffusion/
token-counter/connection-manager/attachments）grep 出它们实际消费的 TavernHelper API，
交叉 134 清单得出真实高频集。已知的高价值项
（从 ST 扩展典型消费 + @types 注释判出，动手前用 grep 复核）：

```
getCharData / getCharLorebooks / getCurrentCharPrimaryLorebook / setCurrentCharLorebooks
createLorebook / setLorebookEntries / getLorebookEntries / getLorebookSettings / setLorebookSettings
getChatWorldbookName / getOrCreateChatLorebook / rebindCharWorldbooks / rebindGlobalWorldbooks
formatAsDisplayedMessage / retrieveDisplayedMessage / getLastMessageId / getMessageId
substitudeMacros / triggerSlash / errorCatched / waitGlobalInitialized / initializeGlobal
getChatHistoryBrief / getChatHistoryDetail / getModelList / getCharacterIds / getCharacterNames
createChatMessages / setChatMessages / rotateChatMessages / deleteChatMessages
insertVariables / updateVariablesWith / deleteVariable
```

---

## 3. 实现红线

1. **语义从 `st-plugins/third-party/JS-Slash-Runner-main/@types/function/*.d.ts` 的注释 +
   ST 权威源码逐字移植**，不自己发明。宿主能力经既有 `requestParent` 桥接
   （`SmartCardCompatController.ts:763+` 的 action 链，世界书侧已有
   `getCharWorldbook`/`getWorldbookEntries`/`createOrReplaceWorldbook`/`setWorldbookEntries`/
   `createWorldbookEntries`/`deleteWorldbookEntries`/`rebindChatWorldbook`/`activateChatWorldbook`
   八个真动作，**优先复用，别新造父侧通道**）。
2. **⚠️ `requestParent` v2 会把数组和字符串展开**（MEMORY.md「帧内两套 requestParent」：
   `SillyTavernCompatRuntime.ts:4659` 处 `{ok:true, ...data.result}`）⇒ 测试桩必须照抄真机形状，
   否则"本地绿、线上崩"。
3. **禁止假实现**：没有宿主能力支撑的键，要么不做（D 类），要么诚实失败 + warn。
   特别是 `createCharacter`/`deleteCharacter`/`replaceCharacter` 这类 ST 角色库概念
   （Palink 角色模型不同）⇒ D 类，列理由跳过。
4. **注册位置**：`part-07.ts:234-318` 的 `tavernHelperCompat` 对象里加（它已经过
   `:318-345` 的 proxy 合并逻辑，加键即生效）；**别新开文件**。
5. `part-*.ts` 是模板字符串：禁裸反引号、`${}`、注释里裸 `\n`（写 `\\n`）。

---

## 4. 验收判据（可复跑，缺一不可）

### 4.1 静态门禁

```
frontend/: npx tsc --noEmit 与 npx vitest run 全绿
  ⇒ 只认 "failed = 0" 且 "errors = 0"
```

### 4.2 契约测试（`smart-card-runtime/__tests__/`）

1. **134 全集 fixture 入库**：`__tests__/fixtures/th134-names.json`（从 1. 的命令生成，
   注释里写明生成命令与来源目录）。测试断言：帧内 `TavernHelper` 可见键
   （`Object.keys` + proxy `has`）对 134 的命中 **≥ 110**，且每个命中键**有真值或真可调用**
   （判据：源码文本契约 + jsdom 执行）。
2. **假实现清零**：对 2. 的优先级 1 全局函数清单逐个断言"非桩"（不许 `reportStubApi` 痕迹）。
3. **每条新键一个行为测试**：输入固定 → 断言输出等于 ST 同语义产出（期望值出处写注释）。

### 4.3 真机探针（露缇雅 7 帧，入口 `/characters/c28061bb-a9b7-46a9-a255-2692d57001fc`）

```
改前：帧内 TavernHelper = 76（= Palink 57 ∪ 运行时自注册 ~19）
改后：帧内 TavernHelper ≥ 110/134
      其中"真可用"判定：抽 20 个高频键在帧内实调，返回值形状正确（不是 undefined/不是抛错）
      露缇雅既有行为零回归：7 帧 / Mvu 6 / 状态栏帧 bodyLen 1361/1487 / 变量变化面板在
```

⚠️ 探针口径：`for (const f of page.frames())` 找 iframe 帧（`frames()[0]` 是主页面）；
`open`+`run-code` 同一条 bash 命令（会话不持久）；输出重定向到文件再读。

### 4.4 反证要求

取 3 个新键，**临时改坏**（删实现/返回错值）⇒ 契约测试必须红；**还原** ⇒ 回绿。
两次输出贴报告。

---

## 5. 交付物

1. 代码 + 测试。提交用 `git commit -o -- <pathspec>` 只提自己的文件；
   消息含代码标识时用 `-F <消息文件>`（反引号会被 bash 吃掉），`-F` 在 `-o --` 之前。
2. `docs/_active/report/REPORT_包H_TavernHelper广度_2026-10-18.md`：
   - 134 键 A/B/C/D 四分类全表（**D 类逐个理由**）
   - 用量证据：露缇雅/猫娘/st-plugins 三处 grep 的统计输出
   - 改前/改后键数 + 20 键实调结果
   - 反证两次输出
3. `th134-names.json` fixture 入库并注明生成命令。

## 6. 明确不做

- 不改 `frontend/dist`、不重建后端镜像
- 不补 D 类（ST 角色库/检查点类概念）——列出即止
- 不动 getContext（包G）、斜杠命令（包F）、Message.tsx 去重（包I）
- 不改卡内脚本执行架构（iframe 是设计取舍，见路线图 §4.1）
