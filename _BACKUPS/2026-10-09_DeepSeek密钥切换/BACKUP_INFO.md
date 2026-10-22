# BACKUP_INFO —— 2026-10-09 DeepSeek 密钥切换

## 1. 备份原因

用户提供新的 DeepSeek API Key（旧的已失效/欠费），要求**把默认 key 换成新 key**，
然后用 **4.1flash**（即 `deepseek-flash` = 上游自报 `DeepSeek-V4.1-Flash`）重跑记忆检索
端到端评测（此前因旧 key 余额 `-0.00` 被 `HTTP 402` 中断）。

> 旧 key `sk-bc95da98...` 实测 `401 Unauthorized`（已失效，非仅欠费）。
> 新 key 实测余额 **¥6.00**，`/v1/models` 正常返回 `deepseek-flash` / `deepseek-v4-pro`。

## 2. 备份内容（`pre/`）

| 文件 | 来源 | 说明 |
|---|---|---|
| `pre/providers.json` | `backend/data/providers.json` | **运行时权威源**（compose 将 `./backend/data` 挂到容器 `/app/data`，`DATA_DIR=./data`）。含 DeepSeek 明文 key。 |
| `pre/providers.app-data.json` | `backend/app/data/providers.json` | 仅含 OpenRouter 一条 `env:` 引用，**未被运行时读取**，一并留档。 |
| `pre/check_resolve.py` | 新建探针 | 验证 `resolve_credentials` 解析结果（已挪至此目录存档）。 |

**另有一处非文件状态被改动（见 §3 改动二），以本文件记录为准：**
- `connection_profiles` 表 `id=2`（name=`DeepSeek`）的 `api_key_encrypted`
  由旧密文改为新密文。**旧密文已无法解密还原**（明文 `sk-7030c45b...` 见 §3）。
  如需回退，"回退"即改回用户手上的旧 key —— 但旧 key 已 401，**回退无意义**。

## 3. 改动内容

**改动一：`backend/data/providers.json`**（DeepSeek provider 记录的明文 key）
```
- "api_key": "sk-bc95da98db2c4243ace9a5f0af44fe03"
+ "api_key": "sk-fe2bff0f217c4368930bc78314249d2d"   （用户新 key）
```
> ⚠️ 注意：用户给的新 key 与仓库里旧的 `backend/app/data/providers.json` 中那条 OpenRouter
> 是不同 provider。本次只改 **name=DeepSeek / base_url=https://api.deepseek.com** 那条。

**改动二：`connection_profiles` 行（DB 内，非文件）**
- `id=2`, `user_id=1`, `name=DeepSeek`, `base_url=https://api.deepseek.com`
- `api_key_encrypted`: 旧明文 `sk-7030c45be3ed4275bf9586d9208e47d6` → **新 key**
  （经 `crypto_service.encrypt_api_key` Fernet 加密；密文长度 140 不变）
- 改动前后均用 `decrypt_api_key` 自校验通过。

> 为什么两处都要改：推理链 `inference_dispatcher` → `resolve_credentials()`
> **优先用用户激活的 `ConnectionProfile`**；无激活 profile 时**回退** `providers.json`。
> 只改一处会留下"某条路径还是旧 key"的隐患。
>
> **重要发现**：`user_id=1` 的**激活 profile 是 `mimo`**（`is_active=True`），
> 不是 DeepSeek。所以走生产推理链并不会用到本次改的 key；
> 只有**显式按 name 取 DeepSeek profile** 的脚本（如评测探针 `p53`）才会用到。
> 本次按用户"改默认 key"的要求把 DeepSeek 这条对齐，**未改动激活态**（改激活态属另一件事，
> 会影响线上对话走向，未获授权不做）。

## 4. 验证（改后已跑）

| 验证项 | 结果 |
|---|---|
| 新 key 余额 | `{"is_available":true,"total_balance":"6.00"}` ✅ |
| 旧 key 余额 | `HTTP 401` ❌（确认已失效） |
| `decrypt_api_key` 自校验（改后） | `AFTER_KEY_OK True` ✅ |
| 经项目自身解密链实调 `deepseek-flash` | HTTP 200，`usage.prompt_tokens=35` ✅ |
| `p52_keycheck.py` 复现 | `key_prefix: sk-fe2bff0f2` ✅ |
| 端到端评测 `p53` | 53 题 × 3 档全部跑完，无 402 ✅ |

## 5. 回退

```bash
cd /d/项目/Palink-AI
cp "_BACKUPS/2026-10-09_DeepSeek密钥切换/pre/providers.json" backend/data/providers.json
```
DB 内那行无文件级回退（旧密文未留档，且旧 key 已失效），如需恢复请重新用
`encrypt_api_key(<旧key>)` 写回 —— **不建议**。

> 本次改动**未触碰任何代码**，无需 `docker compose build backend`；
> `providers.json` 在 bind mount 内，改完即生效（`get_providers()` 按 mtime 自动失效缓存）。
