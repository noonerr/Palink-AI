# SillyTavern 多用户隔离 + 按需插件加载 机制分析

> 分析对象：`zhaiiker/SillyTavernMOD`（已 clone 到 `community-st-forks/zhaiiker-SillyTavernMOD`，depth=1）
> 对比基线：工作区内已存在的 `SillyTavern-1.18.0/SillyTavern-1.18.0/`（原生 ST 1.18.0）
> 日期：2026-07-25

## 0. 结论速览（先说人话）

你之前用的“社区版 ST 多用户 + 按需加载插件”，其实**核心机制是 ST 自 1.12.0 起就内置的**，不是社区 fork 自己发明的黑科技。社区版只是在这之上加了：
- OAuth 登录（weetown/SillyTavernchat 加了 GitHub/Discord/Linux.do 登录）
- 更顺手的账号管理 UI / 管理员面板（zhaiiker MOD）

关键澄清：
- **多用户登录隔离** = 每个用户一个独立数据命名空间 `DATA_ROOT/<handle>/...` + 各自一份 `settings.json`（含插件启用列表）。
- **“按需加载插件”** = **用户粒度**的开关（每个账号只启用自己勾选的扩展），**不是**按消息/按角色卡的懒加载。所有“对本用户启用”的扩展仍然在页面启动时一次性加载并常驻。

---

## 1. 多用户登录隔离是怎么做到的

### 1.1 开关与账号存储
- 配置项 `enableUserAccounts: true`（`src/users.js:29`）。原生 1.18.0 同样支持。
- 账号存于 `node-persist`（`src/users.js:556 initUserStorage`，存到 `DATA_ROOT/_storage`）。
- 密码用 **scrypt** 加盐哈希：`getPasswordHash = crypto.scryptSync(password.normalize(), salt, 64)`（`src/users.js:644`），salt 16 字节随机（`getPasswordSalt`，`:604`）。**不是明文，也不是单一共享账号**。

### 1.2 每个用户一套独立目录（隔离核心）
`USER_DIRECTORY_TEMPLATE` 定义了 30+ 个子目录（角色、聊天、群聊、背景、扩展、设置……），`getUserDirectories(handle)`（`src/users.js:683`）把它们全部映射到：

```
DATA_ROOT/<handle>/characters/
DATA_ROOT/<handle>/chats/
DATA_ROOT/<handle>/extensions/        ← 每个用户自己的扩展代码目录
DATA_ROOT/<handle>/settings.json      ← 含 extension_settings（启用列表）
...
```

注意 `handle` 来自登录会话 `request.session.handle`（`:973`）。

### 1.3 请求级注入与越权防护
- 中间件 `setUserDataMiddleware`（`src/users.js:955`）：把 `request.user = { profile, directories }` 挂到请求上。
- 所有静态/数据路由都用 `createRouteHandler(req => req.user.directories.xxx)`（`src/users.js:1213-1218`）从**当前用户目录**解析路径，并用 `isPathUnderParent` 防穿越（`:1071`）。用户 A 读不到用户 B 的文件。
- 会话版本哈希：密码变更后 `getAccountVersion` 变化，旧 session 被 403 失效（`src/users.js:994-1000`）。
- 管理员 `requireAdminMiddleware`（`:1129`）、登录 `requireLoginMiddleware`（`:1027`）。

### 1.4 认证方式
- 内置：用户名+密码（scrypt 校验）。
- 单用户无密码自动登录（`singleUserLogin`，`:782`）。
- SSO 信任头（Authelia/Authentik，`autheliaUserLogin`/`authentikUserLogin`，`:805`/`:815`），需 `trustedProxies` 配置。
- Basic Auth 可按用户：`src/middleware/basicAuth.js:62` 走 `PER_USER_BASIC_AUTH && ENABLE_ACCOUNTS`，逐用户比对 scrypt 哈希。
- 速率限制：Basic Auth 失败 `RateLimiterMemory`（`:18`）。

---

## 2. “按需加载插件”到底指什么 —— 两层插件系统

ST 其实有**两套**插件机制，要分开看：

### 2.1 服务端插件（`src/plugin-loader.js`）—— 全局、启动即加载、所有用户共享
- `loadPlugins(app, pluginsPath)`（`plugin-loader.js:40`）在**服务器启动时**一次性 `import()` 全部插件（`:153`），注册到 `app.use('/api/plugins/:id', router)`（`:222`）。
- 由 `enableServerPlugins` 开关控制（默认 false，`:10`）。
- **这是全局的，不分用户**。-administrators 装一次，所有人共享。跟“按需/分用户”无关。

### 2.2 前端扩展（extensions）—— 这是“多用户 + 按需”真正发生的地方
代码目录在 `public/scripts/extensions.js` + 后端 `src/endpoints/extensions.js`。

#### (a) 每个用户有独立的扩展代码目录
- 普通用户安装：`POST /api/extensions/install` → 落到 `request.user.directories.extensions`（`src/endpoints/extensions.js:121`）。
- 管理员可装“全局”扩展：`global: true` → 落到共享的 `PUBLIC_DIRECTORIES.globalExtensions`（`:121`），但需 `request.user.profile.admin`（`:96`）。
- 服务路由：`/scripts/extensions/third-party/*` 由 `createExtensionsRouteHandler` 解析到 `req.user.directories.extensions`，找不到时回退到 `globalExtensions`（`src/users.js:1092-1119`）。**所以每个登录用户拉到的扩展文件，是他自己目录里的那份；同名时本用户本地副本优先于全局**（`:503-508` discover 逻辑）。

#### (b) 启用列表（enabled set）是**每用户**的
- 前端 `initExtensions()`（`public/scripts/extensions.js:2293`）遍历 discover 到的扩展。
- 对每个扩展：`isDisabled = extension_settings.disabledExtensions.includes(name)`（`:626`）。
- 仅当 `!isDisabled` 才 `addExtensionScript` + 触发 `activate` 钩子（`:628-638`）。
- `extension_settings` 从**当前用户自己的** `settings.json` 合并而来（`public/scripts/extensions.js:1784-1785`：`Object.assign(extension_settings, settings.extension_settings)`）。因为 `settings.json` 在 `request.user.directories.root` 下，所以这份禁用列表天然是每用户独立的。

> 这就是“按需加载”的真实含义：**每个账号只加载/激活自己勾选启用的扩展**。未启用的扩展代码即使装在本地也不会被 import/activate。但**不是**按消息或按角色卡的惰性调用——一旦启用，页面启动就常驻监听事件。

---

## 3. 插件冲突在“多用户”下变好了吗？

**没有本质改善，只是隔离粒度变了：**
- **跨用户**：因为启用列表 + 代码目录都是每用户独立，用户 A 启用的扩展不会污染用户 B 的运行时。这是多用户带来唯一的好处。
- **同用户内部**：之前分析过的软冲突依然存在——
  - 事件总线是裸 `EventEmitter`（`events.js`），多个扩展监听同一事件会叠加，无优先级仲裁。
  - 宏注册重名 = 静默覆盖（`MacroRegistry.js:306`）。
  - 各扩展 `try/catch` 只做加载隔离，运行期逻辑冲突不报错只漂移。
- 所以“按需”解决的是**装太多/不想用**的问题，不解决**已启用扩展之间互相打架**的问题。

---

## 4. 与 Palink-AI 的对照

| 维度 | SillyTavern（含社区 fork） | Palink-AI |
|---|---|---|
| 多用户隔离 | `enableUserAccounts` + `DATA_ROOT/<handle>/` 命名空间 + 每用户 `settings.json` | 原生 `User` 模型 + `get_current_user` + 每用户目录（如 `data/uploads/1/`） |
| 状态面板（心情/动作/状态） | 依赖社区前端扩展，或让模型每次重复 markdown 表格 | **后端内置服务** `status_bar_detector.py`，用户零配置 |
| 插件模型 | 前端 extensions（每用户启用列表）+ 服务端 plugins（全局） | `plugins.py` 复刻 ST 扩展模型 + 沙箱 + 每插件命名空间 |
| “按需加载” | 用户粒度开关（`disabledExtensions`） | 后端服务常驻；插件可参照 ST 做每用户启用列表 |
| 插件冲突 | 跨用户隔离；同用户内软冲突依旧 | 状态面板走内置服务，**无插件冲突面**；导入型插件仍受 ST 式软冲突影响 |

**结构性优势**：Palink 把“状态面板”做成后端内置服务而非插件，等于砍掉了 ST 上最大的一块社区插件依赖——用户不用装、不用启用、不会遇到插件冲突。这正是你项目比社区 ST 更省心的地方。

**可借鉴点**：若 Palink 未来要支持“每用户启用不同插件”，ST 的做法是直接复用——把每个用户的 `disabledExtensions` 存进该用户的 settings（Palink 已有每用户 settings 载体），前端/后端加载时跳过禁用项即可。

---

## 5. 关键代码索引（便于回查）

| 位置 | 内容 |
|---|---|
| `src/users.js:29` | `ENABLE_ACCOUNTS` 开关 |
| `src/users.js:644` | scrypt 密码哈希 |
| `src/users.js:683` | `getUserDirectories` 每用户目录命名空间 |
| `src/users.js:955` | `setUserDataMiddleware` 请求级注入 |
| `src/users.js:1092` | 每用户扩展路由（带全局回退） |
| `src/users.js:1213` | 各数据路由从 `req.user.directories` 解析 |
| `src/endpoints/extensions.js:92` | `/install` 每用户 vs 全局（admin） |
| `src/endpoints/extensions.js:480` | `/discover` 合并 built-in + local + global |
| `src/plugin-loader.js:40` | 服务端插件：全局、启动即加载 |
| `public/scripts/extensions.js:626` | `isDisabled` 判定（每用户 `disabledExtensions`） |
| `public/scripts/extensions.js:2293` | `initExtensions` 入口 |

---

## 6. 对你之前疑问的修正

- 之前我们说“ST 是单用户的”——准确说是**默认单用户模式**，但原生 ST 1.12.0+ 已内置多用户（`enableUserAccounts`）。你工作区里的 `SillyTavern-1.18.0` 副本同样支持，并非社区 fork 独有。
- “没有按需调用吗 ST？”——对**单条消息/单个角色卡**而言确实没有惰性调用；但**多用户场景下“按账号按需启用插件”是有的**，就是上面的 `disabledExtensions` 机制。这两件事不要混为一谈。
