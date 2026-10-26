# 查验报告：palink-ollama 日志通道失效根因——docker logs 冻结于 2026-10-11（撕裂日志记录挡死前向读取）

> 状态：已完工待审读（只读查验·2026-10-26）

## 背景

- 主脑派单 T4：`palink-ollama` 容器自 2026-10-11 起 `docker logs` 零输出，但 healthcheck 每 30 秒成功（容器 healthy），排查生产问题少一路证据。派单列出三个常见候选形态：日志驱动为 none / entrypoint 把输出重定向进文件 / 日志被轮转没了。
- 查验结论先行：**三个候选形态都不是**。真实根因是：宿主机 2026-10-12 02:51（本地时区 UTC+8）关机时 Docker VM 被硬杀，ollama 正在写的一条日志记录被**撕裂**（无闭合、无换行），与下一条记录**粘连成一行坏数据**；此后 daemon 的日志**前向读取器每次都在这条坏行处中止**——磁盘上的日志从未停止写入（至今连续、实时），只是 `docker logs` 的常规读路径（全量 / `--since` / 管道 grep）看不见 2026-10-11T18:50:16Z 之后的任何内容。
- 本次查验为只读，未改任何文件、未重建/重启任何容器。

## 方法

全部为本机实测（Git Bash；时间为 UTC，本地=UTC+8 会单独标注）：

| # | 命令（摘要） | 用途 |
|---|---|---|
| M1 | `docker ps -a --format ...` | 确认容器名与状态 |
| M2 | `docker inspect palink-ollama / palink-ai-backend-1 --format '...LogConfig/Entrypoint/Cmd/Tty/Env/Healthcheck/StartedAt/RestartCount...'` | 日志驱动与进程配置对比 |
| M3 | `docker logs [-t] [--tail N] [--since X] palink-ollama`（含 `wc -l`、按日期 grep/awk 统计） | docker logs 读路径行为 |
| M4 | `docker exec palink-ollama sh -c 'ls -la /proc/1/fd/...; env; /bin/ollama --version'` | 容器内进程 stdout 指向、环境变量、版本 |
| M5 | `wsl.exe -d docker-desktop ...`（`MSYS_NO_PATHCONV=1`，全部 ls/cat/wc/grep/od/tail 只读） | 进入 Docker VM 直接检验原始 json 日志文件字节 |
| M6 | `git log --oneline/--format --since=2026-10-09 -- docker-compose*.yml` + Read `docker-compose.yml` 全文 | compose 配置与时间线 |
| M7 | `pwsh -NoProfile -Command 'Get-WinEvent -FilterHashtable @{LogName="System"; Id=41,6005,6006,6008,1074; ...}'` | 宿主机开关机事件（本地时区） |
| M8 | `wsl df -h`、backend 日志文件对照 | 排除磁盘满；对照组健康性 |

## 发现（逐条带证据）

### 1. 容器与日志驱动：与 backend 完全一致，不是 driver:none

- `docker ps`（M1）：`palink-ollama  Up 15 hours (healthy)  ollama/ollama:latest`；对照组 `palink-ai-backend-1  Up 3 hours (healthy)`。
- `docker inspect`（M2）：
  - ollama：`LogConfig={json-file map[max-file:3 max-size:10m]}`，`Entrypoint=[/bin/ollama]`，`Cmd=[serve]`，`Tty=false`，`StartedAt=2026-10-25T03:25:09Z`，`Created=2026-10-06T19:06:39Z`，`RestartCount=0`，`RestartPolicy={always 0}`。
  - backend：`LogConfig={json-file map[max-file:3 max-size:10m]}`，`Cmd=[sh /app/start-server.sh]`，`Tty=false`。
  - **两容器日志驱动与大小限制逐字相同**；ollama 用镜像默认 entrypoint，日志走 stdout/stderr。

### 2. compose 配置：ollama 与 backend 的 logging 段逐字相同，无 entrypoint/tty 覆盖

- `docker-compose.yml`（M6，全文 Read）：
  - ollama 块 `docker-compose.yml:61-95`：`logging: driver "json-file" / max-size "10m" / max-file "3"`（`docker-compose.yml:81-85`）；healthcheck `["CMD-SHELL", "ollama list || exit 1"]` 30s/10s/5 次重试（`:75-80`）；模型在命名卷 `ollama_data:/root/.ollama`（`:70`，卷声明 `:281`）；无 `entrypoint`/`command`/`tty`/`init` 覆盖。
  - backend 块 `docker-compose.yml:153-243`：logging 段 `:228-232`，与 ollama 的**逐字相同**。
  - 其余服务（frontend `:43-47`、new-api `:138-142`、db `:263-267`）同款，属全仓统一模板。
- `docker-compose.dev.yml`（783 字节）无 logging 段；`docker-compose.test.yml` 的 logging 段属于测试栈，与生产容器无关（生产容器由 `docker-compose.yml` 创建，inspect 值与之一一吻合）。
- VM 内**无** `/etc/docker/daemon.json`（M5 实测 `NO_DAEMON_JSON`）→ 10m/3 完全来自 compose 每服务显式配置。
- 镜像 `ollama/ollama:latest` 本机 ID `9d30908e4114`，创建于 2026-08-17（M2/M6 之间实测 `docker images`）；容器 2026-10-06 创建至今未重建，运行的 ollama 版本 `0.32.14`（M4 实测）。

### 3. 「docker logs 零输出」复现：前向读取冻结在 2026-10-11T18:50:16Z

- `docker logs palink-ollama`（M3）总行数 **135,036 行**，按 `-t` 前缀日期统计：`2026-10-10` 52,225 行 + `2026-10-11` 82,811 行 = 135,036，**再无任何其他日期**（`grep -c '^2026-10-12'`=0，`grep -c '^2026-10-25'`=0）。
- 最后一行：`2026-10-11T18:50:16.034792426Z [GIN] ... GET "/api/tags"`（一次 healthcheck 的请求记录）。
- 冻结是读路径级的，不是数据没了：间隔 10 分钟以上的多次 `wc -l` 恒为 135,036；`docker logs --since 2026-10-20T00:00:00Z` = **0 行**；`--since 90s` = 0 行。
- 但 **`--tail` 小 N 能读到今天的行**：`--tail 3` 返回 `2026-10-25T18:36:12Z`/`18:36:42Z` 的 healthcheck GIN 记录；`--tail 50` 最早行 `2026-10-25T18:30:11Z`。同一秒内 `--tail 200000` 却返回 135,036 行（与全量读完全同集，最老行 2026-10-10T00:44:51Z）。两种读法返回不同集合——daemon 两条读路径对同一份文件行为不一致（细节见发现 8）。

### 4. healthcheck 正常的证据（服务本身确实健康）

- inspect：`Health=healthy`；`State.Health.Log` 最近 5 次全部 `exit=0`，每 30 秒一次，输出为 `ollama list` 的模型清单（`qwen3-embedding`）（M2）。
- healthcheck 定义与 compose `:75-80` 一致（interval=30s 即 inspect 的 `30000000000` 纳秒）。
- 也就是说：**每 30 秒一次的 `ollama list` HTTP 请求持续成功**，且其 GIN 访问日志持续落在磁盘文件里（见发现 5），唯独 `docker logs` 读不出来。

### 5. 决定性反证：磁盘上的日志从未停止（VM 内字节级检验）

经 `wsl.exe -d docker-desktop` 只读进入 Docker VM（M5），日志目录
`/mnt/docker-desktop-disk/data/docker/containers/29842591450c...804f053/`（容器 ID 目录，文件名已用 `cat -A` 复核三个文件 ID 一致）：

- 三个文件（`ls -la` + `wc -l`）：
  - `...-json.log.2`：10,000,068 字节，mtime **Oct 11 00:30**，67,636 行，首行 `time=2026-10-10T00:44:51Z`；
  - `...-json.log.1`：10,000,147 字节，mtime **Oct 11 17:06**，66,423 行；
  - `...-json.log`（当前）：9,227,370 字节，**mtime = 查验当时（Oct 25 18:48，实时增长）**，57,794 行。
- 当前文件内按 `"time":"2026-10-XX"` 统计：**10-11:977、10-12:4035、10-13:4546、10-14:4179、10-15:1736、10-16:5613、10-17:2234、10-18:4293、10-19:4989、10-20:3128、10-21:4518、10-22:4705、10-23:5113、10-24:3745、10-25:3983**（合计 57,794 = wc -l，逐日连续，无空洞）。
- 当前文件末尾 200 字节（`od -c`）：`..."time":"2026-10-25T18:55:46.057979234Z"}\n` —— 完整记录、带换行，写入健康。
- 算术闭合：前向可见集 = .2(67,636) + .1(66,423) + 当前文件前 977 行 = **135,036**，与 `docker logs` 实测行数**分毫不差**。
- 当前文件内共 27 条 ollama 启动横幅 `server config`（routes.go），最后一条 `time=2026-10-25T03:25:10.842Z`，与容器 `StartedAt=2026-10-25T03:25:09Z` 吻合 → 14 天里容器随宿主机多次重启自动拉起（restart: always），日志每次都有记录，只是 `docker logs` 看不见。

### 6. 撕裂记录实锤：第 978 行 = 半条记录 + 下一条记录的粘连体

当前文件 `sed -n '976,978p'`（M5，截前 260 字节）：

```
第976行 {"log":"[GIN] 2026/10/11 - 18:50:16 | ... HEAD \"/\"\n","stream":"stdout","time":"2026-10-11T18:50:16.034103227Z"}
第977行 {"log":"[GIN] 2026/10/11 - 18:50:16 | ... GET \"/api/tags\"\n","stream":"stdout","time":"2026-10-11T18:50:16.034792426Z"}
第978行 {"log":"[GIN] 2026/10/11 - 18:50:46 | 200 |      21.772µs |       127.0.0.1 | HEA{"log":"time=2026-10-12T00:18:12.507Z level=INFO source=routes.go:1933 msg=\"server config\" ...
```

- 第 978 行共 1370 字节（`sed -n '978p' | wc -c`）：前半条 `{"log":"...18:50:46 | ... | HEA` 在 **"HEAD" 一词中间被截断**——无闭合引号、无 `}`、**无换行**；紧接着直接拼上 5.5 小时后的下一条记录（2026-10-12T00:18:12Z 的 ollama 启动横幅）。
- JSON 解码器读到该行必然语法错误 → **前向读取在此中止**，之后 14 天的记录全部不可见。`--tail` 的小 N 读法从文件尾反向读、不经过坏行，所以能看到今天的记录（发现 3 的两种读法矛盾由此而来）。
- 排除写失败的环境因素：VM 数据盘 `df -h` = 1006.9G 总量、**909.8G 空闲（5% 已用）**（M8），ENOSPC 不成立。

### 7. 时间线：撕裂发生在宿主机关机前 18 秒

- Windows 事件日志（M7，本地时区）：2026-10-12 当晚 **01:28:20 / 01:43:49 / 01:51:12 / 02:17:50 / 02:22:58 / 02:36:00 六条 1074（User32，重启/关机被发起）**，**02:51:04 事件 6006（事件日志停止=系统关机）**，**08:06:20 事件 6005（开机）**。
- 撕裂写入时刻 `2026-10-11T18:50:46Z` = **本地 10-12 02:50:46** —— 比关机完成（02:51:04）早 **18 秒**，正处于关机序列中（Windows 快速关机硬杀 WSL2 VM，写在半截被切断）。
- 磁盘下一条记录 `2026-10-12T00:18:12Z` = 本地 08:18:12 —— 开机（08:06:20）后 12 分钟，Docker 引擎起来、`restart: always` 把容器拉起，打出启动横幅。两事件间隔 5h27m，与宿主机离线窗口（02:51:04→08:06:20 = 5h15m + 引擎启动耗时）吻合。
- git 时间线（M6）：`git log --since=2026-10-09 -- docker-compose*.yml` 仅两笔——`c7ef194`（2026-10-10 23:17 +0800，CI 入库）、`678c288`（2026-10-15 18:30 +0800，前端端口），**均不涉及 ollama 服务块，且事件发生在两笔之间**；compose 配置与本次故障无关。本机 Docker Desktop「非正常停止」史在 compose 注释里早有记载（`docker-compose.yml:14-18`：「本次是 Docker Desktop 引擎非正常停止后重启」）。

### 8. 对照组 backend：日志通道正常，差异不在配置而在「有没有踩中坏行」

- backend 前向读活跃：`docker logs --since 60s palink-ai-backend-1` = 4 行（M3/M8）。
- backend 当前日志文件（VM 内）：118,478 字节，mtime = 查验当时，末尾 `..."time":"2026-10-25T18:57:40.989298696Z"}\n` 完整带换行（M8）。该容器 2026-10-25 15:21 才创建（新容器=新日志目录），没有历史撕裂记录。
- 结论：同款 logging 配置，backend 正常、ollama 冻结，唯一差异是 ollama 的日志文件里躺着那条 10-11 期的粘连坏行。

## 结论与建议

### 结论（回答派单四问）

1. **为什么 healthcheck 正常但 logs「空」**：不是进程不写、不是驱动 none、不是重定向进文件、也不是轮转丢日志。ollama 每 30 秒都在往 stdout 写、daemon 每条都在往磁盘文件写（当前文件实时增长、末尾记录完整）。坏在**读**：2026-10-12 02:50:46（本地）宿主机关机硬杀 Docker VM，把当时正在写的一条日志撕成半条且无换行，与 5.5 小时后开机横幅粘连成第 978 行坏数据；`docker logs` 的前向读取器（全量/`--since`/管道统计都走这条路）每次解析到该行即中止，于是「日志永远停在 2026-10-11T18:50:16」，表现为零新输出。
2. **修法**：**重建（recreate）容器**，一条命令：
   ```
   docker compose up -d --force-recreate ollama
   ```
   新容器 = 新容器 ID = 全新日志目录，坏行随之消失，`docker logs` 立即恢复。**改 compose 无用**（配置本来就没错，无需改任何一行）；**`docker restart` 无用**（容器 ID 不变，日志目录原样保留，坏行还在）。风险极低：模型在命名卷 `ollama_data`（`docker-compose.yml:70`）不受影响；中断仅数秒，backend 侧 `OllamaEmbedder` 本就设计为 Ollama 不可达时自动降级（`docker-compose.yml:178` 注释）。
   - ⚠️ 可选留存：重建后旧日志目录会被 `docker rm` 一并删除。.2/.1 两份历史文件本就完整可读（前向可见集就是它们），如需留档，重建前可从 VM 拷出（路径见发现 5）。
   - ❌ 不建议在 VM 内就地修文件（删第 978 行坏行）：daemon 持有文件句柄、轮转窗口内有竞态，只治标且违反「不动 daemon 数据」的稳妥边界。
3. **要不要 recreate**：要。见上。
4. **同类风险**：这个失效模式（硬关机撕裂日志 → 前向读取中止）对本机任何容器都可能发生，与本容器配置无关；backend 等容器没坏只是因为没踩中（新近重建过或当时没在写）。判别配方：`docker logs --tail 5 <容器>` 能出今天的行、而 `docker logs --since 1h <容器>` 为 0 → 即为此症，recreate 该容器即可。宿主机频繁重启是既有限制（compose 注释 `:14-28`），无法在 compose 层面预防。

### 待主脑裁定

- `--tail 50` 与 `--tail 200000` 同秒返回不同集合（发现 3/5）：小 N 走反向读、大 N 走前向环形缓冲的中止行为，是从外部观测到的现象；Docker 29.2.1 日志读取器内部分支未能从本机进一步验证。不影响根因定性与修法。
- 六条 1074 事件中具体哪次操作触发了这次关机序列（可能含计划内重启）：事件日志只证明「02:51:04 完成关机、08:06:20 开机」，发起方细节未深挖。

### 交接注意事项

- 本报告新建于 `docs/_active/report/`，**按 AGENTS.md 规矩需跑 `py scripts/docs/gen_docs_catalog.py` 刷目录**；但本次为只读查验（除本报告外禁改文件），故目录刷新留给收稿的主脑/下一个施工 agent 执行，提交前 `--check` 会显示 STALE 属预期。
- 建议入账：`docs/OPEN_ISSUES.md` 可加一条「palink-ollama 需 recreate 恢复日志通道」（一条命令、低风险），以及「宿主硬关机后个别容器 docker logs 冻结」的判别配方（上文第 4 点）。
