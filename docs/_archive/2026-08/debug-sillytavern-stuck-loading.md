# Debug Session: sillytavern-stuck-loading

## Status: [OPEN]

## Symptom
SillyTavern iframe 卡在"正在加载 SillyTavern..."，`stReady` 状态始终为 `false`。

## Hypotheses
- **A**: `script.js` 未成功执行，`window.SillyTavern` 未定义（模块加载失败或 JS 执行错误）
- **B**: `bridge.js` 的 `checkSTReady` 轮询逻辑有 bug，即使 `window.SillyTavern` 已定义也没有正确发送 `ready` 消息
- **C**: `bridge.js` 的 `window.fetch` 拦截未生效，API 请求返回 HTML，JS 解析错误阻止了 `script.js` 执行
- **D**: `lib.js` 打包后存在运行时错误（如某些库的副作用），导致模块加载失败
- **E**: `SillyTavernIframe` 组件中的 `message` 事件监听有问题，导致即使 iframe 发送了 `ready` 消息，主应用也没有收到

## Evidence

## Fix

## Verification
