# BACKUP_INFO.md

## 1. 备份日期

2026-10-10（凌晨，审计 → 方案 → 落地同一批）

## 2. 原始来源路径

`pre/` 下按原相对路径留存 8 份动工前快照，`_manifest.tsv` 记录 sha256：

| 原路径 | 大小 | 本批谁会动它 |
|---|---|---|
| `AGENTS.md` | 必读文档 | 主 agent（本批核心交付：新增 §验证纪律 8 条） |
| `CODE_WIKI.md` | 项目百科 | 并行 agent D（加失效横幅） |
| `frontend/vite.config.ts` | 构建配置 | 并行 agent C（`drop_console` 修复） |
| `frontend/package.json` | 依赖清单 | 并行 agent D（卸 `mermaid`） |
| `backend/app/api/silly_tavern.py` | 6248 行 | 预留（鉴权缺口，本批可能动） |
| `backend/tests/test_p1_fixes.py` | — | 并行 agent A（拆 9 处文件存在性 skip） |
| `backend/tests/test_p2_fixes.py` | — | 并行 agent A（拆 36 处文件存在性 skip） |
| `backend/tests/test_worldbook_st_semantics.py` | — | 并行 agent B（拆 28 个假理由 skip 空壳） |

## 3. 备份原因

2026-10-10 全仓悲观审计（`REPORT_悲观审计_项目可信度体检_2026-10-10.md`）发现
**项目没有能力证明自己是对的**（无 CI / 无覆盖率门槛 / 唯一的"门禁"日志带 84 errors 被当通过存档）。
本批做三件事，动工前必须留可回退快照：

1. **把验证纪律钉进必读文档**（`AGENTS.md` §验证纪律 8 条）—— 让后续所有 agent 无法绕过门禁。
2. **交付门禁工具** —— `.github/workflows/ci.yml`（三 job）+ `scripts/gate.sh`（本地一把梭，退出码即结论）。
3. **并行 agent 修复审计发现的其他缺陷** —— 测试诚实化、可观测性、文档与依赖卫生。

⚠️ **备份时工作区已有他人约 200 项未提交改动**（含 `CharacterChat.tsx`、`Message.tsx` 等并行会话在途编辑）。
**回退必须按文件整体拷回**（`cp -r <本目录>/pre/<相对路径> <仓库根>/<相对路径>`），
**不要只回退本批 hunk** —— 否则会把他人的在途改动一起抹掉。

## 4. 后续待办清单

### 4.1 本批已交付（无需再动）

| 项 | 状态 |
|---|---|
| `AGENTS.md` §验证纪律 8 条 | 已写入 |
| `.github/workflows/ci.yml`（后端 pytest / 前端 tsc+vitest / docs catalog） | 已交付，**从未在真实 runner 跑过** |
| `scripts/gate.sh`（本地门禁，退出码即结论） | 已交付并实测（docs 档红→绿均正确） |
| `backend/requirements-test.txt`（剥离 llama-cpp-python / faster-whisper） | 已交付（另一 agent，静态依据写在文件头） |
| `_CATALOG.md` 刷新（253 docs，`--check` 退出码 0） | 已交付 |
| `backend/.pytest_tmp` 残留隔离（156 条目 / 677K → 本区 `pre/` 之外的隔离目录） | **已隔离，未删除**，第 3 步待用户确认 |
| `.gitignore` 加 `backend/.pytest_tmp/` | 已交付，`git check-ignore` 命中 `.gitignore:228` |

### 4.2 未开工（按 ROI 排序，需另立批次）

| # | 项 | 风险 |
|---|---|---|
| 1 | **拆 38 个文件的「import 失败 → 整文件 skipif」模板**（改硬失败）。本批**故意没做** —— 它一旦改会让所有真实导入错误一次性暴露，需要单独批次 + 全量跑验证 | **高**，会让 CI 集体红 |
| 2 | **迁移体系收敛**：73 个迁移文件 / **7 个 head** / 生产 `RUN_MIGRATIONS_ON_STARTUP=false` / 实际靠 `create_all` + `migrations.py:41-140` 约 70 条手写补列 + `storage.py` 运行时 ALTER **三套并存**。二选一：修 head 并启用迁移，或弃用 alembic 把三套收敛成一份幂等初始化 | **高**，动 schema |
| 3 | **`silly_tavern.py:992-994` 鉴权缺口**：注释明写「匿名请求按 id 全局解析，不做 user 过滤」，配合 `:1865`/`:1883` 两个无鉴权头像路由 ⇒ 未登录者可拉他人角色头像。已备份原文件，本批未改 | **中**，改鉴权需真机回归 |
| 4 | **拆 `SillyTavernCompatRuntime.ts` 的 6694 行模板字符串**（6961 行里只有 256 行受 tsc 覆盖）→ 独立 `.ts` + Vite 多入口打包进 iframe | **高**，深度重构 |
| 5 | **三真源收敛**：stat_data 三处（`chat_metadata.variables` / `ChatVariable` 表 / 消息级 `extra.variables.stat_data`）、记忆镜像表派生副本、三套模型注册表 `find_model` 两个实现 | **高** |
| 6 | **96 处异常被吞后返回合法默认值**，优先 5 处关键路径：`websocket.py:649/1143`、`character_ext.py:871/1445`、`roleplay_prompt_assembly.py:1749` | 中 |
| 7 | **卫生**：`frontend/` 下 8 个废弃构建目录（`dist_fix_bubble{,2,3}`、`dist_new{,_b15,_gcm1,_narrow2,_wave1}`）；`frontend/dist` 内 24 份孤儿 `index-*.js`（45MB 中约 33MB 垃圾）；修 `scripts/clean-dist.cjs:15-19`（`VITE_OUT_DIR` 非 dist 时**应清理该目录**而非跳过，导致每次安全构建往 dist 堆一代）；根目录 `_tmp_a.txt`/`_tmp_b.txt`/`_tmp_list_b.txt`/`_stage_only_mine.patch`/`_tmp_st_probe/` | 低，**但绝不碰 `frontend/dist` 本身**（nginx bind mount，删即白屏） |
| 8 | **`SILLYTAVERN_NATIVE_LAYER_PLAN.md` 的 7 处活引用**（该文件已标「不要按本文领任务」，仍被 `specs/dual-frontend-st-compat-strategy/spec.md` 6 处 + `tasks.md:32` 引用）。先改引用再搬 | 低 |

### 4.3 已知但**未证实**的两条（不要当事实引用）

- **「`--basetemp` 落在仓库外就安全」未成立**：本批有一次全量用 `D:/tmp/pt_full`（仓库外）仍得 84 errors；
  运维手册 §3 亦有 `D:\tmp\pt_diag` 被拦的实测。但那次未存完整日志，**属形态一致但未完整证实**。
- **「并发改源码 → 炸一片 setup error」是待验证假设**，且与「基线是确定的」互斥。
  验证方法：固定源码跑基线，再故意在跑测试时改一个无关文件，对比是 collection error 还是 setup error。

## 5. 回滚方法

```bash
BK="_BACKUPS/2026-10-10_验证体系与缺陷修复"
cd "D:/项目/Palink-AI"
# 整体拷回（不要只回退 hunk，工作区有他人 200 项在途改动）
cp "$BK/pre/AGENTS.md" AGENTS.md
cp "$BK/pre/CODE_WIKI.md" CODE_WIKI.md
cp "$BK/pre/frontend/vite.config.ts" frontend/vite.config.ts
cp "$BK/pre/frontend/package.json" frontend/package.json
cp "$BK/pre/backend/app/api/silly_tavern.py" backend/app/api/silly_tavern.py
cp "$BK/pre/backend/tests/"*.py backend/tests/
# 校验
cd "$BK/pre" && find . -type f -exec sha256sum {} \; > /tmp/now.tsv && diff <(sort ../_manifest.tsv) <(sort /tmp/now.tsv) && echo "一致"
```
