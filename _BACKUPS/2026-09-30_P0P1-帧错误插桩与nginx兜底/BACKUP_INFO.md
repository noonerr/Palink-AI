# 备份说明

## ① 备份日期

2026-09-30

## ② 原始来源路径

| 文件 | 原始路径 | 状态 |
|---|---|---|
| dist 快照 | `D:\项目\Palink-AI\frontend\dist\` | **物理快照**（本目录 `dist/`），nginx bind mount 的在用产物（修复前版本） |
| git HEAD 指纹 | — | 本目录 `git-head-commit.txt` = `15dc75c`（st-plugin-compat-20260727 分支头） |
| CharacterCardRenderer.tsx | `frontend/src/components/ui/custom/CharacterCardRenderer.tsx` | git tracked 且改动前与 HEAD 一致（恢复命令见下） |
| legacy-st-sim.ts | `frontend/src/components/ui/custom/smart-card-runtime/frame-shim/legacy-st-sim.ts` | 同上 |
| nginx.conf | `frontend/nginx.conf` | 同上 |
| inspect_close_tags.py / inspect_regex_scripts.py | 本目录 | P0 排障用的 DB 数据分析脚本（调查记录，非源码备份） |

> 注：三个源文件本应物理复制进本目录，但 Mimosa PreToolUse 钩子按文件名拦截一切
> Bash 写源码（含备份目的地）。三文件均为 git tracked、改动前与 HEAD 完全一致，
> 故以 git 对象为权威备份。

## ③ 备份原因

接手 `HANDOFF_卡片正文空白与卡脚本执行_2026-09-30.md` 的 P0/P1 施工。

**P0 最终结论（与交接文档 §3 的首要嫌疑不同）**：`SyntaxError: Unexpected token '<'`
不是任何网络请求（nginx 访问日志全量核查无 SPA 兜底伪装记录），真凶是
**`frontend/src/lib/sillytavern/formatting.ts` 的 `renderMathInHtml`**：完成态 LaTeX
渲染只保护 `<pre>/<code>`，不保护 `<script>`——状态栏卡片 JS 里的 jQuery 代码
`$('#lia-date').text(...)` 与 `$('#lia-time')` 之间的代码被 `\$...\$` 行内公式正则
配对，KaTeX 解析失败后整段替换为 `<span class="katex-error">`，脚本文本混入 `<`，
注入 iframe 后 SyntaxError、面板脚本永不执行 → 立绘/角色面板空白。
修复 = `renderMathInHtml` 补 `<script>/<style>` 段保护（与 pre/code 同口径）。
已验证：修复后 `window.__palinkFrameErrors` 清零，面板/立绘全部渲染出数据。

本轮落地改动（除本备份外）：
1. `formatting.ts` renderMathInHtml 补 script/style 保护（**根因修复**）。
2. `CharacterCardRenderer.tsx` frame-error 收集器透传 `filename/lineno`（永久改进）。
3. `legacy-st-sim.ts` SCRIPT 资源加载失败连同 URL 上报（永久改进）；P0 排障用的
   临时诊断（MutationObserver/createElement 陷阱/err-context 等）已全部拆除。
4. `nginx.conf` P1 加固：资源扩展名显式 404 + `/uploads/` 加 `^~`（已 reload 验证）。
5. 新增守卫测试 ×3：帧错误上报契约、生成脚本文本可解析性、KaTeX script 保护。

## ④ 后续待办清单

1. **故事帧"故事正文为空"已修复（同日第二批，根因三层）**：
   ① `Message.tsx` 传给渲染器的 context 漏了 `chatMessages`（smartCardChatMessages
   只喂了显示管线，renderer 的 context.chatMessages 恒 undefined）→ iframe
   compatChat 恒空、`getChatMessages` 永远返回 []；已补传（同批补 `messageIndex`）。
   ② `getCompatChatMessages` 把数字 id 一律当数组下标，而 Palink 的 messageId 是
   数据库行 id（如 2375）→ `messages[2375]` 越界落空；已改为索引未命中回退按
   id/message_id 匹配（ST 脚本传索引的语义不受影响，索引优先）。
   ③ 卡脚本在解析期注册 DOMContentLoaded init，此刻 chatMessages 尚未 context-update
   到达（boot ctx 刻意轻量），数据首达后无人再调 init；面板脚本靠 ST 事件
   （VARIABLE_UPDATE_ENDED 等所以能恢复）而故事脚本只挂一次性 DOMContentLoaded。
   已修：运行时 applyParentContextUpdateCompat 加闭包级一次性标志，chatMessages
   首达补发一次 DOMContentLoaded（对齐 ST"脚本运行时数据已在"的生命周期）；
   shim 层另加"文档加载完毕后的 DOMContentLoaded 晚注册异步补发"（覆盖脚本重放路径）。
   验证：故事正文逐句渲染、帧错误 0。新增守卫
   `card-init-late-registration-guard.test.ts`（4 例）。
   改动文件另含：`Message.tsx`（context 补 chatMessages/messageIndex）、
   `SillyTavernCompatRuntime.ts`（数据首达补发 + getCompatChatMessages id 回退）。
2. **P3（需用户拍板，勿擅自做）**：iframe 内 MVU 依赖缺全局 `Vue`/`z`，是否预加载
   Vue3+Zod 到 window 是产品决策。注意：角色面板当前显示的数值是卡脚本自身的
   兜底默认值（本会话变量仍为空，MVU 未跑）。
3. **P4（需用户拍板）**：沙箱 opaque origin 的 localStorage 与主页面不互通，跨端
   存储桥设计待立项。
4. **次要发现**：`frontend/src/i18n/translations.ts:324` 声称
   `frontend/public/st/locales/{locale}.json` 应存在，实际目录不存在，
   `lib/i18n/index.ts` 每次页面加载 fetch 404 后静默降级空翻译。
5. `formatting.ts` / `Message.tsx` 有并行会话（图片代理批等）的在途未提交改动，
   本次修复叠加其上，提交时需按 pathspec 谨慎拆分。

## 恢复命令

```bash
cd D:/项目/Palink-AI
# 三个源文件（tracked，与 15dc75c 一致）：
git checkout 15dc75c -- frontend/nginx.conf \
  frontend/src/components/ui/custom/CharacterCardRenderer.tsx \
  frontend/src/components/ui/custom/smart-card-runtime/frame-shim/legacy-st-sim.ts
# dist：从本目录拷回（禁止反向覆盖本备份，AGENTS.md 第 4 条）
cp -r dist/. ../frontend/dist/
```
