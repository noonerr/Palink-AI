# ST 兼容性约束下的前端优化可行性复核

> 复核日期：2026-09-21　前置报告：`docs/ANALYSIS_前端性能与缓存优化_2026-09-21.md`
> 触发条件：用户明确要求「不影响 ST 兼容性，尤其是插件兼容性」
> 结论：**上一轮列出的「首屏体积削减」方案（O2 动态拆包）绝大部分不成立，必须撤回。零风险项只剩缓存层与分包层。**

---

## 0. 一句话结论

**这个项目首屏 55% 的体积，恰好就是 ST 兼容层本身。** 想要压首屏，就必须在「ST 兼容完整度」和「首屏体积」之间做交易；在不碰兼容面的前提下，只能优化**缓存层**，不能优化**首访字节**。

---

## 1. 逐组复核结果

上一轮我把 5 组「可延后」的库列成了优化目标。逐个查代码后，**4 组不能拆**：

| 组 | 库 | 上轮判定 | 复核判定 | 依据（代码位置） |
| --- | --- | --- | --- | --- |
| A | jquery / select2 / toastr / handlebars / marked | 可拆，收益 ~95KB gzip | **❌ 不可拆** | 三处运行时热路径 + 一处同步 require 路径，见 §2 |
| B | katex | 可拆，收益 ~65KB | **❌ 不可拆** | `formatMessage` 是**同步**函数，且是 ST 插件契约 `messageFormatting` 的实现 |
| C | chevrotain（宏引擎） | 可拆，收益 ~35KB | **❌ 不可拆** | `MacroRegistry`/`evaluateMacros` 经 `getContext.ts` 暴露给插件；宏在显示链路同步求值 |
| D | react-markdown + remark + rehype | 可拆，收益 ~50KB | **❌ 不可拆** | 被 `smart-card-runtime/shared.ts` 静态引用，是智能卡运行时全部模块的公共底座 |
| — | framer-motion | 可拆，收益 ~30KB | ⚠ 可拆但无收益 | 只被 `Sidebar.tsx` 用，而 Sidebar 在 App shell 常驻，拆出去也立刻加载 |

**合计撤回约 275KB gzip 的削减承诺。**

---

## 2. 组 A（jQuery 系）为什么不能拆 —— 三个消费方 + 一条同步路径

### 消费方 1：插件沙箱 `lib/plugin-system/sandbox.ts`

- 模块**顶层**执行 select2 注册副作用（`sandbox.ts:163-171`）：
  ```ts
  const factory = (select2Factory as any)?.default ?? select2Factory;
  if (typeof factory === 'function' && jQuery) {
    factory(window, jQuery);   // 扩展 $.fn.select2
    select2Ready = true;
  }
  ```
  这不是惰性函数，是 module-eval 期的副作用。
- `createSandboxGlobal()`（`sandbox.ts:2894`）里用真实 jQuery 构造包装层：
  ```ts
  Object.assign(wrappedJQuery, jQuery);
  wrappedJQuery.fn = jQuery.fn;          // 必须同一引用，插件 $.fn.myMethod 扩展才生效
  wrappedJQuery.prototype = jQuery.prototype;
  ```
- **致命点**：`evalLocalFile()`（`sandbox.ts:2867-2883`）是 **同步** 私有方法，也调用 `createSandboxGlobal`。它服务于插件 `require('./core/xxx.js')` 的**同步**加载场景 —— 在这里无法 `await`。
  - 可行解法只有一条：把 `await ensureStCompatLibs()` 提到 `executePluginCode()`（`sandbox.ts:2629`，本身是 async）开头，再让 `createSandboxGlobal` 从模块级缓存同步读取。
  - 这条**理论上成立**，但它是「所有插件入口都必须先 await」的全局不变量，一旦将来新增一条插件执行路径（bridge.js / 新的 host），忘记 await 就会让插件静默拿到 `undefined` 的 jQuery —— **失败模式是静默的，不是报错的**。

### 消费方 2：`utils/sillyTavernPluginRuntime.ts`

```ts
import jQuery from 'jquery';        // 文件头第 3 行
...
// 设置全局 jQuery：酒馆助手等 ST 插件脚本在 IIFE 中直接使用 $ 变量，
// 必须在脚本注入前将 window.$ / window.jQuery 设置为真实 jQuery
(window as any).$ = jQuery;
if (typeof (window as any).jQuery === 'undefined') (window as any).jQuery = jQuery;
```
这是插件脚本注入的**前置条件**：`window.$` 必须在插件 IIFE 执行前就位。

### 消费方 3：`smart-card-runtime/inline/inline-st-globals.ts`

```ts
import jQuery from 'jquery';        // 第 28 行
/* jQuery：主包里已有（sillyTavernPluginRuntime 静态引用），此处直接复用同一实例 */
defineIfAbsent(win, '$', jQuery);
defineIfAbsent(win, 'jQuery', jQuery);
```
调用链：`InlineCardRenderer.tsx:128` → `ensureInlineStGlobals()`，位于 **`useLayoutEffect`**（第 126 行）内，**同步调用**。
而 `inline-flags.ts:74` 说明「**最新消息走 InlineCardRenderer**，历史消息走 CharacterCardRenderer(iframe)」—— 也就是**默认路径**。

> 结论：jQuery 在「插件沙箱 + 插件脚本注入 + 内联智能卡首帧」三处都是**热路径同步依赖**。为省 95KB gzip 去改三处时序，且失败模式是静默降级，**不划算**。

---

## 3. 组 B（KaTeX）为什么不能拆 —— 它在一个 ST 契约同步链路上

```
sandbox.ts:3268   return formatMessage(String(content ?? ''), {...})   ← ST 插件 API messageFormatting
                       ↓ 同步
formatting.ts     formatMessage() → renderMathInHtml() → renderMathInSegment()
                       ↓ 同步
formatting.ts:221 return katex.renderToString(tex, {...})
```

- `formatMessage` 是 **同步** 函数（`formatting.ts` 全部导出均为 `export function`，无 async 版本）。
- `sandbox.ts:3262-3268` 把它作为 `messageFormatting` 交给 ST 插件 —— 而 ST 原版该 API **就是同步返回字符串**。
- 改成 async 会让所有调用 `context.messageFormatting(...)` 的插件拿到 Promise 而不是字符串 → **契约破坏**。
- 折中（后台预加载 + 未就绪时回退渲染原文）会让**首次**含公式消息显示成 `$x^2$` 原文再突变 → 可见回归，正是 `formatting.ts:198-201` 注释里明令禁止的「流式/完成态突变」。

---

## 4. 组 C（chevrotain）为什么不能拆

- `getContext.ts:19` 静态引入 `MacroRegistry, evaluateMacros` 并将其暴露给插件。
- `lib/sillytavern/macros/bridge.ts:115` 再导出 `evaluateMacros / MacroEngine / MacroRegistry`。
- `lexer.ts` 在**模块顶层**用 `createToken` 定义词法记号，`MacroLexer` 是模块级构造物。
- 宏在消息显示链路（`substituteParamsExtended`）中**同步求值**，`sandbox.ts:7` 与 `sillyTavernPluginRuntime.ts:5` 都静态依赖 `macros`。

---

## 5. 组 D（react-markdown 家族）为什么不能拆

- `components/ui/custom/smart-card-runtime/shared.ts:12-13`：
  ```ts
  export const REMAINING_MARKDOWN_PLUGINS = [remarkGfm, remarkMath];
  export const REMAINING_REHYPE_PLUGINS = [rehypeKatex];
  ```
- `shared.ts` 是 `smart-card-runtime/` 下**几乎所有子模块**的公共底座（`CharacterCardRenderer` 一次性从它导入 20+ 个符号）。
- 这 4 个包（含 micromark/mdast 传递依赖，约 437KB 未压缩 ≈ 50KB gzip）因此被焊死在入口。
- 唯一消费点只有 `CharacterCardRenderer.tsx:1663-1668` 一处 JSX，但它的宿主模块是智能卡渲染器 —— **动它就是动智能卡**。

---

## 6. 复核后仍然成立的部分（零 ST 兼容风险）

### 6.1 缓存层 —— 收益最大、风险为零

| 项 | 内容 | 为什么零风险 |
| --- | --- | --- |
| **O1** | 带 hash 的 JS/CSS 改 `public, max-age=31536000, immutable` | 纯 nginx 响应头，不碰任何代码。内容变则文件名变，语义上不可能拿错文件 |
| **O4** | `/fonts/`、`/st/css/`、`/st/webfonts/`、`/katex.min.css`、`/bootstrap.js` 加 `max-age` | 同上。注意 `/st/*` 非内容 hash，建议 7d 而非 30d，避免上游更新 Font Awesome 后长期拿旧版 |
| **O5′** | **只**缓存 `/api/st/characters/{key}`（角色头像） | 该路由后端**不强制鉴权**（`nginx.conf:131-136` 注释已说明），是共享内容 |
| **O6** | `gzip_static` 预压缩 | 构建产物加 `.gz`，nginx 少做一次实时压缩 |

**⚠ 修正上一轮的 O5-A：`/uploads/` 不能做 nginx 代理缓存。**
理由：`/uploads/{file_path:path}` 的鉴权是 `_verify_upload_access()` 的**短时效令牌**（`backend/app/main.py:448-521`，N-7 去主 JWT 化）。nginx 默认缓存键含 query string → token 每 5 分钟变 → 缓存命中率≈0（缓存无收益）；若为提命中率而自定义缓存键**剔除 token**，则等于绕过令牌隔离（知道路径即可拿到他人附件缓存体）→ **安全回归**。故 `/uploads/` 保持现状。

### 6.2 路由预取瘦身（O3）—— 已核实与插件无关

`StPluginMountPoints` 位于 `App.tsx:1105`，在 `Route path="*"`（App shell 层）内，**不在页面级 `<Routes>`（`App.tsx:1008-1016`）里**。
→ 插件挂载点与当前路由无关，预取策略怎么改都不影响插件挂载时机。

### 6.3 函数式 `manualChunks` 做 vendor 分包（O2′）—— 零兼容风险

- 与 dynamic import 不同，`manualChunks` **不改变任何模块的加载时机**，只改变「哪些字节落在哪个文件里」。
- 首次访问字节数**不变**（入口静态 import 的包仍会被 Vite 加 `modulepreload`）。
- 收益在**重复访问与发版之后**：vendor chunk 内容不变 → 命中 immutable 缓存 → 0 字节；只有业务代码 chunk 变化时才重下。
- 与智能卡独立资产**无冲突**：`palink-smart-card-runtime-<hash>.js` 由 `vite-plugins/smart-card-runtime-asset.ts` 经 `emitFile` 产出，是独立资产，不参与 chunk 切分（`vite.config.ts:65` 的原注释亦已核验此点）。
- **硬约束**（沿用 `vite.config.ts:54-68` 的教训）：必须用**函数式** `manualChunks`，只匹配目标包自身的 `node_modules` 路径；**切勿**把 `dompurify` / `clsx` / `react` / `katex` 等共享依赖纳入命名 chunk，否则会重演 2026-09-15 的「巨型 chunk 被 modulepreload 拉进首屏」事故。

### 6.4 佐证：作者本来就是按 immutable 设计的

`vite-plugins/smart-card-runtime-asset.ts` 的 dev 中间件里明确写着：
```ts
res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
```
并在文件头注释里写「hash 文件名**命中 nginx immutable 缓存规则**」。
→ 说明 O1 是**设计意图**，生产 nginx 的 `no-cache, must-revalidate` 与之矛盾。这是一处应当修正的不一致。

---

## 7. 如果将来要动首访字节：代价与前置条件

不是「不能做」，而是必须当作**独立项目**做，且要接受以下前置条件：

1. **必须逐条回归**：`npm run test:contract`（162 项）中 `runtime-contract` / `event-contract` / `getcontext-parity` / `regex-pipeline-contract` / `formatting-latex-contract` 正好覆盖这些兼容面。
2. **必须补一条不变量守卫**：所有插件执行入口都在 await 之后，否则失败模式是**静默**的（拿到 undefined 不报错）。
3. **必须接受可见回归**：智能卡首帧或含公式消息会出现加载占位/原文回退。
4. **优先级建议**：A（jQuery 三消费方）> D（markdown 底座）> B（KaTeX 契约）> C（宏引擎）。收益递减、风险递增。

**我的建议：不做。** 首屏 541KB gzip 里有 ~285KB 是兼容层，这是这个项目「兼容 ST 生态」的**固有成本**，不是可以白拿的优化空间。

---

## 8. 修订后的实施清单

| 顺序 | 项 | 内容 | 风险 | 生效方式 |
| --- | --- | --- | --- | --- |
| 1 | **O1** | hashed 资源 immutable | 零 | `docker restart palink-ai-frontend-1` |
| 2 | **O4** | 字体 / `/st/` / katex.css / bootstrap.js 加 max-age（`/st/` 用 7d） | 零 | 同上 |
| 3 | **O3** | 路由预取瘦身 | 零（1 文件） | 重跑 build |
| 4 | **O6** | gzip_static | 零 | 重跑 build + restart |
| 5 | O5′ | 仅 `/api/st/characters/` 头像代理缓存 | 零 | `docker restart` |
| 6 | **O2′** | 函数式 `manualChunks` vendor 分包 | 零（不改加载时机） | 重跑 build |
| — | ~~O2 动态拆包~~ | ~~5 组库改 dynamic import~~ | **撤回** | — |
| — | ~~O5-A `/uploads/` 缓存~~ | ~~代理缓存~~ | **撤回（安全）** | — |
