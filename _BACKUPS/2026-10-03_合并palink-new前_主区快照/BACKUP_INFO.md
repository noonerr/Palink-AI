# BACKUP_INFO — 合并 palink-new 前的主区快照

## ① 备份日期

2026-10-03（合并 `D:/项目/palink-new` 代码回主区**之前**的基线快照）

## ② 原始来源路径

| 内容 | 来源 |
|---|---|
| 主区源码与 git 历史 | `D:/项目/Palink-AI`（分支 `st-plugin-compat-20260727`，HEAD `79969a7`） |
| palink-new git 历史 | `D:/项目/palink-new`（6 笔提交，基线 `3cbe8d4` → `52639d5`） |
| 主区数据库 | 容器 `palink-ai-db-1`，库 `ai_hub`，用户 `ai_user` |

## ③ 备份原因

用户裁定：**以新代码为主**，把 palink-new 的修复成果合并回主工作区 `Palink-AI`，
palink-new 降级为回退保险。合并属不可逆覆盖，故先做基线快照。

## ④ 后续待办清单

- [ ] **本备份不主动清理**，直到用户在真机验收新合并代码后确认无回退需求
- [ ] 若合并后出现问题，恢复方式见下「恢复演练」

## 快照内容清单

| 文件 | 大小 | 说明 |
|---|---|---|
| `main-repo.bundle` | 131M | 主区全量 git 历史（`--all`，含所有分支与tag） |
| `palink-new-repo.bundle` | 16M | 新区全量 git 历史（6 笔修复提交都在里面） |
| `worktree-uncommitted.patch` | 80K | 主区 17 个已修改文件的完整 diff |
| `untracked-list.txt` | 63 行 | 主区 63 个未跟踪路径清单 |
| `goal-groupchat/` | 4 文件 | 主区独有：群聊设计文档（含 59 行未提交改动，**新区没有**） |
| `main-db-dump.sql` | 32M / 49 表 | 主区数据库全量 dump（`--clean --if-exists`） |
| `new-only-untracked/frontend/` | 10 文件 | 新区独有未跟踪文件（`Dockerfile`×4 / `nginx.conf` / `security-headers.conf` / 4 个构建配置） |
| `new-only-untracked/docker-compose.test.yml` | 6K | 新区独有测试编排 |

## 快照时的主区状态（物证）

```
git HEAD        79969a7  chore(backup): 补 4 份漏登记备份的说明书 + 台账登记
已修改文件      17 个（含 backend/app/api/character_ext.py、websocket.py、
                frontend/src/hooks/useCharacterChat.ts、CharacterChat.tsx 等）
未跟踪路径      63 个
alembic 版本    0065_drop_dialogue_mode_column   ← 与新区的 0067 不同步
```

## 恢复演练

### 回退代码到合并前
```bash
cd D:/项目/Palink-AI
git bundle verify _BACKUPS/2026-10-03_合并palink-new前_主区快照/main-repo.bundle
git reset --hard 79969a7
git apply _BACKUPS/2026-10-03_合并palink-new前_主区快照/worktree-uncommitted.patch
```

### 回退数据库
```bash
docker exec -i palink-ai-db-1 psql -U ai_user -d ai_hub < \
  _BACKUPS/2026-10-03_合并palink-new前_主区快照/main-db-dump.sql
```
⚠️ 该 dump 带 `--clean --if-exists`，**会先删表再建表**，执行前确认容器已停。

### 取回 palink-new 独有文件
直接从 `new-only-untracked/` 拷回原位，或从 `palink-new-repo.bundle` 恢复该仓库历史。