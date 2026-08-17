# ST 兼容层 fork 改动路线记录与正确性审查

> 日期：2026-08-17
> 作者：排查会话（接手上一个 agent 的未提交改动）
> 目的：记录上一个 agent（下称"前 agent"）在 `st-plugin-compat-20260727` 分支上的全部改动、逐处判断"改了什么 / 为什么 / 对不对"，并给出**可继续修改的路线**。

---

## 0. 总览与基线事实

| 项 | 现状 |
|---|---|
| 分支 | `st-plugin-compat-20260727`，**整 working tree 未提交** |
| 改动规模 | 31 个跟踪文件改动（`+1832 / -155`）+ 16 个新文件 |
| 类型检查 | `npx tsc --noEmit` → **退出码 0**，零类型错误 |
| 构建产物 | `frontend/dist/` 构建于 **08-17 04:04**，晚于全部源码改动；grep 确认 dist 已含 `mvuVariablesUpdated` / `palink-smart-card-asset-mode` / `no-referrer` 等新代码 |
| 报告声称"阶段5 未部署" | **与现状不符**——dist 04:04 已含 MVU 事件链等全部新代码（除非运行容器未重新部署最新 dist，见 §3.3） |
| 回退手段 | 永远用 `git`（整树未提交，`git diff` / `git stash` / `git checkout -- <file>`）。`.backups/` 是散装备份，其中 `fork-fix-20260817` 已被用户判定为**残次品，排除**；`phase-smartcard-direct-20260817` 是"做完所有 phase、只差你 fork 三文件"的干净中间态（见 §5） |

**核心结论**：前 agent 没有把项目搞到编译/构建失败。它解决了若干真实问题（Galgame 首次完整初始化、宏真正展开、CSP 适配、字体/图片 CDN 白名单、多项 API 镜像、多处正确性修复），但也留下 4 个未决/未根治项（§3）。

---

## 1. 你的报告 vs 实际代码（逐条对照）

| 报告说法 | 代码实情 | 判定 |
|---|---|---|
| 阶段0：`character_card.py` `_overlay_field` 修清空复活 | 完整函数已读：第一分支 `stored_value is not None and stored_value != ""` 接住真实非空编辑值，**不会误清空** | ✅ 正确且安全 |
| 阶段0：`getRequestHeaders` 去重复 | `main.py` 改动属实 | ✅ |
| 阶段0：根目录调试脚本归档 | 属实 | ✅ |
| 阶段1：`compat-stub-registry.ts` 新建 + `substituteParams` 升级 + 51 个 TavernHelper 镜像 | `sillyTavernPluginRuntime.ts` + `compat-stub-registry.ts` + `macros/` 确有其事，逻辑自洽 | ✅ 属实 |
| 阶段2：安全头两处放开 | 工作区里 `security-headers.conf` 和 `nginx.conf` **两处源码都改了**（都放宽 CSP） | ⚠️ 源码属实；但**部署拓扑不同**（§3.3） |
| 阶段2：fetch 守卫（默认 warn，strict 可选） | `sillyTavernPluginRuntime.ts` 的 `installGlobalFetchGuard` 属实；默认放行 + `recordStubHit` 登记 | ✅ 属实（引入复杂性，但 warn-only 不阻断） |
| 阶段3：直连模式 + 全局 `referrerpolicy="no-referrer"` + http→https 升级 | `asset-mode.ts` + `resource.ts` 属实 | ✅ 属实（referrerpolicy 反噬风险见 §3.4） |
| 阶段4：shim（PARENT-ALIAS / IDB 垫片 / worldbook stubs） | `legacy-st-sim.ts` 确有这些段 | ✅ 属实 |
| 问题1：嵌套 iframe（BubbleDialogue dcRoot）没 shim | shim 只注入**卡 iframe** 一层；`scripts/dialog_render_v7.1.js` 确认 BubbleDialogue 在卡内创建 `srcdoc` 子帧（含 `id="dcRoot"`，第 2453-2456 / 2830-2836 行） | ✅ 属实（冰山一角） |
| 问题2：面板 220px 截断未查明 | 见 §3.2，根因与 #1 同源 | ✅ 属实（未定位，但假设已建立） |
| 问题3：MVU 变量刷新修复未部署 | dist 04:04 已含，源码+产物都改了 | ⚠️ 与"未部署"不符（除非容器未重新部署） |
| 问题4：安全头双源配置认知遗漏 | 源码两处都改了；但 `security-headers.conf` 是 bake-in，仅改源码不 rebuild 运行时仍为旧配置 | ⚠️ 部分属实（部署缺口真实） |
| 问题5：全局 no-referrer 对图床反噬 | `resource.ts` 给所有直连 img 加 `referrerpolicy="no-referrer"` | ✅ 属实（设计取舍） |

---

## 2. 逐文件正确性审查

### 2.1 后端（已验证安全）
- `backend/app/character_card.py`（`_overlay_field`，+9）：第一分支正确接住真实非空编辑值，不会误清空。**安全**。
- `backend/app/main.py`（`getRequestHeaders` 去重复，+5）：消除潜在认证泄露路径。**安全**。
- `backend/tests/test_st_import_export_roundtrip.py`（+20，新）：后端导入导出往返测试。

### 2.2 安全模型（逻辑对，部署有缺口）
- `frontend/security-headers.conf`（+2）：CSP 放开 font/style/media/img 为 `https:`。**注意：此文件是 bake-in（Dockerfile `COPY`，见 §3.3），仅改源码不够，必须 `docker compose build frontend`。**
- `frontend/nginx.conf`（+15）：同步放开 + `script-src` CDN 扩展。**注意：此文件是 bind mount（`docker-compose.yml:29`），改后容器重启即生效，无需 rebuild。**
- `frontend/src/utils/sillyTavernPluginRuntime.ts`（`installGlobalFetchGuard`，+~90）：
  - 同源请求无 Authorization 时注入 Bearer（从 `localStorage.palink_token`）；
  - 跨源走 `isUrlAllowedByPluginWhitelist`（与 ESM 沙箱同套白名单）；
  - 默认 **warn-only 放行**并 `recordStubHit`；`localStorage.palink_plugin_fetch_guard='strict'` 才拒绝；
  - 模块级 `nativeFetchForGuard` 防堆叠，`cleanup` 时 `restoreGlobalFetchGuard`。
  - **逻辑正确**。局限（已在代码注释写明）：不拦截 XHR/WebSocket/sendBeacon/动态 script 标签；经典插件仍可读 localStorage。
- `frontend/src/lib/plugin-system/sandbox.ts`（+5）：仅把 `isUrlAllowedByPluginWhitelist` 改为 `export`，供 fetch 守卫复用。**良性重构。**

### 2.3 直连模式（正确，有取舍）
- `frontend/src/components/ui/custom/smart-card-runtime/asset-mode.ts`（全新）：`direct`（默认，浏览器直连第三方）/ `proxy`（服务器中转）模式，localStorage + CustomEvent 持久化。**正确。**
- `frontend/src/components/ui/custom/smart-card-runtime/resource.ts`（+41）：
  - `getSmartCardAssetProxyUrl` 在 direct 模式 `return null`（全部直连）；
  - 新增 `upgradeMixedContentSmartCardUrl`：https 页面下 http:// → https://（混合内容升级）；
  - `optimizeSmartCardHtmlForRuntime` 给所有 img 加 `referrerpolicy="no-referrer"`（**两模式都加**，非仅直连）；
  - 缓存键含资源模式（`${mode}:${hash}`），切换模式不复用旧缓存；
  - 服务端预取仅对 proxy 模式的 style+font。
  - **逻辑正确**；`no-referrer` 对**需要正确 Referer** 的图床（pixiv、微信图床等）可能 403（§3.4）。

### 2.4 兼容层显性化（正确）
- `frontend/src/lib/plugin-system/compat-stub-registry.ts`（全新）：桩调用计数 + 首次 warn（去重）+ `window.__palinkCompatStats`。设计干净，**正确**。
- `frontend/src/utils/sillyTavernPluginRuntime.ts`：
  - `substituteParamsCompat`：优先 `substituteParamsExtended`（来自 `@/lib/sillytavern/macros`，**模块确实存在**，`macros/bridge.ts` 导出），失败回退原文 + 登记；`{{chatId}}` 手动兜底。**正确**（前 agent 报告"substituteParams 从 no-op 升级为真实宏引擎"属实）。
  - `window.substituteParams` / `window.substitudeMacros` / `getGlobalWorldbookNames` / `rebindGlobalWorldbooks` / `injectPrompts` / `slash:profile-list` 等接入 `recordStubHit`，从静默失效变为**可观测降级**。
  - `window.getRequestHeaders` 不再把 `palink_token` 明文递给插件（凭据泄露路径收敛，同源认证由 fetch 守卫补）。**正确且更安全。**
  - 删除了 `SillyTavern.getRequestHeaders` 返回空对象的兜底桩（注释说明：语句顺序变动时静默破坏插件认证，统一到上方实现）。

### 2.5 智能卡 shim（顶层修好，嵌套漏了）
- `frontend/src/components/ui/custom/smart-card-runtime/frame-shim/legacy-st-sim.ts`（+269）：PARENT-ALIAS（`parent`/`top` 代理，`postMessage` 用 `realParent.postMessage.bind(realParent)` 穿透）、document/localStorage/sessionStorage 代理、addEventListener 转发、aliasStore 命名空间写入、IDB 内存垫片、iframe 内 worldbook 全局 stubs。
  - `post()` 用 `window.parent.postMessage`，与 `frame-measure.ts` 的 `measure()` 同处一个 shim IIFE 作用域，**不缺**——postMessage 通道本身没坏。
  - **缺口**：只注入卡 iframe 一层，不覆盖卡内 BubbleDialogue 的 `srcdoc` 子帧（dcRoot）。
- `frontend/src/components/ui/custom/CharacterCardRenderer.tsx`（+37）：frame-error 来源兼容 + resize 消息探针（`window.__palinkFrameMsgs` / `window.__palinkFrameErrors`）。已构建进 dist。
- `frontend/src/components/ui/custom/smart-card-runtime/frame-shim/frame-measure.ts`（已读）：`measure()` 计算高度并 `post({type:'resize'})`；父页面有 `maxMeasuredHeight`（≤680）封顶与 `realContentFlag` 机制。

### 2.6 MVU 事件链（已部署）
- `frontend/src/hooks/useCharacterChat.ts`（+17）：发送 `palink:mvuVariablesUpdated` 事件。
- `frontend/src/components/views/character/CharacterChat.tsx`（+27）：监听事件更新 sessionVariables。
- 两者事件链完整，且 dist 已含 `mvuVariablesUpdated`。**已部署（除非容器未重新部署最新 dist）。**

### 2.7 性能 / 正确性改进（全部良性）
- `Message.tsx`（+24）：Markdown 图/头像加 `loading="lazy" decoding="async"`；新增 `canSkipOffscreenRender`（`.mes-render-skip`），且**显式排除**智能卡/状态栏/沉浸式卡，保护 iframe 高度测量同步。
- `ChatSidebar.tsx`（+32）：StorylineMap（~2MB）懒加载 + Suspense fallback。
- `CharacterList.tsx`（+29）：空闲预热前 12 角色头像。
- `useChatView/index.ts`（+66）：流式更新 RAF 批处理（一帧内多 chunk 合并一次 setState），对齐 useCharacterChat 的 `scheduleStreamUpdate`；onDone/onError/onCancelled 均正确冲刷/丢弃挂起帧。
- `useChatMessages.ts`（+13）：消息 id→下标 `Map` 索引，流式 O(1) 定位。
- `generation-engine.ts`（+27，**正确性修复**）：去掉模块级 `_cachedDefaultModel` 缓存，改用 `api.get` 的 5 分钟 TTL；避免管理员改默认模型后插件永远用旧模型。
- `worldbookApi.ts`（+37，**正确性修复**）：Mutation 后 `invalidateCache('/api/worldbooks')`，列表立即可见更新；各读接口加 `cacheTtlMs`。
- `App.tsx`（+26）：空闲预取常用路由 chunk。
- `index.html`（+12）：KaTeX / Font Awesome 改 `media="print" onload` 异步加载，不阻塞首屏。
- `SettingsView.tsx`（+37）：新增"智能卡图片走服务器代理"开关（直连/代理切换）；多处 `api.get(...{cacheTtlMs})` + `invalidateCache`。
- `CharacterList.tsx` / `ChatSidebar.tsx` 等见上。

### 2.8 测试 / 调试 / 构建基础设施
- `frontend/package.json`：新增 `tsx` / `vitest` 依赖；新增 `test:contract` 脚本。
- `frontend/vitest.config.ts`（新）、`frontend/src/test/`（新）、`frontend/src/lib/sillytavern/__tests__/`（contract 测试）、`_tsx-loader.mjs`。
- `frontend/scripts/clean-dist.cjs`（+10）、`frontend/scripts/verify-shim-identity.mjs`（+3）。
- `frontend/Dockerfile`（+8）：**仅新增被禁用的 brotli 注释**——记录 2026-08-17 实测 `nginx-mod-http-brotli` 与 `nginx:alpine 1.28.3-r7` 冲突导致镜像构建失败、前端容器持续崩溃的历史坑。**不要再尝试启用 brotli，除非先解决模块与基镜像版本匹配。**
- `scripts/dialog_render_v7.1.js`（新）：BubbleDialogue v7.1 渲染脚本，**确认嵌套 srcdoc 帧结构**（dcRoot）。
- `scripts/extract_chara.cjs`、`scripts/debug/`（新）：调试工具。
- `st-plugins/`（新目录）：插件目录。
- `docs/PLUGIN_SECURITY_MODEL.md`（新，4.6KB）：fetch 守卫的安全模型说明。
- `frontend/src/views/settings-tabs/CompatStubStatsCard.tsx`（新）：插件管理页降级统计面板。
- `frontend/src/components/views/settings-tabs/AdminPluginsTab.tsx`（+8）、`frontend/src/lib/plugin-system/index.ts`（+6）等：接入 CompatStubStatsCard / 桩登记。

---

## 3. 核心未决问题（前 agent 遗留 / 未根治）

### 3.1 问题1：嵌套 iframe（BubbleDialogue dcRoot）无 shim —— **已确认真实**
- 证据：`scripts/dialog_render_v7.1.js` 第 2453-2456 行 `frame.srcdoc.includes('id="dcRoot"')`、第 2830-2836 行重写 `frame.srcdoc`、第 5114 行"挂到所有可达的父级 window"。
- 后果：卡 iframe 内 BubbleDialogue 给每条消息创建 `srcdoc` 子帧，这些子帧跑在卡 iframe **内部**、**没有 shim** → `window.parent.jQuery` 跨源报错仍来自嵌套帧。前 agent 只修了顶层卡 iframe 的 parent/top 别名，是"冰山一角"。

### 3.2 问题2：面板 220px 截断 —— 与 #1 **同源**
- `IFRAME_DEFAULT_HEIGHT = 220`，高度一直卡在初始值（非被 `maxMeasuredHeight` 截到几百 px），说明 postMessage 通道没把真实高度传上来。
- 沙箱卡是 **opaque origin**，父页面轮询兜底（`frame.contentDocument`）跨源抛错被 catch → **对沙箱卡无效**，高度 100% 依赖 postMessage。
- 根因假设：若状态栏面板（好感度/角色名单）是 BubbleDialogue 在卡内用 `srcdoc` 子帧（dcRoot）渲染，则卡 iframe 的 `MutationObserver` 看不到嵌套帧内部变化 → 卡 iframe 量到的只是"装了 220px 空框" → 上报 220 → 父页面永远停 220。
- **#1 与 #2 是同一个冰山**：嵌套帧无 shim 既导致跨源报错，也导致高度测不到。

### 3.3 问题3/4：security-headers.conf 部署缺口（修正前 agent 与我的早期误判）
- **正确部署拓扑**（已用 Dockerfile + docker-compose 核实）：
  - `nginx.conf` → **bind mount**（`docker-compose.yml:29` `./frontend/nginx.conf:/etc/nginx/conf.d/default.conf:ro`），改后容器重启即生效，**无需 rebuild**。
  - `security-headers.conf` → **bake-in**（Dockerfile `COPY security-headers.conf /etc/nginx/security-headers.conf` + awk 去 BOM），改后**必须 `docker compose build frontend`** 才进镜像生效。
- 含义：前 agent 改了两处源码，但**若只做了容器重启（未 rebuild），则 security-headers.conf 的放宽根本没进运行容器**——这正是用户"重启后发现旧配置仍生效"的真实成因。前 agent 报告"只改了 nginx.conf 没改 security-headers.conf"在**源码层面不实**（两处都改了），但在**运行时层面准确**（security-headers 需 rebuild 才生效）。

### 3.4 问题5：全局 `referrerpolicy="no-referrer"` 反噬
- `resource.ts` 给所有直连 img 加 `no-referrer`。对**按 Referer 防盗链、且要求正确 Referer** 的图床（pixiv、微信图床部分场景）可能 403。
- 取舍：no-referrer 也常能绕过"Referer 来自异站则拦截"的防盗链。是否反噬取决于具体图床。可选方向：仅 http→https 升级场景加、或加白名单开关。

---

## 4. 继续修改的路线（按文件 / 按目标）

### 路线 A：根治 #1 + #2（嵌套帧 shim 传播）—— **最高优先，唯一同时关掉两个问题清单**
- **入口**：`frontend/src/components/ui/custom/smart-card-runtime/frame-shim/legacy-st-sim.ts` 的 PARENT-ALIAS 段（约 329 行起的 `post()` 同作用域）。
- **做法**：在卡 iframe shim 内加 `MutationObserver`，检测新 `<iframe srcdoc>`（含 `id="dcRoot"`）加载完成后，向其中注入**精简版** PARENT-ALIAS + resize 转发（`post({type:'resize'})` 冒泡到真实父帧）。
- **风险**：中。需浏览器实测 BubbleDialogue 嵌套帧的真实加载时序（srcdoc 是同步还是异步、MutationObserver 能否捕获）。
- **前提先验证**：打开卡片，控制台读 `window.__palinkFrameMsgs`（看有无 `type:'resize'` 且 `height>220`）：
  - 有 → 不是嵌套帧问题，转查 `prefersAvailableHeight` 是否被误开；
  - 没有 → 印证本假设，再实现路线 A。

### 路线 B：security-headers.conf 部署（低风险，需你拍板）
- 直接 `docker compose build frontend && docker compose up -d frontend`（完整重建，security-headers 才进镜像）。
- 或临时把 security-headers.conf 的放宽也搬进 nginx.conf（bind mount），避免 rebuild。
- **注意**：brotli 段在 Dockerfile 里是**禁用注释**，切勿取消（见 §2.8）。

### 路线 C：referrerpolicy 反噬（设计取舍，看你）
- 改 `resource.ts`：仅 http→https 升级场景加 `no-referrer`，或加白名单开关；或改为 `referrerpolicy="no-referrer-when-downgrade"`（更温和，保留同站 referer）。

### 路线 D（可选，前 agent 未做）：补回退检查点
- 建议用 `git stash` 暂存整个 working tree（最规范），而非往 `.backups/` 塞目录。
- 若需"保留所有 phase 成果、只差你 fork 三文件"的干净基线，用 `.backups/phase-smartcard-direct-20260817/` 里的 `CharacterCardRenderer.tsx` 与顶层 `CharacterChat.tsx`（与 git HEAD 差 1511/大量行，即 phase 全部工作；与当前 working tree 差 61/25 行，即你 fork 的改动）；`useCharacterChat.ts` 该备份**没有**，只有 git HEAD。

---

## 5. 关键事实速查（写代码前必读）

- **部署拓扑**：`nginx.conf`=bind mount（重启生效）；`security-headers.conf`=bake-in（需 `docker compose build frontend`）。
- **探针**（已构建进 dist，打开卡片后控制台读）：
  - `window.__palinkFrameMsgs` —— 父页面收到的 iframe→父 消息序列（看 resize / height）
  - `window.__palinkFrameErrors` —— 卡内脚本错误（含跨源访问/初始化失败）
  - `window.__palinkCompatStats` —— 降级桩调用统计
- **回退永远是 git**，不是 `.backups/`；`fork-fix-20260817` 是残次品已排除。
- **brotli 禁用**：Dockerfile 中 `nginx-mod-http-brotli` 与 `nginx:alpine 1.28.3-r7` 冲突，勿启用。
- **宏引擎模块路径**：`@/lib/sillytavern/macros`（`macros/` 目录，`bridge.ts` 导出 `substituteParamsExtended`），真实存在、tsc 通过。
- **tsc 命令**：`cd frontend && npx tsc --noEmit`（当前 0 错误）。
- **构建命令**（绕过 safe-delete 护栏）：`VITE_OUT_DIR=dist_fix_<ts> node scripts/build-vite.mjs`，详见既有项目记忆。
