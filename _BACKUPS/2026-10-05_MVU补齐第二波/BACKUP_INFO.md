# BACKUP_INFO — 2026-10-05 MVU 补齐第二波

## ① 备份日期

2026-10-05（当日 03:2x，GMT+8）

## ② 原始来源路径

| 备份内相对路径 | 原始来源 |
|---|---|
| `pre/backend/app/api/__init__.py` | `backend/app/api/__init__.py` |

校验清单：`_manifest.tsv`（sha256，1 条）。

本波**只改了这一个已存在文件**（路由注册两行）；端点本体与测试都是**新增文件**，
无旧版本可备。之所以能只动这一个文件，是因为刻意规避了并行 agent 占用的文件（见 ③）。

## ③ 备份原因

承接 `docs/PROMPT_MVU兼容补齐_交给Agent_2026-10-05.md` 的**第二波**，用户要求
「继续做，但**不要耽误另外一个 Agent**」。

开工时复核 `git status`：并行 agent 的那批成果**（变量自动清理 + 批次 A）仍未提交**，
占用 `character_ext.py` / `mvu_engine.py` / `websocket.py` /
`character_message_builder.py` / `Message.tsx` 等文件。而第二波的原定落点
（P0-2 门 A、P2 端点、P2 面板挂载、P3-a、P3-b、P3-d）**几乎全在这些文件里**。

故本波改了排期，**只做零冲突的那一项**：把 P2 的后端写入端点落进**新文件**
`backend/app/api/mvu_variables_api.py`，经（空闲的）`api/__init__.py` 注册。
路径 `POST /api/character-sessions/{sid}/variables/patch` 是全新的，
与任何既有路由不冲突，全程未触碰被占用文件。

## ④ 后续待办清单

1. **P2 前端部分仍未做**：面板挂载点在被占用的 `Message.tsx` 里；且已确认
   `TavernHelperPanel` **无法自取 sessionId**（无会话 Context、无全局 session id、
   `messageManager` 只有私有的 `_currentSessionId`）。等 `Message.tsx` 空出后
   加一行 `sessionId={_sessionId}` 传参即可点亮编辑能力。
2. **P0-2 门 A 仍未做，且刻意不从前端硬凑**：已实测 `getContext.ts:1515-1523` 是
   **唯一**把会话 metadata 写回后端的通道，若从前端把 `variables` 剥掉，
   卡脚本的变量写入会失去落库路径 = 回归。后端键白名单必须在 `character_ext.py`
   空出后补。
3. **P3-a / P3-b / P3-c / P3-d** 均落在被占用文件，等交回。
   ⚠️ P3-a 的落点要改**调用方**（`character_ext.py:4409/6290`、
   `character_message_builder.py:611`），不是 `mvu_engine.py` 本身 ——
   `merge_character_book_entries` 的入参是 entry 正文列表，函数内没有 `enabled` 字段。
4. **踩坑留档**：`apply_patches` 的 patch path 是**相对 `stat_data`** 的
   （内部 `target = stat_data.get("stat_data", stat_data)`，最后再包回 `result["stat_data"]`）。
   写成 `/stat_data/角色/好感度` 会多套一层 `stat_data.stat_data`。探针脚本
   `backend/scripts/_probe_apply_patches.py` 可复跑。
5. **踩坑留档 2**：本仓 FastAPI 版本下 `router.routes` 里的元素是 `_IncludedRouter`，
   **不展平**，用 `getattr(r,'path','')` 探测会得到一堆空串、误判成「端点未注册」。
   验证路由注册要用 `app.openapi()['paths']`。
