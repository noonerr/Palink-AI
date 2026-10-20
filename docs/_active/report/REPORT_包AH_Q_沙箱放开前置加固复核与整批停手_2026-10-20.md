# REPORT — 包AH · 批次 Q（卡片读主页面 + 凭据加固）· **停手待裁**

> **状态：Q-1 判据不可达 ⇒ 按硬规矩整批停手，未写一行代码，未放开沙箱。**
> 执行方：零上下文执行方（分支 `three-tracks-merge-20261012`，HEAD `99d65c5`）。
> 复核方：Qoder「分配分包派遣任务」会话（主脑）。
> 依据：`docs/_active/prompt/PROMPT_对话包_批次P预设分身与Q沙箱放开与R插件_2026-10-20.md`（只做 Q）、
> 该件所引用户 2026-10-20 三条裁定、台账 `docs/_active/spec/SPEC_向ST学习的子系统缺口与标记方案_2026-10-19.md` §2.2。
> 批次 P / R 未触碰（未解锁）。

## 0. 一句话结论

**任务书 Q-1 的前提（"有一枚登录凭据 cookie 是 `httponly=False`，把它挪出 JS 可达范围即可放开沙箱"）与代码事实不符。**
JS 可读的那枚是 CSRF 双提交配对值，不是凭据；真正的会话 cookie 早已 `httponly=True`。
更关键：**`allow-same-origin` 一旦给出，`HttpOnly` 与 CSRF 令牌都不构成防线** —— 卡不需要"偷 token"，
它直接以登录用户身份调 `/api/*`（GET 全通；POST 因"同源 Origin 直接放行"而过闸）。
因此 Q-1 的两种改法 (a)(b) 都**无法**让"陌生卡读不到凭据"这条断言变绿，写它等于自欺。

## 1. 三处任务书 ↔ 代码不符（逐条 file:line）

| # | 任务书说法 | 代码事实 |
|---|---|---|
| 1 | "登录凭据目前有一枚 cookie 是 `httponly=False`（`auth.py:153-158`）" | `auth.py:153-160` 下发的是 **`palink_csrf`**（`CSRF_COOKIE_NAME`，`httponly=False` 是双提交设计的**必要**条件）。它是配对值，**不是访问令牌**。 |
| 2 | "同文件 `:310-315` 那枚才是 `httponly=True`" | `:306-317` 那枚是 **`oauth_state`**（OAuth 临时态，`max_age=600`）。它是 `httponly=True` 没错，但**不是**"另一枚登录凭据"，构不成对照。 |
| 3 | "访问令牌 / 刷新令牌 二选一" | 本仓**没有刷新令牌**。会话令牌唯一来源是 `dependencies.py:20-30` 的 `set_session_cookie()`：`httponly=True`、`secure=(APP_ENV=='production')`、`samesite=lax`、`path=/`。`ACCESS_TOKEN_EXPIRE_MINUTES` + 服务端滑动续期，前端不持有任何可读凭据（`frontend/src/services/api.ts:129-131` 明写）。 |

⇒ **Q-1 第 1 步"核清三枚 cookie"的答案是：`palink_session`（HttpOnly，真凭据）/ `palink_csrf`（可读，配对值）/ `oauth_state`（HttpOnly，OAuth 临时态）。加固对象并不存在。**

## 2. 决定性证据：为什么"改 cookie"救不了 `allow-same-origin`

### 2.1 同源 Origin 直接过 CSRF 闸（不需要令牌）

`backend/app/main.py:386-461` 全局 CSRF 中间件，强制区通过条件是 **OR 语义**（`:399-403` 自述）：

- a) 标准双提交：`X-CSRF-Token` == `palink_csrf`（`:439-446`）；
- b) **`Origin` 同源即放行**（`:448-452`，判定函数 `core/csrf_guard.py:29-49`：`Origin.host == Host` 即 `True`）。

⇒ 把 `palink_csrf` 改成 `httponly=True`（方案 a 的一半），同源卡发 `fetch('/api/xxx',{method:'POST'})`
浏览器自动带同源 `Origin`，**走 b 分支直接放行**。加固收益 = 0。

### 2.2 帧内 fetch 只白名单少数 ST 端点，其余真发

`runtime-body/part-06.ts:714-721`：`setCompatFunction('fetch', …)` 先问 `handleStApiFetchCompat`，
命中 `/api/worldinfo|world-info`、`/api/groups`、`/api/backends|status|tokenizers`（`:700-711`）才本地应答，
**其余一律落 `nativeFetchCompat` 真发**。

⇒ 同源后，卡内 `fetch('/api/characters')` / `/api/chats/*` / `/api/settings/get` 都是真网络 + 真 Cookie +
可读响应体（同源无 CORS 限制）。当前之所以安全，靠的正是 opaque origin：跨源 fetch 默认
`credentials:'same-origin'` ⇒ **不带** cookie，且响应不可读。

### 2.3 srcdoc ⇒ 给 `allow-same-origin` 就是**真同源**，不是"新源"

`CharacterCardRenderer.tsx:476`（`srcDocHtml`）+ `:1379-1383`（sandbox 计算点）。
srcdoc 继承父文档 origin ⇒ `allow-same-origin` 之后 `parent.document` / `parent.localStorage` /
`parent.fetch` 全部可达。帧内**无任何 CSP**（`Content-Security-Policy` 在
`smart-card-runtime/` 与 `CharacterCardRenderer.tsx` 全 0 命中）⇒ 没有 `connect-src` 之类的第二道闸。

### 2.4 现有保护的真实来源

`CharacterCardRenderer.tsx:1355-1364` 的 P1-1 注释写的就是这件事：未授信帧只给 `allow-scripts` ⇒
opaque origin ⇒ `parent` / `localStorage` / cookie 全不可达。**这条保护与 cookie 属性无关，与 sandbox 字符串有关。**

## 3. Q-1 两个方案为什么都不满足判据

| 方案 | 能否让"陌生卡读不到凭据"变绿 | 原因 |
|---|---|---|
| (a) 改 `httponly=True` + 前端内存持有 + 拦截注入 | **不能** | §2.1 同源 Origin 已过闸；§2.2 卡直接真发 GET 读全量数据。它连 token 都不需要。而且 `palink_csrf` 改 HttpOnly 会直接打断 `api.ts:139-146` 的 `getCsrfToken()`，等于用一个**无效**加固换一次登录链路风险。 |
| (b) 保留 cookie、把"卡片可读的父页面范围"限制在展示区（脱敏/影子 DOM） | **不能** | 攻击面不是"父页面 DOM 里有什么可读"，而是 **API 与 `parent.*`**。把展示区脱敏，`fetch('/api/settings/get')` 照样读全部设置。脱敏治的是"读屏"，不是"读库"。 |

⇒ **Q-1 判据（"加固后跑一次真实登录 + 刷新 + 一次生成流程仍可用" 与 "陌生卡读不到任何 cookie/localStorage 令牌"）在 `allow-same-origin` 前提下不可同时成立。**
按用户硬规矩：**不通 ⇒ 整批停手回报，不许先放开沙箱再补。** 本报告即回报，Q-2 一行未动。

## 4. 三条可选路径（请主脑裁一条；我不动手）

### 方案 B（推荐）· 不放开 same-origin，把"读主页面"做成父侧服务
- sandbox 字符串**不动**（`allow-scripts` + 四项能力，opaque origin）。
- `retrieveDisplayedMessage` 帧内 → `requestParent` → 父侧 `document.querySelector` 取目标消息节点 →
  返回**脱敏 HTML 快照**（剥 `data-*`、内联事件、`script`）→ 帧内 `DOMParser` 造元素返回。
- 产品语义达成："默认不需要逐卡点信任就能读那条消息"。凭据暴露面 = 0（与今天完全一致）。
- 代价：1 天级；动 `part-07.ts` + `SmartCardCompatController.ts`；**不动 sandbox、不动 dist**。
- 必须登记的偏差：ST 返回**活** `HTMLElement`，我们返回**快照**（`MutationObserver` / 事件监听不活）。
  批前应先 grep 真实卡对 `retrieveDisplayedMessage` 的用法，确认没有卡依赖活节点。
- 反证设计：父侧不发快照（注入 `null`）⇒ "能取到消息文本"那条必须红。

### 方案 A（真放开，代价最高，且与 Q-2 目标冲突）
- 卡帧迁**独立源**（`cards.<host>` 或独立端口，用 `src` 而非 srcdoc）⇒ cookie 天然不随行。
- 但 `parent.document` 从此不可达 ⇒ "读主页面 DOM"仍须改走快照（等于方案 B 再加一次迁移）。
- 且要动 nginx / dist 装配 ⇒ 撞"禁动 `frontend/dist`、禁重启 Docker"两条红线，本批不可行。

### 方案 C（用户裁定里已写好的降级分支）· 仅本机/内网默认放开
- 需要主脑定**开关形态**。建议：配置项 `CARD_SANDBOX_OPEN`（默认 **关**），部署时显式打开，
  **不要**用运行时判 `request.client.host` / `X-Forwarded-For`（反代后可伪造，且判定点分散在前后端两处）。
- 打开后必须同时做：① 导入卡时明示"此卡可完全控制你的账号"；② 记录"当前部署为放开模式"的启动留痕。
- 注意：C 是"真放开"，§2 的威胁全部生效，只是把受害者范围限制在非公网。

**建议组合**：C（默认关的显式开关，给内网/单机用户）+ B（默认路径下也能读那条消息）。
两者不冲突，且都不需要动 cookie。

## 5. 本批实际产出（无代码）

- 门禁（只跑与本批直接相关的两条守门测试，全量未跑因无改动）：
  ```
  npx vitest run src/services/__tests__/api-csrf-credentials-contract.test.ts \
                 src/components/ui/custom/smart-card-runtime/__tests__/st-gap-ledger-guard.test.ts
  RC=0
  ✓ api-csrf-credentials-contract.test.ts (16 tests)
  ✓ st-gap-ledger-guard.test.ts (17 tests)
  Test Files  2 passed (2)
  Tests  33 passed (33)
  ```
- 逐文件用例数：16 / 17（合计 33，`failed=0`、`errors=0`）。
- 两组反证：**不适用**（未写码）。设计已写在 §4 方案 B 末条，批准后执行。
- `git show --stat` 边界比对：**无提交**（未写码，按纪律不空提交）。工作区仅 `.workbuddy-ai/memory/*` 既有改动与本报告新增。
- 真机读数：**未取到**。`http://localhost:16000/` 实测 `curl` 返回 `000`（不可达），
  而"禁止重启 Docker"⇒ 无法自行拉起。故 `TavernHelper=144` / `getContext()=196` / `commands=509` /
  每帧插件 CSS 5/5 / `window.context===undefined` **全部标"未取"**，不以记忆值充数。
- 旁路构建 / dev 探针：未启动（无新代码要验）。

## 6. 顺手发现（不改代码也成立，建议写进放开前的用户提示）

**`trusted-native` 卡今天就已经是 `allow-same-origin`**（`CharacterCardRenderer.tsx:1381-1382`），
⇒ 它**已经**具备 §2 的全部能力：读 `parent.document`、读 `parent.localStorage`、以你的身份调任意 `/api/*`。
换言之，**当前"信任这张卡"的实际语义 = "把你的账号交给这张卡"**，而 UI 文案（`:1394` 的信任入口）没有这么说。
这不是本批引入的，但它是"默认全放开"决策必须先看见的事实。

## 7. 未做 / 做不到

| 项 | 状态 | 原因 |
|---|---|---|
| Q-1 加固落地 | **未做** | 前提不成立（§1–§3），等主脑选路径 |
| Q-2 sandbox 放开 | **未做** | 硬规矩：加固不通不许先放开 |
| `retrieveDisplayedMessage` 接真实现 | **未做** | 属 Q-2，且实现形态取决于方案 B/A 选择 |
| 反证两组 | **做不到（本批）** | 无代码可回退 |
| 真机零回归读数 | **做不到** | 16000 不可达 + 禁重启 Docker |
| P / R 批 | **未动** | 未解锁 |

## 8. 等主脑回的三件事

1. 选 **B** / **A** / **C**（或"C 先上、B 做默认放开实现"）。
2. 若选 C：开关名与默认值是否按 §4 建议（`CARD_SANDBOX_OPEN`，默认关）。
3. 若选 B：`retrieveDisplayedMessage` 的"快照 vs 活节点"偏差是否接受（这决定要不要先做卡侧用法普查）。
