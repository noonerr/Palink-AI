# BACKUP_INFO · MS-3 谱系守卫 + 审计采纳修法上线前 dist 归档

## ① 备份日期

2026-10-22 04:0x（本地时间）

## ② 原始来源

- `D:\项目\Palink-AI\frontend\dist`（nginx bind mount 在用产物）
- `dist_before.tar.gz`：**260,669,784 B**，`tar -tzf` 可读
- 改前入口：`assets/index-D3_xHSm8.js`（MS-2 那一版）

## ③ 备份原因

把两处**已提交但未上线**的改动发到线上：
1. **MS-3**（`69fc9eb`）：`/branch-create` / `/checkpoint-create` 取不到楼层锚点时不再创建分支
   （旧行为会造出父指针双空的"谱系丢失分支"，是库里 32 行 NULL 父分支的来源之一）。
2. **审计采纳的 P0-1**（`82d5a26` 之后的一行修法）：页面级变量在"视点不可得"时只覆盖
   `stat_data`，不再整份替换 `variables`（避免丢掉卡/插件写入的自定义键）。

## ④ 后续待办清单

1. 上线后判据（零成本）：
   - `curl` 读入口 ⇒ `assets/index-I1K08YoO.js`；
   - 产物字面量 `未创建分支` 命中 1 个 js；
   - 后端容器内 `grep -c "采纳审计" /app/app/api/character_ext.py` = 1；
   - 真机：打开角色页，卡片帧内各楼层值哈希与接口逐层值一致（方法见 2026-10-22 变量报告 §9）。
2. ⚠️ 已知观察：真机导航到角色页后，**活动分支**可能落在只有 1 条消息的那条分支上
   （`327f3d97…`），此时接口如实返回 `mvu_state_source=unavailable`、不回落会话级。
   这是 MS-2 的预期行为（宁缺勿错），但如果用户看不到主分支，属**另一个问题**（分支选择/恢复），
   另立议题，不要拿"变量修复"去糊它。
3. 回退：`tar -xzf dist_before.tar.gz -C frontend/` 还原整份 dist 即生效；后端 `git revert` + 重建镜像。
4. 待清理：`frontend/dist_ms2`、`dist_ms3` 草稿目录（各 199 文件），按"列清单→隔离→确认→删"处理。
