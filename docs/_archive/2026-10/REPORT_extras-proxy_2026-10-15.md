# REPORT — ST Extras 后端转发代理补齐（/api/summarize + translate）

> **状态**：✅ 代码就绪 + 单测全绿；**真机端到端（backend 镜像重建 + 探针）未做**，由主控统一安排
> 日期：2026-10-15
> 分支：`be-extras`（worktree `D:\项目\_palink-wt\be-extras`）— **未 merge**
> 范围：`backend/app/api/silly_tavern.py`（新增 4 条路由）+ `backend/tests/test_st_extras_proxy.py`（新增 17 例）
> 性质：**只加不改**——未改动任何现有端点语义，未动前端
> 上位依据：`st-plugins/ADAPTATION.md` §一.3「后端 ST Extras 端点（2026-09-05 实弹复核修正）」

---

## 0. 一句话结论

ADAPTATION.md 记载为 404 的 `/api/summarize` 与 translate 端点，根因是
**`silly_tavern.py` 里只有 pydantic 模型、从未注册过路由**（孤立模型）。
本次补齐 4 条转发路由，实现与同批 P1-9 classify / P1-12 caption / P1-13 elevenlabs
**完全同构**（同目录、同中间件、同转发器、同错误形状），新增 17 例单测全绿。

---

## 1. ⚠️ 任务书的两处前提，与代码实测不符（已与用户确认后调整）

动工前复核发现任务书的两个前提不成立，已在开工前与用户逐条确认并改道。

### 1.1 「对齐已有 `/api/openai/generate-image` 同构做法」——该端点不存在

`/api/openai/generate-image` **从未注册过路由**，它在 ADAPTATION.md 里自己就被标成 ❌ 404。
代码里能找到的只有两个**孤立模型**（定义了但没有任何路由消费）：

| 模型 | 位置 | 状态 |
|---|---|---|
| `STSummarizeRequest` | `silly_tavern.py:5114` | 孤立（本次补上路由消费它对应的端点） |
| `STGenerateImageRequest` | `silly_tavern.py:5147` | 仍孤立（不在本次范围） |

取数（改前，在 `be-extras` 起点 commit `9b24724` 上）：
```bash
grep -rn "generate-image" backend/ --include=*.py        # 0 命中
grep -rn "api/summarize" backend/app --include=*.py      # 仅 1 命中：模型 docstring
```

**改道（用户确认）**：以**真实存在**的同类转发代理为基准 —— 同文件内的
`_forward_extensions_to_st_native`（P1-9 classify / P1-12 caption / P1-13 elevenlabs 共用）。

### 1.2 「补 `/api/extra/translate`」——插件实际调用的不是这个路径

`st-plugins/translate/index.js` 的 8 个 provider 函数全部打 `/api/translate/{provider}`
（`onering`/`libre`/`google`/`lingva`/`deepl`/`deeplx`/`bing`/`yandex`），
全仓搜 `extra/translate` **0 命中**。

**改道（用户确认）**：两条都加 —— 任务书指定的 `/api/extra/translate` 照补，
同时补插件真正会命中的 `/api/translate` 与 `/api/translate/{provider}`。
否则"补完"之后插件依旧 404，等于没修。

---

## 2. 改了什么

### 2.1 新增路由（`backend/app/api/silly_tavern.py`，插在 `STGenerateImageRequest` 之后）

| 路由 | 上游路径 | 消费方 |
|---|---|---|
| `POST /api/summarize` | `api/summarize` | memory 插件 `callExtrasSummarizeAPI`、vectors 插件 `summarizeExtra` |
| `POST /api/extra/translate` | `api/extra/translate` | 任务书指定（Extras 族路径） |
| `POST /api/translate` | `api/translate` | 无 provider 子路径的兜底 |
| `POST /api/translate/{provider}` | `api/translate/{provider}` | translate 插件（实际调用形状） |

同构性逐项落地：

- **同目录**：`backend/app/api/silly_tavern.py`，同一个 `router`（自动继承 `csrf_guard`）
- **同中间件**：`Depends(get_st_current_user)`（与 elevenlabs 三端点一致）
- **同转发器**：`_forward_extensions_to_st_native(request, user, path)`，请求体原样透传
- **同错误形状**：sidecar 未配置 / 不可达 → `502 {"error": "ST native service unavailable", "detail": ...}`

### 2.2 provider 白名单（安全）

`provider` 参与拼接上游 URL，故限定为 ST 1.18.0 translate 扩展的 8 个字面值
（`_ST_TRANSLATE_PROVIDERS`），白名单外返回 **400** 且**不发出任何出站请求**。

这不是装饰性校验 —— **反证实测**：摘掉白名单后，`%2e%2e` 与 `google/../admin`
两个用例立刻变红，说明它们确实会穿透到转发环节。

---

## 3. 验证

### 3.1 新增单测（`backend/tests/test_st_extras_proxy.py`，17 例全绿）

```
17 passed in 6.57s
```

覆盖：4 条路由注册、4 条路径的转发目标一一对应、响应体透传、
provider 白名单（含路径穿越）、8 个 provider 全部可达、
502 两种分支（未配置 / 上游不可达）、未认证不得进入转发。

### 3.2 反证（negative control，两项均实测）

| 故意破坏 | 结果 |
|---|---|
| 把 summarize 上游路径改成 `api/summarize-BROKEN` | 1 红（转发目标断言） |
| 摘掉 provider 白名单校验 | 3 红（未知 provider + 2 个穿越用例） |

破坏后均已还原，复跑 17 passed。

### 3.3 全量门禁

```
cd backend && py -3 -m pytest tests/ -q
```

实测（均带 `--basetemp` 绕开下述清理坑）：

| | 汇总行 | failed | errors |
|---|---|---|---|
| 基线（主工作区 `three-tracks-merge-20261012`，未改动） | `2043 passed, 23 skipped` | **0** | **0** |
| `be-extras`（含本次改动） | `2060 passed, 23 skipped` | **0** | **0** |
| 差值 | **+17 passed**（= 本次新增用例数） | — | — |

passed 差值恰好等于新增用例数、skipped 不变 ⇒ 纯增量，无回归。

> ⚠️ **首轮踩坑记录**：第一次不带 `--basetemp` 跑基线时，进度条里出现过
> `EEE` / `ssE` 字样，看似有 error；改用独立 basetemp 复跑后 `errors = 0`。
> 即那些 `E` 是**临时目录清理被守卫打断导致的假性 error**，不是真实缺陷。
> 判定门禁时**必须以带 basetemp 的汇总行为准**。

> ⚠️ **跑全量门禁的坑（本次实测，供后续复用）**：直接跑 `pytest tests/ -q`
> **拿不到汇总行**，进程在收尾清理 pytest 临时目录时被**安全删除守卫**拦下
> （`SAFE_DELETE_BULK_CONFIRM_REQUIRED {"count":60,"threshold":50}`），
> 表现为"进度条跑到 100% 后无 `passed/failed` 行、退出码 1"。
> **解法**：显式指定仓库外的独立 basetemp，让清理逻辑不触发——
> `py -3 -m pytest tests/ -q --basetemp=/tmp/pb_$RANDOM`
> （⚠️ basetemp 仍**不可**指进仓库内，沿用 AGENTS.md 既有纪律）。

### 3.4 未做（按任务书，属主控统一安排）

- backend 镜像重建
- 真机端到端探针

---

## 4. ⚠️ 交付后必须让主控知道的一条限制

转发目标是 **ST sidecar**（`ST_NATIVE_SERVICE_URL`，默认 `http://sillytavern:8000`）。
而 `silly_tavern.py:6236` 的注释写明：**sidecar 容器已随 st-native 双轨删除（2026-09-03）**。

⇒ **在本机默认部署下这 4 条新端点会返回 502**（与同族的 elevenlabs 三端点行为一致），
属"路由已补齐、上游不存在"，不是新引入的缺陷。
真机验证时若要看到 200，**必须先把 `ST_NATIVE_SERVICE_URL` 指向一个真实可用的 ST 服务**。

这一点在真机验收前请务必确认，否则容易误判为"补齐失败"。

---

## 5. 产出文件

| 文件 | 变更 |
|---|---|
| `backend/app/api/silly_tavern.py` | 新增 4 条路由 + `_ST_TRANSLATE_PROVIDERS`（纯新增） |
| `backend/tests/test_st_extras_proxy.py` | 新增，17 例 |
| 本文件 | 新增 |

**未 merge**，保留在 `be-extras` 分支 / worktree `D:\项目\_palink-wt\be-extras`（工作区干净）：

| commit | 内容 |
|---|---|
| `69a472b` | 4 条路由 + 17 例测试 + 本报告 |
| `c36fc37` | 刷新 `_CATALOG.md` |

> ⚠️ **目录脚本的一个顺序坑**：`gen_docs_catalog.py` 的输出含 `tracked=` 计数（来自 `git ls-files`）。
> 新报告**提交入库后**该计数 323 → 324，目录随即"过期"，`--check` 会失败。
> ⇒ 正确顺序是**先提交新文档、再重新生成目录**；只在本分支内生成不提交、或先生成后提交，都会留下一个过期的目录。
> 当前 `py scripts/docs/gen_docs_catalog.py --check` → `OK 324 docs, catalog up to date`（rc=0）。
