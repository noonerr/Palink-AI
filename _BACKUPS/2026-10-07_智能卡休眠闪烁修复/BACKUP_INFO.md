# BACKUP_INFO

## ① 备份日期

2026-10-07（03:28）

## ② 原始来源路径

- `frontend/src/components/ui/custom/Message.tsx`（108011 字节，含 `SmartCardDormancyGate` 的 `repaintKick` display 双帧切换版）

## ③ 备份原因

修复「智能卡消息进入视口后正文持续闪烁」前留存现场。

**故障现象**（用户真机录屏，448x960 / 30fps / 9s）：

- 长对话滚到倒数第二条（N-1，一条 `pipelineResult.kind === 'smart-card'` 的助手消息）时，
  卡片**外框位置与高度不变**，但框内正文在「有 → 无 → 有 → 无」之间反复跳，肉眼即"一闪一闪"。
- 最后一条（N）停留在视口内时完全正常。
- 20fps 抽帧（3.4s–5.0s）可见空白段持续约 150–200ms、周期复现，非单次抖动。

**根因**：`d436a7e` 把唤醒重绘踢从 `transform: translateZ(0)` 翻转改成 `display` 双帧切换
（`inner.style.display='none'` → 下一帧 `''`）。该元素同时是被 `IntersectionObserver` 观察的目标，
`display:none` 会让其高度瞬间归零 ⇒ 观察器立刻报"离开视口" ⇒ 走休眠分支（此刻 `offsetHeight` 为 0，
`dormantHeight` 被置 null）⇒ 高度恢复后观察器又报"进入视口" ⇒ `dormantRef.current` 仍为 true
⇒ 再次 kick。**自激闭环**，与滚动位置无关，停下也继续闪。

**为什么只有 N-1**：`SmartCardDormancyGate` 只包裹 `smart-card` 分支；N 若始终停在视口内从未休眠，
`dormantRef.current` 恒为 false，永不进入 kick 分支。N-1 是"先休眠、再被滚回视口"的那一条，
是唯一满足 kick 触发条件的消息。

**附带结论（本轮复核）**：`repaintKick` 本身就是误判产物。
`docs/_active/report/REPORT_历史消息样式丢失_深度窗根因_2026-10-07.md` 已证明
「历史消息样式丢失」的真根因是角色卡正则 `maxDepth` 深度窗，**那类消息压根没生成 iframe**，
不存在"iframe 休眠后不重绘"；且 10-07 已移除 `content-visibility: hidden`，
"跳过整棵子树渲染"的载体已不存在，`visibility` 从 hidden→visible 本身必然走主线程重绘。

## ④ 后续待办清单

1. **已做**：删除 `repaintKick` 调用与函数；加固观察器回调（状态未变则忽略、测不到高度则不进入休眠）。
2. **待真机复测**：滚动到任意曾休眠的智能卡消息，确认正文不再闪；
   同时确认 10-07 要修的「休眠态加载后正文空白」**没有回归**（判据：卡片正文与样式同时可见，
   不是纯文本或灰块）。
3. **已上线**（2026-10-07 03:34）：本批只改 `Message.tsx`。
   用项目内置的备份式构建工作流绕开 `scripts/clean-dist.cjs` 的批量删除保护 ——
   `VITE_OUT_DIR=dist_fix_dormancy node scripts/build-vite.mjs` 构建到独立目录，
   再 `cp -r` 同步进 `dist`，最后 `node scripts/gzip-dist.cjs` 补 .gz。
   - 新入口：`assets/index-C6qsLQK4.js`（旧：`index-aWXo-K7r.js`）
   - 含休眠门控的 chunk：`assets/index-B_CIMkVQ.js`（旧：4 个残留副本，其中 3 个含 `firstElementChild`）
   - **产物级验证**：该 chunk 的 `firstElementChild` 命中数 **1 → 0**（`firstElementChild` 是属性名，
     terser 默认不 mangle，可作可靠判据；局部函数名 `repaintKick` 会被压缩重命名，不可作判据）
   - 线上核验：`http://localhost:14000/` HTTP 200，入口与上述一致，chunk 200 / 1800560 字节
   - 回滚点：`_BACKUPS/2026-10-07_dist重建前/dist`（入口 `index-aWXo-K7r.js`，即重建前在用产物）
     ⇒ `cp -r <该目录>/dist/. frontend/dist/`
4. **待订正文档**：`docs/_active/report/REPORT_角色卡对话页性能四问题排查_2026-10-07.md` 的
   §4 第 2 条（休眠修复）应加订正说明 —— 该修复引入了自激闪烁，且其针对的现象已被证伪。
