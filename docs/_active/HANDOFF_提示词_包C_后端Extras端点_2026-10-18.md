# 提示词 · 包 C：ST Extras 后端端点补齐（让"轻后端插件"真能用）

> 本文件是**可直接发送给子 agent 的完整任务包**，自包含，不依赖任何对话上下文。
> 主控：Pal 的项目 Palink-AI。分支 `three-tracks-merge-20261012`，HEAD `94107db`。
> ⚠️ 本包改**后端** Python，与包 A / 包 B（前端）**不冲突**，可并发。
> ⚠️ 但**后端容器镜像落后**（见 §1.3），改完必须 rebuild 才能验证，rebuild 会重启容器 —— **rebuild 前必须先问主控**。

---

## 0. 你要解决的问题（一句话）

ST 生态里有一批插件（Summarize / Chat Translation / memory / expressions / stable-diffusion）依赖 ST 的 **Extras 后端端点**。
Palink 这些端点**基本全缺**（实测只剩 `/api/vector/*` 一类是真的），所以这些插件"面板能出来但一按就失败"。

**好消息**：ST 的 Extras **本质全是转发代理**——ST 自己不生成图、不翻译、不嵌入，只是把请求转派到你配置好的外部服务。
所以"缺端点"= "补一个转发代理"，**不是原理性不可行**，且 Palink 已有同族先例（`/api/openai/generate-image`）。

## 1. 现状

### 1.1 端点实测状态（2026-09-05 实弹探测口径，动工前请复跑确认）

| 端点 | 状态 |
|---|---|
| `/api/vector/*`（index/query/insert/delete 等 8 个） | ✅ **唯一真实实现** |
| `/api/backends/chat-completions/generate` | ✅ 存在（智能卡拦截链红线端点） |
| `/api/backends/text-completions/*` | ❌ 404 |
| `/api/extra/caption` | ❌ 404 |
| `/api/extra/classify` + `/labels` | ❌ 404 |
| `/api/summarize` | ❌ 404 |
| `/api/translate` | ❌ 404 |
| `/api/openai/generate-image` | ❌ 404（生图走 Palink 自有 `/api/images/generate`） |
| `/api/openai/generate-voice` | ❌ 404 |

### 1.2 缺失清单（按插件影响面，来自 `st-plugins/ADAPTATION.md` §二）

| 缺口 | 影响插件 | 适配动作 |
|---|---|---|
| `/api/sd/*`（SD WebUI / ComfyUI 转发代理） | stable-diffusion | 薄代理，**只做实际用的 1~2 个 provider**，不必全做 30 个 |
| `/api/sprites/get`、`/api/sprites/delete` | expressions | 补 sprite 存储接口，或映射到 Palink 资源服务 |
| `/api/backends/kobold/embed` | vectors | 补 embedding 后端，或复用 Palink 已有 embedding 端点 |
| `/api/translate/{provider}` 子路径（libre/google/deepl/deeplx/bing/yandex/lingva/onering） | translate | Palink 只有单一 `/api/translate`；加按 provider 路由**或**前端 URL 垫片 |
| `power_user` 成员（仅 `powerUserSettings`） | expressions | expressions 用 `power_user.waifuMode`；在 getContext 暴露 `power_user` 别名 |
| TTS 音频合成后端 | tts | 先确认音频来源：`index.js` 里 `new Audio()` 播放但无 fetch ⇒ 可能是浏览器 Web Speech（免改），外部才需代理 |

### 1.3 ⚠️ 后端镜像落后（已登记 OPEN_ISSUES [P1-12]）

后端容器镜像是 **2026-10-11 13:19** 构建的，此后 `backend/app` 有多笔提交**未上线**。
⇒ 你改完代码后，本地 `pytest` 通过**不代表线上生效**；**必须** `docker compose build backend && docker compose up -d backend` 才能真机验证。
⇒ **rebuild 会重启 backend 容器**，动工前/重建前先问主控确认可以重启。

## 2. 任务（按优先级，建议逐级做，每级单独验证）

### C-1 先做：把"明确能补、风险最低"的三个补上
1. **`/api/extra/classify` + `/api/labels`**：转派到 Palink 已有 LLM 能力，返回 ST 期望的 `{ classification: [...] }` 形状。
2. **`/api/extra/caption`**：转派到 Palink 多模态/图生文能力（若有）；没有就明确登记为"依赖外部服务，需用户配置"。**不要**为了凑端点造假响应。
3. **`/api/translate/{provider}`**：在现有单一 `/api/translate` 上按 provider 分子路由；至少支持 `libre` + `google` 两个（其余回退到默认 provider 并留痕）。

### C-2 再做：sprites 与 embedding
4. **`/api/sprites/get`、`/api/sprites/delete`**：映射到 Palink 资源服务（先 `grep` Palink 现有资源/附件存储接口再接，不要新建一套）。
5. **embedding 端点**：复用 Palink 已有 embedding 能力替代 `/api/backends/kobold/embed`。

### C-3 最后：SD 代理（按用户是否真用 SD 决定）
6. **`/api/sd/*`**：只做 SD WebUI + ComfyUI 两个 provider 的转发代理。其余 28 个 provider（horde/novelai/stability/…）**不做**，在报告里登记为 P2。

### C-4 前端小垫片（若需要）
7. `power_user` 别名（getContext 暴露 `power_user` 指向 `powerUserSettings`）—— 这一项动前端 `runtime-body/part-08.ts`，**若要动请告诉主控**（会与包 B 撞文件）。

## 3. 明确**不要做**的事

| 不要做 | 原因 |
|---|---|
| 造假响应（端点了但返回假数据） | 比 404 更糟——插件会以为成功，用户拿到垃圾结果 |
| 一次做全 30 个 SD provider | 只做实际接入的 |
| 动 `silly_tavern_mode` / `st-compat` / `st-native` 相关代码 | 这两个模式**已于 2026-09-03 删除**，无解封开关 |
| 回填 `backend/app/core/migrations.py` 的 `_RUNTIME_COMPAT_COLUMNS` 里的 `silly_tavern_mode` / `silly_tavern_theme` | **T1 红线**：回填会让后端重启把已删的列重建回来 |
| 按名字删 `st_groups.py` / `st_sync_service.py` / `api/silly_tavern.py` | 全是**在用的生产代码**。动前必须 `grep -rn` 查调用方 |
| 改 `frontend/dist` | nginx bind mount，主控统一管理 |

## 4. 验收（必须逐项给出实测证据）

| 项 | 判据 |
|---|---|
| 端点可达 | 每个新增端点 `curl` 返回**非 404**（401/403 说明路由在、只是认证没带，也算路由存在） |
| 真跑通 | 至少 **1 个端点端到端跑通一次**（有真实外部服务配置的那个），给出请求/响应样例 |
| 后端测试 | `docker compose exec backend pytest` —— 只认 **`failed = 0` 且 `errors = 0`**（passed 数字会漂，不是验收线） |
| ⚠️ 全量 pytest | **必须** `pytest tests/ -q --basetemp=/tmp/pb_$RANDOM`（全量不带 `--basetemp` 拿不到汇总行，会被安全删除守卫伪造 `E` 字符） |
| 前端不回归 | `npx vitest run` 全绿（基线 78 文件 / 1000 passed / 0 failed）；`npx tsc --noEmit` exit 0 |
| **改坏证明** | 撤改动 → 端点回 404；还原 → 恢复。**两项都写进报告** |

## 5. 环境纪律（本机实测，别踩）

1. **唯一 shell = Git Bash**。Python 一律 `py`（`python`/`python3` 是微软商店空壳，exit=49 零输出）。
2. **后端依赖在容器里，不要 `py -m pip install` 凑** —— 该进容器/镜像。
3. 不可用：powershell、wget、jq、make、7z、gh、sqlite3、psql、redis-cli。
4. **backend 容器里没有 `ps` / `git` / `wget`**；SQL 走文件传，不要长串内联（引号嵌套必烂）。
5. **`git commit -m` 里的反引号会被 bash 吃** ⇒ 提交信息含代码标识时用 `git commit -F <消息文件>`。
6. Windows 程序输出是 GBK，加 `| iconv -f GBK -t UTF-8`，或只认结构化 ASCII 行（`OK` / `rc=` / `failed = 0`）。
7. `curl` 用 `/c/Windows/System32/curl.exe --noproxy '*'`（Clash 会拦 localhost）。
8. **永远不要把 pytest 的 `--basetemp` 指进仓库内**。
9. 改 `docs/` 后跑 `py scripts/docs/gen_docs_catalog.py`。

## 6. 联调用的登录方式（真机验证端点时用）

```bash
cd /d/项目/Palink-AI/.tmp_probe
/c/Windows/System32/curl.exe --noproxy '*' -s -c ck.txt -X POST http://localhost:16000/api/token -d "username=admin&password=admin123"
/c/Windows/System32/curl.exe --noproxy '*' -s -b ck.txt "http://localhost:16000/api/<你的端点>" -w "\nrc=%{http_code}\n"
```

前端端口 **16000**（3000/14700/14000 均落 Windows 保留段，bind forbidden）。
认证是**双 cookie**（`palink_session` HttpOnly + `palink_csrf`）；mutating 请求带 `X-CSRF-Token` 头（值取 `palink_csrf` cookie）。
判登录成功：`GET /api/users/me` 返回 `admin`。

## 7. 交付要求

1. 代码 + 测试，提交到当前分支。
2. 完工报告放 `docs/_active/report/`，必须包含：
   - 每个端点的**改动前后 HTTP 状态码对比**；
   - 至少 1 个端点的真实请求/响应样例（脱敏）；
   - 后端 pytest 的 `failed = 0` / `errors = 0` 原样输出；
   - **改坏证明会红 + 还原证明回绿**两项；
   - **没做的项 + 原因**（SD 其余 provider、未配置的外部服务等）；
   - 是否执行了 `docker compose build backend`（**执行前必须问过主控**）。
3. 报告里所有结论给 `文件:行号`，不要写"经查存在"。
