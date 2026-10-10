# HANDOFF_审计修复完工_2026-10-10-new

> **状态**：已完工（14 个提交已落地）· **一处验收被环境阻塞**（见 §5）
> **完工日期**：2026-10-10
> **依据**：`REPORT_悲观刻薄审计_第二次全仓体检_2026-10-10-new.md`
> **施工方案**：`SPEC_审计后综合治理方案_2026-10-10-new.md`
>
> **一句话**：**工作区未提交改动 208 项 → 0**。生产代码、测试、迁移、文档、CI 均已入库。

---

## §1 提交总览（14 笔，分支 `st-plugin-compat-20260727`）

全程**未使用 `git add -A`**，按批次显式 `git add <文件>`，每笔可独立回滚。

| # | commit | 内容 | 规模 |
|---|---|---|---|
| 1 | `aecf216` | 批次A 后端生产源码（含从未入库的 `mvu_cleanup.py` 625 行） | +1429/−99 |
| 2 | `8df6ebe` | 批次B 前端源码（10 个从未入库的新文件） | +1357/−94 |
| 3 | `c7ef194` | 批次C 运行配置 + **ci.yml 首次入库** | +205/−23 |
| 4 | `c2415e6` | 批次E 43 个已删文件（提交前校验未删被引用文档） | −10555 |
| 5 | `ddcef2e` | 修门禁假红 + 删 3 处 `or True` | +184/−3 |
| 6 | `968cf67` | 计量常量正名 + AGENTS.md 两处订正 | +1091/−46 |
| 7 | `85aa3ca` | **修复 P0-1：alembic 0068 入库** + requirements-test.txt | +124 |
| 8 | `a56bb2f` | 批次D 测试 13 文件（6 个从未入库） | +3029/−665 |
| 9 | `14e65dc` | backend/scripts 20 个一次性探针 | +1599/−1 |
| 10 | `878b015` | .gitignore 加 `*.tsbuildinfo` | +4 |
| 11 | `6a015ed` | 批次F **docs 92 份（81 份从未入库）** | +21325/−5 |
| 12 | `9a18b53` | 批次G 根目录文档 + `gen_docs_catalog.py`（CI 依赖） | +897/−1 |
| 13 | `a2b3163` | .gitignore 阻止 `_BACKUPS` 膨胀 | +13 |
| 14 | `74e9f9a` | `_BACKUPS/_INDEX.md` | +13 |

---

## §2 修复过程中新挖出的 5 个「从未入库」

> 这些**审计时没发现**，是提交过程中逐一暴露的。每一条都比原审计结论更严重。

| # | 发现 | 后果 |
|---|---|---|
| 1 | **`.github/workflows/ci.yml` 从未入库**（`git ls-files .github` 返回空） | AGENTS.md 宣称的 CI **在任何平台从未运行过**。这是 208 项长期无人拦下的直接原因 |
| 2 | **`scripts/gate.sh` 从未入库** | 「唯一门禁入口」本身不在版本库 |
| 3 | **alembic `0068` 未入库，而 `0069` 已入库** | = OPEN_ISSUES 的 **P0-1**（2026-10-05 记录后一直没修）。迁移链断一节，**从干净库 `alembic upgrade head` 必然失败** |
| 4 | **`docs/OPEN_ISSUES.md`、`docs/_INDEX.md` 从未入库**；整个 `_archive/`（40+ 份）与 `_reference/` 也从未入库 | 项目建了完整的文档治理体系，**而这套体系本身没版本化** |
| 5 | **`gen_docs_catalog.py`、`requirements-test.txt` 未入库** | 它们是 CI 文档 job / 后端 job 的依赖。**CI 入库了但依赖没有** ⇒ CI 一跑就失败。已一并补齐 |

**共同病根**（与原审计 §1 同源）：**在用的东西不在版本库里。**
不只是代码 —— CI、门禁脚本、迁移、治理文档、归档体系，全都在。

---

## §3 具体修复内容

### 3.1 门禁假红（`scripts/gate.sh`）

**根因比 AGENTS.md 现有描述更精确**：旧注释「实测只产生 17 个临时子目录，远低于阈值 50」
错在**统计了「本次产生」，而触发守卫的是「清理历史累积」**（实测一次清理 59 个文件 > 50）。

修法：每轮给一个**全新的空 temproot**（`PYTEST_DEBUG_TEMPROOT`）⇒ 无历史 basetemp
⇒ garbage 收集无从发生 ⇒ 守卫永不命中。未加 `|| true`。
另加 `diagnose_junit`：即使 pytest 被环境杀在收尾，也能从 junitxml 读出真实结果
并提示「红的是环境还是代码」（**退出码照实返回，不洗绿**）。

### 3.2 3 处 `assert X or True`

- `test_memory_entity_card_gate.py:412` —— 原断言即便去掉 `or True` 仍是**重言式**
  （`.split("\n")[0]` 按定义不含换行）。改为验证真实行为：
  `_flatten_stat_value` 的 `replace("\n", " ")`（RPA:5167）
- `test_memory_semantic_store.py:246`、`test_st_plugin_import.py:97` —— 去掉 `or True`

单独跑 3 个文件：**78 passed / 0 failed** ⇒ 这 3 处**本来就该通过**，
只是被 `or True` 掩盖成了「什么都不测」。

### 3.3 计量常量正名（不改值）

`_MEMORY_BUDGET_LEVEL_TOKENS` → `_MEMORY_BUDGET_LEVEL_INTERNAL_UNITS`。
**数值一字未改、行为零变更**，改的是名字与契约说明：
名字不再暗示「4000 = 真实 token」（实际约 5490）。
同时把「已知且刻意保留」改写为**契约**：本式是档位表的定义基准，
改口径必须同时把档位值 ×1.37，二者绑定。

### 3.4 AGENTS.md 两处订正

- **新增第 6 条**：「ST 双轨已删」≠「ST 兼容层可删」—— 附 4 条引用链，
  禁止以「ST 已删」为由删除 `SillyTavernCompatRuntime.ts` / `legacy-st-sim.ts` / `api/silly_tavern.py`。
  （**本条同时作废审计报告 §10 原「清理 ST 残留」建议**，那是未做引用链复核的错判。）
- **第 7 条**：CI 从未入库的史实 + 验证方法（`git ls-files .github`）。

---

## §4 验收结果

| 项 | 结果 |
|---|---|
| `bash scripts/gate.sh`（全量） | **四项全绿**：后端 pytest / 前端 tsc / 前端 vitest / 文档目录 |
| 后端 pytest | **2006 passed / 23 skipped / 0 failed / 0 errors** |
| 前端 vitest | 810 passed / 3 skipped（tsc `--noEmit` 通过） |
| `gen_docs_catalog.py --check` | OK，256 docs（tracked 174 → 256） |
| 门禁耗时 | 3m52s 失败 → **2m26s 通过** |
| 工作区 | **208 项 → 0** |

**终极验收（HEAD vs 生产容器，11 个文件）**：**SAME=9 / DIFF=2**，判定通过。
9 个 SAME 中含 `mvu_cleanup.py`（625 行，此前从未进过版本库）。
2 个 DIFF 已逐行证实为「改名 + 注释」，**行为零变更**（详见 §5）。
⇒ **生产后端代码可从 git 重建。**

---

## §5 ✅ 终极验收已补做完成（Docker 恢复后，2026-10-11）

**结果：`SAME=9 / DIFF=2`** —— 判定为**通过**。

```
SAME  memory_module/retriever.py        SAME  api/chat.py
SAME  api/character_ext.py              SAME  services/character_message_builder.py
SAME  core/config.py                    SAME  services/mvu_cleanup.py
SAME  memory_module/service.py          DIFF  services/roleplay_prompt_assembly.py
SAME  services/mvu_engine.py            DIFF  utils.py
SAME  memory_module/config.py
```

### 2 个 DIFF 已逐行证实「行为零变更」

不是缺陷，是「我改了源码但尚未重建镜像」的正常状态：

| 文件 | 差异 | 实证 |
|---|---|---|
| `roleplay_prompt_assembly.py` | 32 行 | 仅 **4 行改名**（常量定义 + 3 处引用）+ 28 行注释/docstring。数值 `(750, 4000, 6000, 8000)` **一字未改** |
| `utils.py` | 22 行 | `diff` 剔除注释行后**空** ⇒ **纯注释，零代码改动** |

交叉验证：容器内 `grep -c "_MEMORY_BUDGET_LEVEL_TOKENS"` = **4**（旧名仍在），
`grep -c "_MEMORY_BUDGET_LEVEL_INTERNAL_UNITS"` = **0**（新名未进去）
⇒ 正好对应"改了源码、未重建镜像"。

### 唯一剩余的一致化动作（可选，非必须）

要让容器与 HEAD **逐字节一致**，需重建后端镜像：

```bash
docker compose build backend && docker compose up -d backend
```

⚠️ 会短暂中断后端服务。**由于本次改动行为零变更，不重建也没有任何功能差异** ——
建议等到下一批后端改动时一并重建，避免为纯注释重启生产。

---

## §6 遗留（本次**故意不做**，需你拍板）

| 项 | 现状 | 建议 |
|---|---|---|
| `_BACKUPS` 已入库的 66 个文件 | 目录实测 **2.4 GB**（含 dist 构建产物） | 已加 `.gitignore` **阻止继续膨胀**；存量需 `git rm --cached`，**会影响他人工作区**，未擅自执行 |
| 上一轮遗留项 | 8 个假测试、14 个 import-skip、P0-1 三处 `to_thread`、清空消息 404、`pytest-cov fail_under` | 未在本轮范围内，按 SPEC §8 第 5 项继续 |
| ST 端点瘦身 | `api/silly_tavern.py` 6247 行 | 逐端点查调用方后删，不要按名字删 |
| 巨文件拆分 | 6803 / 6247 / 5925 行 | 先瘦身再拆，不为了拆而拆 |

---

## §7 复用时注意（本轮踩过的坑）

1. **容器侧 md5 必须在容器内算**。`docker exec md5sum <path>` 可行；
   `docker exec cat <path> | md5sum`（宿主机算）会因传输层行尾转换而不一致。
   容器内归一化要写 `sh -c "tr -d '\015' < f | md5sum"` —— **不能写 `'\r'`**，
   `sh` 不解释转义，那样删的是字符 `\` 和 `r`。
   最稳：`docker exec base64 <path> | base64 -d | tr -d '\r' | md5sum`。
2. **`git add` 被 gitignore 目录内的已跟踪文件**会报 ignored 失败，
   但它可能仍留在暂存区 ⇒ 遇到就直接 `git commit`，不要重复 add。
3. **`--check` 退出码要直接取**，不要接管道（`cmd | tail -1; echo $?` 拿到的是 tail 的码）。
4. 多 agent 共享工作区：**任何情况下不要 `git add -A`**。
