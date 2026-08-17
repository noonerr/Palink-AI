# Palink 轻插件范本（palink-sample-extension）

这是一个**最小可装的 ST 扩展**，用于验证 Palink 原生 UI 对轻量 ST 插件的兼容链路。
它不是某个具体第三方插件，而是一份「能跑通的最小样本」，作为后续适配其他轻插件的模板。

## 验证的三件事

1. **多文件模块加载（双源解析）**：`index.js` 通过 `import { EXT_ID } from './core/constants.js'`
   加载插件自带模块。沙箱此前只查 ST 模块白名单、不解析插件本地文件——这是 2026-07-30
   修复的核心缺口（`sandbox.ts` 的 `createMockRequire` 改为 `makeRequire(baseDir)`）。
2. **extension_settings 共享 store**：插件读写 `extension_settings[EXT_ID]`，与 ST 1.18.0
   全局命名空间契约对齐，并由 `saveSettingsDebounced()` 持久化。
3. **jQuery 注入设置面板**：用 `$('#extensions_settings').append(...)` 把面板落到真实挂载点。

## 关键陷阱（务必记住）

沙箱里 `document` 被代理到**插件私有 container**（`getOrCreatePluginExtensionContainer`），
原生 `document.getElementById('#extensions_settings')` 只会查到空容器、找不到真实挂载点。
但注入的 `jQuery` 是模块加载时捕获的**真实 jQuery**，内部查真实 `document`，所以
**设置面板必须用 `$('#extensions_settings')` 注入，不能用原生 `document.getElementById`**。

## 安装与验证

1. 把本目录打包为 zip，通过 Palink 前端「插件管理器」安装（或后端 `/api/plugins/install`）。
2. 在聊天界面打开「插件设置」，应看到本插件的设置面板（标题 + 启用复选框）。
3. 勾选/取消复选框后，刷新页面再打开，状态应保持（验证 extension_settings 持久化）。

## 自动验证脚本

`../verify-sample.mjs` 可在 Node 环境实跑本插件的「数据面 + 注入逻辑」（mock 真实 jQuery /
extension_settings / document），断言上述三件事成立，无需浏览器：

```bash
node ../verify-sample.mjs
```

## 不在本范本范围

- 深插件（小白X / 酒馆助手）：依赖大量 ST 内部符号与 ST 服务端端点，必须走
  opt-in st-native 逃生舱（真实 SillyTavern sidecar），不在 Palink 原生 UI 内运行。
- 事件钩子、slash command、generate_interceptor：本范本未演示，属后续适配项。
