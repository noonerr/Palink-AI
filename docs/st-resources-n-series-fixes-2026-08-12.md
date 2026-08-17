# 后续批次修复记录（N 系列 + K-11）

> 生成时间: 2026-08-12（P 系列之后第二轮）
> 来源: `docs/MOBILE_ST_COMPAT_VERIFY_2026-08-12.md` §7.1 N1-N5 + §6.3 K-11
> 状态: **DONE（全部落地并验证）**

---

## 1. N1-N5：ST 资源端点行为修复

### 1.1 验证结论

对 N1-N5 逐项实测（新增 `backend/tests/test_st_resources_n_series.py`，9 个用例）：

| # | 问题（文档描述） | 实测结论 | 处理 |
|---|---|---|---|
| N1 | avatars/delete 请求体 `avatar` vs `path` → 422 | **已兼容**（双字段） | ✅ 补测试锁定 |
| N2 | backgrounds/delete（`bg` 字段）→ 422 | **已兼容**（双字段） | ✅ 补测试锁定 |
| N3 | backgrounds/rename（`old_bg`/`new_bg`）→ 422 | **已兼容**（双字段） | ✅ 补测试锁定 |
| N4 | backgrounds/upload 返回 JSON 而非纯文本背景名 | **仍有缺陷**：FastAPI `return str` 序列化为 JSON 字符串（带引号 `"N4Bg.png"`），ST `response.text()` 拿到引号 | ✅ **修复**：改用 `PlainTextResponse` |
| N5 | sprites/get 包装对象 + `name`≠`label` | **已修复**（裸数组 `[{label,path}]`） | ✅ 补测试锁定 |

### 1.2 真实缺陷（N4）修复

- 位置: [st_resources.py:200-246](file:///d:/项目/Palink-AI/backend/app/api/st_resources.py#L200-L246) `st_backgrounds_upload`
- 根因: FastAPI 对 `return str` 自动 JSON 序列化（`"N4Bg.png"` 带引号），而 ST 前端 `backgrounds.js:1565` 用 `response.text()` 读裸文件名
- 修复: `return PlainTextResponse(stored_filename)`——输出裸文本，无引号
- 验证: TestClient 断言 `resp.text` 不以 `"` 开头；9 用例全过

---

## 2. K-11：ST wand 菜单容器缺失

### 2.1 现状

- ST 1.18.0 `scripts/templates/wandMenu.html` 定义 `#extensionsMenu` 内含 15 个 `*_wand_container`（含 `#token_counter_wand_container`）
- token-counter 插件 `index.js:110` 通过 `$('#token_counter_wand_container').append(...)` 注入按钮
- Palink 此前未提供 `#extensionsMenu` 及 wand 容器 → 插件加载成功但按钮静默不可见

### 2.2 修复

1. **StPluginMountPoints.tsx**: 新增 `WAND_CONTAINERS` 常量（15 个容器）+ 渲染 `#extensionsMenu` 挂载点（AutoRevealMountPoint，有内容才显示）
2. **sandbox.ts**: `ST_MOUNT_POINT_IDS` 白名单补充 `extensionsMenu` 与全部 wand 容器 id——插件在沙箱 container 查不到时回退真实 document（StPluginMountPoints 常驻 App 壳层，聊天页可用）

### 2.3 验证

- `tsc --noEmit` 通过
- `npm run build` 成功，dist 产物确认含 `token_counter_wand_container` / `extensionsMenu`

---

## 3. 回归验证

- 后端: `test_st_contract` + `test_st_resources_n_series` + `test_st_import_export_roundtrip` → **126 passed, 11 skipped**
- 后端: `test_st_contract` + `test_st_compat_p2_features` + `test_p2_fixes` + `test_st_resources_n_series` → **100 passed, 4 skipped**
- 前端: `tsc --noEmit` + `npm run build` 通过
- 容器: backend 镜像已重建（`docker compose build backend && up -d backend`）使 `st_resources.py` 改动生效

---

## 4. 说明

- N1-N3/N5 的兼容代码在验证文档生成后已被其他批次补上（双字段兼容），本轮用行为测试将其**锁定防回归**，并修出 N4 的真实残余缺陷
- K-11 只解决"容器缺失导致 UI 不可见"；token-counter 的计数后端接入（K-9）此前已修复（`getContext.ts` 委托 `/api/tokenizers/count`）
