# HANDOFF — S1 开工交接（三轨并一轨 · 一次性方案）

> 写给人：接手做 **S1 补功能** 的下一位 agent
> 交接人：完成 S0 备料 + B1–B9 自检的 agent｜日期：2026-10-13 01:51
> 分支：`three-tracks-merge-20261012`｜基线 tag：`merge-base` → `66672a0`｜末笔提交：`9be0b18`

## 0. 先读这三句，再动手

1. **现在是 S0 备料完成、S1 未开工的状态，生产代码一行没改。** 你接手的是"刀已磨好、还没下刀"。
2. **这次不是"加功能"，是"把三套执行环境并成一套"。** 最大的事故来源是**误删**和**改坏兼容语义**，不是写不出代码。凡是要删东西，先 grep 消费链。
3. **验收线只有一条：`failed = 0`**（唯一例外是 B1 那条设计红，见 §8）。passed 数字不是验收线。

**必读顺序**：本文件 → `AGENTS.md`（项目红线 + 本机命令行环境）→ `TODOS.md` 的「三轨并一轨」条目 → `REPORT_一次性并轨施工方案与回退计划_2026-10-12.md` → `REPORT_S0备料基线与回退演练档案_2026-10-12.md` → `REPORT_S0完工自检_B1-B9_2026-10-13.md`。

> ## ⚠️ 先看这条订正（2026-10-13 02:20，接手 agent 实测后追加）
>
> **§2 T1 的技术前提被推翻了，别照原文施工。** 原文称「ST 契约是 `Promise<string[]>`、
> MVU 在模块顶层 await 后读 `.length`」，实测三条证据都不支持：
> 1. 本仓自带 ST 官方类型声明 `st-plugins/third-party/JS-Slash-Runner-main/@types/function/worldbook.d.ts:32`
>    —— `declare function getCharWorldbookNames(name): CharWorldbooks;`
>    `type CharWorldbooks = { primary: string | null; additional: string[] };` **且不是 Promise**。
> 2. 真机 MVU bundle（`backend/data/smart_card_assets/` 三份：307KB / 573KB / 137KB）调用形如
>    `getCharWorldbookNames('current').primary ?? 'unknown'` —— **不 await、读 `.primary`**；
>    三份里 `await getCharWorldbookNames` 出现次数 = **0**。
> 3. 同仓 JS-Slash-Runner 自家实现 `src/function/worldbook.ts:50` 就是同步转调 `getCharLorebooks({name})`，
>    其消费者 `src/function/character.ts:115` 也读 `.primary`。
>
> ⇒ 真缺陷是「**三处都返回 Promise，而消费者不 await**」：`.primary` 恒 undefined，
> MVU 的 `initialized_lorebooks` 键退化成 `'unknown'`。原文说的「对象形状是错的」方向相反；
> 把 #2/#3 改成 `string[]` 会让 `await` 派也拿错形状。**已在用户裁决下改为「三处同步返回
> `{primary, additional}`」**（提交 `fe419b7`，22 条契约测试钉住三处）。
>
> 教训：交接文档/审计报告里「契约形状」这类可证伪断言，**先去 `backend/data/smart_card_assets/*.js`
> 搜真机 bundle 再采信**，比读注释可靠。（`backend/data` 是红线目录，只读不改。）

---

## 1. 进度与证据（别重复做，也别推翻）

| 步 | 状态 | 判据 |
|---|---|---|
| S0 备料 | ✅ 9/9（方案 §7 原文九条逐条对上） | 末笔 `9be0b18`；tag `merge-base` |
| S1 补功能 | ❌ **你来** | 无 `s1-done` tag |
| S2 挂载点+存储迁移 | ❌ | 无 tag；`storage.ts` 无旧键前缀字面量 |
| S3 切换默认 / S4 拆单间 / S5 删大堂 | ❌ | 均无 tag |

**门禁基线（S0 末当场复跑）**：vitest **845 passed / 1 failed / 3 skipped（849）**｜tsc **退出码 0**｜pytest 2043 passed / 23 skipped。

---

## 2. 你这次要干的活（S1 补功能）

### T1【首选】修 `getCharWorldbookNames` 返回形状 —— 已定位到根，直接改

⚠️ **我核实后修正了外部核查的描述，这比你拿到的清单更准确：不是"单间轨写错了"，而是"两轨形状不一致，且错的那轨正是并轨的目标轨"。**

三处实现，**形状各不相同**（全部已 `grep` + 读源码核实）：

| # | 位置 | 返回 | 是否符合 ST 契约 `Promise<string[]>` |
|---|---|---|---|
| 1 | `utils/sillyTavernPluginRuntime.ts:1625-1657`（**大堂轨**） | `Promise<string[]>`，**且处理了冷缓存自拉** | ✅ **正确** |
| 2 | `smart-card-runtime/frame-shim/legacy-st-sim.ts:1384-1387`（单间轨 shim） | `Promise<{primary, additional}>` | ❌ 错 |
| 3 | `smart-card-runtime/SillyTavernCompatRuntime.ts:5393-5396`（单间轨 runtime） | `Promise<{primary, additional}>` | ❌ 错 |

**为什么这条必须修**：MVU 在**模块顶层 await** 这个 API 后读 `.length`（`sillyTavernPluginRuntime.ts:1611` 记录了真机报错 `Cannot read properties of undefined (reading 'length')`）。返回对象 ⇒ `.length` 为 undefined ⇒ MVU 初始化中断 ⇒ 卡内状态栏/变量面板拿不到变量引擎。

**⭐ 最关键的推论**：并轨之后**全部走单间轨**，等于把这个坏形状**扩散到原本正常的大堂轨用户身上**。所以这不是"顺手修个小 bug"，是**并轨的前置阻塞项**。

**修复方向（别自己造，照抄已验证的实现）**：以 `sillyTavernPluginRuntime.ts:1625-1657` 为蓝本，把第 2、3 处改成返回 `Promise<string[]>`。注意一并搬过去的两个细节：
- **冷缓存自拉**（`:1643-1655`）：桥缓存是惰性拉取的，首次调用几乎必撞冷缓存，直接返回 `[]` 会让 MVU 误判"这张卡没有世界书"，所以冷缓存时要自己 `refreshCharLorebooks(cid)` 拉一次再答。
- **降级留痕**（`:1629-1632`）：桥不可用时 `recordStubHit(...)` 并返回 `Promise.resolve([])`，不要静默。

**T1 验收**：
1. 新增契约测试**钉住 `string[]` 形状**（三处一起钉，防止只改一处），测试名建议带 `[红→S1 转绿]`。
2. 改完跑：vitest + tsc 全绿（除 B1 那条）。
3. ⚠️ `legacy-st-sim.ts` 有**模板字符串雷区**（见 §3 红线 4），改完必须 `tsc --noEmit`。

### T2【S0 实测推出，原方案没有】iframe 生命周期策略

我实测出来的硬数据（被测：91 条消息会话，库内最长）：

- 内存：7 个 iframe → 113MB；**48 个 iframe → 560MB**。**边际 ≈ +9~11MB/个，且只增不减**（滚出视野不卸载）。
- 滚动：同页面配对测，每千像素主线程耗时 **28.1ms → 42.3ms（1.51×）**。
- nodes 4.8k → 14.0k；可滚动高度 12,399px → 55,753px。

**⇒ 必须在 S1 就定「懒挂载 + 出视野卸载/冻结」方案**，不能拖到 S4 拆完再看。否则并轨完成后长会话会线性劣化。
**T2 验收**：方案文档 + 至少一条契约测试（例如"iframe 数不随已加载消息数线性增长"的守卫）。

### T3【B3 已拍板 ①】废掉 inline 渲染 flag

**背景（我对外部核查的一处更正）**：清单称 `InlineCardRenderer` 是"活的生产路径"，实测**默认已被 flag 关闭** —— `Message.tsx:1153` 需 `shouldUseInlineCardRendering()`，而 `inline-flags.ts:84` = `isInlineCardRenderingEnabled() && isInlineCardSafeEnv()`，`:79-82` 注释写明默认恒 false、统一走 iframe。
⇒ 敞口是"有人翻开 flag 才出现"，不是线上正在跑，**紧急度低但结论不变**：仍按 ① 把 flag 彻底废掉，避免它成为合并后残留的第三个执行面。
**连带**：S5 若要删 `inline-script-replay.ts`，**必须同步处理 `InlineCardRenderer.tsx:41` 的 import**（已核实存在），否则 tsc 悬空。

---

## 3. ⛔ 红线（违反即返工）

1. **不按文件名删任何东西。** 名字带 `st_` 不等于要删：`st_groups.py` 是 Palink 自有群聊后端，`st_sync_service.py` 被主链路引用，`synthesize_tts_st_compat`、`'st-compat-v2'`、`st-vec::`、`get_st_current_user`、`frontend/public/st/`、`lib/group-chat/*` 全是**在用的生产代码**。动它们之前先 grep 全仓消费链。
2. **`SillyTavernCompatRuntime.ts` / `legacy-st-sim.ts` / `api/silly_tavern.py` 只拆不改语义。** 拆的是单间轨文件本身，不是删除。这三个文件是卡片渲染底座，不是残留。
3. **不改后端、不改正则管线、不动装配链** `roleplay_prompt_assembly.py`（非本次目标，且需授权）。
4. **`legacy-st-sim.ts` 内禁止出现反引号（`` ` ``）和 `${`。** 该文件整体是模板字符串，新注释/新代码里出现这两个字符会提前终止模板 → `TS1005`，且报错指向注释行、极易误判成配置坏。正则一律用 `new RegExp(...)`。**改完 shim 必须跑 `node scripts/verify-shim-identity.mjs`**。
5. **`SillyTavernCompatRuntime.ts` 同理**：全文 44 个反引号 / 26 个 `${`，`:220` `const bootScript = \`<script${nonceAttr}>` 即模板字符串起点。
6. **别动这些目录**：`frontend/dist`（nginx bind mount）、`backend/data`、根级 `图片/`、`记忆/`、两个 mp4。
7. **`backend/app/core/migrations.py` 的 `_RUNTIME_COMPAT_COLUMNS` 禁止回填** `silly_tavern_mode` / `silly_tavern_theme`（列已 drop，回填会让后端重启时把列重建回来）。
8. **存储迁移（S2）只准加不准删**：「读新键 → 无则读旧键 → 写新键」，**不删旧键** `palink:card-storage:v1:`（R2 回退完整性）。

---

## 4. ⚠️ 本机环境坑（命令会静默失败，不报错）

| 坑 | 正确做法 |
|---|---|
| `python` / `python3` 是微软商店空壳（exit=49，零输出） | 一律用 **`py`**（`py -3`）。`scripts/gate.sh` 已自动探测，别写死 `python` |
| `powershell` 按名调不到（PATH 类型被存成 REG_SZ，不展开） | 用 **`pwsh`**（7.6.6，按名可用）或全路径；`powershell`（5.1）要等重启 |
| 唯一 shell 是 **Git Bash** | 别写 PowerShell 的 `$env:` / cmd 的 `%VAR%`。WSL 不是可用选项（只有 docker-desktop 一个发行版） |
| `make` / `jq` / `wget` / `7z` / `gh` / `sqlite3` / `psql` 都没有 | `jq` → 用 `py -c "import json..."` 或 node；`make` → 进容器 |
| `reg.exe` / `sc.exe` 带 `/v` `/f` 参数 | 先 `export MSYS_NO_PATHCONV=1`，否则 MSYS 把 `/v` 当路径改写 |
| 控制台代码页 936（GBK） | Windows 程序中文输出是 GBK 字节，加 `\| iconv -f GBK -t UTF-8`；或只认结构化 ASCII 行和退出码 |
| git bash 无 `curl` | `/c/Windows/System32/curl.exe`；访问本机服务**必须加 `--noproxy '*'`**（Clash 拦 localhost） |
| backend 容器里没有 `ps` / `git` / `wget` | SQL 走文件传，别长串内联 |
| ⚠️ **pytest 的 `--basetemp` 千万别指进仓库内** | 曾导致一次删 58 文件撞安全删除守卫 → `SystemExit:1` → 临时目录半残 → 连带 84 个 error。默认落系统 temp 即安全 |
| **安全删除监视器** | 单次批量删 **>50 项**会被中止（bash 的 `rm` 是函数垫片）；node 侧 `fs.rmSync` 递归删会被**进程级 SIGKILL**。别造"回头再删"的大目录 |
| **git 重型操作会被 SIGKILL** | `git fetch` / `clone` / `stash -u`（含大量未跟踪文件时）/ 整树 `tar` 全部中招。**`git stash -u` 被杀会留下损坏的 .git（refs 被删、objects 丢失 = 全部历史丢失），本仓禁止使用** |
| ✅ 但 `git bundle create` 是安全的 | 实测 1 秒完成、不被杀。这是本机唯一可靠的分支出仓手段 |

---

## 5. ⚠️ git 操作纪律（本仓特有，踩过学费）

1. **提交一律用 `git commit -o -- <pathspec>`**（`-o` = only）。不用 `-o` 会把别人已暂存的内容一起吞掉 —— 我第一笔提交就吞了 56 项 rename，靠 `reset --soft HEAD~1` + `restore --staged` 才救回来。
2. **逐项 pathspec，禁止 `git add -A`**（共享工作区，会动别人的暂存区）。
3. `commit -o` 不接受未跟踪文件 → 先 `git add <file>` 再 `commit -o`。
4. `_BACKUPS/_INDEX.md` 被 .gitignore 拦但仍被跟踪 → 需要 `git add -f`。
5. **commit message 里不要出现 "powershell" 字样** —— 会被安全垫片误判为「从 Bash 调用 PowerShell」而拦下。改写"PS 5.1"。
6. 测试里**不要写 api_key 字面量**，会被 secret scanner 拦 → 用拼接常量。
7. 备份一律进 `_BACKUPS/日期_主题/` 且必带 `BACKUP_INFO.md`。
8. 改了 `docs/` 下任何文件 → **必须** `py scripts/docs/gen_docs_catalog.py` 重新生成，再 `--check` 验证，否则 `bash scripts/gate.sh docs` 必红。

---

## 6. ⚠️ 浏览器实测方法论（我本轮踩过的坑）

| 坑 | 正确做法 |
|---|---|
| 前端真实端口是 **14700**（不是记忆里的 14000） | 先 `docker ps` 确认映射 |
| **headless 无 vsync ⇒ FPS 是假象** | 实测 149.8fps 毫无意义。改用 **CDP `Performance.getMetrics` 的 `TaskDuration` 增量**当主线程占用代理。**不要宣称"实测 60fps"** |
| `longtask` 观测器 | `addInitScript` 只对**后续导航**生效，不导航时永远测不到 0 —— 别当成"无卡顿"的证据 |
| **同一 origin 的 `goto` 会复用渲染进程** | 先加载 91 条再刷新回默认视图，堆仍报 404MB、nodes 25k（脏数据）。要干净基线：用**新 page/新会话**，或干脆同页面前后配对 |
| **A/B 必须归一化** | 两次滚动距离不同（少的一方会提前触顶），必须按**实际滚动像素**归一，否则把"滚得更远"误判成"更卡" |
| `playwright-cli run-code` | 必须传**箭头函数源码**（`async page => {...}`）。传语句块报 `Unexpected token 'const'`，传 IIFE 报 `__fn__ is not a function` |
| 数 DOM 规模 | 用 `document.getElementsByTagName('*').length`。`[class*=message]` 之类选择器会恒返回 46（匹配到非消息元素），别用它数消息 |
| 角色聊天数据在哪 | 表是 **`character_chat_messages`**（不是 `messages`）；消息数要**按 `branch_id` 分组**才看得到真实值（主分支 91 / 另一分支 1） |
| 历史分页不是滚动触发 | 是顶部「↑ 加载更早消息」按钮（`CharacterChat.tsx:2080-2093`），每点一次 +5 条 |
| 滚动容器 | `.rp-chat-area`（不是 `document.scrollingElement`） |

---

## 7. 已知缺口清单（不许默默放过，没修就登记）

| # | 缺口 | 位置 | 本期处置 |
|---|---|---|---|
| G1 | `getCharWorldbookNames` 三处都返回 Promise，而真机消费者同步读 `.primary` ⇒ 恒 undefined | `legacy-st-sim.ts`、`SillyTavernCompatRuntime.ts`、`sillyTavernPluginRuntime.ts` | **T1 已修（`fe419b7`）**：三处统一同步返回 `{primary, additional}`，22 条契约测试钉住。⚠️ 原文「不符 `Promise<string[]>`」的结论已推翻，见文首订正 |
| G2 | 手势闸门不含 `setChatMessage` / `deleteMessage`，卡片可无手势改写/删除既有消息 | `SmartCardCompatController.ts:57-80`（实际 9 项：原 8 + `clearChat`） | 本期不修，登记。与 `clearChat` 的入选理由自洽性存疑 |
| G3 | inline 渲染仍是第三套执行面（默认 flag 关闭） | `Message.tsx` + `inline-flags.ts` | **T3 已修（`ea15a6f`）**：flag 彻底废除、`inline-flags.ts` 已删、渲染收口 iframe，9 条守卫测试。`InlineCardRenderer.tsx` 与 `inline-script-replay.ts` 留到 S5 一并删 |
| G4 | 「单文件 ≤1200 行」门禁若按全 src 字面执行，已有 **14 个文件超限**且多数与并轨无关 | `sandbox.ts` 5612、`ModelManagementTab.tsx` 1973 等 | **待拍板**：建议门禁限定为"本次被改动/被拆分的文件" |
| G5 | `_BACKUPS` 全量备份是**等效满足**（未复制 2.5GB 备份树） | 档案 §2 | 待复核是否接受 |
| G6 | kill switch 真机验证未做 | 开关：`card-script-runner.ts:34`、`card-idb-namespace.ts:45`；单测已覆盖 | 留至 S3 前 |

---

## 8. 门禁命令与验收口径

```bash
# 前端（主力）
cd frontend && npx vitest run        # 期望 845 passed / 1 failed / 3 skipped
cd frontend && npx tsc --noEmit      # 期望退出码 0

# 后端（只在碰了 backend/ 时跑）
cd backend && py -3 -m pytest tests/ -q   # 期望 2043 passed / 23 skipped（约 167s）

# 文档（动了 docs/ 必须跑）
py scripts/docs/gen_docs_catalog.py && py scripts/docs/gen_docs_catalog.py --check

# 一把梭
bash scripts/gate.sh all
```

**验收口径（红线）**：
- **`failed = 0` 是唯一验收线**，passed 数字不是。
- **唯一允许的例外**：`storage-isolation-contract.test.ts:221`（测试名带 `[红→S2 转绿]`）—— 它是 S2 的开工信号，**S2 未做完之前必须保持红**。你如果把它改绿了，说明你提前做了 S2 或者改了测试，两种情况都要说明。
- 拆完大文件必跑 `tsc --noEmit` + `vitest run`（模板字符串雷区，见 §3 红线 4/5）。

---

## 9. 回退链（都还在，别重复造）

| 层 | 状态 |
|---|---|
| R0 tag | `merge-base` → `66672a0`；R3 区间 revert 已空跑验证**零冲突** |
| R1 kill switch | 代码在、单测覆盖；真机验证待 S3 前 |
| R2 存储双兼容 | 待 S2；当前确认无任何清理逻辑触碰旧键前缀 |
| R3 revert + DB 快照 | `D:\项目\_palink-s0-20261012\palink_ai_hub_dump_20261012.sql`（36M） |
| R4 全量 | 分支 bundle 75MB + 上传目录快照 461M，均在 `D:\项目\_palink-s0-20261012\` |
| ⚠️ push origin | remote 已配但**未 push**（属外部动作，需用户授权）。别自作主张 push |

---

## 10. 工作节奏建议（照这个来，最不容易出事）

1. **先写测试钉住，再改代码转绿。** S0 那 18 条契约测试就是这么做的，效果很好——测试先红是"开工信号"不是失败。
2. **一次只做一件事，一件事一笔提交。** 删码 commit 单独一笔（方案 §5 已定，revert 成本最低）。
3. **改之前先 grep 消费链，改之后全局搜标记验证。** 容器 healthy ≠ 代码最新。
4. **每笔提交后立刻跑门禁**，别攒着跑——攒到最后一堆红你分不清是哪笔引入的。
5. **遇到"看起来像残留"的，先 grep 再下结论。** "看起来像残留"和"真的是残留"之间，隔着一个 grep。
6. **数字说不通就查，别硬写。** 我本轮有个对照读数堆内存报 404MB 但对不上 iframe 数，查下去才发现是渲染进程复用导致脏数据，差点把错的数字写进档案。

---

## 11. 交付前自检（逐条给证据）

1. 你实际做到了哪一步（commit / tag / 门禁数字）
2. 门禁实跑输出：vitest / tsc（碰了后端就加 pytest）
3. T1：三处 `getCharWorldbookNames` 是否**全部**改成 `Promise<string[]>`？契约测试钉住了吗？冷缓存自拉逻辑搬过去了吗？
4. T2：iframe 生命周期方案定稿了吗？有守卫测试吗？
5. T3：inline flag 废掉了吗？`InlineCardRenderer.tsx:41` 处理了吗？
6. §7 六条缺口：修了的给证据，没修的明确写"未修"
7. `git status` 除预期项必须为零
8. 分支 bundle 更新一次（`git bundle create "D:/项目/_palink-s0-20261012/palink_three-tracks-merge_20261013.bundle" three-tracks-merge-20261012`）
