# 双运行时 ST 兼容架构策略 - 检查清单

> 已按代码现状校准（2026-07-17）。

## 认知纠偏验证

- [x] spec 如实承认现状为「公开规范实现 + 移植代码」混合（仓库存有 ST 1.18.0 源码副本）
- [x] spec 明确「新增合规、存量收敛」原则（非"已纯接口实现"）
- [x] spec 明确「单前端双运行时模式」而非双前端
- [x] spec 明确兼容层边界与可禁用原则

## 架构原则验证

- [ ] 新增 ST 兼容端点均为按公开规范独立实现，未复制 ST 后端源码
- [ ] 兼容代码收敛到 `frontend/src/lib/sillytavern/` + `frontend/src/components/sillytavern/` + 后端 `silly_tavern*.py`（非不存在的 `src/st-compat/`）
- [ ] iframe 兼容模式与原生模式共享同一后端 API（单前端内双模式）
- [ ] ST 兼容层可独立启用/禁用

## 阶段一验收标准

- [x] `GET /api/characters` 分页后 100+ 角色加载 < 1s
- [x] 列表裁剪大字段，不返回完整 description/mes_example/creator_notes/post_history_instructions
- [x] 分页参数纳入 `@cached` 键，无错页
- [x] 消息格式化在 Web Worker 执行，主线程不阻塞
- [x] ST 格式角色卡在 Palink 前端正常渲染（HTML/表格/面板）
- [x] 现有 ST iframe 功能未受影响

## 阶段二验收标准

- [ ] 原生模式独立可用（不依赖 iframe ST 运行时）
- [ ] 原生角色卡格式与 ST 格式无损互转
- [ ] 不依赖 ST jQuery/FontAwesome 技术栈
- [ ] 不重复实现已有后端（prompt_manager/personas/st_groups）

## 阶段三验收标准

- [ ] ST iframe 编辑 → 原生模式即时可见
- [ ] ST 兼容层可独立禁用，原生模式不受影响
- [ ] WebSocket 事件双模式广播正常
