# 智能卡完全内联渲染改造 — 交接文档

> 目标：放弃 iframe 沙箱方案，像 SillyTavern 一样把智能卡 HTML 完全内联进 `.mes_text`，换取 100% ST 一致的浏览器自然排版体验（根除截断/抖动问题）。

## 背景（为什么走到这一步）

- `CharacterCardRenderer.tsx` 手写 ST 兼容 shim + iframe 高度测量，反复出现「先截断、点一下才展开」问题
- 多轮修复（图片 load 重测、字体 fonts.ready、realContent 上报）均无法根治——**问题根源是 iframe 本身**：只要内容塞进 iframe，就要自己解决高度/滚动/资源加载，这些是 ST 不需要面对的
- 用户确认：**完全内联（舍弃沙箱）**，接受单用户信任模型

## 文档结构

| 文件 | 内容 |
|---|---|
| [spec.md](./spec.md) | 完整技术方案：现状分析、目标架构、分步计划、风险、验证、回滚 |
| [todolist.md](./todolist.md) | 执行清单（按阶段，含明确禁止事项） |
| [注意事项.md](./注意事项.md) | 最容易踩坑的点速查（执行前必读） |

## 建议执行顺序

1. 读 `spec.md` §0（决策记录）+ §1（现状分析）
2. 读 `注意事项.md` 全文
3. 按 `todolist.md` 从阶段 A 开始，每阶段过四道关：tsc 无错 → `npm run build` 成功 → 功能实测 → 插件实测

## 关键文件索引

| 文件 | 作用 |
|---|---|
| `frontend/src/components/ui/custom/Message.tsx` | 渲染决策树所在，smart-card 分支 L937 要改 |
| `frontend/src/components/ui/custom/CharacterCardRenderer.tsx` | 要删除 iframe 渲染的核心对象 |
| `frontend/src/components/ui/custom/smart-card-runtime/` | 各模块，部分可复用、部分删除 |
| `frontend/src/utils/sillyTavernDisplayPipeline.ts` | smart-card 判定逻辑（保留） |
| `frontend/public/st/palink-smart-card.js` | ST 脚本执行方案参考（fetch 拦截 + MutationObserver） |
| `frontend/src/components/ui/custom/TavernHelperPanel.tsx` | Tavern Helper 面板（不能破坏） |
