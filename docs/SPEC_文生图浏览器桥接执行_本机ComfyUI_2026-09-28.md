# SPEC：文生图「浏览器桥接执行」——服务端编排、用户浏览器驱动本机 ComfyUI

> 日期：2026-09-28 ｜ 前置调研：`docs/REPORT_浏览器桥接本地算力可行性调研_2026-09-28.md`
> 范围拍板（用户）：**暂时只做文生图**的浏览器桥接（LLM 文本回答暂不做）。
> 并行约束：本 SPEC 的改动文件均为自查清单内文件；`chat.py` / `websocket.py` / `character_ext.py` / `sillyTavernPluginRuntime.ts` / `formatting.ts` / `api/__init__.py` **零改动**（其他 agent 活跃区）。

---

## 1. 目标与非目标

**目标**：托管部署（服务端在远端、够不到用户内网）下，ComfyUI 出图改为「后端组好工作流 → 下发给用户浏览器 → 浏览器 fetch 用户本机 `http://127.0.0.1:8188` → 结果回传后端入库」。触发路径（启发式自动出图 / P4 模型工具出图 / 手动配图按钮）与媒体收敛链**全部复用，零改动**。

**非目标**：
- 不做 SD WebUI 的浏览器执行（结构已预留，二期照抄）；
- 不做本地 LLM 文本回答；
- 不做浏览器扩展 / 桌面壳 / 常驻伴侣进程；
- 不改 `message_media_service` 契约（media 三态、120s 渲染期超时收敛语义原样）。

## 2. 核心设计决策（等待式委派）

现有出图链：`generate_image_for_message` 插 pending media（内部 commit，不占写锁）→ `await generate_image(...)` → 成功 `update_media_status(ready)` / 失败 `update_media_status(failed)` + 抛 `MessageImageGenerationError` → 四个调用点（chat.py:326、websocket.py:299/932、character_ext.py:4869、image_generation.py:95/131）统一形态 `if not image: return None` + try/except 发事件。

**决策：浏览器模式在 `generate_image_for_message` 内部分支——创建任务后原地 `await` 任务完成事件，之后完全复用既有成功/失败收敛与事件发射。** 后果：

- 四个触发点、六个事件发射点、媒体契约、`MessageImageGenerationError` 语义**全部不动**；
- 超时/失败自然走既有 failed 收敛（DB 落 `failed` + 失败事件）；
- 代价：后端协程挂起等待（≤ timeout，默认 120s，可配 ≤600s）。事务安全依据：`attach_message_media` / `update_media_status` 均内部 `db.commit()`（message_media_service.py:161/216），等待期间无未提交写事务，WAL + busy_timeout=30s 下不阻塞其他写者（与现状云服务商生成 30~120s 持有行为同级别）。

**任务送达采用「前端轮询」而非推送**：不新增 SSE/WS 事件类型、不动 `useChatWebSocket.ts` / `stream-engine`（避开其他 agent 活跃面与 P1.6「勿复活悬空事件契约」约束）。执行器为模块级单例，页面可见时每 2.5s 轮询一次自家后端 `GET /local-tasks/pending`（仅当桥接已配置启用）。

## 3. 配置模型（provider 级新增一字段）

```jsonc
// DATA_DIR/image_generation_config.json 的 providers[i]（comfyui / sd_webui 适用，本批只接线 comfyui）
{
  "id": "comfyui",
  "type": "comfyui",
  "execution": "server",              // 新增："server"（默认，现状行为）| "browser"
  "base_url": "http://127.0.0.1:8188", // browser 模式下语义=「用户浏览器视角」可达地址
  "timeout_seconds": 120,              // browser 模式同字段复用：任务总时限
  "...": "其余字段不变"
}
```

- `_validate_provider`：`execution` 归一化，非法值回落 `"server"`；**`execution == "browser"` 时跳过 `_is_safe_mcp_url` 内网拒绝**（后端在 browser 模式下对该 URL 发起零请求——SSRF 守卫管的是后端出站面，浏览器执行面不归它管；代码注释写明两层语义，防止未来被"顺手统一"拆掉守卫），仍强制 http(s) scheme + netloc。`execution == "server"` 时行为逐字节不变。
- `_default_config()` 的 comfyui / sd_webui 两条补 `"execution": "server"`（`_merge_with_defaults` 对旧配置文件自动补齐）。
- `PUT /config` 仍 admin-only（不变）。`POST /test` 对 browser 模式返回 400（服务端无法替浏览器执行；设置页用「检测」按钮做直连验证）。

## 4. 后端新增：本地任务桥 `backend/app/services/local_image_bridge.py`

进程内单例（无新容器/无新线程池，asyncio 原生）：

```python
@dataclass
class LocalImageTask:
    task_id: str                  # "lt_" + uuid4.hex[:16]
    user_id: int
    kind: str                     # "comfyui"（v1 唯一）
    message_kind: str             # "chat" | "character"（仅透传给前端定位，后端不用）
    session_id: Optional[str]
    message_id: Optional[int]
    media_id: str                 # 关联 extra.media 项
    prompt: str
    base_url: str                 # 浏览器视角地址
    workflow: dict                # 完整 POST /prompt body（后端组装，见 §5）
    seed: int                     # 组装时已随机化的实际 seed
    timeout_seconds: int
    status: str                   # pending → dispatched → completed / failed / expired
    result: Optional[dict]        # {"base64": [b64], "seed": int}
    error: Optional[str]
    created_at: float             # time.monotonic()
    dispatched_at: Optional[float]
    done: asyncio.Event           # 完成信号（result 或 error 均置位）
```

API（模块级函数）：
- `create_local_task(...) -> LocalImageTask`：每用户活跃任务 ≤ 8，超出时把最老的 pending/expired 置 failed（error="任务积压，已取消"）。
- `claim_pending_tasks(user_id) -> list[dict]`：取该用户 `pending`，或 `dispatched` 且 `dispatched_at` 距今 > 45s（断标签回）的；逐个置 `dispatched` 并打时间戳；返回前端执行所需字段（§6 响应形状）。
- `complete_local_task(task_id, user_id, base64_images) -> None`：校验归属 + 状态可收敛（completed/failed/expired 时幂等返回），存 result、置位 `done`。
- `fail_local_task(task_id, user_id, error) -> None`：同上，存 error。
- `await_local_task(task) -> dict`：`asyncio.wait_for(task.done.wait(), timeout=task.timeout_seconds)`；超时把任务置 expired 并抛 `HTTPException(504)`。成功返回 result；error 非空抛 `HTTPException(502, error)`。
- 模块级 `asyncio` 后台清扫：惰性启动，每 60s 把超时未收敛任务置 expired（兜底，防 `done` 永不置位的协程悬挂——有 `await_local_task` 的 wait_for 在，此清扫仅清内存）。

**不做持久化**：后端重启 = 任务丢失 = 该次等待协程死亡。影响与现状一致（云模式后端重启同样把 pending 永久悬挂，渲染期 120s 收敛兜底），登记为已知限制。

## 5. 工作流组装复用

从 `_generate_comfyui` 中**抽出** `_build_comfyui_workflow(prompt, negative_prompt, width, height, steps, cfg_scale, seed) -> tuple[dict, int]`（返回 workflow + used_seed，随机 seed 逻辑原样搬入），服务端路径 `_generate_comfyui` 与浏览器路径共用。`_generate_comfyui` 行为不变（同参同返回）。

## 6. 新 API（挂在既有 `backend/app/api/image_generation.py` router，prefix `/api/image-generation`）

| 端点 | 鉴权 | 请求 | 响应/语义 |
|---|---|---|---|
| `GET /local-tasks/pending` | get_current_user | — | `{"tasks": [{task_id, kind, message_kind, session_id, message_id, media_id, prompt, base_url, workflow, timeout_ms}]}`；调用即认领（§4 claim 语义） |
| `POST /local-tasks/{task_id}/result` | get_current_user | `{"images": ["<裸b64或dataURL>"]}` | 校验：归属（非本人 404）、状态可收敛（已收敛幂等 200 `{"status":"already_done"}`）、取 `images[0]`、≤25MB base64、魔数白名单 PNG/JPEG/WEBP（`_sniff_image_magic`，与 image_proxy_service 同思路独立实现）。通过 → `complete_local_task` → `{"status":"ok"}`。不通过 400/413 |
| `POST /local-tasks/{task_id}/fail` | get_current_user | `{"error": "原因"}` | `fail_local_task` → 等待方抛 502 → 既有 failed 收敛链 |

- `result`/`fail` **不直接写 media**：媒体生命周期唯一属主是等待中的 `generate_image_for_message` 协程（避免双写竞态）。
- result 上传的图片字节走等待方的 `_result_from_base64` → `_save_generated_image`（既有 30MB 上限、落 `UPLOAD_DIR/{uid}/generated-images/`、URL `/api/uploads/generated-images/*.png`）。

## 7. `generate_image_for_message` 分支（唯一触碰的服务函数）

```python
# 伪代码，插在 pending media 落库之后、generate_image 调用处
if provider_type == "comfyui" and provider.get("execution") == "browser":
    result = await _generate_image_via_local_browser(
        db=db, user=user, message=message, media_id=target_media_id,
        provider=provider, prompt=prompt, width=width, height=height,
    )   # 成功返回 GeneratedImage；失败/超时抛 HTTPException → 走既有 except 收敛
else:
    result = await generate_image(prompt=prompt, user_id=user.id)
```

`_generate_image_via_local_browser`：组 workflow → `create_local_task` → `await_local_task` → `_result_from_base64(provider, prompt, user_id, result["base64"], result["seed"])`。异常语义：任务失败 502（带浏览器上报原因）、超时 504（detail 注明「本机 ComfyUI 未在时限内回传」）——与现有 SD/ComfyUI 错误文案风格一致。

`generate_image` 本体与 `POST /test`：browser 模式下 `/test` 抛 400（detail：请用设置页「检测本机服务」）。

## 8. 前端改动

### 8.1 执行器（新目录 `frontend/src/lib/image-gen/`，目录已存在且为空）

**`comfyui-client.ts`**（纯函数，无 React 依赖，可契约测试）：
- `probeComfyUI(baseUrl)`：两段式探测——(1) `fetch(base + '/system_stats', {mode:'no-cors'})` 3s 超时：失败=「unreachable」；(2) 带 CORS 真请求 `/system_stats`：成功=「ok」（取 version），CORS TypeError=「cors_blocked」（提示加 `--enable-cors-header`）。AbortController 控时。
- `executeComfyUITask(task, {deadlineMs, onStage})`：`POST {base}/prompt`（body=task.workflow）→ `prompt_id` → 每 1.5s 轮询 `GET {base}/history/{prompt_id}`（复刻后端 `_extract_comfyui_image_ref` 选取规则：优先 `type=="output"`；`status_str=="error"` 判失败）→ `GET {base}/view?filename&subfolder&type` → blob → FileReader → dataURL → 剥前缀取裸 b64。deadline（= timeout_ms − 5s）到先于后端超时上报 `/fail`。错误分类：connect_refused / cors_blocked / timeout / workflow_error / empty_image。

**`executor.ts`**（模块级单例，仿 `useImageGenerationAvailability` 的 module store 模式）：
- `startImageTaskExecutor()` / `stopImageTaskExecutor()`：interval 2500ms；仅当 `enabled` 且 `document.visibilityState === 'visible'` 时拉取；`enabled` 来自 `getBridgeEnabledFromConfig()`（复用可用性 hook 的配置单例，新增 `invalidateImageGenerationConfig()` 供设置页保存后刷新）。
- `pollOnce()`：`api.imageGeneration.listLocalTasks()` → 过滤 in-flight 去重（task_id 集合）→ 逐个 `executeComfyUITask` → 成功 `submitLocalTaskResult(task_id, {images:[b64]})`；失败 `submitLocalTaskFail(task_id, {error: 中文原因})`。
- `useImageTaskExecutor()` hook：`useEffect` 挂载/卸载 executor + 监听配置失效事件；**只挂一处**（App 根组件，实现时定位 shell 文件）。

### 8.2 接线（最小面）

- `frontend/src/services/api.ts`：`imageGeneration` 增 3 方法（listLocalTasks / submitLocalTaskResult / submitLocalTaskFail）。
- `frontend/src/types/imageGeneration.ts`：provider 类型加 `execution?: 'server' | 'browser'`；新增 LocalImageTask 类型。
- `frontend/src/hooks/useImageGenerationAvailability.ts`：新增 `invalidateImageGenerationConfig()`（清缓存 + 通知订阅者），不改既有读取逻辑。

### 8.3 设置页 `ImageGenerationTab.tsx`（新建，注册三处：SettingsView.tsx 联合类型 + 菜单数组 + 条件渲染）

- 全局开关 + active provider 选择 + 三个 provider 卡片（openai_compatible / sd_webui / comfyui），字段按 schema：base_url / api_key / model / size / timeout / steps / cfg_scale / negative_prompt / seed / sampler_name（sd_webui）。
- comfyui（与 sd_webui 预留）卡片新增「执行位置」单选：`服务器（Palink 后端可达）` / `用户浏览器（本机算力，适合托管部署）`。
- 选 browser 时展开**连接向导**：动态生成复制即用命令 `python main.py --enable-cors-header '<window.location.origin>'`（明示不要用 `*` 的安全理由）+ 「首次执行时浏览器会请求『本地网络访问』权限，请允许」提示 + 「检测本机 ComfyUI」按钮（调 `probeComfyUI`，三态结果：在线✅ / 在线但 CORS 未放行→展示向导 / 不可达）。
- 保存 → `updateConfig` → `invalidateImageGenerationConfig()`。（该 Tab 顺带补齐 TODOS.md:180 登记「前端图片生成设置页 updateConfig 零调用方」缺口。）

## 9. 安全要点（实现时落注释）

1. SSRF 语义分层：`execution=="browser"` 跳过 `_is_safe_mcp_url` **仅**因为后端零出站；server 路径守卫原样。`image_proxy_service` 的「无条件拒内网」不受影响（不碰）。
2. 任务归属强校验：所有 local-tasks 端点按 `task.user_id == current_user.id` 过滤，404 不泄露存在性。
3. 回传字节三道闸：≤25MB base64、魔数白名单、`_save_generated_image` 既有 30MB 上限兜底。
4. 每用户活跃任务 ≤ 8。
5. workflow 由后端组装下发，浏览器不往上送 workflow（只送图），无注入面。
6. UI 提示用户 CORS 放行用精确 origin，不用 `*`。

## 10. 已知限制（如实登记）

- **骨架 120s**：`PENDING_TIMEOUT_SECONDS=120` 是渲染期收敛，browser 模式生成超 120s 时骨架先显示失败、图到了再收敛 ready；向导建议 timeout ≤ 110s。
- **后端重启丢任务**：pending 悬挂，靠渲染期 120s 收敛（与云模式现状同级）。
- **Safari 不可用**：WebKit 按混合内容拦回环地址（调研报告 §2），不做特殊处理。
- **双标签竞速**：两标签都认领任务都执行，先回传者胜，后者幂等 200，无副作用。
- **刷新/关页**：任务 45s 后回收认领标记，重新打开页面会被再次认领执行（超时前）。

## 11. 测试计划

**后端 `backend/tests/test_local_image_bridge.py`**（仿 test_image_generation_p0.py 的 TestClient + sqlite 夹具；SSRF 场景仿 test_sd_provider_ssrf.py 的开关控制）：
1. 配置：browser 模式可保存 `http://127.0.0.1:8188`；server 模式同 URL 仍被 400 拒（守卫未松）；execution 非法值回落 server。
2. 端到端（进程内）：browser 配置 + 手动端点 `POST /character-sessions/{sid}/messages/{mid}` → 任务创建 → `GET /local-tasks/pending` 认领到该任务（含 workflow/seed/base_url）→ `POST .../result` 合法 PNG b64 → 端点返回 ok + media ready + URL 指向 generated-images。
3. 失败链：`POST .../fail` → media failed + error 文案透传。
4. 超时链：timeout 压到 0.1s → 504 → media failed。
5. 安全：非属主 result → 404；文本魔数 → 400；超 25MB → 413；重复 result → 幂等 already_done；9 个并发任务 → 最老被取消。
6. `/test` browser 模式 → 400；claim 的 45s 回收（monkeypatch monotonic）。

**前端 vitest（`src/lib/image-gen/__tests__/`）**：
- `comfyui-client.test.ts`：probe 三态（vi.stubGlobal fetch 序列）；execute 全流程（prompt→history 空→done→view blob→b64）；deadline 超时；history error。
- `executor.test.ts`：pollOnce 认领→执行→回传（vi.mock api 模块）；同 task 去重；enabled=false 不拉取。

**回归门禁**：`cd backend && python -m pytest tests/`（基线 1457/42/0，不许出红）；`cd frontend && npx tsc --noEmit`；`cd frontend && npx vitest run`（基线 27 文件 396|3）。

## 12. 改动文件清单（＝备份清单＝提交清单）

**改**：`backend/app/services/image_generation_service.py`、`backend/app/api/image_generation.py`、`backend/app/schemas/image_generation.py`、`frontend/src/types/imageGeneration.ts`、`frontend/src/services/api.ts`、`frontend/src/hooks/useImageGenerationAvailability.ts`、`frontend/src/components/views/SettingsView.tsx`
**增**：`backend/app/services/local_image_bridge.py`、`backend/tests/test_local_image_bridge.py`、`frontend/src/lib/image-gen/comfyui-client.ts`、`frontend/src/lib/image-gen/executor.ts`、`frontend/src/lib/image-gen/__tests__/{comfyui-client,executor}.test.ts`、`frontend/src/components/views/settings-tabs/ImageGenerationTab.tsx`
**零接触**（其他 agent 活跃区）：`backend/app/api/chat.py`、`websocket.py`、`character_ext.py`、`__init__.py`、`frontend/src/utils/sillyTavernPluginRuntime.ts`、`lib/sillytavern/formatting.ts`、`lib/stream-engine/`、`hooks/useChatWebSocket.ts`、`hooks/useCharacterChat.ts`、`lib/messageMedia.ts`

## 13. 回滚

备份目录 `D:\_palink_backup_20260928_localimg\`（改前逐文件复制）；回滚=复制回 + 删除新增文件。无 DB 迁移（配置是 JSON 文件，`execution` 字段向后兼容）。

## 14. 待实机验收清单（代码完成后用户侧）

- [ ] 本机起 ComfyUI（`--enable-cors-header '<站点origin>'`）→ 设置页检测三态正确
- [ ] Chrome 托管域名下首次执行 LNA 弹窗放行后全链闭环（自动出图 / 工具出图 / 手动按钮三路）
- [ ] CORS 未配置时失败文案指引导向正确
