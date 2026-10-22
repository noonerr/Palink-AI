# BACKUP_INFO · 移除卡片信任开关上线前 dist 归档

## ① 备份日期

2026-10-22 04:4x（本地时间）

## ② 原始来源

- `D:\项目\Palink-AI\frontend\dist`（nginx bind mount 在用产物）
- `dist_before.tar.gz`：**264,058,239 B**，改前入口 `assets/index-I1K08YoO.js`

## ③ 备份原因

老板 2026-10-22 裁定：**信任在上传卡片时勾选决定，卡片 UI 里不得再有任何信任开关。**
据此移除 `CharacterCardRenderer.tsx` 里两处 `<SmartCardTrustButton>`（沉浸式工具栏 + 内联右上角）
及其触发的确认弹窗入口；信任的判定与授权写入逻辑**未改**。
`trust-control.test.tsx` 中原 D-⑤⑥ 两条"渲染器接线"用例测的正是被移除的入口，随功能一并删除
（文件内留了裁定说明）；组件层（盾牌按钮/确认弹窗）用例保留。

## ④ 后续待办清单

1. 上线后判据（零成本，已实测）：
   - `curl` 读入口 ⇒ `assets/index-CHK4yxNm.js`；
   - 真机主文档 + 7 个卡片帧内 `button[aria-label]` 含"信任"的数量 **全部为 0**；
   - 7 帧仍渲染，逐层变量哈希与改动前逐条相同（`52be50fb/a9bea921/6245467/ef80ce5f×2/4a6e0012×2`）。
2. `shared.ts` 里的 `nativeEnabled` / `enableNative` 等文案键仍保留（组件层与导入流程可能用到），
   属"文案在、入口无"，不是残留开关；将来若确认无人用可另立清理议题。
3. 回退：`tar -xzf dist_before.tar.gz -C frontend/` 还原整份 dist 即生效。
4. 待清理：`frontend/dist_ms2` / `dist_ms3` / `dist_trust` 三个构建草稿目录，走"列清单→隔离→确认→删"。
