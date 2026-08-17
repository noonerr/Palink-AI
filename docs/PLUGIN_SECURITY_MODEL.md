# 插件安全模型（Plugin Security Model）

> 状态：2026-08-17 阶段2「安全模型诚实化」落地。
> 本文档描述 Palink 插件体系的**真实**信任边界——包括没有防住的部分。
> 目标是让"装一个插件意味着什么"变得可判断，而不是宣称不存在的安全性。

## 两条执行路径

| | ESM 插件（plugin-system 沙箱） | 经典脚本插件（SillyTavernPluginRuntime） |
|---|---|---|
| 插件类型 | Palink 原生 ESM 插件 | 酒馆助手 / ST 官方扩展 / Galgame 等 IIFE 经典脚本 |
| 执行方式 | Proxy 沙箱转译执行（`lib/plugin-system/sandbox.ts`，约 5200 行） | `<script>` 标签直接注入主页面 |
| DOM 访问 | 限制在插件容器（带 ST 挂载点白名单回退） | **完整主页面 DOM** |
| window | 白名单 + pluginGlobals 隔离 | **真实 window** |
| fetch | 域名白名单（CDN + 用户配置） | **fetch 守卫**（见下），XHR/script 标签不受限 |
| localStorage | 插件隔离存储 | **真实 localStorage**（可读 palink_token） |
| 适合安装 | 任意来源（含不可信） | **仅可信来源** |

## fetch 守卫（经典脚本路径，2026-08-17 起）

经典脚本插件运行在主 window，其 `fetch` 即 `window.fetch`。插件注入期间
（进入角色对话页 → 离开），`window.fetch` 被替换为守卫版本：

1. **同源请求**：未携带 `Authorization` 头时自动注入 Bearer token。
   配套地，`getRequestHeaders()` 不再返回 token——插件构造的请求头不含凭据，
   转发到第三方或写入日志都不会泄露。
2. **跨源请求**：套用与 ESM 沙箱**同一套**域名白名单
   （`isUrlAllowedByPluginWhitelist`）：默认 CDN（jsdelivr/unpkg/cdnjs/github）
   + 用户在 `localStorage.palink_plugin_fetch_whitelist` 配置的域名（逗号分隔）。
   白名单外的请求被拒绝（reject + 降级统计，见插件管理页「ST 兼容层降级统计」）。
3. `data:`/`blob:` URL 与无法解析的 URL 走原生 fetch。

## 明确的已知限制（诚实清单）

经典脚本插件**仍然**可以：

- **读取 `localStorage`（含 `palink_token`）**——它在主 window 运行，浏览器同源
  存储对它完全可见。fetch 守卫阻止的是"平台主动分发凭据"与"fetch 通道外传"，
  不是读取。要完全杜绝需要 iframe/Worker 隔离重设计，当前不做。
- **使用 XHR / WebSocket / sendBeacon / navigator.sendBeacon** 外传数据——
  守卫只覆盖 fetch。
- **创建 `<script src>`/`<img>` 等标签加载任意远程资源**——不受白名单限制
  （沿用历史行为：酒馆助手等插件依赖 CDN 加载 GSAP/Live2D）。
- **操作全部 DOM、监听全部事件、设置定时器**——`unloadAll` 只能尽力清理
  script/style 标签与已登记的 Galgame 选择器，插件注册的全局函数/监听器/
  MutationObserver 无法撤销。

因此结论不变：**经典脚本插件以"等同网页自身代码"的权限运行，只装可信来源的。**

## 与宿主应用的交互

- 应用自身请求已带认证头（api 层）→ 守卫不动它们。
- 应用公开端点（登录等）可能被注入有效 Bearer——后端忽略无关认证头，无副作用。
- **智能卡第三方资源**（2026-08-17 起）：默认 direct 模式下图片/样式/字体全部由
  浏览器直连第三方（`<img>`/`<link>` 标签加载不经 fetch，不受守卫影响）；仅
  `fetchWarmSmartCardResource` 的跨源预热 fetch 会被白名单拦截并静默失败
  （预热是 best-effort，不影响加载）。proxy 模式下资源走同源代理 URL，与守卫
  无交互。如需放行预热，把域名加入 `palink_plugin_fetch_whitelist`。
  详见设置页「智能卡图片走服务器代理」开关。

## 用户可配置项

```
localStorage.palink_plugin_fetch_whitelist = "example.com,cdn.example.org"
```

追加到默认 CDN 白名单，两条执行路径共用。

## ESM 沙箱路径的边界（摘要）

详见 `sandbox.ts` 注释。要点：Proxy DOM 隔离（容器作用域 + ST 挂载点白名单
回退）、fetch/script 域名白名单、WebSocket 同源限制、CSS/HTML 消毒、
内联脚本拒绝。已知缺口：白名单回退选择器命中的真实 DOM 元素可被插件操作
（这是功能性妥协，见 `ST_MOUNT_POINT_IDS`）。

## 路线图（未承诺）

- XHR/sendBeacon 拦截（视实际威胁反馈）
- `unloadAll` 的监听器/定时器记账反注册（阶段4）
- 经典脚本路径的 Worker/iframe 重设计（成本高，暂不做）
