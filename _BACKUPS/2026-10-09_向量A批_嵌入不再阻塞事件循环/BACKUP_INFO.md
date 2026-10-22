# BACKUP_INFO — 向量 A 批：嵌入不再阻塞事件循环

## ① 备份日期
2026-10-09（动工前）

## ② 原始来源路径
- `backend/app/api/character_ext.py`（286495 字节，git HEAD `77f1a35` 同版，动工前工作区干净）
- `backend/app/memory_module/embedder.py`（12243 字节，动工前工作区干净）
- `backend/tests/test_memory_vector_search.py`（15619 字节，作为回归基线留存）

回滚方式：`cp _BACKUPS/2026-10-09_向量A批_嵌入不再阻塞事件循环/pre/<文件> backend/app/...`（按文件整体拷回，勿只回退 hunk）。
git 侧回滚点：tag `pre-vectorperf-A-20261009` → HEAD `77f1a35`。

## ③ 备份原因
只读实测定位到向量引擎的 CPU 成本结构，用户授权做「A 批：不改变模型、不改变检索效果的三项提速」。
其中两处落在**并行 agent 正在编辑的文件**里（`roleplay_prompt_assembly.py` / `retriever.py` / `service.py` / `storage.py`
当日工作区各有 +99~+183 行未提交改动），**本批刻意只动当前干净的 `character_ext.py` 与 `embedder.py`**，避免同文件撞车。

实测依据（本机 Docker 栈，全部只读跑出来的数）：
- 单次嵌入 **1 个字 = 163 ms / 21 字 = 194 ms / 240 字 = 348 ms / 960 字 = 993 ms**
  ⇒ 成本 ≈ 固定约 160 ms + 约 1.4 ms/token；**挂钩模型规模，与输出维度无关**
- 容器内 HTTP 往返 0.9 ms、不存在的模型报错 0.8 ms ⇒ 那 160 ms 不是网络/调度，是模型自己
- 跑批时 ollama 容器 **CPU 457%–608%**（配额 `PALINK_OLLAMA_CPUS=6.4`）持续约 1 秒 = 用户看到的「CPU 100%」
- 8 条塞 1 个请求 = 315 ms vs 分 8 次 = 1369 ms ⇒ **批量省 4.3 倍**
- `character_ext.py:4724` 是 `async def event_generator()`，其 `:5151` 起的记忆写入块**同步调用**
  `MemoryService.store_memory` → `storage.store_chunks` → `embed_text()` → 同步 `httpx.Client.post`
  ⇒ **停整个 worker 的事件循环约 1 秒**，同 worker 上其他用户的流一起卡（多用户产品的真实风险）

## ④ 后续待办清单
1. **本批刻意未做（撞车风险，待并行会话收口后再排）**：
   - A3「用户那句与 AI 那几块合成一次嵌入请求」——需要改 `memory_module/service.py`、`storage.py`，两者当日在他人手上。
   - 世界书检索查询仍是「最近 4 条拼接」（实测约 600 字 ≈ 600 ms/轮），而记忆查询已被并行会话改成「本轮用户消息」。
     两侧查询文本从此不同源 ⇒ **不能简单共用一次嵌入**，要不要统一是**检索质量决策**，属并行会话地盘。
2. **必须重建后端镜像才生效**（后端非 bind mount）：`docker compose build backend && up -d backend`。
   ⚠️ 已核实容器内**本就已经带着**并行会话 `roleplay_prompt_assembly.py` 的当日改动（容器内文件时间 10-09 21:22、
   标记命中数与工作区一致），故重建不是「首次把别人半成品推上线」；但重建前应再看一次工作区是否有半保存状态。
3. **换更小嵌入模型的 A/B 尚未做**（用户问的第 2 问）：判据是「160 ms 固定开销里有多少是模型规模」。
   需要约 100 MB 下载（`bge-base-zh` / `bge-small-zh` 级别）+ 同批查询各跑几十次对比。
   ⚠️ 若真要换：连带 `_PROVIDER_EXPECTED_DIMS`（写死 ollama=1024）、`MEMORY_VECTOR_DIMENSION`、
   两张表的列重建、**全库重嵌**（实测 764 条记忆 + 1056 条世界书向量）、**阈值重测**（MIN_SIMILARITY 0.5 / 世界书 0.55÷3）。
4. **GPU / 核显探测**（用户追加要求）：已实测 `docker run --gpus all` 下容器内**无 `/dev/nvidia*`、无 `/usr/lib/wsl/lib`**，
   但 `libcuda.so.1` 有注入、Docker `Runtimes: nvidia` 已注册；ollama 0.32.14 日志里 `OLLAMA_VULKAN:true` 已默认开、
   `inference compute` 只报 `id=cpu`。⚠️ 宿主是**独显直连**（780M 不接面板），且即便打通 4070 也**救不了 NAS 用户**。
5. 遗留观察：`OLLAMA_NUM_PARALLEL=1`（默认）⇒ 所有嵌入**串行排队**；并行会话报告 600 字查询 1652 ms、
   本批同量级实测约 600 ms，差 2.5 倍最可能就是排队所致。

---

## ⑤ 完工记录（2026-10-09 22:15–23:00）

**已上线**：`docker compose build backend && up -d backend`，容器内标记核对
`PERF-EMB-NONBLOCK` 命中 3 处 / `EMB-DEDUP` 3 处 / `_write_turn_memory` 4 处 / `_write_action_memory` 2 处；
`docker ps` backend `Up (healthy)`，启动日志无 error/traceback。

**实测效果（容器内跑真函数，零 token 花费）**：
| 项 | 改前 | 改后 |
|---|---|---|
| 长文本嵌入期间，同一条流上其他协程的心跳次数 | **0 次**（1367ms 完全冻结） | **49/49 次**（988ms 全程正常） |
| 同一句话嵌第二次 | 又发一次 HTTP（~190ms） | **0.0 ms，不发请求**（ollama 侧日志核对：3 次真实嵌入对应 3 条 `/api/embed`） |

**测试门禁**：全量 **1999 passed / 51 skipped / 0 failed**（201.74s，文件稳定后复跑）。
新增 `backend/tests/test_memory_embed_perf_batch.py` 13 例。
⚠️ 单独跑 `tests/test_st_vectors_full.py` 会 7 failed —— **与本批无关的既有红**：
把 `embedder.py` 换回备份原件后同样 7 failed（已做 A/B 归因），根因是并行会话在途的
SQLite 建表缺 `character_id`；全量跑时该文件是绿的（用例顺序使表结构就位）。

**GPU 终判（探测容器 `embgpu` 已 `docker rm -f` 删除，系统内无残留）**：

> ⚠️ **订正说明（同日 23:2x，用户告知原因后复测）**：本节第一次写下的"GPU 是负收益"**作废**。
> 第一次探测时**用户正在玩游戏**，显存被吃掉大半 → 容器内只报 `available=1.0 GiB` → 模型只搬进 6% 的层。
> 那是**污染输入得出的结论**，不是 WSL2 的显存预算限制。复测数据如下。

`--gpus all` 下 CUDA **能发现** 4070（`library=CUDA compute=8.9 driver=13.1`）。显存空闲 5619 MiB 时同场 A/B：

| 用例（bge-m3） | 走显卡 | 走 CPU（现状） | 倍数 |
|---|---|---|---|
| 21 字查询 | 190.8 ms | 199.4 ms | 1.05×（**无收益**） |
| 240 字 | 176.9 ms | 395.4 ms | 2.24× |
| 960 字 | 264.7 ms | 1164.4 ms | 4.40× |
| 4×240 字批量（≈一轮写库量） | 270.4 ms | 1273.8 ms | **4.71×** |

`ollama ps` = **`100% GPU`，SIZE 仅 664 MB**（CPU 模式吃 1.2 GB 内存）。连续 11 秒猛打同一批负载：
**GPU 完成 39 批 / 容器 CPU 246–268%；CPU 仅完成 10 批 / 容器 CPU 589–598%**（配额 6.4 核已打满）
⇒ GPU ≈ **3.9× 吞吐 + 省 2.4× CPU**，但**做不到"CPU 归零"**（分词/HTTP/调度仍在 CPU 上，空转才回落到 0.10%）。
冷加载 **18 秒**；⚠️ **显存被挤抢时不会回落 CPU，而是变成"比 CPU 更慢"**（第一次实测到的正是这一幕）。
**由此推翻本件早前的推断**：GPU 上 21 字查询仍 ~190 ms、与 CPU 同价 ⇒ 那 160–190 ms 固定开销
**不是"把权重读一遍"，而是 ollama 每请求的管线成本** ⇒ **换小模型救不了"查询"这一路**，只能靠少发请求（去重/合并/缓存）。

核显路线（AMD 780M）**仍不通**：容器内无 `/dev/dri`、无任何设备通道（`OLLAMA_VULKAN:true` 却找不到设备）。
这条与游戏无关，是 Docker Desktop 的拓扑限制。Windows 侧 780M 与 4070 两块均在列（独显直连下 780M 仍 OK）。

## ⑥ ⚠️ 施工期间发生的事故与连带改动（必须让人知道）

1. **Docker 引擎非正常停止**：本批实测做完后、重建镜像前，`docker-desktop` WSL 发行版变为 Stopped，
   6 个容器全停约 15 分钟（Palink 对外不可达）。**不是**本批任何写操作导致：最后几次 `docker exec` 正常返回，
   失联发生在其后约 10 分钟；本会话在容器内只做过只读查询与两次 `--rm` GPU 探测（探测早已正常返回）。
   根因未定（怀疑 WSL2 VM 资源耗尽，或外部/并行会话操作）。
2. **恢复动作**：启动 Docker Desktop（约 30 秒引擎就绪）→ 容器由 `restart: always` 自动全部回来，
   `docker ps` 六容器 healthy，DB 卷未动、无数据丢失迹象。
3. **⚠️ 前端宿主端口 14000 → 14700**（`docker-compose.yml` 已改并写了注释）：引擎重启后 WinNAT 重新划段，
   14000 落进本次保留区间 **13940–14039**，`docker` 绑定报 `bind: ... forbidden by its access permissions`，
   容器卡在 `Created`、隧道无处路由、站点整体不可达。**这是本项目第三次踩同一个坑**
   （09-30 的 3000、10-04 的 13000，compose 注释里有前两次记录）。
   复核：`docker ps` 现为 `0.0.0.0:14700->8080`，本地 `curl http://127.0.0.1:14700/` = **200**。
   恢复原样：把那一行换回 `- "14000:8080"` 并 `docker compose up -d --force-recreate frontend`。
   连带：`backend/scripts/_accept_mvu_realrun.py:15` 硬编码 `BASE=http://localhost:14000`，换端口期间需同步改。
4. **⚠️ 公网入口当前不可达，且未修复**：`palink-tunnel` 是 **cloudflared 快速隧道**
   （`tunnel --no-autoupdate --url http://frontend:8080`，无挂载配置、无 token、无 env），
   本次重启后**只完成 precheck、始终没有再发出新的 trycloudflare 地址**；昨天那个
   `yarn-accepted-graphic-explains.trycloudflare.com` 实测已死（000）。
   ⇒ 站点本机可用、公网不可用。**要稳定公网地址必须换成 Cloudflare 命名隧道**（需他的 Cloudflare 账号操作），
   本批未擅自改隧道拓扑。
