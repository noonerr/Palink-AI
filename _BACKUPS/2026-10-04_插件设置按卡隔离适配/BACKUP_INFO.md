# BACKUP_INFO — 2026-10-04 插件设置按卡隔离适配

## ① 备份日期

**2026-10-04**（`date '+%Y-%m-%d %H:%M:%S %z'` 实测：`2026-10-04 19:2x +0800`）

## ② 原始来源路径

全部位于工作区 `D:\项目\Palink-AI`，原相对路径保留在 `pre/` 下：

| 原路径 | 改动前 sha256 |
|---|---|
| `frontend/src/utils/sillyTavernPluginRuntime.ts` | `55d7d3cded0c0e5380ae4baaf0d0b6cc20c50b936ac331ef12f636e9bcd92172` |
| `backend/app/api/plugins.py` | `72167e8459ada85aa1f1d4a98b2d86cece14a5c8d41213ae9bb278d3f01ecdd8` |
| `frontend/src/lib/sillytavern/extension-settings-store.ts` | `e57b3f888eb1d1acbd29a57e8eed13948f50610accd0d68a6caedcc0a5e6907f` |
| `frontend/src/lib/plugin-system/compat-stub-registry.ts` | `7e0539bfbe731b6c5859b20fa22ea181da27a0102fc679df8cdfd1018f3d26c0` |

（`_manifest.tsv` 为上述 sha256 台账；`worktree-uncommitted.patch` 为**全部**未提交改动的快照，47,814 字节，不止上表 4 个文件）

基线：`HEAD = f2bca1be8e244f6a18ac952331a5b842b887a921`（`HEAD.txt`），分支 `st-plugin-compat-20260727`。

## ③ 备份原因

按 `docs/SPEC_插件设置按卡隔离适配_2026-10-04.md` 施工（批次 0「仪表盘」+ 批次 1「L1 全开」）前的**动工前备份**。

动工内容：
1. 经典轨补 Proxy 兜底（缺口可见化）
2. 挂 `SillyTavern.extensionSettings` / `saveSettingsDebounced` / `chatMetadata`
3. 新增后端 `POST /api/plugins/runtime/settings`（**现为 404 死路径**，见 `docs/REPORT_插件设置冲突与100%适配可行性_2026-10-04.md` §6）
4. 补只读项 `getLorebookEntries` / `getCharLorebooks` / `getPresetNames` / `builtin`

**额外风险**：动工时工作区已有 **8 个未提交文件、459 处改动**（2026-10-03 深夜那轮 ST 适配的成果，尚未提交）。本备份的 `worktree-uncommitted.patch` 一并快照，避免我的改动与之混淆后无法还原。

## ④ 后续待办清单

- [ ] 按 SPEC 批次 0 施工：经典轨 Proxy 兜底 + `recordStubHit` 登记
- [ ] 按 SPEC 批次 1 施工：挂载 L1 facade + 新增 `/runtime/settings` 端点
- [ ] 补只读项 4 个（A1/A3/A5/A6）
- [ ] 写**行为断言**测试（非字符串断言，见 `docs/SOP_Agent交付自查清单.md` §七）
- [ ] 跑三道门禁：`npx tsc --noEmit` / `npx vitest run` / `py -3 -m pytest tests/ -q`
- [ ] **把 2026-10-03 那 8 个未提交文件交还用户处理**（不代为提交，避免混入本轮）
- [ ] ⚠️ **docker 当前不可用** → 无法做浏览器真机验证，只能做 vitest + pytest + 静态验证；**交付报告必须如实标注此局限**
- [ ] ⚠️ **提交 ≠ 上线**：改后端需 `docker compose build backend && up -d backend`；改前端需重建 dist 并容器内核验指纹 —— 待 docker 恢复后由用户执行
