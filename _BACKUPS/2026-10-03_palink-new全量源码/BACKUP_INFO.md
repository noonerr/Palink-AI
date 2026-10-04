# BACKUP_INFO — 2026-10-03 palink-new 全量源码备份

## ① 备份日期

2026-10-03

## ② 原始来源路径

`D:\项目\Palink-AI`，基线 HEAD = `79969a7ae9e83a95f246a83d819ac346cb3a3f11`（短 `79969a7`）。

| 备份物 | 内容 | 体积 |
|---|---|---|
| `source.tar` | backend/app + alembic + tests + frontend/src + public + 前端构建配置 + docker-compose×2 + .env.example + .gitignore + AGENTS.md + TODOS.md + st-plugins + specs + mcp + scripts | 81 MB / 2074 文件 |
| `repo.bundle` | git 全历史（`--all`），`git bundle verify` = **The bundle records a complete history** | 131 MB |
| `docs.tar` | docs/ 全量 | 3.7 MB |
| `specs.tar` | specs/ 全量 | 2.8 MB |

**排除的可再生物**（不占备份体积，出问题可重新生成）：
`node_modules`(465M) · `frontend/dist`(14M) · `backend/data`(429M) · `.mimosa`(1.5G) ·
`__pycache__` · `.pytest_cache` · `.venv` · `*.pyc` · 根级 `屏幕录制*.mp4`

⚠️ **本备份拷贝的是含 14 个未提交改动的磁盘真实状态**（报错提示模板批在途），非 HEAD 状态。
回捞时优先用 `source.tar`，勿用 `git checkout`。

## ③ 备份原因

用户决定在 **`D:\项目\palink-new`**（同级新目录）做架构升级，**原 Palink-AI 完全不动**作为保险。
本备份是升级前的最后一道防线，需求原文：「这次我要求是全量备份，因为这是一个非常大的架构调整」。

升级内容（依据 `docs/SPEC_架构审查修复_2026-10-03.md`）：
- 对齐 ST 1.18 的世界书机制（`character_book` + `charLore.extraBooks` + `globalSelect` 三源）
- 对齐 ST 的思考预算算法（`calculateClaudeBudgetTokens`：min=1024 / low=10% / medium=25% / high=50% / max=95%，下限 1024，非流式上限 21333）
- 修跨卡提示词串味（世界书 / 扩展提示词 / 前端提示词池三处）
- 修输入框卡顿（输入状态下移 + memo）
- 零风险批 7 项（沙箱路径解析、except 日志、宏接线、文档清理等）

## ④ 后续待办清单

### 升级执行期
- [ ] 建 `D:\项目\palink-new`（从本备份 `source.tar` 解出）
- [ ] palink-new 内重建 `node_modules`（`npm ci`，用 package-lock.json）
- [ ] palink-new 内重建 `backend/data`（**从原项目拷贝，不从 tar** —— tar 已排除）
- [ ] palink-new 内重建 `frontend/dist`（走 VITE_OUT_DIR 流程）
- [ ] palink-new 的 `.env` 从原项目拷（**不入库，含密钥**）

### 升级后验收
- [ ] `cd backend && python -m pytest tests/` → failed=0（基线 1696 passed / 51 skipped）
- [ ] `cd frontend && npx tsc --noEmit` → 0 error
- [ ] `cd frontend && npx vitest run` → failed=0（基线 46 文件 / 635 passed）
- [ ] 三处串味各造一次双卡会话验证
- [ ] 思考长度对比改前改后（后端日志 grep `STREAM-CALL`）

### 长期
- [ ] 升级确认无误后，决定是否切换生产部署、是否归档原 Palink-AI
- [ ] 依 AGENTS.md 规范第 3 条，本 `BACKUP_INFO.md` 必须入库

## 恢复方式

```bash
# 全量源码
tar -xf _BACKUPS/2026-10-03_palink-new全量源码/source.tar -C <目标目录>
# git 历史
git clone _BACKUPS/2026-10-03_palink-new全量源码/repo.bundle <目标目录>
```

## 状态

- 备份完成度：4/4 备份物已生成并验证
- ⚠️ 依 AGENTS.md 规范第 4 条，**本目录内容不得删除或改写**。需要历史文件时复制出来用。
