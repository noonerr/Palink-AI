# 智能卡渲染交接日志（详细版）— 思维/记忆/经验完整移交

> **交接日期**: 2026-08-08
> **原始会话ID**: `6a7559027828ff476fc762e6`（20260807-20260808 跨天主会话）
> **目标**: 让下一个接手 agent 能**完美复刻**本会话的思维过程、技术决策、记忆与踩坑经验，无缝继续开发。
> **必须前提**: 接手前先读本文件 + `docs/st-compat-handover/README.md` + `docs/inline-card-rendering-plan/README.md` + `docs/mvu_smartcard_full_compat_spec.md` + 记忆文件 `c:\Users\Pall\.trae-cn\memory\projects\-d----Palink-AI--p2-9e901dfba5dcc4c4a5d5\project_memory.md`。

---

## 一、项目是什么（一句话）

Palink-AI 是一个自研的、**多用户/多租户**的 AI 角色扮演聊天平台，深度兼容 SillyTavern(ST) 生态的角色卡（智能卡）、插件、MVU 变量引擎、状态栏、故事线等功能。前端 React + Vite，后端 Python FastAPI + 单 worker 异步事件循环，Docker 容器化部署。

**核心矛盾/主线**：如何在**多用户隔离安全模型**下，尽可能复刻 ST（单用户本地部署、无严格安全隔离）的浏览器原生渲染体验，同时保证角色卡的功能（状态栏、变量、交互、全屏启动器）100% 可用。

---

## 二、本次会话全部工作（按时间/主题）

### 主线：智能卡「双路径渲染」方案的确立与实现

**最终架构（务必刻进脑子）**：
- **历史消息** → 走既有 `CharacterCardRenderer` 的 **iframe** 渲染（每张卡独立 document，保持在线行为、样式隔离）
- **最新一条消息** → 走新增的 **`InlineCardRenderer`** 内联渲染（浏览器自然排版，无 iframe 高度抖动，贴合 ST 状态栏语义）
- **切换条件**：`flag 开启 && 桌面安全环境 && isLast（最新消息）`
- **全屏启动器类卡片**（`id="launcher"` / `mg-launcher` 家族）→ **永远走 iframe 沉浸式全屏**，绝不走内联

这是经历多轮失败后收敛出来的**最终裁决**，也是接手人必须遵守的架构边界。

### 主题 1：内联渲染 7 大模块（已实现）
| 模块 | 作用 |
|---|---|
| `inline-flags.ts` | 内联渲染开关。**桌面端恒返回 true**（不再依赖 localStorage flag，解决"新页面变成 iframe"问题） |
| `inline-sanitize.ts` | `extractInlineCardStyles`：清洗前抽出 `<style>` 绕过 DOMPurify，处理后回填 |
| `inline-script-replay.ts` | `createElement('script')` 手动重放 + fingerprint 守卫（防流式重复执行） |
| `inline-st-globals.ts` | ST 全局变量增强（不覆盖），变量导入/导出 + 幽灵监听跟踪 |
| `inline-host-registry.ts` | 按 cardId 注册/注销宿主能力 |
| `primitives.ts` | `stripHtmlFenceLeftovers` 围栏残留清理 |
| `hashing.ts` | `adaptSmartCardRuntimeAccess`：非原生模式下重写卡片脚本对父页面 DOM 的访问 |

### 主题 2：四个关键 bug 修复（内联路径）
1. **移动端黑屏** → ErrorBoundary 隔离 + 移动端强制 iframe
2. **CSS 污染** → 对内联卡做「轻保护」（root/body/fixed 样式捕获到卡片容器回填）
3. **流式脚本重复执行** → fingerprint 守卫
4. **历史消息交互失效** → 限制内联只用于最新消息，历史消息退回 iframe

### 主题 3：全屏卡黑色空白区域修复（`CharacterCardRenderer.tsx`）
- **根因**：iOS 沉浸式路径强制加了 48px 顶部偏移 + 66px 纯黑顶栏（`resolvedImmersiveTheme.backgroundColor` 默认黑色），在 iPhone UA 模拟下全屏 launcher 卡顶部出现一条纯黑空白条。
- **修复**：删除 `immersiveSafeTopPx`/`immersiveFrameHeightPx`/`immersiveToolbarHeight` 变量；移除 `isIOSDevice` 黑色顶栏 div；iframe 改为 `top:0`、`height:immersiveStableViewportHeight` 填满视口。
- **验证**：launcher + 星空背景顶部 edge-to-edge，无黑条。

### 主题 4：关键问题澄清（用户反复追问，接手人必须能答）
- **「启用 Tavern 原生模式」按钮**：切换 iframe 内两档沙箱模式 `iframe-js`（默认，`adaptSmartCardRuntimeAccess` 重写父页面访问为代理）与 `trusted-native`（允许直接访问父页面真实 DOM）。授权存 sessionStorage，**30 分钟 TTL，关标签页失效**。**仅出现在 iframe 沉浸式全屏路径**。对 Magical Fairy 这类**自包含卡**（不调用 `parent.$`/`parent.document`）无实际影响。
- **全屏卡为什么必须走 iframe**：`InlineCardRenderer` 设计为消息流中的块级元素（`position: relative`），**无全屏能力**（需覆盖视口、脱离文档流、独立样式隔离）。内联卡脚本运行在主页面全局作用域，会导致样式与交互冲突。实测强行内联实现全屏会导致全屏丢失。
- **数据保存是否受渲染路径影响**：**不受**。数据保存由后端 MVU 引擎处理，与前端走 iframe 还是内联无关。

---

## 三、核心架构与决策思维过程（接手人必须理解"为什么"）

### 3.1 为什么不能完全照搬 ST 的内联渲染？
- ST 是**单用户本地部署**，无严格安全隔离，角色卡内联 HTML + 允许 script 执行没问题。
- Palink 是**多用户账号系统**，必须用 iframe 隔离不可信角色卡内容，防止跨用户/跨卡脚本污染。
- 结论：**静态卡片可走内联分支，动态/全屏卡片必须 iframe 隔离**。

### 3.2 双路径渲染的取舍
- iframe 优势：样式隔离、独立 document、多卡共存不冲突、移动端兼容。
- iframe 劣势：**高度抖动/振荡**（三大根因见记忆）、首帧截断、资源加载中止（字体 `net::ERR_ABORTED`）。
- 内联优势：浏览器自然排版、无高度抖动、贴合 ST 状态栏语义。
- 内联劣势：多卡共享主文档 → 全局变量/class/id 冲突、React DOM 冲突（NotFoundError）、无全屏能力。
- **最终裁决**：内联只给"最新一条普通消息"，历史+全屏都走 iframe，扬长避短。

### 3.3 iframe 高度振荡三大根因与修复（20260807，记忆 L88，极重要）
1. **vhDriven 判定必须单向**（`naturalHeight >= innerH - 4`）而非双向（`abs(diff) <= 4`）——双向阈值在"内容略超/略低于视口"边界翻转（实测 914↔926 极限环）。
2. **fallback 基线绝不能用 root.scrollHeight/root.offsetHeight**——卡片 html 常设 `height:100%`（跟随 iframe），折叠时（如 lightbox 遮罩 `height:100%`）root.scrollHeight=iframe 高度，作基线会形成"上报+2→变高→root 更高"无限增高正反馈。仅当 `rootHeight > innerH+4` 才采用，否则用可见元素扫描。
3. **overflow 裁剪祖先判定**需区分"被视口压缩撑开"与"主动折叠"（容器被脚本压到远小于视口如 `height:0`），且循环不能 break 在第一个 clipping 祖先——内部滚动容器之上可能还有折叠容器在裁剪，需沿祖先链取最小可见底部。

---

## 四、已解决问题汇总（含根因与关键词）

| 问题 | 根因 | 修复 |
|---|---|---|
| 内联卡样式丢失 | DOMPurify 清空 `<style>` 内容 | `extractInlineCardStyles` 清洗前先抽出样式 |
| lightbox 无法点击/进卡显示 div | 卡内 `<style>` 在 `<head>`，`removeFullDocumentShell` 只取 body.innerHTML 丢弃 head 样式 → 默认隐藏规则丢失，主应用 CSS 劫持 | `prepareInlineCard` 剥壳前先抽 `<style>` |
| JSON patch 泄漏 | 后端未在落库前剥离 `<UpdateVariable>` 块 | 后端 `strip_update_variable_blocks` + 前端显示层兜底剥离 |
| 内联渲染围栏残留 | 模型把 `<UpdateVariable>` 包在 markdown 代码围栏内输出，剥离块后残留围栏行 | 后端 `_strip_markdown_fence_leftovers` + 前端重构 `stripHtmlFenceLeftovers` |
| 新开页面变 iframe | 内联依赖 localStorage flag，丢失则回退 | `shouldUseInlineCardRendering` 桌面端恒返回 true |
| 删除会话 500 | 删除顺序错（先删 branches 再删 messages）违反外键 | 调整为先删 messages 再删 branches |
| 开局全屏面板丢失 | 双路径分流让最新消息走内联，内联渲染器无沉浸式全屏分支 | `SmartCardComponent` 判定加 `!cardAllowsImmersive` |
| 全屏黑空白条 | iOS 路径强制 48px 偏移 + 66px 黑色顶栏 | 删除偏移变量与黑顶栏，iframe `top:0` 填满视口 |
| 发消息假死 | tokenizer 远程下载同步阻塞在事件循环主线程（单 worker） | 下载移到后台守护线程，缓存 `/tmp/palink_tokenizers/`，失败 600s 退避 |
| iframe 面板先截断 | `stPluginRuntimeConfig` 异步晚到导致 `resourcePlan` 变化 → srcDoc 重建 → 中止在途资源 | `useRef` 快照资源计划 + `context-update` postMessage 热更新 |

---

## 五、关键文件索引（接手人必查）

### 前端
| 文件 | 作用 |
|---|---|
| `frontend/src/components/ui/custom/Message.tsx` | 渲染决策树、`cardAllowsImmersive` 判定、`SmartCardComponent` 选型、Tavern Helper 面板条件 |
| `frontend/src/components/ui/custom/CharacterCardRenderer.tsx` | iframe + 沉浸式全屏渲染（本次修复黑条的核心） |
| `frontend/src/components/ui/custom/InlineCardRenderer.tsx` | 内联渲染器（React 逃逸区 `dangerouslySetInnerHTML: {__html:''}`，`position:relative` 无全屏） |
| `frontend/src/components/ui/custom/TavernHelperPanel.tsx` | Tavern Helper 面板（不能破坏） |
| `frontend/src/components/ui/custom/smart-card-runtime/hashing.ts` | `adaptSmartCardRuntimeAccess` 父页面访问重写 |
| `frontend/src/components/ui/custom/smart-card-runtime/storage.ts` | 信任授权（sessionStorage，30min TTL） |
| `frontend/src/components/ui/custom/smart-card-runtime/inline/*` | 内联 7 模块 |
| `frontend/src/utils/sillyTavernDisplayPipeline.ts` | smart-card 判定逻辑 |

### 后端
| 文件 | 作用 |
|---|---|
| `backend/app/services/mvu_engine.py` | MVU 变量引擎（`extract_update_variable_blocks`/`apply_patches`/`build_initial_stat_data`） |
| `backend/app/api/websocket.py` | JSON patch 落库点（MVU 后应用 `strip_update_variable_blocks`） |
| `backend/app/api/character_ext.py` | 删除会话顺序修复（先 messages 后 branches） |
| `backend/app/services/st_tokenizer_service.py` | tokenizer 非阻塞下载 |

---

## 六、记忆精华（必须继承的约束与经验）

### 6.1 硬约束（不能违反）
- **沉浸式全屏卡**：判定**仅基于显式 launcher 元素**（id/class 含 launcher / mg-launcher 家族），绝不能用 `body{height:100vh}`/flex 居中/`position:fixed` 等样式特征判定。
- **launcher 正则不能带尾部 `\b`**——`\b` 导致无法匹配 `id="launcher">`（引号+`>`后无词边界），静默失败。
- `Message.tsx` 的 `cardAllowsImmersive` 与 `CharacterCardRenderer` 的 `htmlPrefersImmersive` 正则**必须一致**，否则"判定 true 却内联渲染"不一致。
- 角色消息 HTML 判定用 `isHtmlCardContent`（检测 div/span/style），**不能用 `looksLikeSmartCardHtml`**（太窄，漏掉无 `<style>` 的 `<div style=...>`）。
- 角色消息 HTML 必须内联渲染在 `.mes_text`（`sanitizeStCompatHtml` 剥 script/iframe/object/embed/base/form，保留 style/div/span），**CSS 不能 re-scope**（作者用 `.mes_text .xxx` 选择器）。
- 用户消息泡泡固定 `bg-slate-900 text-white`（黑底白字），明暗模式一致。
- 前端部署：`./frontend/dist` 是 volume mount，镜像层被覆盖。改前端必须 `npm run build`（更新 host dist）→ `docker compose restart frontend`。**光 build 镜像没用**。
- **CRITICAL 部署写穿透**：改源码后若没重新 `npm run build`，运行中的 dist 还是旧字节。调试 iframe 高度/脚本错误时，**先对比源码与 dist/index-*.js 的 LastWriteTime**。陈旧 dist 常见症状：`SyntaxError: Unexpected token ')'`/`':'`（TS 类型注释泄漏进 buildShim 模板串）、`data-palink-height` 为 null → iframe 锁死在 IFRAME_DEFAULT_HEIGHT(220px) → 内容截断。
- 后端单 worker（`APP_PERFORMANCE_PROFILE=eco` + 内存限制 → WORKERS=1）。**事件循环主线程禁止任何同步阻塞网络调用**，否则全项目 API 排队超时假死。
- Docker healthcheck 的 `docker-compose.yml` 设置会覆盖 Dockerfile `--start-period`，需 `start_period: 180s`（Python ML 库加载），否则容器被过早重启。

### 6.2 工程约定（美术/UI，用户偏好）
- 顶栏（ChatViewMobile/ChatHeader）`backdrop-blur(16px) saturate(160%)` + 渐变：底部 100% 透明 → 中 60% → 顶部 30%。
- div 元素：**底部更透明**，从下到上透明度递减（前 50% 更透明、后 50% 更不透明），降低模糊强度，高度更窄。
- 按钮在 div 内垂直居中不溢出；改动时**不影响其他元素布局**。
- 设置标题放最左。
- 用户偏好整体 UI 不满意时**回退到指定旧版本**（如 5 月 UI）而非增量修。

### 6.3 用户工作方式偏好
- 通信语言：**中文**。
- 实时同步用 WebSocket，不用轮询。
- frpc 等内网穿透服务要跑在**真实内存**（非 swap）。
- 容器**本地先建好再传服务器**。
- 按钮状态变化要**即时视觉反馈**（不等 API 响应）。
- 未明确指定修改的代码/组件**不要动**，保留原样；不得不改无关代码时确保不引入新问题、不影响原功能与 UI。
- 每次修改默认**重新创建容器运行**确保生效（除非修改可自动同步到镜像）。
- **较大版本更新时自动保存之前的修改**，确保不丢失。
- 用户要可靠助手，**不要偷懒**；理解需求而非简单重复指令；小心谨慎不乱改。

---

## 七、测试与验证方法（接手人沿用）

- **内联渲染单测**：42/42 通过；CSS 保护断言 8/8 通过。
- **测试数据 SQL**：`scripts/seed-inline-*.sql`（构造智能卡 HTML 测试会话）。
- **管理账号**：`admin/admin123`（用户明确授权用于测试，内置两张卡：Magical Fairy 等）。
- **Magical Fairy**：开局全屏启动器归属沉浸式分支，永远走 iframe；重置后可成功渲染开机全屏面板。
- **浏览器验证**：用内置浏览器做 DOM/元素检查（本模型无图片识别，**不要截图给 API 提供商**；用 `browser_snapshot`/元素选择器人工核对显示一致性）。
- **验收标准**：tsc 无错 → `npm run build` 成功 → 功能实测 → 插件实测。

---

## 八、当前状态与下一步

**当前完成度评判**：
- 内联渲染取代 iframe 学习 ST 前端渲染：**核心方案已确立并落地**（双路径），但**仅限最新消息 + 桌面安全环境**，全屏卡仍走 iframe。
- JSON patch 泄漏：**已修复**（后端落库 + 前端显示层双兜底），与渲染路径无关。
- 多卡冲突：**已确认**内联后多卡共享主文档导致冲突，**通过"仅最新消息内联"规避**。
- 全屏黑条：**已修复并验证**。

**无明确未完成的技术任务**，所有用户提出的问题均已解决并验证。接手人下一步应：
1. 先通读本文件 + 记忆 `project_memory.md` + 三份 spec/README。
2. 若用户有新的智能卡需求，按上述"双路径 + 全屏 iframe"的架构边界判断归属。
3. 任何 iframe 高度/脚本问题，先排查"dist 是否陈旧"，再查三大振荡根因。

---

## 九、给接手人的一句话总结

> **Palink 是"多租户里的 ST"**：普通智能卡的最新一条消息用内联换自然排版，历史与全屏启动器用 iframe 保隔离与全屏；判定全屏只看显式 launcher 元素；改前端先重新 build 再重启容器；改后端绝不阻塞事件循环主线程；遇到 iframe 高度问题先查 dist 是否陈旧，再按三大振荡根因排查。所有约束、用户偏好与本会话记忆都以 `project_memory.md` 为准，必要时随时回读。