# BACKUP_INFO

- **备份日期**：2026-10-21（夜）
- **原始来源路径**：`D:\项目\Palink-AI` 工作区未提交改动 4 个文件 ——
  `frontend/src/lib/plugin-system/sandbox.ts`、`frontend/src/lib/sillytavern/bundled-plugin-css.ts`
  （两者为 tracked 修改），`frontend/src/lib/plugin-system/__tests__/b4-regex-preset-select-mount.test.ts`、
  `scripts/gen-bundled-plugin-css.mjs` + `scripts/README.md`（三者为未入库新文件）。
- **备份原因**：执行"小尾巴批次"（CSS generator / preset-session-source 实机验 / 三处报错定性 /
  style_removal 量化）的子 agent 撞 **150 轮上限中断**，交付是**半成品且工作区不绿**：
  - ① CSS generator **已可用**，主脑独立实测：删掉产物后 `node scripts/gen-bundled-plugin-css.mjs`
    重新生成 → 与入库版本 `cmp` 逐字节一致（`REGEN_IDENTICAL`），generated 守卫测试绿；
  - ③-B4（RegexPresetManager「找不到预设下拉」）**不是竞态，是沙箱读写不同域**：agent 找到了真病灶
    并写了执行型测试（真 `PluginSandbox` + 真 `st-plugins/regex/dropdown.html`，10 例），
    但**修复的两处调用点被写成 `if (false && …)` 死码** ⇒ 该文件 **3 例红**（②④⑥），
    即"缺陷已被复现、修法已写好但没接通"。
  - ②（preset-session-source 实机验）与 ④（style_removal 量化）**没有任何产出**，无报告文件。
  ⇒ 按本仓"中断现场"处置纪律：先物理备份 + 逐文件标归属，再由主脑**串行接管收尾**；
  ⛔ 禁止整包 `git apply -R`（会把已验证可用的 generator 一起抹掉）。
- **后续待办清单**：
  1. 主脑把 `sandbox.ts` 两处 `if (false && mountScoped && …)` 的死码接通，
     跑 `b4-regex-preset-select-mount.test.ts` 期望 10/10，并跑全量 `bash scripts/gate.sh frontend`
     确认没有把读面放开到挂载点之外（该文件的 ③⑤ 两例就是钉这条边界的）。
  2. ②④ 两条要么另行派单，要么主脑自己补；本备份里**没有**它们的任何中间产物。
  3. 小尾巴批次的报告文件尚不存在，交付时补 `docs/_active/report/REPORT_批次小尾巴_…_2026-10-21.md`
     并刷新 `_CATALOG.md`。
  4. 若接通后测试仍红且无法定位，**回退路径**：`cp files/frontend/lib-plugin-system/sandbox.ts`
     回原位（保留 generator 与测试），把 B4 降级为"已定性未修"登记进 `docs/OPEN_ISSUES.md`。
