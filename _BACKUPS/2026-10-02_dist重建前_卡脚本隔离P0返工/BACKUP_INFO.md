# BACKUP_INFO — dist 重建前 · 卡脚本隔离 P0 返工

## ① 备份日期

2026-10-02（22:18 前后）

## ② 原始来源路径

原始：`D:\项目\Palink-AI\frontend\dist\`（容器 nginx bind mount 的**在用**前端产物）
备份到：`D:\项目\Palink-AI\_BACKUPS\2026-10-02_dist重建前_卡脚本隔离P0返工\dist\`

整目录全量拷贝（`cp -a`），**非只备份改动文件** —— 这份产物的用途是"线上坏了立刻退回去"，
部分备份退不回去。

拷贝后校验：

| 项 | 备份 | 原目录 |
|---|---|---|
| 文件数 | 280 | 280 |
| 体积 | 14M | 14M |
| 0 字节文件 | 0 | 0 |
| `index.html` 入口 chunk | `assets/index-Bx3kP9zq.js` | `assets/index-Bx3kP9zq.js` |
| P0 代码标记 | 有 `__palinkCardStorage` / `palink:card-storage:v1:` | 同左 |

> 为什么是 280 文件 / 14M，而**上一份** dist 备份（`2026-10-02_dist正式重建前`）是 1892 文件 / 111M：
> 后者是「多轮构建累积的旧 hashed 资源」；2026-10-02 12:26 那次 `npm run build` 跑过 `clean-dist.cjs`
> （**会先清空 `./dist`**），所以当前在用产物是那一次干净构建的结果：
> 195 个构建产物 + 85 个 `.gz` = 280。两处计数均已核对，非缺文件。

## ③ 备份原因

「卡脚本存储隔离 P0 未生效（立绘解锁仍跨卡）」返工批次要**替换**在用产物：

1. 返工改了 `frontend/src/lib/sillytavern/card-script-runner.ts`（改写覆盖面 + 回退粒度 + 唤痕）。
2. `frontend/dist` 被 `.gitignore` 排除（`git ls-files` = 0 条）→ **git 不是回滚路径**。
3. 按 AGENTS.md「清理三步 / 禁止直删」与备份规范，先落一个物理回滚点再动线上产物。

对应文档：`docs/提测_卡脚本存储隔离P0未生效_2026-10-02.md`（本次已按复核结果改写）、
`docs/SPEC_卡脚本本地存储按角色与账号隔离_2026-10-02.md`。

### 采用的上线方式（与 12:26 那次不同，刻意更稳）

**不跑 `npm run build`**（它第一步 `clean-dist.cjs` 会清空在用 `dist`，中间存在 dist 为空的窗口，
且会把历史 hashed 资源一起删掉）。改用：

```
cd frontend
VITE_OUT_DIR=dist_new_2 node scripts/build-vite.mjs   # 零风险：产物不在 ./dist
# 校验新产物标记后，原地覆盖（保留 dist 目录本身 → bind mount 不失效；旧 hashed 资源不删）
cp -r dist_new_2/. dist/
node scripts/gzip-dist.cjs                            # 只在 dist 内新增 .gz，不删任何文件
```

回滚命令：

```
rm -rf frontend/dist && cp -a "_BACKUPS/2026-10-02_dist重建前_卡脚本隔离P0返工/dist" frontend/dist
```

⚠️ **不要 `mv frontend/dist dist_prev`**：`dist` 是 nginx bind mount 目标路径，重命名后新产物会落到
`frontend/dist/dist/`（多一层），容器顶层仍读旧产物。

## ④ 后续待办清单

1. **删除两个暂存目录**（本环境批量删除受守卫拦截，需用户侧执行；两者都在 `.gitignore` 里，
   不影响 `git status`）：
   `frontend/dist_new/`（本次第一次试构建，缺最后一版唤痕改动，**不可用于上线**）、
   `frontend/dist_new_2/`（最终构建，已覆盖到 `dist`，可留作对照后删）。
2. **真机验收未做**（本机 docker daemon 未启动，`curl localhost:13000` 与浏览器探针都跑不了）。
   判据见 `docs/提测_卡脚本存储隔离P0未生效_2026-10-02.md §6`：
   `cardScripts > 0`、`cgTags > 0`、`cgScriptRewritten === true`、`chainedHostRemained === false`、
   `nsKeyCount ≥ 1`、`storagePatchMiss === 0`，以及「新导入同款卡 → 图鉴为空」。
3. **后端 pytest 基线待核实**：提测单写 1621 / SPEC 写 1612，两处冲突，本轮 docker 未起来，
   `pytest tests/` 没跑（宿主机跑会静默少 9 例，不许当基线）。实测后统一三处口径。
4. **`frontend/dist_new` 与 `dist_new_2` 都是产物目录，禁止当真源**；后续构建请继续用
   `VITE_OUT_DIR=` 零风险路径，不要为了省事跑 `npm run build`。
