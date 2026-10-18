# REPORT 包E — ST 生态卡「真实世界」实测

> 状态：**已完工待验收**（实测报告，无功能代码改动）。
> 基线分支 `three-tracks-merge-20261012`，测量时 HEAD = `efeeac8`。
> 执行 agent：测量。日期 2026-10-18。
>
> ⚠️ **已知前提（主脑补充）**：包F / 包G 的执行 agent 正在并行改前端源码，
> 而 **nginx 挂载的 `frontend/dist` 是重建前的旧代码**（提交≠上线）。
> 因此本报告所有真机数字反映的是**当前部署 dist（旧构建）**的行为，
> **不代表** `three-tracks-merge-20261012` 最新源码。判据一律用运行时 DOM / 帧内对象，
> 不用"最新提交已生效"。源码 `文件:行号` 仅用于定位"修在哪"，非"当前已生效"。

---

## 0. 一句话结论

在 5 张去重样本卡（7 个角色，其中 3 个是同一张卡的克隆）上实测：
**纯文本卡全部正常显示；唯一一张富 Tavern 卡（墨蝶妖1.2 家族）结构上能渲染
（7 帧 / getContext 145/145 / TavernHelper 76 / Mvu 6），但存在两个可复现缺陷：
Palink 自己的 5 个测试插件注入的 CSS 在 ~6–14s 内被清空且守护无法恢复，
以及 `getContext().characterId` 恒为 0。** 包A 遗留的最高风险（解析期同步读 extensions）
**未导致崩溃**——卡脚本用了 `?.` 可选链，降级为读空值。

---

## 1. E-1 — ST 289 命令 fixture（验收基建，已落盘）

**产物**（本包交付物，未 git add / 未提交）：
- `frontend/src/lib/sillytavern/__tests__/fixtures/st-slash-commands-1.18.0.json`
- `frontend/src/lib/sillytavern/__tests__/fixtures/README.md`（提取方法 + 复跑命令）
- 提取脚本：`.tmp_probe/extract_st_commands_E1.py`（`py .tmp_probe/extract_st_commands_E1.py --write` 复跑）

**分开报数（ST 1.18.0，静态提取自 `_reference/sillytavern-1.18.0/public/scripts/`）**：

| 桶 | 数量 | 说明 |
|---|---|---|
| core | **220** | 非扩展脚本（power-user.js / chats.js / personas.js / backgrounds.js …） |
| extension | **73** | `extensions/**` + `extensions-slashcommands.js`（connection-manager / vectors / regex / sd / tts / quick-reply …） |
| commands（core∪extension 去重） | **293** | 唯一命令名总数 |
| aliases | **176** | `aliases: [...]` 二级名 |

主控报告叙述口径为 ≈222 core + 67 ext（+175 别名 ≈ 289）。静态提取为 220 / 73（总 293）。
±few 差异来源：解析器内部名（`/`、`?`、`parser-flag`、`break`、`breakpoint`，均经 `fromProps` 注册）
被计入，以及个别名 core/extension 归类边界。**此 fixture 是可复跑权威，勿再手工推导。**

提取要点（防误计）：命令 idiom = `(?<![\w.])SlashCommand\.from(Props|AsyncFunction|…)(`；
**排除** `SlashCommandNamedArgument.fromProps` / `SlashCommandArgument.fromProps`（它们是参数不是命令，
负向前瞻保证不误伤）；取对象内**第一个** `name:` 为命令名。
`help`/`format`/`crop`/`wrap`/`countwords` 是 Showdown 宏/全局函数，非 `fromProps` 命令，**不计**（正确）。

---

## 2. E-2 — 样本卡清单与依赖形态

后端 API `GET /api/characters` 列出 **7 个角色**（用 API 列，未猜）。去重后 **5 张不同卡**：
`c28061bb` / `7a3a5dfc` / `c44f2ae6` 为**同一张卡**（墨蝶妖1.2）的 3 份导入（各自独立持久化聊天）。

| 卡 | id | 依赖形态（据 extensions/first_mes 实测） | 命中 E-2 必选形态 |
|---|---|---|---|
| Yae Miko | `7c1376ed` | first_mes 纯散文，0 `<style>`/`<div>`/`<script>`/`{{var`；无 tavern_helper/regex/CDN | **① 纯静态 HTML/CSS（无脚本）** |
| Eve Marie Clarke | `8f17cf48` | 纯散文，含 11 处 `{{macro}}`，0 HTML 标签 | **① 纯静态**（+宏） |
| CardC04 | `c0400988` | first_mes 仅 19 字符，tavern_helper 为空壳（87B） | **① 最小静态** |
| 我是猫 | `78faa27a` | regex_scripts×6、tavern_helper 2 脚本（MagVarUpdate CDN import）、44 外链 URL；**first_mes 为 `<猫娘>` 自定义标签，0 标准 HTML** | **③ regex** + **⑤ CDN**（④ 的 getContext=0） |
| 墨蝶妖1.2（Lutiya） | `c28061bb` | regex×6、tavern_helper 3 脚本（含 45KB 主脚本读 `getContext`、MagVarUpdate CDN import）、830 外链 URL、`variables` | **② MVU** + **③ regex** + **④ tavern_helper+getContext** + **⑤ CDN** |

**形态④（解析期同步读 getContext）重点核对**（c28061bb 主脚本，45948 字符）：
- L295–296 `if (st?.getContext) { const ctx = st.getContext(); }`（存在性守卫）
- L341 / L369 `const stContext = (topWin.SillyTavern || window.SillyTavern)?.getContext?.();`（**可选链**）
⇒ 全部为**防御式读取**，getContext 缺失/空时**不抛异常**，降级为 `undefined`。
**包A 遗留风险结论：不崩，但解析期读到的是空值**（详见 §4 失败项 F-2）。

形态②（MVU `[initvar]`/`Mvu.getVariable`）：卡体内 first_mes/description **无** `[initvar]`/`Mvu.` 字面量；
MVU 能力是经 tavern_helper 的 `import '…/MagVarUpdate…/bundle.js'`（jsdelivr CDN）注入的运行时，
`extensions.tavern_helper.variables` 承载变量。**没找到**"卡体内直接写 `[initvar]` 宏"的样本 ⇒ 记为缺样。

---

## 3. E-3 — 逐卡真机指标（playwright-cli，端口 16000，t=6s / t=14s）

**零 API 成本证据**：`page.route('**/*')` 拦截，命中计费正则的 URL **只有** `/api/ws/ticket`
（被 `/ws/` 规则误捕，它**不是**计费端点，是 WS 鉴权票）。**`/api/chat`、`/generate`、
`/api/openai/`、`/api/extra/*`、`/completion` 命中数 = 0**（浏览既有聊天页不触发生成）。
`upstream_forwarded = 0`（凡命中一律本地 `fulfill`，从不转发）。⇒ **blockedCount（真实计费上游）= 0**。
副作用：stub 掉 ws/ticket 触发页面顶部"⚠ 网络连接较慢(3g)"黄条——**探针自造，非卡缺陷**。

截图：`docs/_active/report/shot-包E-*.png`（见 §6）。原始 shot 在 `.tmp_probe/.tmp_probe/shot-E-*.png`。

### 3.1 主页面指标

| 卡 | t6 hosts/ifr/srcdocB/toasts | t14 hosts/ifr/srcdocB/toasts | 帧内 srcdoc 每帧字节（t6） |
|---|---|---|---|
| YaeMiko | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | —（无 HTML 段，纯文本渲染，**正确**） |
| EveMarie | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | —（同上，**正确**） |
| CardC04 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | —（同上，**正确**） |
| 我是猫 MaoCat | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | —（greeting 为 `<猫娘>` 非标准 HTML，无 iframe 宿主，**正确但特性休眠**） |
| 墨蝶妖 Lutiya | 5 / 7 / **324,939** / 0 | 5 / 7 / **324,939** / 0 | [45905,46049,45999,47508,45961,47532,45985] |
| cloneA `7a3a5dfc` | 5 / 7 / 335,201 / 0 | 5 / 7 / 335,201 / 0 | 7 帧 |
| cloneB `c44f2ae6` | 5 / 7 / 342,669 / 0 | 5 / 7 / 342,669 / 0 | 7 帧 |

> 基线单卡报告值 7 帧合计 **326,773**；本次 Lutiya 324,939（差 ~1800B，属旧 dist + 不同持久化聊天，量级一致）。

### 3.2 帧内指标（Lutiya，代表富卡；7 帧数值高度一致，取帧 0）

| 指标 | t=6s | t=14s | 判定 |
|---|---|---|---|
| style 数（帧内 `<style>`） | **8**（帧3/5 为 9–10） | **3** | 🔴 **归零式下降**（见 F-1） |
| 其中插件 CSS（`id^=palink-st-plugin-css`） | **5** | **0** | 🔴 全被清空 |
| `__palinkStyleGuardRestored` | absent | **3** | 守护触发但救不回插件 CSS |
| getContext 键数 | 194 | 194 | 🟢 |
| 缺 ST-145 键数 | **0** | **0** | 🟢 145/145 齐 |
| TavernHelper 键数 | 76 | 76 | 🟢 基线 |
| Mvu 键数 | 6 | 6 | 🟢 基线 |
| `getContext().characterId` | **0** | **0** | 🔴 无值（见 F-2） |
| 帧内 `extensions` 可读 | empty | empty | 🟡 见 F-2 |
| body 文本长度 | 182（帧3/5 为 1361/1468） | 201（帧3/5 1380/1487） | 🟢 内容未清空 |
| 顶部 toast（sonner） | 0 | 0 | 🟢 |

**克隆差异（坐实"竞态"而非稳定行为）**：
- cloneA：t6 帧内 style=3、插件 CSS=**0**（**从头就没注入成功**），t14 style=3、guard=3。
- cloneB：t6 style=4–5、插件 CSS=**0**，t14 style=3–4、guard=3。
- Lutiya：t6 插件 CSS=5 → t14=0。
⇒ 同一张卡三份，插件 CSS 命运各异（5→0 / 0→0 / 0→0）= **注入与守护快照、与卡侧 head 重写三者竞态**。

---

## 4. 失败样本根因（逐条：现象 / 根因 file:line / 修在哪 / 值不值得修）

### F-1（🔴 高）Palink 插件注入的 CSS 在 ~6–14s 被清空，守护救不回
- **现象**：Lutiya 帧内 `<style>` 8→3，消失的 5 条**全是 Palink 自己的插件 CSS**，其 `data-palink-st-plugin`
  恰为主控点名的 5 个复测靶插件：
  `Chat Translation`(2e1fa886b439)、`Regex`(43ef24b1a3ba)、`Summarize`(01db1f12ddd0)、
  **`Quick Replies`(4d61e879d0c5，44,839B 最大)**、`Token Counter`(ca0611884034)。
  存活到 t14 的 3 条为基样式（10773 / `data-palink-color-scheme`25 / `data-palink-smart-card-adapter`572）。
- **谁删的 / 怎么删的（实测否证）**：在帧内 monkey-patch `Node.prototype.removeChild` 与
  `Element.prototype.remove`，**捕获到的 STYLE/LINK 删除 = 0**；而 MutationObserver 记录到 23–24 次 STYLE 移除。
  ⇒ 删除**不走** removeChild/remove，走 **`head.innerHTML=` / `outerHTML` / `replaceChild`** 路径。
  与卡侧外部 `MagVarUpdate` bundle（`import '…testingcf.jsdelivr.net/…/bundle.js'`，第三方、在帧内改写样式）行为吻合。
- **根因（Palink 侧，file:line）**：
  1. 插件 CSS 注入：`runtime-body/part-01.ts:821-827` `injectStPluginCssCompat()` 往 `document.head`
     `appendChild(<style id="palink-st-plugin-css-*">)`，且 `getElementById` 幂等（只注一次）。
  2. 样式守护快照时机：`runtime-body/part-08.ts:1516` `startCardStyleGuard()` 在 **DOMContentLoaded** 拍快照，
     `part-08.ts:1481-1482` `if (styleSnapshot) return;` ⇒ **只拍一次、先到先得**。
  3. `injectStPluginCssCompat()` 的调用点（`part-06.ts:378`、`part-01.ts:675`、`part-03.ts:62`）是**异步**的
     （等父侧 postMessage 下发插件数据），常**晚于**守护快照 ⇒ 插件 CSS **不在快照内**。
  ⇒ 卡侧 bundle 之后重写 head 抹掉插件 CSS 时，`restoreCardStyles()`（`part-08.ts:994-1031`）
     只认快照里的 3 条基样式（故 `__palinkStyleGuardRestored=3`），**插件 CSS 永久丢失**。
- **修在哪**：`part-08.ts` 守护逻辑（约 1481–1521 快照段 + 994–1031 恢复段），二选一/并用，**~20–40 行**：
  (a) 让 `injectStPluginCssCompat()` 注入后**主动刷新/追加守护快照**（把插件 style 纳入快照）；
  (b) 守护的 MutationObserver 命中 `palink-st-plugin-css-*` 丢失时**重跑 `injectStPluginCssCompat()`**（其幂等检查正好支持重入）。
- **值不值得修**：**值得**。丢的是 Palink 自家 5 插件的样式，Quick Replies 44KB 全丢；凡"卡侧会重写 head 的富卡"都中招。

### F-2（🟡 中）`getContext().characterId` 恒为 0；帧内 extensions 未确认到位（包A 遗留风险落点）
- **现象**：Lutiya 全 7 帧、t6 与 t14，`getContext().characterId === 0`（falsy），`extensions` 读为空。
- **根因（file:line）**：`lib/sillytavern/getContext.ts:1785` `characterId` 计算：
  Palink 角色 id 是 **UUID 字符串** → `Number(uuid)=NaN` → 回退 `charactersArray.findIndex(...)`，
  而卡帧内 `ctx.characters` 不含该 UUID（或为空数组）→ `idx=-1` → **返回兜底 0**（`getContext.ts:1789`）。
  即 ST 语义的"characters 数组下标"在卡帧上下文里拿不到。
- **是否崩**：**不崩**。卡主脚本对 getContext 用 `?.` 可选链（§2），characterId=0 / extensions 空只导致
  "按 characterId 分区/按 extensions 水合"的功能静默降级，不抛错。包A 的"解析期同步读 extensions"风险
  **实测为：读空、不崩**（因卡侧防御式写法），未成为崩溃源。
- **修在哪**：`getContext.ts:1782-1791`——把真实角色标识透传进卡帧 context（或让 `characters` 在帧内可见），
  使 UUID→index 映射可命中，或直接暴露字符串 id 供 Palink 插件用。**~5–15 行**（需与包G 的 getContext 补齐协调）。
- **值不值得修**：**看插件依赖度**。依赖数字 characterId 的 ST 插件会拿 0；Palink 自家 `plugin-character-id.test.ts`
  已在管此事 ⇒ 建议与包G 合并处理，勿单点改。

### F-3（🟢 非缺陷，记录）4 张卡 hosts=0
YaeMiko/EveMarie/CardC04/MaoCat 在 `/characters/<cid>` 上 smart-card 宿主=0——
经核对 first_mes **无标准 HTML 段**，`extractHtmlRenderParts`（`CharacterCardRenderer.tsx:1773`）
只从 HTML 段产 iframe，纯 markdown 走文本渲染 ⇒ **0 帧是正确行为，非失败**。
MaoCat 的 regex/MVU/CDN 特性需要"含 HTML 的生成消息"才激活，本包零成本约束下不生成 ⇒ 特性休眠（见 E-4 定性）。

---

## 5. E-4 — 结论表

| 卡 | 定性 | 依据（数字） |
|---|---|---|
| Yae Miko | **能跑** | 纯文本正确渲染，无富特性 |
| Eve Marie Clarke | **能跑** | 纯文本 + `{{macro}}`，无富特性 |
| CardC04 | **能跑** | 最小文本卡 |
| 我是猫 MaoCat | **部分能跑** | 文本渲染正常；regex×6/CDN×44/MVU 因 greeting 无 HTML 宿主而**特性未激活**（非崩，是休眠） |
| 墨蝶妖1.2（Lutiya + 2 克隆） | **部分能跑** | 7 帧 / srcdoc 325–343KB / getContext **194 键 145/145 齐** / TH76 / Mvu6 全达标；**但** 插件 CSS 6–14s 内 5→0（F-1）、characterId=0（F-2）。可见聊天区为纯文本、卡帧在折叠线下方，t6/t14 截图无肉眼塌陷 |

**"哪些能跑 / 哪些不能 / 缺什么"总答**：
- 能跑：纯文本卡（本仓 3/5 去重卡）。
- 部分能跑：富 Tavern 卡——**渲染骨架 OK，但 Palink 插件 CSS 会被卡侧 head 重写抹掉且守护救不回**（F-1），
  characterId 在帧内恒 0（F-2）。
- 缺什么（没找到样本的形态）：**卡体内直接写 `[initvar]`/`Mvu.getVariable` 宏**的卡（本仓 MVU 均走外部 bundle import，无内联宏样本）；
  **需真实生成消息才能激活 regex/插件 UI 的卡**（零 API 成本约束下无法覆盖其"生成后"形态）。

### 整体百分比判断（带样本量与偏差）

- **样本量**：去重 5 张卡（7 角色，3 为同卡克隆）。**真正走 iframe/Tavern 运行时的富卡只有 1 张（墨蝶妖家族）**——
  样本对"富卡"这一关键子集 **n=1**，且它就是基线单卡，**外推性差**。
- **取样偏差**：本仓现存卡偏向 ST 官方纯文本示例卡（Yae/Eve），富卡仅墨蝶妖一种且被导入 3 次 ⇒ 高估"纯文本卡占比"。
- **可辩护的结论**：
  - 以"能正常**显示**"论：**5/5 去重卡的可见区域无塌陷**（纯文本卡正常；富卡帧内容稳定、无 error 关键字、无成串 toast）。
  - 以"富卡**功能完整**"论：**被实测到的 1/1 富卡都带 F-1 插件 CSS 丢失**（含 2 克隆更早已丢）——
    对"用 Palink 插件 + 卡侧会重写 head"这一生态子集，**缺陷命中率 = 100%（n=1，弱）**。
  - **粗估**（明确标注为估）：生态里"纯文本/轻 HTML 卡"约占多数，当前**显示层可用率偏高（>80%）**；
    但"重度 Tavern + 插件卡"因 F-1/F-2，**功能层可用率明显更低**，本包证据不支持给这类卡一个乐观数字。
  - ⇒ **要一个可信的生态百分比，必须扩样到 ≥10 张真·富卡**（含内联 `[initvar]`、含插件依赖 UI），本包样本不足以定这个数。

---

## 6. 复现步骤

```bash
# 环境：Git Bash；docker 栈在跑，前端 http://localhost:16000（非 8000/3000）
cd /d/项目/Palink-AI

# E-1 复跑 fixture
py .tmp_probe/extract_st_commands_E1.py            # 打印 RESULT core=220 ext=73 aliases=176 total=293
py .tmp_probe/extract_st_commands_E1.py --write    # 写 frontend/src/lib/sillytavern/__tests__/fixtures/...

# 登录（curl 侧，可选；探针内已在页面 fetch /api/token）
export MSYS_NO_PATHCONV=1
curl.exe --noproxy '*' -s -X POST http://localhost:16000/api/token \
  -d "username=admin&password=admin123" -c .tmp_probe/cookies.txt -w "http=%{http_code}\n"

# E-3 全卡指标（open 与 run-code 同条命令；输出重定向文件再读，勿 | tail）
cd .tmp_probe
py gen_probe_E3.js 2>/dev/null; py gen_probe_E3.py     # 生成 probe_E3.js
playwright-cli -s=pe open http://localhost:16000 >/dev/null 2>&1; \
  playwright-cli -s=pe run-code --filename=./probe_E3.js > E3_out.txt 2>E3_err.txt
py parse_E3.py

# F-1 插件 CSS 丢失取证（t6/t14 样式身份 + removeChild 否证 + 克隆竞态）
playwright-cli -s=pe6 open http://localhost:16000 >/dev/null 2>&1; \
  playwright-cli -s=pe6 run-code --filename=./probe_E_styleid2.js > E_styleid2_out.txt 2>&1; py parse_styleid2.py
playwright-cli -s=pe7 open http://localhost:16000 >/dev/null 2>&1; \
  playwright-cli -s=pe7 run-code --filename=./probe_E_clones.js > E_clones_out.txt 2>&1; py parse_clones.py
```
截图：`.tmp_probe/.tmp_probe/shot-E-{YaeMiko,EveMarie,CardC04,MaoCat,Lutiya,Lutiya-t6,Lutiya-t14,Lutiya-expanded,cloneA,cloneB}.png`。

---

## 7. 建议主控下一步做哪三件事

1. **修 F-1（插件 CSS 守护竞态）**——`part-08.ts` 守护快照改可刷新 / 或在插件 CSS 丢失时重跑
   `injectStPluginCssCompat()`（其 `getElementById` 幂等正好支持重入）。这是**唯一有实测数字、有 file:line、
   影响 Palink 自家 5 插件**的硬缺陷，性价比最高。改后须**重建 dist** 再复跑本报告 §6 的 styleid/clones 探针，
   验 `t14 插件 CSS 数 = t6 数`（当前 0/5 且随卡漂）。
2. **扩富卡样本到 ≥10 张再定生态百分比**——本包富卡 n=1（墨蝶妖家族），不足以支撑任何乐观百分比。
   导入含**内联 `[initvar]`/`Mvu.getVariable` 宏**、含**插件依赖 UI**、含**外链 CDN** 的真实 ST 卡各若干，
   复用 `probe_E3.js` 同一套指标跑一遍，把 §5 的"粗估 >80%"换成有样本量的数。
3. **与包G 合并处理 F-2（characterId=0 / 帧内 extensions）**——`getContext.ts:1785` 的 UUID→index 兜底 0
   与包G 的 getContext/libs 补齐同源，勿单点改；改前先确认哪些存活插件真读数字 characterId
   （`grep -rn "characterId" st-plugins/ frontend/src/lib/plugin-system/`），按依赖面决定是"透传字符串 id"
   还是"帧内补 characters 数组"。**注意包F/G 正在并行改前端源码，此项须协调，避免撞车。**

---

## 附：本包纪律自查

- ✅ 零 API 成本：唯一被 route 命中的是 `/api/ws/ticket`（非计费），`/api/chat`·`/generate`·`/api/openai/`·
  `/api/extra/*` 命中 0，`upstream_forwarded=0`，**blockedCount=0**。
- ✅ 入口只用 `/characters/<cid>`（`/chat?character_id=` 未用）。
- ✅ playwright 会话 open+run-code 同条命令；输出重定向文件再读。
- ✅ 探针用独立 session（pe/pe2…pe7），未复用/关闭他人页面。
- ✅ 未重建 dist、未动后端/容器、未改任何生产代码。
- ✅ 交付物：fixture + README（E-1，未提交）、本报告、截图；探针脚本留 `.tmp_probe/`。
- ⚠️ 判定基于**部署旧 dist**（提交≠上线），源码 file:line 仅定位"修在哪"。
- ⚠️ 未 git add / 未提交（交主脑收尾统一处理）。
