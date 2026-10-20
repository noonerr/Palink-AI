# REPORT 包AG · 批次D — 前端静默 + 后端自动留痕（2026-10-20）

> **状态：代码与测试完成并已过门禁；真机（容器内 JSONL 行数对账）未做，原因见 §6。**
> 施工方：批次 D 对话。分支 `three-tracks-merge-20261012`。
> 派包：`docs/_active/prompt/PROMPT_对话包_批次D与E与H与I_2026-10-20.md`「批次 D」。
> 底本红线：`docs/_active/HANDOFF_提示词_已授权批次_写桥与人设角色库与getContext与服务端留痕_2026-10-20.md` §0 / §D。

## 0. 一句话结论

后端新增只追加留痕端点 `POST /api/diagnostics/records`（JSONL 按天切分、体积/行数/限流三重上限、超限停写不删、`detail`/`stack` 只落长度+摘要）；
前端 `palink-diag.ts` 在**记录器启用**前提下按批节流上传，载荷由 11 键白名单逐键拼装，`detail`/`stack` 结构上进不去，失败静默只试一次。
202 条未实现命令的既有行为（返回空串、前端不弹框）一字未改，只是它们现在会随批落到后端文件里。

## 1. 红线变更（用户已授权，写进代码注释与本节）

| 项 | 变更前（包W） | 变更后（2026-10-20 用户裁决 5） |
|---|---|---|
| 网络面 | 零网络：不 fetch / 不上传，导出只在本地下载 | **记录器启用时**允许 POST 到自家后端留痕；导出仍是本地下载 |

三条硬约束**未放宽**，且各有测试与反证钉住：

1. **闸门仍是 `palinkDiagEnabled()`**（内存覆盖 > localStorage 手动开关 > 本机/内网默认开；外部站点默认关）。
   关闭时 `flushPalinkDiagUpload()` 直接 `skipped='disabled'`，**连载荷都不组装**（`markPendingUpload` 也在闸门后返回）。
   代码位置：`palink-diag.ts` 文件头红线段 + `flushPalinkDiagUpload()` 首段。
2. **只传结构化字段**：`DIAG_UPLOAD_FIELDS` = `owner/kind/name/count/filename/lineno/colno/missingStSubsystem/frameId/cardId/textLength`（11 键）。
   载荷由 `toUploadRecord()` **逐键拼**出来（不是"摊平 record 再删键"），`detail`/`stack` 结构上不可达。
   服务端第二道闸：`_sanitize_record()` 只保留同一份白名单；万一收到 `detail`/`stack`，只写 `detailLength` + `detailHash`（sha256 前 16 位），**原文不落盘**。
3. **失败静默、只试一次**：一次 `fetch`，无重试循环；`catch` 只累加 `failedBatches` 并记 `lastResult`，不抛、不弹框、不写 UI；超时 5s 由 `AbortController` 兜。

## 2. 后端（新增文件 `backend/app/api/diagnostics.py`）

- 路由：`APIRouter(prefix="/api/diagnostics", dependencies=[Depends(csrf_guard)])`，端点 `POST /records`，
  鉴权用既有 `get_current_user`（Bearer 或 `palink_session` Cookie）。注册于 `backend/app/api/__init__.py` 末尾。
- 落盘：`settings.DATA_DIR/diagnostics/records-<UTC 日期>.jsonl`，一行一条 `{"receivedAt","userId","record"}`。
  **只追加**：模块内没有删除/覆盖/轮转删除的代码路径；目录用 `mkdir(parents=True, exist_ok=True)` 新建子目录，
  `backend/data` 既有文件一律不碰（且 `data/` 在 `.gitignore:50`，不会误入库）。
- 上限（全部是"防灌盘"）：单请求体 64KB、单批 100 条、单文件 4MB、单日 20000 行、每用户 30 请求/60 秒。
  到顶行为 = **停写 + 回 `capped=true` + `reason`**，绝不删旧文件。
- 幂等：客户端每批带 `batchId`，内存去重窗口 512 个 ⇒ 重复上传回 `duplicate=true, written=0`。
- 异常面：目录建不出/写失败一律折成 `capped=true, reason=...` 的 200 响应，不抛 500 长栈（开发期留痕不该把前端拖红）。

## 3. 前端（改 `palink-diag.ts` + 一处既有测试改判）

- 新增导出：`DIAG_UPLOAD_ENDPOINT`、`DIAG_UPLOAD_LIMITS`（batchRecords 20 / intervalMs 15s / maxBatches 20 / timeoutMs 5s）、
  `DIAG_UPLOAD_FIELDS`、`scheduleDiagUpload()`、`flushPalinkDiagUpload()`、`diagUploadStats()`。
- `recordPalinkDiag()` 两个分支（新建/同名累加）末尾各加一句 `markPendingUpload(key)`；**没有**改写入语义、去重语义、有界语义。
- 计数语义：载荷里的 `count` 是**自上次上传以来的增量**（`rec.count - uploadedCount`），与帧内上送的增量语义一致，
  避免同一条记录后续变多时服务端把旧次数再算一遍。
- 全局入口新增 `__palinkDiagUploadNow()` / `__palinkDiagUploadStats()`（真机查验用）。
- CSRF：本地 6 行读 `palink_csrf` Cookie（`readCsrfCookie()`），刻意不 import `services/api`，避免把 API 客户端拖进这个被 main/渲染器/脚本 runner 多处引用的模块。
- **既有测试改判**（不是删断言）：`palink-diag-recorder.test.ts` 原断言"模块内不许出现 `fetch(`"，
  在新红线下改判为"`fetch(` 恰好一处，且必须落在 `flushPalinkDiagUpload` 内；`XMLHttpRequest`/`sendBeacon` 仍为零"。
- 静默 catch 基线**未动**：新增的上传路径只引入 0 个静默 catch（`readCsrfCookie` 的 catch 有语句、flush 的 catch 有语句；
  `abort()` 那处原本包的静默 catch 已删——`abort()` 对已完成请求是 no-op 不抛）。基线仍是 7。

## 4. 门禁（原始行）

```
# bash scripts/gate.sh frontend   → 退出码 0
 ✓ 前端 tsc --noEmit
 ✓ 前端 vitest
 Test Files  108 passed (108)
      Tests  1452 passed | 3 skipped (1455)
  全部门禁通过。

# bash scripts/gate.sh backend    → 退出码 0
2249 passed, 23 skipped, 430 warnings in 229.22s (0:03:49)
  ✓ 后端 pytest
  ℹ️ junitxml 显示 failures=0 errors=0
  全部门禁通过。
```

⚠️ 诚实说明：两次门禁跑在**混有并行批次（E 改 `part-07.ts`、新增 `e-package-slash-alias-shape-deltas.test.ts`、改 `f-package-slash-enum-contract.test.ts`）的工作区**上
（108 个测试文件里有 1 个不是我新增的）。我提交时只 `-o --` 自己的 6 个路径，别人的在途文件原样保留。

## 5. 新增/改测试与用例数（单跑）

| 文件 | 形态 | 单跑结果 |
|---|---|---|
| `backend/tests/test_diagnostics_records.py`（新） | pytest | **11 passed**（401/403/413/415/400/幂等/白名单/正文只落摘要/限流 429/按天单文件/浏览器 Cookie+CSRF 通道） |
| `frontend/.../__tests__/palink-diag-upload.test.ts`（新） | vitest | **14 passed** |
| `frontend/.../__tests__/palink-diag-recorder.test.ts`（改 1 条断言） | vitest | 随下条一起跑 |
| 三份记录器测试合跑 | vitest | `Test Files 3 passed (3)` / `Tests 58 passed (58)` |

## 6. 真机对账：**未做到**（不藏）

要求是"本机页面产生记录后，容器内当天 JSONL 行数与前端记录条数对得上"。**没做成，原因是一手核实到的部署事实**：

- `backend` 容器只挂了 `backend/data`、`backend/models`、`backend/tests`（`docker inspect` 实测），
  **`backend/app` 不在挂载里** ⇒ 新增的 `app/api/diagnostics.py` 不在运行中的进程里；`start-server.sh:347` 的 uvicorn **没有 `--reload`**。
- 要让容器内出现这个端点，只能重建镜像或重启后端容器 —— 派包与本批红线明确"禁重启 Docker/容器"，且"动容器/重建镜像权限已移出施工方"。
- 前端侧同理：新代码不在 `frontend/dist`（禁动），:16000 上的页面仍是旧 bundle。

**给主脑的复跑命令**（重建镜像/重启后端后执行，我未执行）：

```bash
# 1) 本机页面（16000）产生若干条记录后，在控制台执行：
#    window.__palinkDiagRecords().length            → N
#    await window.__palinkDiagUploadNow()           → {sent: n, ok: true}
# 2) 容器内当天文件行数：
docker exec palink-ai-backend-1 sh -c 'ls -l /app/data/diagnostics/; wc -l /app/data/diagnostics/records-*.jsonl'
# 期望：文件行数 == 上传成功的记录条数（分批时 = 各批 sent 之和）
```

替代证据（同一条不变式，但走的是 ASGI 进程内真实 HTTP，不是容器）：
`test_browser_path_cookie_plus_csrf_token_writes` 用**前端真实通道**（`palink_session` Cookie + `X-CSRF-Token` 配对）POST 2 条，
断言 `written==2` 且文件恰好 2 行；`test_duplicate_batch_is_not_double_counted` 断言重复批不涨行数。

## 7. 两组反证（原始输出 + 还原）

**反证 A：把闸门改成恒开 ⇒ "外部站点不上传"必红**

```
# 临时在 palinkDiagEnabled() 首行插入 `return true;`
     × 外部站点（默认关）产生记录后：fetch 调用数必须为 0 9ms
     × 手动关（本机站点但用户关了）同样零 fetch 1ms
AssertionError: expected "vi.fn()" to be called +0 times, but got 1 times
AssertionError: expected "vi.fn()" to be called +0 times, but got 1 times
 Test Files  1 failed (1)
```

**反证 B：往上传载荷里塞 `detail` ⇒ 白名单/正文断言必红**

```
# 临时在 toUploadRecord() 里加 `detail: rec.detail,`
AssertionError: expected [ 'cardId', 'colno', 'count', …(9) ] to deeply equal [ 'cardId', 'colno', 'count', …(8) ]
AssertionError: expected '{"batchId":"d-mvg9keci-1","records":[…' not to contain '绝不能上传的正文-A7f3'
AssertionError: expected '{"batchId":"d-mvg9kecl-1","records":[…' not to contain '帧内细节-ShouldNotUpload'
 Test Files  1 failed (1)
```

还原后：`Test Files 1 passed (1)`，且 `git status --short` 里我的路径只剩预期的 6 个（§8 清单），无临时改动残留。

## 8. 本批文件清单（逐项 pathspec 提交）

| 路径 | 性质 |
|---|---|
| `backend/app/api/diagnostics.py` | 新增：只追加留痕端点 |
| `backend/app/api/__init__.py` | 改：注册 router（1 行 import + 1 行 include + 注释） |
| `backend/tests/test_diagnostics_records.py` | 新增：11 用例 |
| `frontend/src/components/ui/custom/smart-card-runtime/palink-diag.ts` | 改：红线段改判 + 上传实现 + 两个全局入口 |
| `frontend/src/components/ui/custom/smart-card-runtime/__tests__/palink-diag-upload.test.ts` | 新增：14 用例 |
| `frontend/src/components/ui/custom/smart-card-runtime/__tests__/palink-diag-recorder.test.ts` | 改：1 条断言按新红线改判 |

**未碰**：`frontend/dist*`、`runtime-body/part-07.ts`/`part-08.ts`/`part-01.ts`（E、H 在改）、Docker/容器、任何付费 API、`_BACKUPS/`、`.workbuddy-ai/`、`backend/data` 既有文件。

## 9. 未做 / 做不到清单

1. **容器内真机对账**：§6，受"禁重启容器 + app 未挂载"所限，交由主脑重建后复跑。
2. **`backend/data/diagnostics/` 的 git 跟踪**：`data/` 在 `.gitignore:50` 内，本批不新增跟踪规则（留痕是运行时产物，不该入库）。
3. 上传的**跨会话持久化配额**：批次配额/去重窗口都在内存里，进程重启即清零。开发期够用，没做落盘配额（有意，写在这里而不是假装有）。
