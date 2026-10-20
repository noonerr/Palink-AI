# PROMPT — 对话派包 · 批次 C（getContext 六个"有名字没实物"的键 + 一处会误导人的记录措辞）2026-10-20

> 给**零上下文**的执行 agent。复核方是 Qoder 里的"分配分包派遣任务"那个会话（主脑）。
> 底本（必读，含全部通用红线与验收口径）：
> `docs/_active/HANDOFF_提示词_已授权批次_写桥与人设角色库与getContext与服务端留痕_2026-10-20.md`（下称**任务书**，看 §0 与 §1-C）。
> ⚠️ 批次 D（后端留痕）**与本批同改 `palink-diag.ts`，严禁同对话顺带做，也不许两个对话并行。**

## 0. 开工前自查（任一不满足就停手回报）
1. `git log --oneline -4` 里能看到 `c3c5639`（主脑复验纠偏）与 `201eec2`/`fdc779f`（批次B 段②）。
2. `git status --short` 除 `.workbuddy-ai/**`（**别人会话的文件，绝不碰**）外干净。
3. `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:16000/` = 200，且 `docker ps` 五容器 healthy。
   ⛔ 全程禁止重启/关停 Docker 与 compose，禁止动 `frontend/dist`（上线只由主脑做）。

## 1. 这一批只做两件事

### C-1 `getContext()` 里 6 个"有名字没实物"的键，逐个定性并按 ST 处理
清单来自**主脑真机实测**（7 帧逐帧一致，2026-10-20）：
`CONNECT_API_MAP`、`chatMetadata`、`getPresetManager`、`getRequestHeaders`、`tagMap`、`tokenizers`。

1. **逐个一手核 ST**：两棵树都在（`_reference/sillytavern-1.18.0` 与 `/d/SillyTavern-release`，均 1.18.0）。
   先 grep `public/scripts/st-context.js` 的顶层键定义，再看每个键的真身从哪来、值是什么形状、
   卡拿到它之后是读还是调。**报告里每个键都要有 `文件:行号`**，不许写"应该是"。
2. 分三档处置，**逐键给结论**：
   - **能真做的** → 做到真（例：`getRequestHeaders` 只是返回带头信息的对象；`chatMetadata` 若本仓有对应数据就映射）。
     实现必须走既有数据源，**不许返回一个长得像的空对象**（本仓红线：形状对语义错 = 假实现）。
   - **依附整套子系统的** → 不动产品码，只把台账对应 id 的行加"为什么不补"（例：`getPresetManager` 属 ST 预设对象模型 = 台账 `preset_prompt`，乙类）。
   - **本仓根本没有数据源的** → 保持"在场但非真"，在报告里写清缺的是哪一层；⛔ 不许造数据。
3. 每键一句可核对的验收：真机（或旁路 dev 探针）里 `getContext().<键>` 的**类型与关键字段**读数。

### C-2 改一条会误导人的记录措辞（不改判定逻辑）
`window.context` 那条启动留痕现在的文字读起来像"我们的缺陷"。主脑一手核实：**ST 里 `context` 恒为局部变量**
（`authors-note.js:325/444`、`extensions.js:90/2062/2144`、`slash-commands.js:3892`、`utils.js:1344`、
`world-info.js:1116` 等都是 `const context = getContext();`），而 `window.context` / `window.getContext` /
`globalThis.getContext` 在两棵 ST 树与酒馆助手插件里**全树 0 命中**
⇒ **ST 也没有这个全局**。用户裁定"与 ST 冲突以 ST 为准" ⇒ **不摆这个全局**。
要做的只是把措辞改成"ST 亦无此全局，卡这种写法本身不合规"，**记录本身保留**（它是"哪张卡在这么写"的证据）。
⚠️ 只改文案，不许改 owner/kind/去重/上送任何一条判定；不许动 `ST_GAP_BY_NAME` 里的键名。

## 2. 文件边界（只许碰这些）
`runtime-body/part-01.ts`（C-2 的启动留痕文案）、
`runtime-body/part-07.ts` / `part-08.ts` 里 **getContext 构造那一段**（C-1 的实现，若某键可落地）、
`SmartCardCompatController.ts`（若需要父侧动作）、
`palink-diag.ts` **仅注释/文案**（⚠️ 批次 D 会改它的代码，你别改代码）、
`__tests__/` 对应测试、`docs/_active/report/REPORT_包AD_*`、台账 `SPEC_向ST学习的子系统缺口与标记方案_2026-10-19.md` 的对应行。
越界（含 `_BACKUPS/`、`.githooks/`、`backend/data`、`frontend/dist*`、`.workbuddy-ai/`）一律退回。

## 3. 硬约束（都踩过坑，别试探）
- ⛔ 空壳实现；⛔ 为凑绿改守卫；⛔ 新加 `it.skip` / `--continue-on-collection-errors` / `|| true`。
- 模板字符串 `runtime-body/part-*.ts`：**不许反引号、不许 `${`（注释里也不行）、反斜杠成对写**；
  `tsc` 查不出里面写坏 ⇒ 必须 `generated-script-parse-guard` 绿。测试注释里不许出现 `*/`（会让整份测试变 `no tests`）。
- 执行型断言只能用 `COMPAT_V2_RUNTIME_ARTIFACT`（求值后产物）。
- **`typeof === 'function'` 不算存在证据**（`TavernHelper` 是 Proxy，未注册名也返回缺能力函数）；
  判存在只认 `Object.keys` 里的自有属性，或调用后不产生 `missing_api`/`tavernhelper_key_unimplemented` 记录。
- 记账按**族表逐条对账**，不要"守卫列了几个就移几个"（上一批就是这样少算了 10 个键）。
  改判必须三层同批：正向锚点 + 台账行 + 包H 报告计数订正（`13 + C + D = 134` 要闭合）。
- 提交逐项 pathspec，禁 `git add -A`；源码与测试同笔，记账单独一笔。
- 真机：`http://localhost:16000`（角色 `c28061bb-a9b7-46a9-a255-2692d57001fc`），**只读、不许点生成、不许花用户 API 余额**；
  计费端点 `page.route` 本地 fulfill。要新代码上线才能测 ⇒ 旁路 `VITE_OUT_DIR=dist_c node scripts/build-vite.mjs`
  + dev 探针（端口 **5216**，会话名 **`-s=pkg-c`**），⛔ 不许覆盖 `frontend/dist`。

## 4. 交回必给（主脑逐条独立复跑）
1. `bash scripts/gate.sh frontend` 退出码 + `failed=0/errors=0` 原始行；碰后端就再加 `backend`。
2. 每个新增/改动测试文件**单独跑**的用例数（0 用例=不存在）。
3. **两组反证原始输出**：① 把你实现的那段短路 ⇒ 相关用例红；② 把记录文案改回旧词 ⇒ 钉文案的用例红。之后还原、`git status` 干净。
4. 6 键逐行结论表：`键名 | ST 一手 文件:行号 | 档位(做了/依附子系统不做/无数据源) | 读数`。
5. 零回归面读数（改前/改后各一次）：`Object.keys(TavernHelper).length`（应为 **144**）、`getContext()` 键数（196）、
   每帧插件 CSS（5/5）、`Object.keys(SlashCommandParser.commands).length`（509）。
6. `git show --stat` 逐笔清单 + 报告 `docs/_active/report/REPORT_包AD_getContext六空壳定性与留痕文案_2026-10-20.md`
   （首部写状态；末尾列"交接给主脑"）。动了 `docs/` 就刷目录并贴 `OK ... docs` 那行。

## 5. 预算与停机
最多 **55 次**工具调用；**前 8 次内落地第一个可执行文件**；到 **40 次**停止新实现转收尾（门禁、报告、提交）。
被截断前**先把已完成部分提交**。做不到不扣分，糊过去才扣分——报告里允许出现"6 键里我只落地 1 个，其余 5 个依附预设/聊天文件面"。
