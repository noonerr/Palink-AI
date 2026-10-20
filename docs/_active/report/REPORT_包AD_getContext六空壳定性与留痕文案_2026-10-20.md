# REPORT — 包AD · getContext 六个「有名字没实物」键的定性 + window.context 留痕文案（批次C）

> 状态：**部分完成**（6 键中 2 个真落地、1 个确认"对象真但缺语义字段"、3 个判定为依附子系统/无数据源不补；C-2 文案已改并有测试钉住）。
> 门禁：`bash scripts/gate.sh frontend` → **全部门禁通过**（tsc ✓ / vitest 107 文件全过，1438 passed | 3 skipped，skipped 为存量）。
> 执行：零上下文执行方（分支 `three-tracks-merge-20261012`），2026-10-20。复核方：主脑。
> ⚠️ **本批未取真机读数**（零回归面 4 项数字、帧内实调读数都没测）——原因见 §6「没做到的」。

## 0. 开工自查（任务书 §0）

| 项 | 结果 |
|---|---|
| `git log --oneline -12` 含 `c3c5639` / `201eec2` / `fdc779f` | ✅ 三条都在（c3c5639 第 4 位，201eec2/fdc779f 第 5/6 位） |
| `git status --short` 除 `.workbuddy-ai/**` 外干净 | ✅ 跟踪文件只有 `.workbuddy-ai/memory/*.md`（别人会话）；`_BACKUPS/**` 是存量未跟踪备份目录，未碰 |
| `:16000` = 200 + 五容器 healthy | ✅ 200；`backend/frontend/db/ollama/new-api` 全 healthy |

## 1. C-1 六键逐行结论表

| 键名 | ST 一手 文件:行号 | 档位 | 读数（载体实测） |
|---|---|---|---|
| `tokenizers` | `public/scripts/tokenizers.js:16-38`（静态枚举，非子系统） | **做了** | 21 键逐值相等：`NONE:0, GPT2:1, OPENAI:2, LLAMA:3, NERD:4, NERD2:5, API_CURRENT:6, MISTRAL:7, YI:8, API_TEXTGENERATIONWEBUI:9, API_KOBOLD:10, CLAUDE:11, LLAMA3:12, GEMMA:13, JAMBA:14, QWEN2:15, COMMAND_R:16, NEMO:17, DEEPSEEK:18, COMMAND_A:19, BEST_MATCH:99`；已有同名全局时合并（`PALINK_ONLY:777` 保留 + `OPENAI:2` 补齐） |
| `getRequestHeaders` | `public/script.js:645` | **做了**（唯一差异：不给 `X-CSRF-Token`，理由见 §3） | `getRequestHeaders()` → `{"Content-Type":"application/json"}`；`getRequestHeaders({omitContentType:true})` → `{}`；无参不抛 |
| `chatMetadata` | `public/script.js:453`（`export let chat_metadata`） | **无数据源（对象本身已是真）** | 活对象：`part-06:408` 从持久化恢复、`:707` 落盘、`updateChatMetadata` 写回。缺 ST 聊天文件语义字段（`note_prompt`/`tainted`/`integrity`/`scenario`/`lastInContextMessageId`，锚点 `script.js:1659/3160/6041/7607/8991`）⇒ **不造默认值** |
| `tagMap` | `public/scripts/tags.js:351`（`let tag_map = {}`，`:616` 由 `settings.tag_map` 灌入） | **无数据源** | 本仓角色标签只是 `backend/app/models/character.py:28` 的一个 `Text` 列（字符串列表），无 tag 实体表 ⇒ 无 id/颜色/分组可映射。保持 `{}` |
| `CONNECT_API_MAP` | `public/scripts/slash-commands.js:141` 声明、`:146 setupConnectAPIMap` 填充 | **依附子系统不做** | 条目形如 `{selected, button:'#api_button_openai', type, source}`，`button` 是 ST 连接面板的 DOM 选择器、整套依附 ST 多后端连接模型。Palink 单后端无该 UI ⇒ 保持 `{}` |
| `getPresetManager` | `public/scripts/preset-manager.js:83`（返回 `PresetManager` 或 `null`，注册表由 `select[data-preset-manager-for]` 建） | **依附子系统不做**（台账 `preset_prompt` 乙类） | 现有手搭 manager：`getSelectedPreset` 读**真** `ctx.presetData`；`getSelectedPresetName` 仍走 `stubApi` 留痕（诚实标注）。未新增假字段 |

**计数口径**：只订正"这 6 个键是什么"，**不动** A/C/D 权威名数（`13 + C + D = 134` 的闭合由批次A/B 与包H 报告负责）。
唯一影响：`getRequestHeaders` 从"故意不补的桩"改判为真实现 ⇒ `PALINK_STUB_API_NOTES` 从 4 项减为 3 项。

## 2. C-2 文案（只改文案，判定逻辑一字未动）

- 改的是 `runtime-body/part-01.ts` 里 `global_shape_absent` 那条启动留痕的 `detail`。
- 新措辞：**「ST 亦无此全局：ST 1.18 的 context 恒为局部变量（`const context = getContext()`）… 卡这么写本身不合规，不是 Palink 的缺陷项」**。
- 一手锚点写进注释：`authors-note.js:325/444`、`extensions.js:90/2062/2144`、`slash-commands.js:3892`、`utils.js:1344`、`world-info.js:1116`。
- 未动：`owner:'frame_compat'`、`kind:'global_shape_absent'`、`name:'window.context'`、`if (!Object.getOwnPropertyDescriptor(window,'context'))` 前提、同名合并去重、上送口径。
- `palink-diag.ts` **一个字都没改**（本批只需改 part-01 的文案，另一批要改它的代码）。

## 3. 唯一与 ST 的差异（必须由主脑确认）：`getRequestHeaders` 不给 `X-CSRF-Token`

ST 返回 `{'Content-Type':…, 'X-CSRF-Token': token}`；我们只返回前者。三条理由（也写在 `part-06` 注释里）：

1. 帧是 opaque origin，`palink_session`/`palink_csrf` 从没进过帧（P1-1 沙箱红线）⇒ **帧内没有这个值的数据源**，硬塞空串才是"形状对语义错"。
2. 帧内 `/api/*` 的 ST 兼容面由 `part-06:660-695` 的 `handleStApiFetchCompat` **本地应答**（不发网络、服务端不校验 CSRF）；真写后端走 `requestParent`，认证头父侧注入 ⇒ 这份 headers 不需要 token 也能用。
3. 卡若拿它去打真后端端点会拿到 403（**诚实失败**），不会被伪装成功。

⇒ 旧决策"恒空对象（安全待拍板）"作废，两张钉旧行为的用例同批订正（见 §4）。

## 4. 验证（可复跑）

### 4.1 门禁原文

```
 Test Files  107 passed (107)
      Tests  1438 passed | 3 skipped (1441)
  ✓ 前端 vitest 通过
  门禁汇总
  ✓ 前端 tsc --noEmit
  ✓ 前端 vitest
  全部门禁通过。
```

### 4.2 每个测试文件单独跑

| 文件 | 用例数 | 结果 |
|---|---|---|
| `__tests__/c-getcontext-six-keys-and-diag-wording.test.ts`（新增） | **18** | 18 passed |
| `__tests__/g-getcontext-and-libs-contract.test.ts`（订正 #14 + 桩表 4→3） | 33 | 33 passed |
| `__tests__/st-compat-fix-batch-contract.test.ts`（桩表断言订正） | 22 | 22 passed |
| `__tests__/palink-diag-silent-point-guards.test.ts`（受 part-01 文案影响） | 28 | 28 passed |
| `__tests__/generated-script-parse-guard.test.ts`（模板字符串守卫） | 4 | 4 passed |
| `__tests__/st-gap-ledger-guard.test.ts`（受台账追加影响） | 17 | 17 passed |

新测试的执行型断言全部对 `COMPAT_V2_RUNTIME_ARTIFACT` 求值（`sliceRegion` 从载体原文切段后 `new Function` 求值，不拿源码副本冒充）。

### 4.3 两组反证原始输出（跑完自动还原，还原后 18/18 回绿）

```
==== 反证① tokenizers 短路回 window.tokenizers || {}（期望红）
     × 载体里确实是 Object.assign 出来的枚举，不再是 window.tokenizers || {} 92ms
     × 21 个键与 ST 逐条相等（含 BEST_MATCH: 99） 3ms
     × 已有同名全局时不覆盖别人写的键（合并而非替换） 2ms
 Test Files  1 failed (1)
      Tests  3 failed | 15 passed (18)
RC= 1
已还原 part-07: True
==== 反证② 文案改回旧词（期望红）
     × 新措辞在场：ST 亦无此全局 + 卡写法不合规 17ms
     × 旧措辞不在场（读起来像我们缺陷的那句） 11ms
 Test Files  1 failed (1)
      Tests  2 failed | 16 passed (18)
RC= 1
已还原 part-01: True
==== 还原后
 ✓ c-getcontext-six-keys-and-diag-wording.test.ts (18 tests)
      Tests  18 passed (18)
```

## 5. 改动文件（逐笔见 `git show --stat`）

**源码 + 测试（同笔）**
- `runtime-body/part-07.ts`：`window.tokenizers` 空对象 → ST 21 键枚举（合并不覆盖）。
- `runtime-body/part-06.ts`：`getRequestHeaders` 桩 → 按 ST 契约真实现（**越界说明见 §6-1**）。
- `runtime-body/part-08.ts`：`PALINK_STUB_API_NOTES` 移除 `getRequestHeaders`；#1-#13 区块后追加六键定性注释（每条带 `文件:行号`）。
- `runtime-body/part-01.ts`：留痕 `detail` 文案（C-2）。
- `__tests__/c-getcontext-six-keys-and-diag-wording.test.ts`（新增，18 用例）。
- `__tests__/g-getcontext-and-libs-contract.test.ts`、`__tests__/st-compat-fix-batch-contract.test.ts`：钉旧决策的断言按"已真实现"订正。

**记账（单独一笔）**
- `docs/_active/spec/SPEC_向ST学习的子系统缺口与标记方案_2026-10-19.md`：新增 §6「批次C 六键逐键定性」（只增不删，§2 原文未动；表首列写成「键 \`x\`」以免被 `st-gap-ledger-guard` 的 `^\| \`id\` \|` 正则误当台账 id —— 这个坑实际踩到了，见 §6-3）。
- 本报告 + `docs/_CATALOG.md`（生成器刷新）。

## 6. 没做到的 / 需要主脑裁定

1. **越界一处（主动申报）**：`getRequestHeaders` 的唯一实现在 `runtime-body/part-06.ts:609`（`ensureFunction` 就是 window 全局的家），`part-08` 那行只是 `window.getRequestHeaders` 的引用。任务书边界只写了 part-07/part-08。若只改 part-08，会出现"getContext 里真、window 全局仍是桩"的**两份逻辑**（任务书 §A-3 明令禁止），所以选择改 part-06 这一处并申报。若主脑判越界，回退这一处即可（其余不受影响）。
2. **`window.context` 全局本身没删**：任务书 C-2 结论写"不摆这个全局"，但 `part-08:779-794` 已有 **包N B-2 2026-10-19** 挂的 `Object.defineProperty(window,'context',{get})`，且 `palink-diag-silent-point-guards.test.ts:167-199` 钉着它。删它属产品行为变更 + 会动包N 的用例，超出"C-2 只改文案"的边界 ⇒ **本批只改文案，删不删全局请主脑裁定**。
3. **台账守卫的真实坑**：§6 表首列原写成 `| \`tokenizers\` |`，被 `st-gap-ledger-guard` 的 `ledgerIds()`（`/^\|\s*\`([a-z][a-z0-9_]*)\`\s*\|/`）当成新台账 id，导致 A/B 两组红（"台账有、代码没标"）。已改成 `| 键 \`tokenizers\` |` 并复绿（17/17）。**任何人在台账里加表都必须避开这个正则形状**。
4. **真机读数全缺**（任务书 §4-5 的四项零回归数字 + §4-3 帧内实调读数）：本批把工具预算全用在"一手核 ST + 落地 + 门禁 + 反证"上，且新代码要上线才能测（需 `VITE_OUT_DIR=dist_c` + 5216 探针），未做。**这是本批最大的缺口，请主脑在自己的复验轮里补测**：
   - `Object.keys(TavernHelper).length`（应 144）、`getContext()` 键数（196）、每帧插件 CSS（5/5）、`Object.keys(SlashCommandParser.commands).length`（509）；
   - `getContext().tokenizers.OPENAI === 2`、`getContext().getRequestHeaders()['Content-Type'] === 'application/json'`。
5. **并行施工冲突（已自愈，但请主脑确认）**：13:17 左右 `part-05.ts` 被**另一个会话**留下未提交的坏注释（先是裸反引号、后是未登记插值 `${String(1)}`），导致 `vitest.config.ts` 加载失败、我这边测试跑不起来；`h-tavernhelper-134-contract.test.ts` 也一度被改。我按纪律**没碰**这些文件，等它自己还原（13:23 已恢复干净）。若那是批次D/F/G 的会话，说明**当前工作树有并行写者**，与任务书"严禁两个对话并行"冲突。
6. **未取基线对照**：因为没跑真机，本报告给不出"改前/改后各一次"的数字，只能给载体级读数（§1）。

## 7. 交接给主脑

- [ ] 确认 §6-1 的 part-06 越界是否接受（不接受就回退 `part-06.ts` 那一处，并把 `part-08` 的 `getRequestHeaders` 行改回桩口径）。
- [ ] 裁定 §6-2：`window.context` 全局删不删（删则要同批改包N 的两个用例）。
- [ ] 补测 §6-4 的四项零回归读数与两项帧内实调读数。
- [ ] 若认可 `getRequestHeaders` 的"不给 CSRF"口径，请在路线图 §4 把"安全决策待拍板"改成"已定性（帧内无数据源，靠 shim 本地应答）"。
- [ ] 台账 §6 只做了定性，A/C/D 权威名数未动；`getRequestHeaders` 的 D→C 改判如需计入 134 闭合，由主脑在包H 报告里订正。
