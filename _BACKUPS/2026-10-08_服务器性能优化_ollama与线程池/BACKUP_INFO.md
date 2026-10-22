# BACKUP_INFO.md

## 1. 备份日期

2026-10-08（07:49）

## 2. 原始来源路径

| 备份文件                     | 原始路径                                 |
| ------------------------ | ------------------------------------ |
| `.env.bak`               | `D:\项目\Palink-AI\.env`               |
| `docker-compose.yml.bak` | `D:\项目\Palink-AI\docker-compose.yml` |

## 3. 备份原因

本轮做服务器性能优化，动手前先备份将要修改的两个配置文件：

1. `.env` —— 新增 `API_THREADPOOL_TOKENS=16`（AnyIO 线程池并发令牌）
2. `docker-compose.yml` —— **最终未修改**（发现 `env_file: .env` 已能把变量注入容器，  
   无需新增插值行），备份仅作前置保险。

## 4. 本轮已做的改动（供回溯）

### 改动一：卸载零引用嵌入模型 `qwen3-embedding:0.6b`（运行态，未改文件）

- **手法**：`docker restart palink-ollama`，让常驻模型全部卸载；随后只由真实调用  
  加载在用的 `bge-m3`。未删除模型文件（`ollama rm` 未执行，可随时重新加载）。
- **依据**：全仓（`.py/.ts/.tsx/.yml/.json/.sh`）grep `qwen3` 命中项**全是聊天模型**  
  （`model_specs.json` 的 qwen3.x-max/plus、`unified_model_registry.py` 的推理档位），  
  **没有任何一处引用 `qwen3-embedding`**。实际嵌入模型由 `OLLAMA_MODEL=bge-m3` 固定。
- **实测 A/B**：
  | 状态           | CPU          | 内存                | 500 字嵌入     |
  | ------------ | ------------ | ----------------- | ----------- |
  | 双模型常驻（改前）    | **360–640%** | 3.33–3.89 GiB     | **3678 ms** |
  | 无模型常驻        | 0.00%        | 14 MiB            | —           |
  | 仅 bge-m3（改后） | **0.00%**    | **1.25–1.53 GiB** | **1001 ms** |

### 改动二：`API_THREADPOOL_TOKENS` 8 → 16

- **手法**：只改 `.env`（加一行），`docker compose up -d backend` 重启容器读新变量。  
  **未重建镜像**，因此不会夹带工作区其他会话的在途源码改动。
- **原理**：`start-server.sh:273` 仅在 `API_THREADPOOL_TOKENS` 非正整数时才走  
  `THREADS_PER_WORKER * 4` 公式（4 worker 下算出 4 → 触底 8）。显式赋值即跳过公式。
- **生效证据**：启动日志 `AnyIO 线程池并发令牌设置为: 16`（改前为 `8`）。

## 5. 后续待办清单

- [ ] **（未做，需授权）** 删除 `qwen3-embedding:0.6b` 模型文件（`ollama rm`）。  
  当前只是卸载，仍在 `ollama list` 里；任何人显式调用会重新加载、CPU 重回 640%。
- [ ] **（未做，需重建 backend 镜像）** P0-1：`chat.py` 的 6 处同步调用包 `asyncio.to_thread`  
  （`persist_snapshot` / `compute_deduct_tokens` / `deduct_usage` / `store_memory` ×2）。  
  ⚠️ 重建镜像会夹带工作区 152 项多会话在途未提交改动，需用户知情同意。
- [ ] **（未做，需重建 backend 镜像）** 修复 4 个 worker 各起一个 `[EMB-BACKFILL]` 线程  
  （`_WORKER_STARTED` 是进程级 global，跨进程不幂等；启动日志出现 4 次）。  
  当前 `conversation_memories` 764 行、NULL 向量 0 行 ⇒ 暂无实际影响，属隐患。
- [ ] **（未做）** `shared_buffers` 128MB 固定值：当前数据量小（764 记忆 / 185 消息），  
  实测无瓶颈，暂不动。
- [ ] **（未做）** nginx `worker_processes auto` 在 1 核容器里起 16 个 worker：  
  **实测 frontend CPU 0.00–3.25%、内存 22MB，未构成实际瓶颈**，降级为理论项，不主动改。

## 6. 回滚方式

```bash
cp _BACKUPS/2026-10-08_服务器性能优化_ollama与线程池/.env.bak .env
docker compose up -d backend
```

（`qwen3-embedding` 若被误删，用 `docker exec palink-ollama ollama pull qwen3-embedding:0.6b` 恢复，约 639 MB。）
