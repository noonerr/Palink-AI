# BACKUP_INFO — 2026-10-03 架构审查修复前

## ① 备份日期

2026-10-03

## ② 原始来源路径

`D:\项目\Palink-AI` 工作区，基线 HEAD = `79969a7ae9e83a95f246a83d819ac346cb3a3f11`（短 `79969a7`）。

备份位置：`_BACKUPS/2026-10-03_架构审查修复前/pre/`，保留原相对路径。
校验清单：`_manifest.tsv`（18 行，sha256 前 16 位）。

## ③ 备份原因

五路并行架构审查 + 两项专项排查（提示词串味、思考过长）+ 一项性能排查（输入框卡顿）完成，
准备按 `docs/SPEC_架构审查修复_2026-10-03.md` 动工前留物理快照。

**工作区当时有 14 个未提交改动**（在途代码，含报错提示模板批），本备份拷贝的是
**含未提交改动的磁盘真实状态**，不是 HEAD 状态。恢复时优先用本备份而非 `git checkout`。

## ④ 后续待办清单

### 必修（会造成用户可见错误）
- [ ] **T1** 世界书加角色绑定 —— `worldbook_service.py:1893` 无条件注入 `character_id IS NULL` 的书；`api/worldbook.py:291` 建书不传 `character_id`。**改现有行为，需用户拍板**（存量世界书是重新绑定还是保持全局）
- [ ] **T2** 扩展提示词按角色隔离 —— `roleplay_prompt_assembly.py:1466` `if not filter_dict: return True`（空 filter 对所有卡放行）
- [ ] **T3** 前端提示词池加角色维度 —— `promptInjection._sources` 分区键无 characterId，`'sandbox'` 分区切卡永不清
- [ ] **T4** 思考额度拆分 —— `inference_dispatcher.py:713` `budget = max(effective_max_tokens, 8192)` 吃满 32768
- [ ] **T5** 输入框卡顿 —— `CharacterView.tsx:1818` 未 memo 包裹 `CharacterChat`；消息列表无虚拟列表；每键触发整树重渲染

### 零风险批（可立即做）
- [ ] `@sillytavern/*` bare-specifier 路径解析 + 未映射模块纳入 `recordStubHit`（`sandbox.ts:2384` / `:5411`）
- [ ] 清 `.mimosa/`（1.5GB / 45963 文件，D 盘仅剩 61GB）
- [ ] 补入库 47 份 `BACKUP_INFO.md`（`.gitignore` 已放行，`git ls-files _BACKUPS/` 仅 9 条）
- [ ] `except: pass` 加日志（`character_ext.py:1491/1514`、`silly_tavern.py:2322/2347/2380`）
- [ ] `MacrosParser.evaluate` 接上 `MacroRegistry`（`sandbox.ts:5235`）
- [ ] 删 24 份文档里的失效命令 `test:contract`
- [ ] 修 `.trae/rules/project_rules.md:9-11` 与 `AGENTS.md` 的矛盾

### 结构性（需另立 spec）
- [ ] 拆 `roleplay_prompt_assembly.py`（5423 行，四条主缝）
- [ ] 四份 `MessageFormatter` 合一
- [ ] 解开 services→api 循环（`roleplay_prompt_assembly.py:1589`、`:554`）

### 明确不做（避免误伤）
- ❌ 不删 `llama_runtime.py` / `inference_queue.py` / `plotline.py` / `lib/group-chat/`（均已查实存活）
- ❌ 不动 `frontend/dist`（nginx bind mount 在用产物）、`backend/data`（412MB 业务数据）

## 状态

- 备份完成度：18/18 文件已拷贝并生成 sha256 清单
- 恢复方式：`cp -r pre/<相对路径> <项目根>/<相对路径>`
- ⚠️ 依 AGENTS.md 规范第 4 条，**本目录内容不得删除或改写**。需要历史文件时复制出来用。
