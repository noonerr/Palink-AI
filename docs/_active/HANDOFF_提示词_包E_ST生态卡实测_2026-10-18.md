# 包E —— ST 生态卡「真实世界」实测（不写功能，只出真相）

> 主控交接文档。你（执行 agent）看不到我们之前的对话，本文档是自包含的。
> 基线分支 `three-tracks-merge-20261012`，HEAD = `decb453`。

## 0. 一句话任务

**不要写新功能。** 拿真实世界的 ST 角色卡和 ST 插件，在 Palink 上跑一遍，
如实回答：**"哪些能跑、哪些不能、不能的原因是什么、要修的话修在哪"**。
今天三包（A 瘦身 / B 兼容 / C 后端）都只验证了**一个角色**（`c28061bb-…`）。
**单样本结论不能外推**，这是本包存在的唯一理由。

## 1. 已验证的（我今天独立复核过，可直接引用，不必重测）

| 项 | 实测值 |
|---|---|
| 7 帧 srcdoc 合计 | **326,773**（单帧 `[46167,46311,46261,47770,46223,47794,46247]`） |
| 帧内 `getContext()` | **145/145 存在，missing = []**，总键数 194 |
| `TavernHelper` / `Mvu` | 76 / 6 |
| `Object.keys(SlashCommandParser.commands)` | **135**（`'add' in commands` = true） |
| `/add 1 2` → `"3"`；`/getchatname` → `palink-session-f25daab6-….jsonl`；`/echo hello` → `"hello"` | 全通 |
| 后端 Extras | `classify/labels` 200、`kobold/embed` 200、`summarize` 400（空体）、`sprites/get`(GET) 422（缺参） |
| 门禁 | vitest **81 文件 / 1033 passed / 3 skipped / 0 failed**；`tsc --noEmit` rc=0 |

⚠️ 上面所有数字都只来自**一个角色**。换卡可能完全不同。

## 2. 你要做的四件事

### E-1 建 ST 289 命令 fixture（验收基建，必须先做）
现状：289 条命令清单**只存在于主控报告的叙述里，没落盘** ⇒ 任何"覆盖多少条"的验收都不可复跑。
- 从 `_reference/sillytavern-1.18.0/public/scripts/` 提取命令名（注册形态
  `SlashCommandParser.addCommand(...)` / `SlashCommand.fromProps({ name })` 等），
  去重后写成 `frontend/src/lib/sillytavern/__tests__/fixtures/st-slash-commands-1.18.0.json`。
- **分开报数**：核心命令 vs 内置扩展命令 vs 别名（ST 1.18 口径约 222 + 67 + 175 别名）。
- 提取方法要写进 fixture 的同目录 README 或 fixture 的 `_meta` 字段（便于上游升级时重跑）。

### E-2 选样本卡（≥ 5 张，覆盖不同依赖形态）
优先从这些地方找：
- 仓库内 5 个测试插件（复测靶子 `2e1fa886b439` / `43ef24b1a3ba` / `01db1f12ddd0` / `4d61e879d0c5` / `ca0611884034`）；
- `st-plugins/` 下的插件；
- 后端 `backend/data/` 里已有角色（用 API 列，别猜）。

**必选的依赖形态**（每种至少 1 张，缺哪种就在报告里写明"没找到样本"）：
1. 纯静态 HTML/CSS 卡（无脚本）
2. 用 MVU 变量（`Mvu.getVariable` / `[initvar]`）的卡
3. 有 `regex_scripts` 的卡
4. 有 `tavern_helper` 脚本、且**在模块顶层同步读 `getContext()`** 的卡 ← **包A 遗留的最高风险点**
5. 依赖外链图片/CDN 资源的卡

⚠️ 第 4 类是重点：包A 把 `characterExtensions` 从 boot 里移除了，靠 context-update 补。
若某张卡在**解析期（parse-time，早于 context-update）**同步读 extensions，它会拿到空值。
包A 报告把这条列为"唯一未完全闭环的风险"，本包必须给出答案。

### E-3 逐卡真机实测（每张卡同一套指标）
用 `playwright-cli`，端口 **16000**，登录 `POST /api/token`（`admin` / `admin123`）。
每张卡记录（**t=6s 与 t=14s 各取一次，不一致就标红**）：

| 指标 | 怎么取 |
|---|---|
| srcdoc 字节 | `iframe.getAttribute('srcdoc').length` |
| 帧内 style 数 | 帧内 `document.querySelectorAll('style').length` |
| 样式守护是否补过 | 帧内 `window.__palinkStyleGuardRestored` |
| getContext 键数 / 缺 ST 145 的键 | `Object.keys(getContext())`，与 fixture 比对 |
| TavernHelper / Mvu 键数 | 76 / 6 为基线 |
| extensions 是否到位 | 帧内 `getContext().characterId` 有值 + 卡脚本能否读到 `extensions`（用卡自有行为判断，别硬造） |
| 顶部 toast 条数 | 主页面 DOM 计数（生产包 console 被剥光，靠 DOM） |
| 截图 | 存 `docs/_active/report/shot-包E-<卡简称>.png` |

**异常判定**：出现"先正常后崩" / style 数归零 / toast 成串 → 记为**失败样本**，
并抓出**根因**（谁删的、什么时候删的），不要只记现象。

### E-4 出结论表（这是本包唯一真正的交付物）

按"能跑 / 部分能跑 / 不能跑"三档给每张卡定性，并对**每个失败项**给出：
- 现象（带数字）
- 根因（带 `文件:行号`，**不接受"可能是"**）
- 修在哪（具体文件 + 大致行数）
- 是否值得修（一句话判断）

最后给一个**整体判断**：以今天这个状态，**生态里大概百分之多少的卡能正常显示？**
（允许估，但必须写明样本量、取样偏差、以及你据以判断的证据。）

## 3. 红线（违反即返工）

1. **本包不写功能代码。** 只写：fixture（E-1）、测试（若需要）、报告、截图。
   如果发现**必须改代码才能继续测**，停下来**先问主控**，不要顺手改。
2. **不要重建 `frontend/dist`**（nginx 只读挂载，并发写会撞车；确实需要时**先问主控**）。
3. **不要动后端**，不要 rebuild 容器（会重启服务，影响并发中的其他工作）。
4. 提交只带自己的文件：`git commit -F <消息文件> -o -- <pathspec>`。
   `-F` 必须在 `-o --` **之前**；消息文件放仓库内（如 `.tmp_probe/`）用相对路径。
5. **不许把失败样本藏起来。** 测出来不能跑就写不能跑。主控宁可要难听的真话。

## 4. 环境纪律（本机实测）

- 唯一 shell = **Git Bash**。Python 一律 `py`（`python`/`python3` 是商店空壳）。
- Windows 程序输出 GBK ⇒ `| iconv -f GBK -t UTF-8`，或只认 `OK`/`failed = 0`/`rc=` 这类 ASCII 行。
- curl 用 `/c/Windows/System32/curl.exe --noproxy '*'`（Clash 拦 localhost）。
- **`docker exec` 传 `/tmp` 路径必须 `export MSYS_NO_PATHCONV=1`**；`docker cp` 宿主路径**不能**加。
- **403 ≠ 路由存在**（`main.py:386` CSRF 中间件跑在路由匹配前）。探端点必须带 `X-CSRF-Token`，
  并**同时打一个不存在的端点做对照**（对照应为 404，否则你的 200 是假阳性）。
- 生产包 console 被 terser `drop_console` 剥光 ⇒ 取证靠 DOM / 运行时对象。
- `page.frames()[0]` 是主页面本身；摸卡帧必须 `for (const f of page.frames())`。
- ⚠️ **读容器先确认口径**：`SlashCommandParser.commands` 是 Proxy，
  `commands.keys()` 返回 Map 自己的 7 条，**`Object.keys(commands)` 才是 135**。我已踩过一次。

## 5. 报告

写入 `docs/_active/report/REPORT_包E_ST生态卡实测_2026-10-18.md`，至少含：
样本卡清单（含各自依赖形态）、E-3 全指标表（每卡一行，t=6s/t=14s 两列）、
失败样本根因逐条、E-4 结论表、整体百分比判断（带样本量与偏差说明）、
以及一节「建议主控下一步做哪三件事」。
