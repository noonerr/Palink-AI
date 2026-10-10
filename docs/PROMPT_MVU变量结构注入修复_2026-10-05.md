# 交接提示词 — 修「模型不按卡片声明的变量结构输出」（对齐 ST）

> 用法：整份交给执行的 Agent。仓库 `D:\项目\Palink-AI`。
> **只做这一项**，不要顺手改别的。

---

## 0. 一句话任务

**让主模型按卡片自己声明的变量结构输出 `<UpdateVariable>`，做法对齐 ST——即不再用我们自己写死的那段模板去覆盖卡片。**

---

## 1. 现象与证据（都是实测，可直接引用）

卡片：`露缇雅1.2`（`characters.id = 05a3fe0f-cb8d-403f-b02f-a0c5a200d58f`）
会话：`94ba57d6-…`（`character_chat_sessions`）

### 1.1 症状

卡片自带的状态栏有**三条进度条**（爱意 / 魔力值 / 饥饿度），**永远不动**。
其余字段（日期时间）能显示。

### 1.2 数据结构被改坏的过程（`character_chat_messages` 实测）

| 楼层 | `stat_data.露缇雅.状态` 类型 | 顶层分组 |
|---|---|---|
| 2595 | **object** ✓ | `环境, 露缇雅` ← **初始状态完全正确** |
| 2597 | object ✓ | `世界信息, 环境, 露缇雅` ← 多出 `世界信息` |
| 2599 | **string** ✗ | `世界信息, 环境, 露缇雅, 露缇雅1.2` |
| 2601 | string ✗ | 同上 |

→ **初始化是对的**（`build_initial_stat_data` 用 schema 默认值建出正确结构），
**是模型后来把 `露缇雅.状态` 从对象替换成了字符串**，三个数值字段随之消失。
卡片脚本读 `stat_data.露缇雅.状态.爱意`，取不到 → 回落脚本内硬编码默认值 → 进度条恒 0/100/0。

### 1.3 卡片声明的结构在哪（这是关键）

**不在 `<initvar>`**（该卡世界书 19 条里 `0` 条含 `initvar`），
而在**卡片自带的世界书条目**里，其中 3 条是 MVU 说明，**全部 `constant=true`**：

| 条目 title | 长度 | 内容 | position | depth |
|---|---|---|---|---|
| `[mvu_update]变量更新规则` | 3589 | **YAML 结构说明书**：逐字段 `type` / `range` / `check` | **4** | **0** |
| `[mvu_update]变量输出格式` | 1698 | `<UpdateVariable>` + JSON Patch 规范 | 4 | 0 |
| `变量列表` | 97 | `<status_current_variables>{{format_message_variable::stat_data}}</status_current_variables>` | 4 | 0 |

`position=4` = atDepth（in-chat）；**`depth=0` = 插在对话最末尾**（紧贴模型下一次输出，遵循度最高）。
**即：ST 里卡片自己就把这份说明放到了最有影响力的位置。**

`[mvu_update]变量更新规则` 原文节选（说明它确实写清了结构）：

```yaml
变量更新规则:
  露缇雅:
    状态:
      爱意:
        type: number
        range: 0~200
        check:
          - 随着与用户的良性互动、亲密接触和陪伴逐渐增加，每次增减幅度为1~3
```

### 1.4 我们做了什么（**这就是要改的地方**）

`backend/app/services/roleplay_prompt_assembly.py:4232-4267`

我们自己写了一段通用模板，**追加到最后一条 user 消息末尾**：

```
【变量更新指令 - 强制，不可省略】
...
[{"op":"delta","path":"/桃汐/好感度","value":5},
 {"op":"replace","path":"/世界信息/日期时间","value":"2026年08月18日 09:00"}]
规则：
- path 格式：/角色名/字段名（如 /桃汐/好感度、/世界信息/日期时间）
- 【必须完整】所有因本回合剧情而变化的字段都要输出——包括角色的
  好感度、关系、性欲值、服饰、内心想法、发情期等
```

⚠️ **`/桃汐/好感度`、`/世界信息/日期时间` 是另一张卡的例子。**

**模型照最后一条指令走 → 照着这些例子自创结构 → 把卡片声明的正确结构覆盖掉了。**
（数据里那个凭空出现的 `世界信息` 顶层键，正是这段模板里的示例字符串。）

### 1.5 这段模板的由来（**不要简单删掉了事，先读懂**）

同文件 `:4232-4238` 注释原文：

> MVU 卡（酒馆助手体系）的"变量输出格式"指令位于 worldbook 拼接消息的**中间偏后**
> （实测：13KB 消息 @8813，其后还有 ~4.7KB 场景描述），模型注意力常无法覆盖
> → AI 不输出 `<UpdateVariable>` → stat_data 永不更新 → 面板恒显示初始值。
> 因此把精简的变量更新指令贴到最后一条 user 消息末尾（遵循度最高），
> **格式与 worldbook 的 `<UpdateVariable>` 一致，双保险不冲突**。

→ **方向是对的**（尾部提醒确实必要），**内容是错的**（用了别卡的例子）。

### 1.6 另一个已确认的缺口

`extract_schema_defaults`（读卡片 `z.object` 结构）全仓只有 3 个调用点：
`character_ext.py:6321`（手动副模型）、`websocket.py:554`（自动副模型）、
`mvu_engine.py:1190`（初始化）。
**`roleplay_prompt_assembly.py` 零命中 → 主模型的提示词里从来没有这张卡的结构。**
（副模型拿得到结构，主模型拿不到 —— 这个不对称本身就不合理。）

---

## 2. ★ 先做这件事：用调试端点看真实装配结果

**不要凭猜改代码。** 本仓已有现成端点：

```
POST /api/character-sessions/{session_id}/debug-prompt-assembly
```
（`backend/app/api/character_ext.py:5223`，返回 `assembly.debug_dict()` +
`messages_preview`（每条消息 role + 前 200 字））

**要回答的问题**：卡片那条 `[mvu_update]变量更新规则`（`position=4, depth=0`）
**最终落在 messages 数组的第几条？相对末尾的位置是多少？**

- 若它已作为**独立消息落在对话最末尾**（在我们那段 user-tail 模板**之后**）
  → 说明 atDepth 路由是好的 → **改法 = 删掉我们那段写死模板**（ST 就是什么都不加）
- 若它仍被拼进中段的大块 worldbook 文本里（`:4232` 注释描述的那种情况）
  → 说明 atDepth 路由有问题 → 改法是修路由：
  `_append_worldbook_context`（`:4554`）→ `depth_entries` → `_insert_depth_prompt`（`:5521`）
  （已有测试 `tests/test_worldbook_st_semantics.py` 覆盖 atDepth，先跑它看是否回归）

**怎么调**：用应用自身的 `create_access_token({"sub": <用户名>})` 在容器内签发 token
（`docker exec -e PYTHONPATH=/app palink-ai-backend-1 sh -c 'cd /app && python <脚本>'`），
`MSYS_NO_PATHCONV=1`。会话属主见 `character_chat_sessions.user_id`。

---

## 3. 改法（按上面查出来的结果二选一，并保留兜底）

| 情形 | 改法 |
|---|---|
| 卡片条目已落在末尾 | **删除我们那段写死模板**（`roleplay_prompt_assembly.py:4239-4267` 的 `_mvu_instr` 注入）。ST 不做任何额外注入 |
| 卡片条目没落对 | 修 atDepth 路由，让 `position=4/depth=0` 真的插到对话末尾 |
| **兜底（无论哪种都要有）** | 卡片**没有**自带 MVU 说明条目时（检测：世界书里没有 title 以 `[mvu_update]` 开头、且正文不含 `<UpdateVariable>` 的启用条目），才注入通用模板，且**必须删掉所有具体字段示例**（不要出现 `/桃汐/好感度`、`/世界信息/日期时间` 这类别的卡的路径） |

**通用性要求**：改完必须对**任意卡**成立——判断依据只能来自**卡片自己的声明**，
不能有任何写死的角色名 / 字段名。

**顺带（可选，若时间允许）**：把 `extract_schema_defaults` 的结果接进主模型提示词，
补上 1.6 那个缺口。但这会改变所有 MVU 卡的提示词长度，**风险更高，建议单独立项**。

---

## 4. 验收（缺一不可）

1. **真机生成**：用 `露缇雅1.2` 这张卡跑**至少 3 轮**真实生成，然后查库：

   ```sql
   SELECT id, jsonb_typeof(extra::jsonb->'variables'->'stat_data'->'露缇雅'->'状态')
   FROM character_chat_messages WHERE session_id = '<会话id>' ORDER BY id DESC LIMIT 3;
   ```
   **期望连续 3 轮都是 `object`**（不是 `string`），且
   `stat_data.露缇雅.状态.爱意/魔力值/饥饿度` 三个键都存在。

2. **回归**：另找**两张卡**验——① 一张结构简单的 MVU 卡；② 一张**没有** `[mvu_update]` 条目的卡
   （验兜底路径不会注入别卡示例）。

3. **门禁**：`cd backend && py -3 -m pytest tests/ -q` → `failed = 0`。
   ⚠️ 已知 3 个删文件类用例会被 safe-delete 守卫拦成红
   （`test_admin_image_cleanup.py` 2 例 + `test_c_batch_security_hygiene.py` 1 例），
   **它们单独跑全绿，不是代码回归**。

4. **反证**：把改动还原 → 断言/实测必须变回坏的样子。

---

## 5. 铁律（违反即事故）

- **备份**：`_BACKUPS/YYYY-MM-DD_主题/` + `BACKUP_INFO.md`（四要素）+ 在 `_BACKUPS/_INDEX.md` 追加一行。
  改动类用 `pre/`（按原相对路径）+ `_manifest.tsv`。**禁止改写已有备份**。
- **提交**：逐项 `git add -- <path>`，**严禁 `git add -A` / `git add .`**（多 agent 共住仓库）。
- **提交 ≠ 上线**：改后端要 `docker compose build backend && docker compose up -d backend`。
- **环境坑**：
  - 后端用系统 `py -3`（托管 python 没装 pytest）
  - `docker exec` 加 `MSYS_NO_PATHCONV=1`；但 `docker cp` 的宿主路径**不能加**
  - 多行 SQL / 含反斜杠的脚本**写成文件再跑**，别用 heredoc（会被吃反斜杠）
  - `roleplay_prompt_assembly.py` 是普通 Python，**不是**模板字符串，注释里可以用反引号；
    但同批若改到 `SillyTavernCompatRuntime.ts` / `sillyTavernPluginRuntime.ts`，**注释里严禁反引号**

---

## 6. 交付

1. 报告写清：**先给出第 2 节的实测结论**（卡片条目落在第几条），再写改法与验收输出。
2. **如实标注未做项**。特别地：若第 1 节 1.6（`extract_schema_defaults` 接入）没做，必须写明。
3. **不要在没有证据的情况下说「已完成」** —— 本问题的上一轮教训就是：
   一个端点漏了一行 import 恒 500，静态读码和单测都没发现，**只有真机跑才暴露**。
