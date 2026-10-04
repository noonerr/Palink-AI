# BACKUP_INFO — 2026-10-04 插件设置复核修复

## ① 备份日期

**2026-10-04**（本轮动工前；`HEAD.txt` 记基线 commit，`worktree-status-before.txt` 记动工时工作区状态）

## ② 原始来源路径

全部位于工作区 `D:\项目\Palink-AI`，改动前副本按原相对路径放在 `pre/`，sha256 台账见 `_manifest.tsv`（4 行）：

| 原路径 | 改动前 sha256 |
|---|---|
| `frontend/src/utils/sillyTavernPluginRuntime.ts` | `0dd302d2…359f084a` |
| `backend/app/api/plugins.py` | `a0b10875…2a333657` |
| `backend/tests/test_plugin_runtime_settings.py` | `bad77a1e…a2aa0de7` |
| `frontend/src/utils/__tests__/plugin-runtime-l1-settings.test.ts` | `a2648069…c2c40641` |

基线：分支 `st-plugin-compat-20260727`，`HEAD = f2bca1be`。

⚠️ **本副本存的是「工作树状态」而非 HEAD 状态** —— 上述文件在动工前已含另外两个会话的未提交改动
（`2026-10-03_酒馆助手脚本全局与父窗口别名` 与 `2026-10-04_插件设置按卡隔离适配` 两批）。
回滚时请连同 `worktree-status-before.txt` 一起看，不要误当成 HEAD。

## ③ 备份原因

对 `docs/REPORT_插件设置按卡隔离_批次0-1交付_2026-10-04.md` 做独立复核后，发现四条缺陷，需在其之上施工：

1. **P0 切卡后设置写入静默丢失**：设置挂载用了「已存在就不覆盖」的守卫，而切卡会把 runtime 那份换成新对象
   → 插件继续写旧对象，落盘发的是新对象。已用可执行探针实测复现。
2. **P0 按卡隔离未实现**：落点是用户级 `UserSetting.silly_tavern_settings.extension_settings`，
   所有角色卡共用，且读路径对所有卡合并 → A 卡设置出现在 B 卡（SPEC 验收项 #2 无实现也无测试）。
3. **P1 新开的写入口触达后端生成管线**：`extension_settings.regex_scripts` 会被
   `character_ext.py` 当作正则规则应用到提示词/显示文本上；实测库里该键 **0 行**，锁掉零数据影响。
4. **P2 超限降级对插件不可见**：后端把未存下的项写进响应 `skipped`，前端从不读响应体。

## ④ 后续待办清单

- [x] 去掉「已存在就不覆盖」守卫：每次注入都把 facade 指向 runtime 当前对象
- [x] 设置改为按 `(user_id, character_id)` 存，落在 `silly_tavern_settings` 的**独立新格**
      （不合并、不覆盖、不清空存量的 `extension_settings` 大包 —— 用户 1 那条是导入自真 ST 的 37 键包）
- [x] 写入口做角色归属校验：非本人卡返回 **404**（对齐 `character.py` 既有口径，不用 403）
- [x] 插件写路径**不再**触达 `extension_settings.regex_scripts`（第 3 条由此关闭）
- [x] 删掉上一批新增的「用户级 extension_settings 合并」——它是跨卡渗漏的来源
- [x] 前端读 POST 响应：`skipped` 与非 2xx 一律登记进 `__palinkCompatStats`（可见降级）
- [x] 补测试：切卡回归 / 跨卡隔离 / 跨用户隔离 / 非本人卡 404 / 可见降级
- [x] 三道门禁复跑：`npx tsc --noEmit`、`npx vitest run`、`py -3 -m pytest tests/ -q`
- [ ] ⚠️ **提交 ≠ 上线**：改后端需 `docker compose build backend && up -d backend`；
      改前端需重建 dist 并容器内 grep 校验指纹 —— **待用户授权后执行**
- [ ] ⚠️ **浏览器真机验证仍未做**：当前 5 个容器**均未发布宿主端口**（宿主机 curl 13000/3000/8080 全拒连），
      需先恢复端口才能开页面。此项无法由本批代码测试替代。

---

## ⑤ 批次 2 追加（同日 20:40 后，用户裁定「放 A 半桶 + 生成参数封顶放」）

新增待改文件（副本在 `pre-batch2/`，按原相对路径）：

| 原路径 | 改动前来源 | sha256 |
|---|---|---|
| `backend/app/services/roleplay_prompt_assembly.py` | `git show HEAD:`（该文件动工前**未被任何会话改过**，故 HEAD 即动工前状态） | `见 pre-batch2 同目录 _sha.txt` |

批次 2 内容：
- [x] **闸 3**：`openai_max_context` 一律 `min(声明值, 模型真实窗口)`；注册表不认识的模型**不夹**。
      此前该值被**原样采信**且压过注册表 —— 用户自己手滑填 200 万也能捅，不只插件能捅。
- [x] **L2 放行**：`SillyTavern.chatCompletionSettings` 挂成按卡设置里的**活子对象**（不开第二条落盘通道）；
      后端读取优先级 **卡影子 > 用户设置 > 模型注册表**，三层全过闸 3。
- [x] `custom_include_body`（"往请求里塞任意字段"）**照存但记账不生效** —— 键名白名单用户尚未裁定。
- [x] `powerUserSettings` **不挂**：实卡命中 0，挂一份没人消费的对象＝制造"有就是支持"的假象。
- [x] A 半桶按**实卡真实命中数**收口：只接 `saveChat`(×8，改为记账不再谎报成功) 与
      `getPreset`(×5，接真数据)；人设 / 角色增删改 / 预设增删改 / importRaw 命中 **0 → 不接**。
- [x] 门禁：见交付说明。新增测试 `test_ctx_hard_floor.py`(9) + `test_l2_card_shadow.py`(8)。
- [ ] ⚠️ 批次 2 同样**未上线、未真机验证**（端口问题同上）。

