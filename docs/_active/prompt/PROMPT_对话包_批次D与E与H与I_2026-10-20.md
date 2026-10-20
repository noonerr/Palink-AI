# PROMPT — 对话派包 · 批次 D / E / H / I 2026-10-20（四批互不重叠，可分别发给四个对话）

> 零上下文执行件。复核方 = Qoder「分配分包派遣任务」会话（主脑）。
> 通用红线与验收口径：`docs/_active/HANDOFF_提示词_已授权批次_写桥与人设角色库与getContext与服务端留痕_2026-10-20.md` §0；
> 并行施工纪律（共享 git 索引的四条 + `_CATALOG.md` 现跑现提交）：
> `docs/_active/prompt/PROMPT_对话包_批次F总账对账与批次G模板串守卫_2026-10-20.md` 的「并行施工纪律」一节，**必读**。
> 主脑 2026-10-20 13:27 合并态实测：`gate.sh frontend` **rc=0（tsc 绿 + 107 文件全绿）**
> ⇒ 上一轮 F/G/C 三方各自报的"别人造成的红"是并行时的瞬时态，合并后不存在，别再去"修"它。

**每批都做**：开工前 `git log --oneline -3` 应含 `0072e77`；`git status --short` 除 `.workbuddy-ai/**` 外干净；
:16000=200、五容器 healthy。全程禁动 `frontend/dist*`、禁重启 Docker/容器、禁点生成或花 API 余额、
禁 `git add -A`、禁裸 `git commit -m`（一律 `git commit -F <文件> -o -- <路径>`）。

---

## 批次 D — 前端静默 + 后端自动留痕（用户已授权）

改 `palink-diag.ts`（代码）+ 后端新端点。**不碰 `part-08.ts` / `part-07.ts`**（H、E 在改）。

- 后端：新增只追加的留痕端点（建议 `POST /api/diagnostics/records`，走既有鉴权 + CSRF），
  落 JSONL 到 `backend/data/diagnostics/`，按天切分、单文件体积上限、超限只停写不删（`backend/data` 是红线区，
  新增子目录可以，**绝不删既有文件**）。服务端做限流与条数/体积上限——站点公网可达且注册开关仍开着。
- 前端：`palink-diag.ts` 加节流上传，**三条不许放宽**：① 只在 `palinkDiagEnabled()` 为真时上传（本机/手动开关；
  外部站点默认关）；② 只传结构化字段（`owner/kind/name/count/filename/lineno/colno/missingStSubsystem/frameId/cardId/textLength`），
  ⛔ `detail`/`stack` 一个字节都不传，最多传长度与不可逆摘要；③ 上传失败静默、只试一次、不弹框不影响页面。
- 202 条未实现命令的行为**不变**（前端仍不弹框、返回空串），只需保证每条都进记录器并随后端留痕。
- 验收：后端测试覆盖"未鉴权 401/403、超大体拒收、非 JSON 拒收、重复上传不重复计数"；
  前端测试覆盖"开关关闭 ⇒ fetch 调用数为 0"（用 spy 断言）与"上传体字段白名单逐键比对"；
  真机：本机页面产生记录后，容器内当天 JSONL 行数与前端记录条数对得上（贴两边原始数）。
- 反证两组：把闸门改成恒开 ⇒ "外部站点不上传"必红；从上传载荷里塞进 `detail` ⇒ 白名单断言必红。

## 批次 E — 别名面三条实测形状差异按 ST 补齐

只改 `runtime-body/part-07.ts`（模板串！）+ 其测试。**不碰 `part-08.ts` / `palink-diag.ts`**。

1. **别名键的 `delete` 被代理当成 Map 方法直通**（`part-07.ts:1136-1143` 附近）：
   ST 的 `commands` 是普通对象 ⇒ `delete commands[x]` 删的是键。先一手核 ST 有没有任何"删命令"的公开路径
   （`SlashCommandParser.js` 的 `deleteCommand`/静态方法），**照它做**；ST 没有对应语义就保持现状并写清理由，
   ⛔ 不要自造"能删"的行为。
2. **`help` 撞名**：Palink 自有 `help` 与 ST 别名 `help`(→`?`) 同名，我们主名优先。
   ST 一手是 `SlashCommandParser.js:79-82`（重名只 `console.trace` 告警，**后注册者覆盖**）。
   ⇒ 结论应是"我们比 ST 更保守"，**保留自有 help**，但必须：① 留一条记录/注释说明这是有意偏离；
   ② 钉一条测试断言这个优先级（防止日后有人顺手改成别名优先）。
3. **`commands.get(别名)` 不解析别名**：先一手确认 ST 有没有 `.get()`（ST 是普通对象 ⇒ 没有）。
   若 ST 没有，则我们的 `.get` 是**多出来的形状**，正确处置是让 `.get` 与 `[]` 走同一解析路径（内部一致性），
   并在报告里写"ST 无此方法，属我们额外提供的便利面"。
- 验收：三条各一条执行型测试（用 `COMPAT_V2_RUNTIME_ARTIFACT`），且 `Object.keys(commands)` 计数**不得改变**（509 是既有实测）；
  `generated-script-parse-guard` 与新的**字面量守卫**（`runtime-body-template-literal-guard.test.ts`）都必须绿
  ——后者会拦你在注释里写反引号/未登记 `${`，别去放宽它的白名单。

## 批次 H — 撤掉还是保留 `window.context`（新发现的与 ST 的偏离）

只改 `runtime-body/part-08.ts`、`part-01.ts` 的那条留痕与相关测试。

主脑一手核实（两棵树 + 酒馆助手插件）：**ST 没有 `window.context`，也没有顶层 `context` 全局**；
ST 的用法一律是各文件内部 `const context = getContext();`（如 `/d/SillyTavern-release/public/script.js:8388`、
`authors-note.js:325`、`extensions.js:90`）。
但**我们已经在帧内定义了它**：`part-08.ts:800-809`（包N B-2，`Object.defineProperty(window, 'context', …)`），
而 `part-01.ts` 的启动留痕又说"未提供这个全局" ⇒ 同一份运行时里**自相矛盾**：
启动时判定不存在（记录确实每帧都打，×7），后面又把它定义出来。
需要做的：① 先把事实钉清（真机/探针：boot 期与 boot 之后各自 `typeof context`、`window.context`、
`getContext()` 是否同一对象）；② 二选一并写理由——
**(a) 按 ST 撤掉**（用户裁定"冲突以 ST 为准"）：撤 `part-08` 的 defineProperty，留痕改为"ST 无此全局，卡应调 `getContext()`"，
并把 `包N B-2` 当年为它写的断言按新事实改掉（⚠️ 不许为了绿悄悄删断言，要改判并写依据）；
**(b) 保留但记账为偏离**：若你能找到**具体哪张卡/插件**因此在跑（台账 §2 或 `.tmp_probe` 证据），
则把它登记为"Palink 比 ST 多出的面"，并修正留痕文案与判定顺序，使二者不再矛盾。
- 验收：留痕文案、定义位置、判定顺序三者一致；两组反证（改回旧文案 ⇒ 钉文案的用例红；把定义挪回原位 ⇒ 顺序断言红）。

## 批次 I — 把守卫 D 名单补齐（对账脚本已经点名的 27 个漏列键）

只改 `h-tavernhelper-134-contract.test.ts` 的 forbidden 名单（+ 必要时的注释）。**这是主脑授权你改这份守卫的唯一情形**。

批次 F 的对账脚本实测：包H 族表 D 类有 51 个键名，而守卫只盯 24 个 ⇒ **漏列 27 个**
（音频 5/8、预设 10/16、正则 3/5、扩展安装 5/9、原始导入 1/2、预设类型判定 3/3）。
漏列的后果就是今天发生过的"塞成空壳没人发现"。
- 做法：跑 `node scripts/<对账脚本>`（F 交付的那个，路径见 `REPORT_包AE_*`），把它列出的漏列键**逐条**加进 forbidden 名单；
  加完后守卫必须**仍然全绿**（因为那 27 个键现在确实都没注册）；
  ⛔ 如果加进去有任何一条变红，说明那个键**已经被注册**——**停下回报，不要删键、不要放宽名单、不要改产品码**。
- 同时把 `palink-diag.ts:83` 注释里的 fixture 路径写准（`st289-names.json` 实际在
  `frontend/src/lib/slash-engine/__tests__/fixtures/`，文件是存在的；只改注释文字）。
- 验收：对账脚本从 `FAIL=1` 变成"③ 不再报漏列"（贴前后两次原始输出）；`gate.sh frontend` rc=0；
  反证一次：把 27 个里随便一个键在帧内注册掉（临时）⇒ 守卫必红，还原 ⇒ 绿。

---

## 交回必给（四批通用，主脑逐条独立复跑）
门禁退出码与 `failed=0/errors=0` 原始行；新/改测试**单跑用例数**；**两组反证**原始输出 + 还原后 `git status` 干净；
`git show --stat` 逐笔清单对照本批边界；一手锚点一律 `文件:行号`；做不到/没做清单项（允许存在，不许藏）。
报告落 `docs/_active/report/REPORT_包AG_(D|E|H|I)主题_2026-10-20.md`，首部写状态。
预算：D 60 次 / E、H、I 各 45 次；各自到 70% 预算即转收尾（门禁、报告、提交），被截断前**必须先提交已完成部分**。
