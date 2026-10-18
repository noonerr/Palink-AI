# HANDOFF — 包F：ST 斜杠命令补全 + 枚举口径修复

> 派发对象：子 agent｜优先级：**P0**｜预估：400~600 行 + 1 个契约测试 + 1 个真机探针
> 前置：`REPORT_完美兼容ST_现状天花板与路线图_2026-10-18更新版.md`（必读，下文编号引用它）
> **只做功能代码，不改 `frontend/dist`、不重建后端镜像**（收尾由主脑做）。

---

## 1. 背景与当前实测基线（2026-10-18 真机，露缇雅 `c28061bb-a9b7-46a9-a255-2692d57001fc`，7 帧）

```
Object.keys(SlashCommandParser.commands).length = 135
ST 1.18.0 权威 289 条命令中：
  `name in commands`            = 87    ← 覆盖率 30%
  出现在 Object.keys 里         = 87
  commands[name] 有真值         = 87
  未覆盖                        = 202
```

权威名单现货：`.tmp_probe/st289.json`（289 个去重名，按字母序；源自
`_reference/sillytavern-1.18.0/public/scripts/slash-commands/*.js` 与 `public/scripts/extensions/**/*.js`
逐文件名提取）。**请把这个文件搬进仓库**（建议
`frontend/src/lib/slash-engine/__tests__/fixtures/st289-names.json`，含 289 名 + 别名字段可后续补），
别让探针目录成为唯一来源。

---

## 2. 任务 F-1（最便宜，先做）：修"命令枚举不出来"的口径

### 2.1 原理

`part-07.ts:543-581` 的懒代理里，`slashKnownNamesCompat` **只由 `/help` 返回文本解析而来**
（`primeSlashKnownNamesCompat()`，`part-07.ts:558-580`）。宿主引擎的 `/help` 只列出
**它真注册了的**命令 ⇒ 集合上限 = 宿主引擎命令表，与 ST 的 289 条对不上。

⇒ 三方卡脚本 / ST 插件若用 `for (const n in SlashCommandParser.commands)` 做命令补全，
或用 `Object.keys(commands).length` 判断命令表规模，看到的与 ST 差 202 条。

### 2.2 做法

**不要**给这 202 条注册假实现。只让"存在性/枚举"与 ST 一致：

1. 把 289 个权威名作为**种子常量**内联进帧内（或经 context 注入，见下方红线的体积顾虑），
   在 `primeSlashKnownNamesCompat()` 里**先批量 add**，再接住 `/help` 解析结果补漏。
   ⇒ `ownKeys` 最少 289 个，`has` / `in` / `for...in` 全部命中。
2. `get` 仍走 `resolveSlashEntryCompat`：未实现的名字返回
   `synthesizeSlashEntryCompat(name)`（已有的合成项，callback 桥到宿主）——
   宿主没有该命令 ⇒ 执行时得到引擎的 "Unknown command"（可诊断），
   **不是假成功**。这条语义是 `st-compat-commands.ts` 的红线 1，**不得破坏**。

### 2.3 体积红线

⚠️ `runtime-body/part-*.ts` 是**模板字符串**（见 MEMORY.md「智能卡关键接缝」）：
禁止裸反引号、`${}` 插值、字符串/注释里的裸 `\n`（写 `\\n`）。
289 个名字约 3KB 文本，直接内联会让单帧 srcdoc 又涨一截（当前单帧 46,167 是包A 的成果）。
⇒ **优选**：经 `buildSmartCardBootContext` 的已有通道把这批名字塞进 ctx（宿主侧注入，
帧内只写一行解析），而不是把 289 个字面量写进模板。**如果只能内联，须在报告里给出
srcdoc 单帧字节数前后对比。**

---

## 3. 任务 F-2：把 ~90 条"该补"的命令做成真实现

### 3.1 分类（本次已判完，按这个来，别自己重新分类）

202 条未覆盖里：

| 类别 | 条数 | 处置 |
|---|---|---|
| **A. 该补（纯逻辑，无 UI / 无后端依赖）** | ~90 | **本包做**，清单见 3.2 |
| B. 可薄补（转发到 Palink 已有能力） | ~15 | 本包做薄层，见 3.3 |
| **C. 不该补（ST UI 类）** | ~60 | **不注册**（`bg`/`bgcol`/`autobg`/`buttons`/`panels`/`movingui`/`theme`/`gallery`/`chat-render`…） |
| **D. 不该补（ST 私有数据模型）** | ~30 | **不注册**（`checkpoint-*`/`closure-*`/`char-create|delete|duplicate|find|get|update`） |

### 3.2 A 类：必须逐个照 ST 源码移植语义

**红线**：语义照抄 `_reference/sillytavern-1.18.0/public/scripts/slash-commands/<name>.js`，
**不自己发明**。已有先例可抄：`frontend/src/lib/slash-engine/st-compat-commands.ts`
（包B 产物，数值命令的 `parseNumericSeries`/`performOperation` 移植 + 三条降级口径
"非法值过滤 / 除零返回 0 / NaN 归一为 0"就写在里面，沿用那套写法）。

A 类清单（从 `st289.json` 里筛出的未覆盖项 + 上面 notInSample）：

```
addsub 系列：sub mul div mod pow round min max sqrt cos sin（add/abs 已有同名，注意不覆盖）
文本类：cut del comment matches replace split join upper lower titlecase trim len
数组类：array-wrap array-unwrap array-foreach array-map array-filter array-length
变量类：setglobalvar delglobalvar getglobalvar listglobalvars addglobalvar
控制类：abort beep wait delay（已有时对齐 ST 行为） input setinput
系统类：echo（已有） flushinject listinjects context api api-url clipboard-get clipboard-set
```

⚠️ **与 Palink 已有命令同名的（`abs` `random` `sort` `pick` `length` 等）一律不覆盖**
（`st-compat-commands.ts` 命名冲突段已立规，引擎 Map 后写覆盖先写，覆盖会静默改变既有行为）。
发现同名冲突**写进报告**，别自作主张。

### 3.3 B 类：薄层转发

`caption` / `summarize` / `translate` 的 ST 语义是"把输出写进当前消息/变量"。
包C 已在后端实现 `st_extras.py` 的 13 端点，帧内可经既有
`requestParent` 桥调用（**注意 `requestParent` v2 会把数组和字符串展开**，见 MEMORY.md）。
薄层要求：**转发的目标端点必须真实存在**（用带 `X-CSRF-Token` 的 curl 探一次，
`X-CSRF-Token` 从 `/api/token` 后的 `palink_csrf` cookie 取）。

---

## 4. 注册位置（红线）

**命令必须注册进宿主 `frontend/src/lib/slash-engine/`，不是帧内。**
理由：沙箱轨 / getContext 轨 / 单间轨三条轨共享；写帧内只有单间轨受益。
现有落点就是 `st-compat-commands.ts` —— **继续往这个文件加**，别新开文件堆命令。

---

## 5. 验收判据（可复跑，缺一不可）

### 5.1 静态门禁

```
frontend/: npx tsc --noEmit 与 npx vitest run 全绿
  ⇒ 只认 "failed = 0" 且 "errors = 0"，passed 数字不是验收线（会漂）
```

### 5.2 新增契约测试（`frontend/src/lib/slash-engine/__tests__/`）

1. **A/B 类每条新命令一个确定性用例**：输入固定 → 断言输出等于 ST 源码同输入的产出
   （把 ST 源文件里的期望值抄进测试注释，注明出处文件）。
2. **枚举口径测试**：帧内 `Object.keys(commands)` 对 `st289-names.json` 的 289 名命中
   **≥ 280**（剩余允许是"确实没实现且不打算让它在场"的 C/D 类，须逐个列在报告里）。
3. **红线测试**：对 C/D 类各抽 3 条，断言 `commands[name]` 为 `undefined` 或执行返回
   "Unknown command" —— **不许有空壳成功**。

### 5.3 真机探针（复跑 `.tmp_probe/probe-parity3.js`）

```
改前：covered_in = 87 / 289
改后：covered_in 目标 ≥ 180 / 289（对齐路线图 §3 的验收线）
      Object.keys(cmds).length ≥ 289
      covered_hasVal == covered_in（有值必须有实现，不许虚）
```

⚠️ 探针口径提醒（都踩过）：
- `page.frames()[0]` 是主页面本身 ⇒ 遍历 `for (const f of page.frames())` 找 iframe 帧
- `run-code` 的 `### Result` 在输出**顶部** ⇒ 不要 `| tail`，重定向到文件再读
- **`playwright-cli` 会话不能跨 bash 持久** ⇒ `open` 与 `run-code` 必须写在同一条命令里

### 5.4 反证要求

取 3 条新命令，**临时改坏**（例如删掉注册行）⇒ 契约测试必须红；**还原** ⇒ 必须回绿。
两次输出都贴进报告。否则不算"测试守住了该行为"。

---

## 6. 交付物

1. 代码 + 测试，提交信息用 `-F <消息文件>`（含代码标识，反引号会被 bash 吃掉），
   `-F` 必须在 `-o -- <paths>` **之前**；只用 `git commit -o -- <pathspec>` 提自己的文件。
2. `docs/_active/report/REPORT_包F_ST命令补全_2026-10-18.md`：
   - 改前/改后覆盖数、srcdoc 单帧字节数（若走了内联路线）
   - C/D 类逐条"为何不补"
   - 同名冲突清单
   - 反证两次输出
3. 若动了 `frontend/src/lib/slash-engine/__tests__/fixtures/st289-names.json`，
   在报告里注明它是从 `.tmp_probe/st289.json` 搬来的，并说明后续如何维护。

## 7. 明确不做

- 不改 `frontend/dist`、不跑 `npm run build`、不重建后端镜像（主脑收尾做）
- 不碰 `getContext` / `TavernHelper` / `libs`（那是包G/H）
- 不恢复主页面插件轨、不让 ST UI 在卡内可见（红线，见路线图 §4）
