# BACKUP_INFO — 2026-10-05 仅推送自己的改动（热补丁）

## ① 备份日期

2026-10-05（当日 04:3x，GMT+8）

## ② 原始来源路径

| 备份内相对路径 | 来源 |
|---|---|
| `container_character_message_builder.py` | **容器内** `palink-ai-backend-1:/app/app/services/character_message_builder.py`（热补丁**前**的原样副本，回滚用） |
| `patched_character_message_builder.py` | 上述容器基线 + 我的两处改动（实际推上去的那份） |

## ③ 为什么用热补丁而不是 `docker compose build`

用户要求「**先把他的给扔到一边，先推送自己的**」。

当时另一 agent 仍在改后端（`memory_module/*`、`sessions.py`、`users.py`、`config.py`、
`mvu_engine.py`、`roleplay_prompt_assembly.py` 等 20+ 文件未提交）。
`docker compose build backend` 会用**整个工作区**当构建上下文 ⇒ 必然把对方改到一半的
代码一起打进去。而本仓禁止 `git stash -u`（会损坏 .git，见用户长期记忆），
所以无法「暂存他的再构建」。

改用**精确热补丁**：以**容器当前文件**为基线（= 已在线上跑着的 03:46 那版，
不含对方的最新在制品），只叠加我的两处改动，`docker cp` 进容器并重启。

- 相对「正在运行的版本」，**唯一的变化就是我的守卫**，对方的在制品一行都没上。
- `docker restart` 保留容器可写层 ⇒ 热补丁**能扛住重启**；
  但 `docker compose up -d --force-recreate` 或重新 build 会覆盖回镜像版本。

## ④ 推上去的两处改动

1. 新增 `app/services/mvu_stat_normalize.py`（原样 copy，无基线版本）。
2. `app/services/character_message_builder.py`：
   - import 行加 `extract_schema_defaults`；
   - `cur_meta["variables"] = new_vars` **之前**插入 `[MVU-SHAPE-GUARD 2026-10-05]` 块
     （每轮补丁应用后按 schema 形状归一化）。

## ⑤ 回滚方法

```bash
docker cp "_BACKUPS/2026-10-05_仅自己的热补丁/container_character_message_builder.py" \
  palink-ai-backend-1:/app/app/services/character_message_builder.py
docker exec palink-ai-backend-1 rm -f /app/app/services/mvu_stat_normalize.py
docker restart palink-ai-backend-1
```

## ⑥ 验证记录

| 检查 | 结果 |
|---|---|
| 容器内语法（`ast.parse`） | 两个文件均 OK |
| 容器内运行时导入 | `normalize_variables` / `ARCHIVE_KEY` 导入 OK；`character_message_builder` 导入 OK |
| 容器内**功能**烟测 | 喂漂移样本 → `状态` 从字符串修回对象、`爱意=7/魔力值=56` 复位、原文本进 `_漂移前文本` → **PASS** |
| 容器状态 | Up (healthy) |
| 重启后日志 | 无 traceback / error / exception |
| 站点 | 前端 200（本轮未改前端，未重建 dist） |

## ⑦ 待办 / 知悉

1. ⚠️ **这是一次热补丁，容器状态与镜像不一致**。等另一 agent 收工后，
   应做一次正常的 `docker compose build backend && up -d backend` 让镜像追上
   （`b85a236` 已把我的改动提交，正常重建即会包含）。
2. **未做真机复现**：没有在真实生成里再触发一次漂移来确认守卫在线上真的拦住。
   容器内功能烟测只证明函数能跑，不等于端到端链路已验。
3. 本轮**没有改前端**，故未重建 dist。
