# SCEP：角色卡好感度/状态 HTML 面板渲染（Tavern Helper 兼容逆向渲染器）

> 项目：Palink-AI（SillyTavern 兼容前端）
> 文档类型：Software Change Execution Plan（变更执行计划）
> 编写日期：2026-08-04
> 关联文档：`docs/交接文档_角色卡面板插件渲染.md`
> 状态：待执行（已通读代码，已完成深度理解）

---

## 0. 一句话目标

在角色卡对话页**下方**渲染一块「好感度/状态面板」，数据来自角色卡 `extensions.tavern_helper` 的 **schema（变量结构）** + 会话 **`stat_data`（变量值）**，对齐 SillyTavern 原版 Tavern Helper（酒馆助手）插件行为。采用**前端自包含「兼容逆向渲染器」**，不导入 ST 引擎、不执行 ESM。

---

## 1. 背景与现状

### 1.1 用户的核心认知（来自交接文档，已确认）
> 「这个角色卡里面的 HTML 面板，是通过这个插件来实现的，显示在这个前端的。」

即：好感度/状态面板**不是**角色卡里的静态 HTML，而是 **Tavern Helper 插件**读取「角色卡 schema + 会话 stat_data」后，在**前端运行时动态生成**的。

### 1.2 已完成部分（勿重复）
- **后端 `mvu_engine.py`**：完整实现（zod schema 解析 `extract_schema_defaults`、stat_data 合成 `build_initial_stat_data`、RFC6902 patch 应用 `apply_patches`、`<UpdateVariable>` 提取）。有测试 `backend/tests/test_mvu_engine.py`（含 `_CATGIRL_SCHEMA_SCRIPT` 样例）。
- **后端导入**：`plugins.py` 的 `_import_tavern_helper` 把角色卡 `extensions.tavern_helper` 脚本合并为 IIFE 入口。
- **前端数据接线**：`sillyTavernPluginRuntime.ts` 的 `getContext()` 已暴露 `character.extensions` + `stat_data`；`CharacterChat.tsx` 已通过 `stContext` 传入 `selectedCharacter.extensions` 与 `sessionVariables.stat_data`；`runtime.ts` 类型已补 `extensions` / `stat_data`。
- **消息 HTML 内联渲染**（`Message.tsx` + `index.css`）已修复，符合 ST 默认样式。

### 1.3 未完成（本 SCEP 主线）
**面板渲染尚未实现**——前端没有把 schema + stat_data 变成可见面板。

### 1.4 三个历史阻塞点（交接文档列出）
1. 前端未实现 `registerMvuSchema` / `registerVariableSchema` 兼容逻辑。
2. `CharacterCardRenderer.tsx` 的 `getContext()`（L3187）覆盖 `window.SillyTavern.getContext`，返回的 context 缺顶层 `stat_data` 和**完整** `character.extensions`。
3. 角色卡 schema 脚本是 **ESM**（`import { registerMvuSchema }`），被 `isEsmModule()`（L138）跳过，schema 未注册。

---

## 2. 为什么这么做（动机与约束）

### 2.1 战略约束（来自项目记忆，最高优先级）
> **ST 兼容不得牺牲 Palink 自主性。** 用户原话：直接嵌入 ST 后端会让项目可修改项变低，变得基本不可自主修改。

推论：面板渲染**必须跑在 Palink 自有前端**，不能把真实 ST 引擎/运行时做成主路径。

### 2.2 为什么不能「执行」schema 脚本
实测猫娘卡 `extensions.tavern_helper` 的 schema 脚本（`_CATGIRL_SCHEMA_SCRIPT`，`test_mvu_engine.py:223`）：

```js
import { registerMvuSchema } from 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js';
export const Schema = z.object({
  世界信息: z.object({ 日期时间: z.string().prefault(''), ... }).prefault({}),
  桃汐: z.object({ 好感度: z.coerce.number().transform(v => _.clamp(v, 0, 100)).prefault(50), ... }).prefault({}),
  苏小兰: z.object({ 好感度: z.coerce.number().prefault(20), 关系: z.string().prefault('邻居') }).prefault({}),
});
```

执行它**不可行**：
- `import ... from 'https://...'` 是 CDN ESM，浏览器直连会被 CORS/网络阻断，且 `isEsmModule()` 已跳过它。
- `z`（zod）是**全局变量**，本脚本未 import——执行时必须已有全局 `z`，而 Palink 前端没有。
- 本脚本只 `export const Schema = z.object(...)`，**并未调用** `registerMvuSchema(...)`，所以即便注入 `registerMvuSchema` 也捕获不到 schema。

### 2.3 为什么用「正则解析 z.object 字面量」
- 后端 `mvu_engine.py:extract_schema_defaults` 已验证此路可行：用 `_Z_OBJECT_RE` 找 `z.object(`，`_match_braces` 配平括号，再 `_parse_zod_object_body` 提取字段名/类型/`.prefault()` 默认值（覆盖 `z.string/z.number/z.boolean/z.array/z.object`、coerce、嵌套、无引号 key）。
- 猫娘卡 schema 的测试结果（`test_mvu_engine.py:251`）全部通过，证明正则解析对该 schema 完全够用。
- 把同一套解析逻辑**移植到前端 TS**，即可不依赖 zod 运行时、不依赖 CDN、不执行 ESM，直接得到字段树。

### 2.4 为什么前端自包含、不依赖 getContext
`CharacterChat.tsx` 已把 `selectedCharacter.extensions`（含 `tavern_helper` 脚本文本）与 `sessionVariables.stat_data` 都作为 React props/state 提供。面板渲染**直接从这些 props 读取**，不依赖 `window.SillyTavern.getContext()`，从而：
- 绕开阻塞点 2（getContext 冲突）对渲染关键路径的影响；
- 数据随 React 渲染自动刷新（AI 回复更新 stat_data 后面板自动变）。

---

## 3. 要做什么（范围）

### 3.1 In Scope
1. 前端新增「zod schema 解析器」工具（移植 `extract_schema_defaults` 思路）。
2. `sillyTavernPluginRuntime.ts` setup script 注入 `window.registerMvuSchema` / `window.registerVariableSchema` 兼容桩（防御性，捕获若被调用时的 schema；不影响渲染主路径）。
3. 前端新增「Tavern Helper 面板」React 组件，按 schema + stat_data 渲染分组/字段面板。
4. 在 `CharacterChat.tsx` 挂载该面板（独立组件，不影响现有布局）。
5. 防御性修复 `CharacterCardRenderer.tsx` 的 `getContext()` 冲突（补 `stat_data` 与完整 `extensions`，与 runtime 的 getContext 合并而非覆盖）。
6. `npm run build` + `docker compose restart frontend` 部署验证。

### 3.2 Out of Scope（本次不做）
- 不实现 MagVarUpdate 真实执行（CDN bundle.js）——`<UpdateVariable>` 解析已由后端 `mvu_engine.py` 完成，前端只消费 stat_data。
- 不碰 Galgame 插件（用户明确：先 Tavern Helper，后 Galgame）。
- 不导入完整 ST 引擎 / 不把 ST 后端做成主路径。
- 不实现面板内「编辑变量」表单（仅展示；如需编辑可后续迭代）。

---

## 4. 方案设计（核心架构）

```
角色卡 extensions.tavern_helper.scripts[].content   ──┐
                                                      │  (前端 props: selectedCharacter.extensions)
                                                      ▼
                                         mvuSchemaParser.ts
                                   (正则解析 z.object({...}))
                                                      │
                                                      ▼
                                           schemaTree = {
                                             世界信息: { 日期时间:{type,default}, ... },
                                             桃汐:     { 好感度:{type:'number',default:50}, ... },
                                             苏小兰:   { 好感度:{type:'number',default:20}, ... },
                                           }
                                                      │
sessionVariables.stat_data  (stat_data)  ────────────┤
                                                      ▼
                                  TavernHelperPanel.tsx
                       (schemaTree × stat_data → HTML 面板)
                                                      │
                                                      ▼
                              注入 CharacterChat 对话页（独立容器）
```

### 4.1 数据结构
- **schemaTree**（解析产物）：`{ [group: string]: { [field: string]: { type: 'string'|'number'|'boolean'|'array'|'object', default: any } } }`
- **stat_data**（已有）：`{ [group]: { [field]: any } }`，未提供的字段回退到 schemaTree 的 default。

### 4.2 渲染形态（对齐 ST 默认观感，但 Palink 自绘）
- 顶部一行「状态面板」标题（可折叠）。
- 每个 group 一个区块（如「桃汐」「苏小兰」「世界信息」）。
- 字段按类型渲染：
  - `number` 且默认在 0–100 区间（如好感度/性欲值）→ 进度条 + 数值。
  - 其余 `string`/`number` → 标签:值 文本行。
  - `boolean` → 开关样式文本。
- 采用当前对话页变量（CSS 变量/毛玻璃风格），**不**引入全局样式污染（遵循 Hard Constraint：HTML/CSS 不重作用域、不改其他元素布局）。

### 4.3 关键文件改动清单
| 文件 | 改动 |
|------|------|
| `frontend/src/utils/mvuSchemaParser.ts` | **新增**：zod schema 正则解析器（移植自 `mvu_engine.py`） |
| `frontend/src/utils/sillyTavernPluginRuntime.ts` | setup script 内加 `window.registerMvuSchema` / `registerVariableSchema` 桩 |
| `frontend/src/components/ui/custom/TavernHelperPanel.tsx` | **新增**：面板渲染组件 |
| `frontend/src/components/views/character/CharacterChat.tsx` | 挂载面板，传入 `extensions` + `stat_data` |
| `frontend/src/components/ui/custom/CharacterCardRenderer.tsx` | 防御性：getContext 合并 stat_data + 完整 extensions |

---

## 5. 后果与风险评估

### 5.1 正向后果
- 角色卡对话页出现与 ST 一致的好感度/状态面板。
- 完全 Palink 自主，不引入 ST 运行时依赖、不触碰许可风险。
- 复用已验证的解析逻辑，行为可预测。

### 5.2 风险与缓解
| 风险 | 等级 | 缓解 |
|------|------|------|
| 正则解析对极复杂 zod（自定义 refine/复杂 transform）失败 | 中 | 仅解析顶层 `z.object` 字段树 + `.prefault/.default`；未知字段安全跳过；猫娘卡已验证通过。后续可扩展。 |
| 面板挂载影响现有布局 | 低 | 独立组件 + 独立容器，置于消息列表上方/输入区下方固定区；遵循「改动不得影响其他元素布局」约束，部署后强制刷新验证。 |
| `getContext` 修复引入回归 | 低 | 仅**新增** `stat_data` 与完整 `extensions` 字段，**不删除/不改**现有返回；合并而非覆盖 runtime 的 getContext。 |
| `registerMvuSchema` 桩被误用 | 极低 | 桩仅 `console.warn` + 存全局，不影响其他插件；ESM 脚本仍被 `isEsmModule` 跳过，不会执行。 |
| 部署后 chunk hash 未更新 | 中 | 严格走 `npm run build`（宿主 frontend/）→ `docker compose restart frontend`；不使用单独 `docker compose build`（volume mount 会遮蔽镜像层）。 |

### 5.3 非目标澄清
- 本渲染不是 ST 原版 tavern_helper 的像素级复刻，而是「兼容逆向渲染」——数据语义一致、观感 Palink 化。符合用户已确认的「兼容逆向渲染器」方向。

---

## 6. 详细执行步骤

### 阶段 0：备份基线（每次重大更新前必做）
- 对每个**即将改动**的文件，改动前复制为 `backups/scep-panel/<YYYYMMDD-HHMMSS>/<相对路径>`。
- 不提交/不 stash 现有仓库 WIP（分支 `st-plugin-compat-20260727` 已有大量无关未提交修改）。
- 备份目录纳入 `.gitignore` 或仅本地保留。

### 阶段 1：新增 schema 解析器 `mvuSchemaParser.ts`
- 移植 `mvu_engine.py` 的 `extract_schema_defaults` + `_parse_zod_object_body` 到 TS。
- 输入：`tavern_helper: { scripts?: {content:string}[] }`。
- 输出：`schemaTree`。
- 处理 `export const X = z.object({...})` 与 `registerMvuSchema(z.object({...}))` 两种包裹形式（都定位 `z.object(`）。
- 单测（可选）：在 `frontend` 内加一个最小测试或至少在组件内 console 验证猫娘卡解析结果。

### 阶段 2：注入 `registerMvuSchema` / `registerVariableSchema` 桩
- 位置：`sillyTavernPluginRuntime.ts` 的 `injectIntoContainer` setup script（约 L182 `getContext` 之后）。
- 内容：
  ```js
  window.registerMvuSchema = function(schema) {
    try { (window.__palinkMvuSchemas = window.__palinkMvuSchemas || []).push(schema); } catch(e) {}
    console.warn('[Palink] registerMvuSchema stub called (schema captured for compat)');
  };
  window.registerVariableSchema = window.registerMvuSchema;
  ```
- 目的：防御性兼容，不影响主渲染路径。

### 阶段 3：新增面板组件 `TavernHelperPanel.tsx`
- Props：`tavernHelper?: { scripts?: ... }`、`statData?: Record<string,any>`。
- 逻辑：
  1. `useMemo` 调 `parseMvuSchema(tavernHelper)` 得 `schemaTree`。
  2. 若无 schemaTree 或为空 → 返回 `null`（不影响无面板的角色卡）。
  3. 对每个 group/field 解析显示值：`statData[group]?.[field] ?? schemaTree[group][field].default`。
  4. 渲染分组区块；number(0-100) 用进度条；其余文本。
- 样式：局部 scoped（组件内 `<style>` 或 Tailwind），不污染全局。

### 阶段 4：挂载到 `CharacterChat.tsx`
- 在对话消息列表上方（或输入区下方）新增面板位。
- 传入：`tavernHelper = compatCharacterExtensions?.tavern_helper || selectedCharacter.extensions?.tavern_helper`，`statData = sessionVariables?.stat_data`。
- 注意 `isCharacterChat` 才渲染；`st-native` 模式走原生 ST 渲染，不挂载（与现有插件注入隔离一致）。

### 阶段 5：防御性修复 `CharacterCardRenderer.tsx` getContext
- L2812 `getContext` 返回对象新增 `stat_data: window.__palinkStRuntime?.context?.stat_data || {}`，并把 `characters[].data.extensions` 改为更完整的 `selectedCharacter.extensions`（若可访问）或保留 `ctx.characterExtensions` 并补 `stat_data`。
- 优先级：不影响渲染主路径，纯防御。若改动风险大于收益，可暂缓并在 SCEP 标注。

### 阶段 6：构建与部署
- `cd d:\项目\Palink-AI\frontend; npm run build`
- `docker compose restart frontend`
- 类型检查：`npx tsc --noEmit`（注意：已知预存类型错误非本次引入，见交接文档十）。
- 验证：用猫娘卡「我被猫娘包围了！」开会话，确认面板出现、好感度显示 50、苏小兰 20；发送消息后若 AI 返回 `<UpdateVariable>` 更新 stat_data，面板数值应变化。

### 阶段 7：验证清单
- [ ] 有 `extensions.tavern_helper` schema 的角色卡 → 面板出现。
- [ ] 无该 schema 的角色卡 → 面板不出现、布局无变化。
- [ ] `stat_data` 有值 → 优先显示 stat_data；无值 → 显示 schema 默认值。
- [ ] 好感度(0-100) 显示为进度条。
- [ ] 发送消息触发 `<UpdateVariable>` 后面板数值更新（经后端 mvu_engine 更新 stat_data）。
- [ ] 强制刷新（Ctrl+Shift+R）后样式/布局正常，无 console 报错（除预期 stub warn）。
- [ ] `st-native` 模式下不挂载 Palink 面板（由原生 ST 负责）。

---

## 7. 备份与回滚策略

- **备份**：阶段 0 规定的带时间戳副本。每次 `Edit`/`Write` 前先 `cp`。
- **回滚**：
  - 单文件：用对应时间戳备份覆盖。
  - 整轮：因未提交仓库，回滚 = 用 `backups/scep-panel/<ts>/` 下文件覆盖工作区。
- **验证点回滚**：每个阶段结束即做一次构建验证，失败立即回滚该阶段文件。

---

## 8. 完成标准

1. 带 `extensions.tavern_helper` schema 的角色卡在对话页显示好感度/状态面板。
2. 面板数值 = stat_data 优先、schema 默认兜底。
3. 不影响其他角色卡、不影响现有布局、不引入 ST 运行时依赖。
4. 后端 `mvu_engine` 测试仍全绿（`pytest backend/tests/test_mvu_engine.py`）。
5. 前端构建通过、`docker compose restart frontend` 后功能可用。

---

## 9. 决策记录（Decisions）

- **D1**：采用「前端正则解析 z.object 字面量」而非「执行 ESM / 引入 zod」。理由：见 §2.2 / §2.3。
- **D2**：面板数据从 React props（`selectedCharacter.extensions` + `sessionVariables.stat_data`）读取，不依赖 `getContext`。理由：自包含、随渲染自动刷新、绕开 getContext 冲突。
- **D3**：`registerMvuSchema` 仅做防御桩，不用于主渲染路径。理由：schema 脚本未调用它，且 CDN 不可达。
- **D4**：不提交现有仓库 WIP，改用带时间戳文件副本备份。理由：分支已有大量无关未提交修改，避免污染。
