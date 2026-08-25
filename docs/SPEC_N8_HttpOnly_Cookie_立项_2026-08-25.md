# SPEC — N-8 本体：JWT 迁移 HttpOnly Cookie + CSRF 配套（认证体系架构级）

> 日期：2026-08-25 立项
> 前置：滑动续期（X-Palink-Token-Refresh）已上线并稳定运行；upload-scope 短令牌通道
> 已隔离（N-7）；jti 黑名单基建现成。
> **本 spec 为完整施工规格**。规模提示：这是认证体系迁移，涉及登录/登出/刷新/API 层/
> WebSocket ticket 全链路，预计为近期最大单批次。建议单 agent 专职施工 + 审计线全程
> 高频验收（至少三次中途检查点）。

---

## 0. 目标与非目标

**目标**：长效凭据（主 JWT）不再可被 JavaScript 读取——XSS 即使发生也无法窃取
长效身份；配合已有 upload 短令牌，XSS 可触达面收敛到"当次请求伪造"。

**非目标**：
1. 不消灭 XSS 本身（那是持续的安全卫生工作，P3 池继续）
2. 不改 upload 短令牌通道（N-7 成果保持）
3. 不做 OAuth 第三方登录扩展（现有 auth.py 的 OAuth 流仅适配响应头，不动其核心）
4. 不删除 localStorage 兼容路径（双轨过渡期保留，见 §5 时间线）

## 1. 目标架构

```
登录 POST /api/token
  ├─ 响应体 {access_token, token_type}     ← 双轨期保留（旧前端兼容）
  └─ Set-Cookie: palink_session=<jwt>; HttpOnly; Secure*; SameSite=Lax;
                 Path=/; Max-Age=720min    ← 新增，* Secure 仅 https

后续所有 API 请求
  ├─ 双轨期：Authorization Bearer 头（存量）与 Cookie 并存均可通过鉴权
  └─ 终态：仅 Cookie

CSRF 防护
  ├─ 登录成功时另发 csrf_token（非 HttpOnly，可读——它必须配同源 Cookie 使用，
  │   被读不构成威胁）+ Set-Cookie palink_csrf（HttpOnly=false, SameSite=Lax）
  └─ 所有 mutating 请求（POST/PUT/PATCH/DELETE）要求 X-CSRF-Token 头 == palink_csrf
      cookie 值；不一致 → 403

登出 POST /api/auth/logout
  └─ 清 Cookie + jti 拉黑（既有逻辑）
```

**为什么 CSRF token 放可读存储是安全的**：CSRF 攻击模型是"攻击者诱导受害者浏览器
发出跨站请求"，攻击者无法读取响应也无法读同源 storage，因此拿不到配对值；
而 XSS 能读到 csrf_token 却已经能直接发同源请求——CSRF 防护对 XSS 无意义，
对跨站有意义。两层各防各的。

## 2. 后端改动

### 2.1 auth.py 登录/登出

```python
# POST /api/token 成功分支追加：
resp = JSONResponse(content={"access_token": token, "token_type": "bearer"})
resp.set_cookie(
    "palink_session", token,
    max_age=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    httponly=True, secure=settings.APP_ENV == "production",
    samesite="lax", path="/",
)
resp.set_cookie("palink_csrf", secrets.token_urlsafe(32),
                max_age=..., httponly=False, samesite="lax", path="/")
return resp
```

- logout：`delete_cookie("palink_session")` + `delete_cookie("palink_csrf")`
  （jti 拉黑逻辑已在）

### 2.2 dependencies.py get_current_user 双轨鉴权

```
token 来源优先级：Authorization Bearer 头 → palink_session Cookie
（oauth2_scheme 改 auto_error=False 或改手动提取；两者皆无 → 401）
```

### 2.3 CSRF 中间件（main.py，复用滑动续期中间件旁新增）

```
mutating method 且路径非 /api/uploads/*（短令牌自有隔离）且非 /api/token（登录本身）:
  通过条件（满足其一即可，OR 语义）：
  a) header X-CSRF-Token == cookie palink_csrf 值（标准双提交校验）
  b) [插件兼容兜底] Origin 头存在且 host 与部署站点同源
     ——浏览器对同源 fetch 必带同源 Origin；跨站表单/img 伪造必带外站 Origin
       或不带 Origin，故此兜底不削弱防护强度
  否则 403
GET/HEAD/OPTIONS 豁免
```

**Origin 兜底的必要性（插件兼容性评审结论，2026-08-25）**：主页面上下文插件
（getContext/沙箱轨）可能绕过 api.ts 以裸 `fetch(..., {method:'POST'})` 发起
mutating 请求——不会携带 X-CSRF-Token 头。若无 Origin 兜底，此类插件在终态后
批量 403。同源 Origin 校验对真正的跨站 CSRF（外站表单）依然有效，防护不打折，
插件零适配。trusted-native 同源 iframe 内的裸 POST 同样被覆盖。

- 滑动续期中间件保持不动；续期头照常输出（前端落地的是新 JWT 到 Cookie 的更新由
  §2.4 承担，见下）

### 2.4 滑动续期的 Cookie 化适配

续期中间件在写 `X-Palink-Token-Refresh` 头的同时，**同步重设 palink_session Cookie**
（Set-Cookie 覆盖）——Cookie 通道的续期不需要 JS 参与，这正是 HttpOnly 的优势。
前端拦截器逻辑保留（双轨期兼容），终态可移除。

### 2.5 WS ticket 与特殊通道

- `/api/ws/*` ticket 端点：签发时接受 Cookie 鉴权（ticket 本身仍是一次性短时效，
  架构不变）
- uploads query 短令牌：不动（N-7 隔离设计）
- openai_compat service_key：不动

## 3. 前端改动

### 3.1 api.ts

- 双轨期：request() 继续带 Authorization 头（localStorage 有则带）+ **补
  `credentials: 'include'`（或 axios withCredentials: true）+ X-CSRF-Token 头**
  （从 document.cookie 读 palink_csrf）
- 收到 X-Palink-Token-Refresh 时：除 localStorage 外**无需操作 Cookie**（服务端已
  Set-Cookie）；csrf_token 若随响应轮换则同步更新本地副本

### 3.2 App.tsx 登录/登出

- 登录：保留 access_token 入 localStorage（双轨期）+ 记录 csrf_token；
  终态移除 localStorage 写入
- 登出：调后端清 Cookie + 本地清理

### 3.3 特殊通道逐一适配（18 处 localStorage 直读的分派）

| 通道 | 适配方式 |
|------|---------|
| WS ticket（useChatWebSocket/api.ts） | fetch 带 credentials 即可，Cookie 自动携带 |
| SillyTavernIframe / getContext / sillyTavernPluginRuntime / primitives（4 处直读拼 Authorization） | 这些是**同源 fetch/XHR**——改为 credentials:'include' 依赖 Cookie，删 token 拼接 |
| usePushToTalk / tts（音频流 fetch） | 同上 credentials 化 |
| CharacterView:67（下载链接拼 query？需施工时确认具体形态） | 若为 uploads 走 N-7 短令牌通道；若是普通下载走 credentials |
| smart-card primitives:746 | iframe 内代码无法依赖父域 Cookie——**此通道保留 token 显式传递**（postMessage 由父页下发短时效副本或维持现状），施工时单独评估并在报告说明取舍 |

### 3.4 测试基建

- 既有 pytest 用 TestClient 直传 Authorization 头——双轨期内不受影响（Bearer 仍有效）；
  新增 Cookie 通路测试（login → cookie jar → 带 Cookie 访问受保护端点）
- CSRF 中间件测试：mutating 无头 403 / 头匹配 200 / GET 豁免 / uploads 豁免

## 4. 安全评审清单（审计线验收重点）

- [ ] Set-Cookie 三属性齐备（HttpOnly/Secure-prod/SameSite=Lax）
- [ ] CSRF 中间件覆盖全部 mutating 方法与豁免表正确
- [ ] 双轨期结束后（终态）grep `localStorage.getItem('palink_token')` 归零
      （primitives 特例除外且有书面取舍）
- [ ] 滑动续期在 Cookie 通道正常工作（Set-Cookie 覆盖断言）
- [ ] CORS allow_credentials 与 origins 配置一致性检查（不得 '*'+credentials 组合）
- [ ] 登出后 Cookie 清理 + jti 拉黑双确认
- [ ] WS ticket 经 Cookie 鉴权全链路通

## 5. 分阶段时间线（建议三批提交，每批独立可回滚）

| 批次 | 内容 | 出口条件 |
|------|------|---------|
| **N8-a** | 后端：Cookie 签发 + 双轨鉴权 + CSRF 中间件 + 续期 Cookie 化 + 全部后端测试 | 宿主全绿；curl 场景手测四态 |
| **N8-b** | 前端：credentials/csrf 头/登录登出适配 + 18 处直读分派 + 契约测试 | tsc 干净；build 产物核验 |
| **N8-c** | 终态切换：移除 localStorage 兼容（primitives 取舍定稿）+ grep 归零 + 文档 | 全绿 + 手测清单 |

N8-a/N8-b 之间系统处于双轨稳定态，可任意停留。

## 6. 风险与缓解

1. **CORS 配置**：allow_credentials=true 时 allow_origins 不得为 '*'——当前配置
   单一 origin 时已正确，多 origin 场景施工时复核 main.py:299 的条件逻辑
2. **SameSite=Lax 对 WS ticket fetch 的影响**：Lax 允许同站子资源携带，同源部署
   无影响；若未来跨子域部署需升级 SameSite=None; Secure
3. **移动端/嵌入式 WebView**：若存在第三方 WebView 客户端依赖 query token，双轨期
   不破坏；终态前需盘点（当前未知有此类客户端）
