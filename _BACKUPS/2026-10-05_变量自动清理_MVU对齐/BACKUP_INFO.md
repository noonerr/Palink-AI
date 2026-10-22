# BACKUP_INFO

## ① 备份日期

2026-10-05（01:5x）

## ② 原始来源路径

按原相对路径存于 `pre/`，逐文件 sha256 见 `_manifest.tsv`（7 行），基线提交见 `HEAD.txt`（`6b98c57`）。

| # | 原始路径 | 本批对它做了什么 |
|---|---|---|
| 1 | `backend/app/api/character_ext.py` | 4 个 MVU 落库点解包补丁 + 删消息后触发恢复 + 新增手动清理端点 |
| 2 | `backend/app/api/websocket.py` | WS 主路径解包补丁 + 生成落库后触发自动清理 |
| 3 | `backend/app/services/character_message_builder.py` | `apply_mvu_reply_to_session` 返回值加补丁（第 3 元） |
| 4 | `backend/app/services/mvu_engine.py` | `update_from_reply` 返回值加补丁（第 3 元） |
| 5 | `backend/tests/test_mvu_engine.py` | 6 处解包同步为 3 元 |
| 6 | `backend/tests/test_mvu_initial_stat_data_sources.py` | 2 处解包同步为 3 元 |
| 7 | `backend/tests/test_mvu_sse_wiring.py` | 3 处解包 + 1 处 monkeypatch 桩返回值同步 |
| 8 | `backend/app/services/roleplay_prompt_assembly.py` | **测试阶段追加**：修 `_load_effective_stat_data` 的存量 bug（见文末「测试阶段追加」） |

> ⚠️ **本备份是动工后补做的**（违反《备份与清理规范》第 1 条的时序要求，如实记录）。
> 副本取自 `git show HEAD:<path>`，且已核验 HEAD（`6b98c57`）**不含本轮任何改动**
> （`git show HEAD:backend/app/services/mvu_engine.py | grep -c "applied: list\[dict\]"` → **0**），
> 故内容与"动工前状态"等价，回滚有效。

## ③ 备份原因

用户 2026-10-05 拍板：「**让它和插件原本跑的一模一样，没有任何区别，也就是百分百适配这个功能**」。
即把 MVU 插件（MagVarUpdate）的「自动清理变量」整套能力 1:1 落到 Palink 后端。

权威来源是卡脚本 bundle `backend/data/smart_card_assets/0c646fb31a…js`（307,179 B）里的
`Za()`（清理）与 `Ya()`（恢复）两个函数 + zod schema 默认值。逐条对照见
`docs/SPEC_变量自动清理_MVU对齐_2026-10-05.md` §1。

### 与插件的两处必要差异（行为等价，非功能打折）

1. **重演的原料不同**：插件重演靠 `Tn(chat[t].mes, u)` —— 重新解析楼层**正文**里的变量指令；
   而我们的正文在后端落库前已剥掉 `<UpdateVariable>` 且不留原文（实测 `websocket.py:742-778`）。
   因此改为**落库时把解析出的补丁存进 `msg.extra["mvu_patch"]`**，重演时直接应用补丁 ——
   结果等价（同一份补丁，确定性更高），且清理只动 `extra["variables"]`，天然不会碰到补丁。
   这一差异**不改行为**，故不构成"打折"。
2. **楼层编号基准**：插件用 `SillyTavern.chat` 的数组下标（0 号位是伪消息头），我们用 1 起算楼层号。
   锚点落点可能相差 1 楼，功能上无差别（都是"每 interval 楼一个锚点"）。

## ④ 后续待办清单

1. **[已在本批完成]** `backend/app/services/mvu_cleanup.py` 新建：设置解析（与插件同源）+
   `prune_variables` / `prune_floor_window` / `auto_prune_window` / `should_auto_prune` +
   `find_anchor_floor` / `replay_patches` + `run_auto_cleanup` / `run_manual_cleanup` / `run_restore`
   + 两个"只传 session_id"的接线入口。
2. **[已在本批完成]** 三个触发入口：① 生成落库后自动清理（WS + SSE 全部入口，共 3 处接线）
   ② 删消息后恢复 ③ 手动清理端点 `POST /{session_id}/mvu-cleanup`。
3. **[已在本批完成]** 补丁留存：`update_from_reply` / `apply_mvu_reply_to_session` 返回值加第 3 元，
   5 个落库点写入 `msg_extra["mvu_patch"]`。
4. **[已在本批完成]** 测试 `backend/tests/test_mvu_cleanup.py`（28 例，五组断言）。
5. **[未做 · 待办]** **真机验证**：需要开页面，确认 ① 每 5 楼自动清理真的发生
   ② 删消息后恢复真的补回 ③ 手动清理端点可用。**本批未做**（未确认站点端口与浏览器环境）。
6. **[未做 · 待办]** **前端 UI**：插件设置面板里的那 4 个开关/数值，目前由**插件自己的面板**
   驱动（我们读的是同一格 `extension_settings.mvu_settings.自动清理变量`）；
   若插件面板不可达，则走插件默认值。**未做**我们自己的设置入口。
7. **[未做 · 待办]** 插件首次启用时的**弹窗三选一**（只清理 / 不再提醒 / 备份并清理）未做 ——
   我们只在后端按默认值直接生效。`ignore_cleanup` 标记位也未实现。
8. **[未做 · 待办]** 提交与上线（未 `git add`、未重建镜像）。

---

## 测试阶段追加（2026-10-05 01:4x，不改动已备份副本）

### 新增第 8 个待改文件

`backend/app/services/roleplay_prompt_assembly.py` —— **测出一个与本功能无关的存量真 bug**：

`_load_effective_stat_data` 里用 `isinstance(extra, dict)` 判断消息的 extra，
而 `extra` 列是 **Text（存 JSON 字符串）** → 判断**恒为 False** → 该函数**从未取到过消息级快照**，
一直静默回落会话级。后果：它文档里声称修好的 `[ST-ALIGN P0-2]`（swipe / 重生成 / 切分支时
变量跟着回退）**实际是空转**。

**探针实测**：`type(row.extra).__name__ == 'str'`；`_load_effective_stat_data` 返回会话级值。
**已修**：加 `isinstance(extra, str) → json.loads` 分支。**既有测试零覆盖**，生产调用点仅 1 处
（`roleplay_prompt_assembly.py:5292`）。
⚠️ **这是本批唯一会改变线上行为的改动**（修好后消息级快照真的优先于会话级，会改变提示词注入取值），
**需重点真机验证**。

### 新增第 2 个测试文件

`backend/tests/test_mvu_cleanup_safety.py`（17 例）：不碰别的东西 / 作用域隔离 /
装配不受影响 / 体积真降（4251 B → 732 B，降 83%）/ HTTP 端点。

### 反证脚本

`backend/scripts/_reverse_check_mvu_cleanup.py` —— 把 4 处关键实现改坏，确认对应测试变红，
跑完自动恢复并 sha256 校验。**4/4 通过**。
（第 ④ 项第一版设计错误：`mvu_patch` 是 extra 的兄弟键，加进 PRUNED_FIELDS 不生效 → 已改为
"整个 extra 换掉"才正确变红。**反证本身也要被验证**。）
