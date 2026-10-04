# BACKUP_INFO — 2026-09-30_plugininject-注入断点修复前

## 备份日期
2026-09-30

## 原始来源
`D:\项目\Palink-AI\frontend\src\utils\sillyTavernPluginRuntime.ts`
（备份时工作区状态：该文件相对 HEAD 有 15 行未提交改动，即并行的「图片代理」补丁；备份内容 = 改动后的当前工作区版本，md5 `86defa8134531c33df5109ee3a06c5a8`）

## 备份原因
排查「角色卡面板与正文 UI 内容为空」时定位到断点：该文件 `injectIntoContainer` 的 setup 脚本模板里第 1372 行
把正则字面量 `/^https:\/\/[a-z0-9.-]*jsdelivr\.net\/(.+)$/i` 直接写进了模板字符串，模板字符串会吃掉反斜杠，
实际注入页面的脚本文本变成 `/^https://[a-z0-9.-]*jsdelivr.net/(.+)$/i` —— 无法解析，
浏览器抛 `SyntaxError: Failed to execute 'appendChild' on 'Node': Unexpected token ']'`（已在 node 里离线复现同一报错）。
第 1388 行 `container.appendChild(setupScript)` 没有 try/catch，于是整段注入中断：
setup 脚本负责挂的 ST 全局（`getGlobalWorldbookNames` / `setExtensionPrompt` / `injectPrompts`）全部没挂上，
后续卡片扩展脚本（含 45948 字符的 `tavern_helper.scripts[2]` CG 图库悬浮按钮）一个都没注入。

## 内容清单
- `frontend/src/utils/sillyTavernPluginRuntime.ts`（修复前原件，保留原相对路径）

## 后续待办清单（备份之后需修复或修改的任务）
- [ ] 第 1372 行正则改为在模板字符串里能安全生成的写法（`new RegExp("...")` 形式）
- [ ] 第 1388 行 `container.appendChild(setupScript)` 包 try/catch：单个 setup 脚本坏了不得拖垮整批插件注入
- [ ] 加真守卫测试：断言生成的 setup 脚本文本可被解析（`new Function` 不抛）且注入后 ST 全局确实为 function
- [ ] `cd frontend && npx tsc --noEmit` + `npx vitest run` 通过后重build dist，并在浏览器复验控制台无 SyntaxError
- [ ] 复验 CG 悬浮按钮（`#tavern-cg-float-btn`）是否随注入恢复而出现；若仍不出现，再单独查该脚本依赖的
      `getVariables` / `getChatMessages` / `getCurrentMessageId` 是否由我们提供

## 还原方式
把本目录下 `frontend/src/utils/sillyTavernPluginRuntime.ts` 拷回原位即可（内容零改动、零重命名）。
