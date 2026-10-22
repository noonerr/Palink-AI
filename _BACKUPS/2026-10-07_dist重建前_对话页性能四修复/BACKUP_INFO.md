# BACKUP_INFO

## ① 备份日期
2026-10-07 02:41（GMT+8）

## ② 原始来源路径
`D:\项目\Palink-AI\frontend\dist\`（nginx bind mount 的**在用产物**，14M）
- 在用入口：`assets/index-CHx1GjHq.js`
- 该产物构建于 2026-10-06 22:49

## ③ 备份原因
「对话页性能四问题修复」（commit `d436a7e`）需要重建 dist 才能生效，重建前留存在用产物快照。

**为什么这次重建是安全的（重建前的判定依据）**：
1. 不影响并行修后端的 agent —— 本次只覆盖前端静态产物，后端容器不动。
2. 工作区另有 15 项并行前端 agent 的在途改动（变量面板 `VariableChangePanel` /
   `cardVariables.ts` / `legacy-st-sim.ts` P0-FIX 等，10-05 起、10-06 20:24 最后改动），
   它们会被一并烤入。但**当前在用的这份产物本身就已包含这批改动**（10-06 22:49 构建，
   见 10-06 报告 §5.5.1「新构建 index-CHx1GjHq.js 全分块复核」），
   ⇒ 本次重建不是在"干净基线"上首次推半成品，而是在"已含该批"的基线上叠加本轮修复。
3. 这批在途文件今天（10-07）mtime 均未更新，说明并行 agent 当前不活跃，非编辑中间态。
4. 重建前门禁绿：`npx tsc --noEmit` exit 0；`npx vitest run` 65 文件 / 810 passed / 0 failed
   （且是在含这批在途改动的工作区上跑的）。

## ④ 后续待办清单
- [ ] 重建后核验：容器 14000 端口返回 200 且 `index.html` 入口指向新指纹
- [ ] 核验 `dist/index.html.gz` 解压后的入口与明文 `index.html` 一致（nginx gzip_static）
- [ ] 真机验证四项修复（**均未真机验证**）：
      · 点角色卡进入对话 → 被点卡片出现「正在进入对话…」spinner
      · 点「↑ 加载更早消息」→ 视口位置不动（ΔscrollTop ≈ ΔscrollHeight）
      · 60 秒内二次进入同一会话 → messages / branch-tree 请求数为 0
      · 故事线分支切换 → 正文不再整块空白，连续切 3 次每次都要出正文
- [ ] 未做的 P0（需真机验证）：卡片 iframe 懒挂载、4MB 插件脚本与正文渲染解耦及瘦身
- [ ] 旧 hashed 资源不删（in-flight 客户端仍可能引用）

## 回滚方式
```bash
cp -r _BACKUPS/2026-10-07_dist重建前_对话页性能四修复/dist/. frontend/dist/
```
（回滚后同样需确认 nginx 服务的是 `index-CHx1GjHq.js`）
