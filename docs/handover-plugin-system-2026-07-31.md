# Palink-AI 插件系统交接文档

**文档日期**：2026-07-31
**适用范围**：前端插件系统（`sillytavern_extension` 类型 ST 扩展的兼容 / 执行 / 渲染）这条线
**状态**：2026-07-30 完成一轮"样例插件渲染"专项排查与修复，现已部署验证通过

> 给接手同事：本文件聚焦**前端插件系统**这一条线。Palink 的群聊、角色扮演后端、ST 协议兼容（后端侧）等不在此详述，详见 `docs/` 下对应分析文档（如 `st_group_chat_gap_analysis.md`、`PALINK_ST_COMPAT_EXECUTION_SPEC.md`、`st_plugin_full_compat_feasibility.md` 等）。

---

## 0. 给非技术读者的摘要
- Palink 有一套"插件系统"，兼容 SillyTavern（开源角色扮演前端）的第三方扩展。
- 2026-07-30 我们让一个**样例插件模板**成功在 Palink 前端渲染并注入设置面板。过程中踩了 4 层坑（数据没入库 → ESM 注入崩溃 → 默认视图没挂载点 → 模块路径解析 bug），已全部修复并部署。
- 当前样例模板已可运行；但**深度插件（小白X / 酒馆助手）仍只能走 opt-in 的 ST 原生逃生舱**，Palink 原生 UI 无法 100% 兼容——这是架构限制，不是工程偷懒。
- 已知待办：事件总线激活、逃生舱 E2E 验证、AGPL 许可合规确认。

---

## 1. 项目整体架构速览
- 技术栈：前端 React + Vite（容器化 nginx 静态服务）；后端 Python / FastAPI；PostgreSQL；另含一个可选的 SillyTavern sidecar 容器。
- 编排：`docker-compose.yml`，四个服务 `frontend / backend / db / sillytavern`。
- 访问：**主 Web UI = http://localhost:3000**（前端主机端口从原 3100 改为 3000，因 Windows 把 3014–3113 标为保留端口导致 bind 失败）。次端口 9000 路由返回 500，不影响主 UI。
- 角色扮演后端为**纯 Python 原生实现**（非调用外部 ST），核心 `backend/app/services/roleplay_prompt_assembly.py`。
- 双模式：`user_setting.silly_tavern_mode` = `st-compat`（高保真对齐 ST 1.18.0）/ `palink-native`（默认，自有标签格式）。
- 与 ST 的关系：Palink 复刻了 ST 的扩展模型与常用 API 子集，但**保持自有后端 / UI**；ST 只作为"深度插件逃生舱"（opt-in）。

---

## 2. 插件系统架构（核心知识）

### 2.1 后端：插件如何入库与下发
- 插件是**从 zip 导入、资源入库**，不是目录扫描。
- 上传入口：前端 **设置 → 管理员 → 插件管理**（`AdminPluginsTab.tsx`）的「导入插件」按钮 → `POST /api/plugins/import`（`backend/app/api/plugins.py:1027`，需 admin 鉴权）。**这是 zip 上传唯一入口**，支持 SillyTavern manifest.json / 扩展 zip。
- 角色扮演区的「插件管理」（`PluginManager.tsx`）**只有 URL 安装框**（代理到 ST sidecar），无 zip 上传。
- 导入逻辑 `_import_sillytavern_extension_zip`（plugins.py:290）校验 manifest → 提取 js/css/templates/modules/assets → 入库 `Plugin(plugin_type='sillytavern_extension', enabled=True, config.runtime={'enabled':True,'execute_scripts':True,'global_runtime':True})`。
- **关键数据结构**：`config` 字段里 `resources.js/modules` 每项含两个路径：
  - `path`：**已剥掉 zip 顶层目录**（`index.js` / `core/constants.js`）
  - `zip_path`：**保留真实顶层目录**（`palink-sample-extension/index.js` / `palink-sample-extension/core/constants.js`）
  - ⚠️ 前端 `manager.ts` 必须按 `zip_path` 推断前缀（见 §3.4 真因）。
- 下发：前端 `pluginManager.discover()` 拉 `GET /api/plugins/runtime/config`（plugins.py:957），该端点**不过滤类型**，只跳过 `global_runtime / runtime / runtime.enabled` 为 False 的插件。

### 2.2 前端：三套执行器（最容易误判的点）
`sillytavern_extension` 类型插件在浏览器端被**三套不同机制**处理，只有第一套正确：

| # | 执行器 | 位置 | 对 ESM 的处理 | 状态 |
|---|--------|------|--------------|------|
| 1 | **plugin-system 沙箱** | `lib/plugin-system/`（`manager.ts` + `sandbox.ts`） | `transpileEsmToCommonJS` 转译后 `new Function()` 执行 ✓ | **主路径，正确** |
| 2 | `sillyTavernPluginRuntime.injectIntoContainer` | `utils/sillyTavernPluginRuntime.ts:225` | 原样塞经典 `<script>`，**不转译 → ESM 崩溃** | **已改：ESM 跳过 + try/catch** |
| 3 | `SillyTavernCompatRuntime`（iframe 沙箱） | `components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime.ts` | `normalizeStPluginScriptSourceCompat` **剥离 import 语句** | 不会崩 ✓ |

- 自动加载：`App.tsx` 登录后 `pluginManager.init()`（:446）→ `discover()` → 对每个 `enabled!=false` 的插件自动 `enable→load→executePluginCode`。**无类型过滤**，所以 `sillytavern_extension` 由第 1 套沙箱执行。
- 为什么第 2 套要"跳过"而非"转译后也跑"：第 1 套已执行过，第 2 套再跑会**双重副作用**（两份设置面板、重复事件监听）。跳过是正确选择。

### 2.3 注入机制：挂载点与全局环境
- 设置面板注入目标 DOM：`#extensions_settings`（ST 标准挂载点），由 `StPluginMountPoints.tsx` 渲染，默认 `display:none`。
- **挂载点常驻于 App 根级**（`App.tsx` 已登录主布局 `isAuthenticated` 块内），所有视图（含默认 `CharacterChat`）都有；原先只在 `NativeRoleplayChat` 渲染，导致默认视图注入失败（见 §3.3）。
- 就绪事件：挂载点 effect 派发 `palink:st_mount_points_ready`；插件通常用 `window.addEventListener('palink:st_mount_points_ready', ready, {once:true})` 接收。子组件 effect 先于父组件 `pluginManager.init()` 执行，时序成立。
- **沙箱全局环境真相**（sandbox.ts，极易踩坑）：
  - `$` / `jQuery` = **真实 jQuery**（查真实 `document`）。
  - `extension_settings` = 全局**共享 Proxy store**（沙箱已注入，需 `var extension_settings = __sandbox.extension_settings;` 声明给插件）。
  - `window` = `sandboxedWindow`（Proxy，`addEventListener` 包装后注册到真实 window，事件能通）。
  - `document` = `sandboxedDocument`（Proxy），`getElementById/querySelector` **只查插件私有 container**，`head/documentElement` 返回 null。
  - ⚠️ **ST 插件写设置面板必须用 `$('#extensions_settings').append(...)`（真实 jQuery），不能用原生 `document.getElementById`**（后者只查空私有 container，必然失败）。

### 2.4 模块解析：多文件插件如何加载
- `sandbox.ts` 的 `createMockRequire`（经 `makeRequire(baseDir)`）先查 ST 模块白名单 `moduleMap`，再按 `baseDir` 解析**插件自带本地模块**（`pluginLocalFiles`），惰性 `evalLocalFile` 且缓存。
- `manager.ts` 合并 `resources.js`（入口）+ `resources.modules`（其余 .js）为 `localFiles`，并推断 / 剥离 zip 顶层目录前缀使相对 import 对齐。
- `index.js` 的 `import { EXT_ID } from './core/constants.js'` → 归一化 `core/constants.js` → 命中 `pluginLocalFiles` → 取值。前缀推断逻辑见 §3.4 真因。

---

## 3. 近期"样例插件渲染"排查复盘（核心交接价值）
样例插件 `palink-sample-extension`（源：`st-plugins/samples/palink-sample-extension/`）只做一件事：向 `#extensions_settings` 注入一个设置面板（标题 + "启用本插件"复选框）。我们在让它真正渲染的过程中，连续踩了 4 层坑。

### 第 1 层：插件根本没入库（数据层）
- 症状：用户"插件完全没渲染到前端"。
- 误判方向：以为是前端加载问题。
- 真因：库里 `sillytavern_extension` 数 = 0，导入根本没落库（疑似打到旧容器 / 前端没真发请求）。
- 修复：在容器内实跑 `_import_sillytavern_extension_zip` 确认逻辑正常 → 直接写库（id=`488399ce-d905-40a2-a52d-f1015fa5152f`，name=`Palink 轻插件范本`，enabled=True）。
- 附：同时修了 `PluginSettingsPanel.tsx` 的面板可见性（样例不在 ST 标准 `PLUGIN_CONTAINER_MAP`，点 ⚙ 只显示"未提供设置面板"；改为按 `${pluginName}_container` 查找 + 兜底）。

### 第 2 层：ESM 注入崩溃（appendChild）
- 症状：`Uncaught SyntaxError: Failed to execute 'appendChild' on 'Node': Cannot use import statement outside a module`。
- 真因：第 2 套执行器 `sillyTavernPluginRuntime.injectIntoContainer` 把样例（ESM）原样塞经典 `<script>` → 浏览器拒 module 语法。
- 修复：`sillyTavernPluginRuntime.ts` 加 `isEsmModule()` 正则检测，ESM 直接 `continue` 跳过；`appendChild` 包 `try/catch`。

### 第 3 层：挂载点不在默认视图（静默不渲染）
- 症状：ESM 修复后"前端没被插件影响"（无报错，但不渲染）。
- 误判：以为"自动加载链路通"就够。
- 真因：`#extensions_settings` 宿主 `StPluginMountPoints` 只在 `NativeRoleplayChat` 渲染；而**默认聊天视图是 `CharacterChat`**（ST / 智能卡模式），那里没有该 DOM → 沙箱执行样例时 `$('#extensions_settings')` 查不到 → 注入失败；第 2 套又被改成跳过 ESM → 两条路都不注入。
- 修复：`StPluginMountPoints` 提到 `App.tsx` 已登录主布局**常驻**；从 `NativeRoleplayChat` 移除（避免重复 id）。并补 `sandbox.ts` 声明 `extension_settings`。

### 第 4 层（真正根因）：manager.ts 用错字段推断前缀 → 模块解析失败
- 症状：挂载点常驻后仍"插件依旧沒渲染"。
- 真因：**最隐蔽、最致命**。样例 `index.js` 首行 `import { EXT_ID } from './core/constants.js'`；模块解析失败 → `EXT_ID=undefined` → 注入出 `undefined_container` → `PluginSettingsPanel` 按 `#palink-sample-extension_container` 查找永远落空 → "没渲染"（且**不报错**，因为 `require` 失败只返回 `{}`）。
- 铁证（DB 真实 resources）：`path="index.js"` / `zip_path="palink-sample-extension/index.js"`；`path="core/constants.js"` / `zip_path="palink-sample-extension/core/constants.js"`。后端存库时 `path` 已去前缀，顶层目录只在 `zip_path`。
- bug：`manager.ts` 原从 `f.path` 推断前缀 → 样例 `core/constants.js` 首段 `core` 被误判为"顶层目录" → 错切成 `constants.js` → `localFiles` 键=`constants.js`，而 `require('./core/constants.js')` 解析成 `core/constants.js` → 不匹配 → 返回空对象。
- 修复：`manager.ts` 前缀改从 `f.zip_path || f.path` 推断（zip_path 恒含真实顶层目录 → `prefix=palink-sample-extension`，对已去前缀的 path 为 no-op，兼容旧假设）。Node 实锤验证：OLD `prefix="core", found:false` → NEW `prefix="palink-sample-extension", found:true`。
- 为何之前的 `verify-sample.mjs`（Node 复刻测试）6/6 通过却没暴露：它用 `new Map([['core/constants.js',...]])` 直接以正确 key 构造，**绕开了 manager.ts 真实前缀逻辑**。→ 教训：此类 verify 脚本必须复刻真实路径处理，不能自己假设 key。

### 踩坑方法论总结
1. "自动加载链路通" ≠ "注入目标 DOM 存在"。先确认挂载点是否在当前视图渲染。
2. `require` / 模块解析失败**静默返回 `{}`**，不会抛错 → 表现为"静默不渲染"，必须靠路径实锤验证（用 DB 真实资源跑一遍）。
3. 多执行器架构下，一处修了可能只是把崩溃换了个形态（ESM 跳过 → 静默不渲染），要追到"插件到底有没有产生可见 DOM"。
4. verify 脚本若简化了关键路径处理，会制造"已验证"假象，必须对照真实代码。

---

## 4. 关键文件索引
| 文件 | 作用 | 备注 |
|------|------|------|
| `frontend/src/App.tsx` | 应用根，登录后 `pluginManager.init()`（:446）、常驻 `StPluginMountPoints`（:894） | |
| `frontend/src/lib/plugin-system/manager.ts` | 插件发现 / 加载 / 模块前缀推断 | **第 4 层 bug 修复点**：`zip_path` 推断前缀 |
| `frontend/src/lib/plugin-system/sandbox.ts` | 软沙箱，ESM→CJS 转译（`transpileEsmToCommonJS`），`createMockRequire`/`makeRequire`，全局注入 `jQuery/extension_settings/window/document` | `buildWrappedCode` 补 `var extension_settings` |
| `frontend/src/utils/sillyTavernPluginRuntime.ts` | 第 2 套执行器 `injectIntoContainer` | **第 2 层修复点**：`isEsmModule` 跳过 ESM + try/catch |
| `frontend/src/components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime.ts` | 第 3 套执行器（iframe 沙箱） | `normalizeStPluginScriptSourceCompat` 剥离 import |
| `frontend/src/components/st-plugin-ui-host/StPluginMountPoints.tsx` | 提供 `#extensions_settings` 等挂载点 + 派发就绪事件 | 已提到 App 根常驻 |
| `frontend/src/components/st-plugin-ui-host/PluginSettingsPanel.tsx` | 点 ⚙ 克隆并展示插件设置面板 | 按 `${pluginName}_container` 查找 |
| `frontend/src/components/roleplay/PluginManager.tsx` | 角色扮演区「插件管理」，⚙ 调 PluginSettingsPanel | |
| `frontend/src/components/views/SettingsView.tsx` | 设置页，含管理员「插件管理」标签 | 已接 `AdminPluginsTab` |
| `backend/app/api/plugins.py` | 导入 / 下发插件 | `:1027` import 端点，`:957` runtime/config，`:290` `_import_sillytavern_extension_zip` |
| `st-plugins/samples/palink-sample-extension/` | 样例插件源（index.js / manifest.json / core/constants.js / style.css） | 范本 |
| `st-plugins/samples/palink-sample-extension.zip` | 打包好的样例插件（导入用） | 4159 字节 |

---

## 5. 运行 / 部署 / 调试

### 启动与访问
```bash
# 启动（需先确保 Docker Desktop 运行；Windows 下守护进程偶尔崩溃需手动拉起）
docker compose -f docker-compose.yml up -d --build
# 主 UI: http://localhost:3000
```
- 后端 healthcheck "unhealthy" 多为误报（`localhost` 解析 IPv6，uvicorn 绑 IPv4）；实测 `127.0.0.1:8000/health` 正常即服务 OK。
- 后端代码改动必须 `docker compose build backend`（非 bind-mount）；前端改动必须 `docker compose build frontend`。

### 如何在容器内确认"修复已进生产包"
```bash
docker compose -f docker-compose.yml exec -T frontend sh -c \
  "grep -roh 'isEsmModule\|st_mount_points_ready\|zip_path\|extension_settings = __sandbox.extension_settings' /usr/share/nginx/html/assets/*.js | sort | uniq -c"
```
当前主 chunk 应为 `assets/index-CUr4MHne.js`（历次修复均已进入）。

### 前端插件上传与启用流程
1. 设置 → 管理员 → 插件管理 → 「导入插件」选 `st-plugins/samples/palink-sample-extension.zip` → 入库。
2. 角色扮演区「插件管理」会自动 `discover` 发现并启用；**或 F5 刷新**即自动加载（无需手动启用）。
3. 点插件 ⚙ → 应见「palink-sample-extension 设置 (v1.0.0)」+「启用本插件」复选框。

### 调试要点
- 浏览器 F12 Console 看 `[PluginSandbox]` / `[SillyTavernPluginRuntime]` 相关日志。
- 确认插件是否真的执行：在 Console 查 `document.getElementById('palink-sample-extension_container')` 是否存在（存在 = 注入成功）。
- 后端 DB 直查：
  ```bash
  docker compose exec -T db psql -U ai_user -d ai_hub -c \
    "SELECT id,name,plugin_type,enabled FROM plugins WHERE plugin_type='sillytavern_extension';"
  ```

### 后端迁移坑（常见"生成失败"根因）
- `docker-compose.yml` 设 `RUN_MIGRATIONS_ON_STARTUP=false` → 后端模型改动后必须手动 `docker exec palink-ai-backend-1 sh -c "cd /app && alembic upgrade head"`，否则必现"模型有、库里没有"的 `UndefinedColumn`。
- 遇 `InFailedSqlTransaction` 一律先找同事务第一条失败 SQL（多为缺列）。

---

## 6. 已知问题 / 待办 / 风险
- [ ] **Task #2 事件总线激活**：palink-native 主流程未 emit ST 事件；`ST_EVENT_TYPES` 定义 117 个，实际有触发源的仅约 27 个。依赖事件钩子的插件基本不可靠。
- [ ] **深插件逃生舱 E2E**：小白X / 酒馆助手走 opt-in st-native（真 ST sidecar），其 `docker compose up`、插件安装 UI 入口、生成握手、许可合规均未 E2E 验证。
- [ ] **兼容性矩阵文档**：哪些 ST 插件能跑 / 半跑 / 跑不了，尚未成文。
- [ ] **AGPL 许可风险**：SillyTavern 为 AGPL-3.0；作为 sidecar 嵌入产品有合规影响，需法务确认。
- [ ] **verify 脚本真实性**：新增 / 修改插件适配时，verify 脚本必须复刻 manager.ts 真实路径处理，否则会重蹈"假通过"覆辙。

---

## 7. 当前已验证状态（截至 2026-07-31）
- 四个容器 healthy；前端 HTTP 200；主 chunk `index-CUr4MHne.js`。
- 样例插件 `id=488399ce-d905-40a2-a52d-f1015fa5152f`（`Palink 轻插件范本`，`sillytavern_extension`，enabled）已在库。
- 四层修复全部部署并 grep 验证进包。
- 用户端验证（⚙ 显示设置面板）建议接手人按 §5 再验一次确认无回归。

---
*本文档基于 2026-07-30 至 07-31 的排查记录与代码核实整理，所有结论以当前代码为准。*
