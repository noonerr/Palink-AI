# REPORT — MVU 变量更新指令让位卡片自带声明（2026-10-05）

承接 `docs/PROMPT_MVU变量结构注入修复_2026-10-05.md`。**先给实测结论，再给改法与验收读数。**

## ① 先给实测结论（不是静态读码，是 `debug-prompt-assembly` 端点实测）

### 1.1 交接文档可信度：高。逐条复核全部对得上

| 文档断言 | 复核结果 |
|---|---|
| `roleplay_prompt_assembly.py:4232-4267` 写死模板，含 `/桃汐/好感度`、`/世界信息/日期时间` | ✅ 逐字命中，行号一致 |
| `extract_schema_defaults` 三处调用点、主装配零命中 | ✅ `character_ext.py:6321/6328`、`websocket.py:554/556`、`mvu_engine.py:1190`，主装配零 |
| 调试端点 `character_ext.py:5223` | ✅ 存在且可用 |
| 世界书 19 条、0 条含 `initvar`、3 条 `[mvu_update]` position=4/depth=0/constant=true | ✅ 全部一致（`has_initvar` 全 f） |
| 楼层 2595 object / 2597 多出 `世界信息` / 2599-2601 string | ✅ 逐层实测一致 |

**但文档漏了决定性的一环**，且我自己在核对过程中一度误判（见 1.3）。

### 1.2 卡死病灶：模型把 `露缇雅.状态` 从对象覆盖成字符串

`extra->'mvu_patch'` 实测（会话 `94ba57d6…`）：

| 楼层 | 模型发出的 patch | 后果 |
|---|---|---|
| 2597 | `/露缇雅/好感度`、`/露缇雅/性欲值`、`/世界信息/日期时间` | 顶层凭空多出 `世界信息` |
| 2599 | `/露缇雅1.2/{好感度,关系,性欲值,发情期,内心想法}` | 自创以**卡名**为分组的顶层键 |
| 2601 | `{"op":"replace","path":"/露缇雅/状态","value":"魔化体质初次显现…"}` | **object → string**，爱意/魔力值/饥饿度三条进度条的数据源被摧毁 |

这三个字段名（好感度/关系/性欲值/发情期/内心想法）**逐字来自我们自己写死的模板**（旧模板 `:4259` 那行"包括角色的好感度、关系、性欲值、服饰、内心想法、发情期"）。卡片真实结构是 `露缇雅.状态.{爱意,魔力值,饥饿度}` + `环境.时间.{…}`。

### 1.3 ★ 真凶二（文档没写，我一度也判错）：`entry.depth or 4` 把 depth=0 吃成 4

`worldbook_service.py:2143`（改前）：

```python
depth_entries.append((entry.depth or 4, entry_content, entry.role or 0))
```

ST 里 `depth=0` 是**合法值**，语义 = "插到对话最末尾，紧贴模型下一次输出"。Python 真值判断下 `0 or 4 → 4`，于是卡片自带的结构说明落点比 ST **远 4 个楼层**。

改前实测（`_dbg_report.txt`，13 条消息）：
- 6 条 atDepth 条目的插入报告全是 `detail=depth=4; key=customDepthWI_4_0` ← 数据库里明明是 0
- 它们落在 **index 8**，而我们写死的模板贴在 **index 12（最后一条 user）**
- `mvu_user_tail | included | tok=365`

**即：文档 §1.4 "模型照最后一条指令走" 的前提是对的，我先前依据静态读码给出的"因果说反了"订正是错的**——错的不是文档，是我的推断：静态读 `roleplay_prompt_assembly.py:5609-5610` 我以为 depth=0 会落到末尾，但那条 `or 4` 让 depth=0 根本传不到那一层。**只有真机端点读数能定这个分支，静态读码读不出来。**

### 1.4 文档风险②被实测否掉：预算没有裁掉任何条目

文档担心的"3589 字结构说明被 token 预算砍掉"**不成立**：改前读数 `token_budget=997440`、实际 `total_tokens_estimate=21611`，18 条启用条目 **全部 `activated`，零 `trimmed/budget_exceeded`**。故**原计划的"运行时免预算放行"支线取消，未实施**。

### 1.5 文档风险③成立且更严重：脏快照自我强化

卡片的 `变量列表` 条目靠 `{{format_message_variable::stat_data}}`（`macro_service.py:581-598`）读**会话级** `chat_metadata.variables.stat_data` 每轮回灌。该快照实测已脏（顶层键同样含 `世界信息|露缇雅1.2`）→ **旧会话自己喂自己坏结构，永远修不回来**。故真机验收必须用新会话。

## ② 改了什么（3 处）

1. **`backend/app/services/worldbook_service.py:2143`** — depth 只在 `None` 时兜 4，不再吃掉合法的 0：
   ```python
   _depth_value = 4 if entry.depth is None else entry.depth
   ```
   全仓唯一一处该模式（`grep "depth or"` 仅此一命中）。
2. **`backend/app/services/roleplay_prompt_assembly.py`** — 新增 `_messages_declare_mvu_update_spec()` + `_MVU_GENERIC_TAIL`，把原来的恒注入改成三分支：非 MVU 卡 → 不注入（与原行为一致）；卡片已声明**且真进了装配结果** → **不注入**（对齐 ST：卡片 depth=0 的说明本身就是最靠后的一条）；MVU 卡但说明没落到提示词 → 注入**不含任何角色名/字段名**的通用兜底。
   判据看的是**装配结果**而非数据库，因为条目可能被预算裁掉——被裁掉就等于没声明。
3. **兜底模板重写** — 删掉两条示例 patch 与那六个字段名（污染源即此），新增两条通用硬约束：`path 只能用「当前状态/变量列表」里已出现的键，禁止新建顶层分组/禁止按角色名或卡名另起结构`；`结构是对象（含子字段）的字段禁止整体替换成一句话字符串`（直打本次病灶）。

未改 `_card_has_mvu_scripts` 语义（护住 `test_memory_entity_card_gate.py:192/203`）。`default_prompts.py` 的 `[MVU-EXEMPT]` **无需改**：两个分支下都仍有"变量更新指令"存在。

## ③ 验收读数（原始输出）

### 3.1 门禁
```
主工作区（含并行会话在途改动）：1882 passed, 51 skipped, 0 failed     ← 2:04
隔离 worktree（纯 HEAD 内容，本批实际提交物）：1820 passed, 51 skipped, 0 failed, EXIT=0  ← 2:06
定向：90 passed / 28 skipped（新增文件 + depth 顺序 + st_semantics）；142 passed（含 MVU 相关五个文件）
```
两个数字不同是因为隔离目录缺未入库的 `backend/data` 等文件，**两者都 failed=0**。
⚠️ 隔离目录首轮曾出现 **4 errors**（`test_batch_a_st_compat_debt.py` 2 例、`test_batch_f_fixes.py` 1 例等），
单独复跑全绿、重跑全量不复现，判定为全量并发下的偶发 fixture 问题，**与本批改动无关**
（三者代码路径分别是 `use_probability` 导入往返 / 分支问候宏 / `world_info_depth`，均不在本批三个改动点上）。
若日后见同款 error，判据是"单独复跑是否绿"，别直接当回归。

新增 `backend/tests/test_worldbook_depth_zero_routing.py`（13 例）：depth=0 原样下发 / depth=None 兜 4 / 声明检测三例 / 兜底模板负断言（`桃汐|世界信息|好感度|性欲值|发情期|内心想法|服饰` 一律不得出现）。
> 注：交接文档提到的 3 例 safe-delete 守卫红本次**未触发**。

### 3.2 上线确认（容器内 grep 字面量，不靠标识符——压缩会抹掉标识符）
```
grep -c 'card declares update spec in prompt'  → 1
grep -c '禁止新建顶层分组'                    → 1
grep -c '桃汐/好感度'                          → 0     ← 旧模板已不在运行代码里
grep -c 'entry.depth is None'                 → 1
```
⚠️ **重建时机**：`docker compose build backend && up -d backend` 于 03:49 执行（真机验收必需），
当时工作区**已含并行会话的未提交改动**（`character_ext.py` / `character_message_builder.py` /
`mvu_engine.py` / `mvu_secondary.py` / `frontend Message.tsx` 等），故本次上线**连带带上了那些改动**，
无法只挑本批上线。已知当时的并行会话均在运行中（用户确认其中一个已跑完，另一个在处理分支记忆混淆）。
**此后本批未再重建**；若需纯净上线，请在该会话工作完成后由用户统一决定。

### 3.3 机制级前后对照（同一会话、同一端点、同样的请求体）

| 项 | 改前 | 改后 |
|---|---|---|
| atDepth 插入深度 | `depth=4; key=customDepthWI_4_0` ×6 | **`depth=0; key=customDepthWI_0_0` ×6** |
| `mvu_user_tail` | **included**（365 tok，含别卡示例） | **skipped — `card declares update spec in prompt`** |
| `total_tokens_estimate` | 21611 | 21247（少了那段 365 tok 模板） |
| 最后一条 user 消息 | 头 200 字里就是写死模板 | 只有探针输入本身 |

真实卡片数据离线喂真函数（容器内，只读）：
```
DEPTH_ENTRIES_COUNT= 5   DEPTHS= [0,0,0,0,0]   ALL_ZERO=True   ANY_FOUR=False
```

### 3.4 反证
- **单元级**：把那行临时改回 `entry.depth or 4`，全量跑出 `1 failed, 1881 passed`，失败项正是 `test_real_depth_zero`（守门断言非空转）；改回即 `failed = 0`。
- **机制级**：3.3 的前后对照本身即反证（同一会话同一端点，只因代码不同就从 `depth=4 + tail included` 变成 `depth=0 + tail skipped`）。
- **效果级（真机 3 轮）：未完成 —— 被网关余额挡住**，见 ④。

## ④ 未完成 / 未做（如实标注）

1. **真机 3 轮验收未完成，根因是外部账户余额，不是代码**：
   ```
   403 insufficient_user_quota
   预扣费额度失败, 用户剩余额度: ¥0.817264, 需要预扣费额度: ¥9.539640
   ```
   新会话 `17139b96-6109-4d78-b945-6c2d588ac112` 已建好但 3 条 user 消息**无 assistant 回复落库**。只有你能处理余额。余额到位后按 ⑤ 复跑即可，无需再改代码。
2. **文档 §1.6 `extract_schema_defaults` 接入主提示词：未做**（会改所有 MVU 卡提示词长度，另立议题）。
3. **`mvu_secondary.py:82-85` 副模型提示词里同样写死的别卡字段名：未做**（按你裁定"只改主装配"，登记为紧随的第二笔）。
4. **旧会话脏数据：未处理**（按你裁定靠新会话绕开；且脏快照会自我强化，见 1.5）。
5. **双卡回归只完成 1 张**：第二张 MVU 卡 `我被猫娘包围了！`（user40/42）与全部非 MVU 卡都属于 admin 之外的账号，我不代跑别人账号；现网 MVU 卡**都自带 `[mvu_update]` 声明**，"兜底分支"没有真实对应卡，只能由单测覆盖。
6. **旁证缺口（未修，非本批范围）**：该卡 `剧情引导` 条目 615 tok 经 `strip_template_syntax` 剥离 EJS 后只剩 33 tok，疑似条件块整段被吞。

## ⑤ 余额到位后的复跑步骤

```bash
# 1) 新建会话跑 3 轮（脚本会自建会话并打印 session_id）
py -3 backend/scripts/_accept_mvu_realrun.py

# 2) 查库判据（把 <新会话id> 换成上一步输出）
docker exec -i palink-ai-db-1 psql -U ai_user -d ai_hub -A -F'|' -c "
SELECT id, jsonb_typeof((extra::jsonb)->'variables'->'stat_data'->'露缇雅'->'状态') AS t_state,
       (SELECT string_agg(k,'|' ORDER BY k)
          FROM jsonb_object_keys((extra::jsonb)->'variables'->'stat_data') k) AS sd_top,
       (extra::jsonb)->>'mvu_patch' AS patch
FROM character_chat_messages WHERE session_id='<新会话id>' ORDER BY id DESC LIMIT 3;"
```
**通过线**：连续 3 轮 `object`；`爱意/魔力值/饥饿度` 三键都在；顶层键**不出现** `世界信息` 与 `露缇雅1.2`；`mvu_patch` 的 path 首段 ∈ {`露缇雅`,`环境`}。

## ⑥ 备份与提交

- 备份：`_BACKUPS/2026-10-05_MVU变量更新指令让位卡片自带声明/`（`pre/` 5 文件 + `_manifest.tsv` sha256 5 行 + `HEAD.txt`=`9eda04b` + `BACKUP_INFO.md` 四要素），台账已登记 `_BACKUPS/_INDEX.md`。
- ⚠️ 回滚 `roleplay_prompt_assembly.py` 会**连带回退并行会话在 `_load_effective_stat_data` 的 +23 行未提交改动**，已写入该目录 `BACKUP_INFO.md`。
- 提交：`b027aa3`（本批改动）+ `a44d646`（剥离误带内容，见下）。

### ⚠️ 共享工作区险情实录（必读，勿照搬我的做法）

提交过程中出过一次事故，已修复并留痕：

1. **现象**：`b027aa3` 把另一会话在**同一文件**的 `[MVU-LOOKBACK]` / `[EXTRA-STR-FIX]` 两块（22 行）一并提交了进来。
2. **成因**：`roleplay_prompt_assembly.py` 里本批改动与该会话改动**同行共存**。我用
   `git update-index --cacheinfo` 构造了"只含自己改动"的索引 blob（校验通过：foreign 0、自己的符号 2），
   但**在我构造之后、commit 之前**，该会话又对同一文件执行了 `git add`，把索引覆盖回工作区版本。
   `git commit -- <pathspec>` 提交的是**该路径索引中的全部内容** → 连他的 22 行一起进去了。
3. **第一次修错**：改用 `git commit-tree $(git write-tree)` 时，`write-tree` 写入的是**整个索引**，
   于是把他另外 3 个已 `git add` 的文件（`character_ext.py` / `character_message_builder.py` /
   `Message.tsx`）也写进了修正提交。发现后用 `git update-ref` 把分支原子回退到 `b027aa3`，
   **工作区与他的索引内容未受影响**。
4. **正确做法**：用**临时索引**（`GIT_INDEX_FILE`）`git read-tree b027aa3` → 只替换目标 blob →
   `git write-tree` 得到只含一个文件的 tree → `git commit-tree` + `git update-ref <ref> <new> <old>` 原子替换。
   `update-ref` 带旧值参数，可确保期间无人动过 ref。
5. **结论**：
   - pathspec 提交**不等于**"只提交我的 hunk"——它提交该路径索引里的**一切**。
   - 共享文件上想只提交自己的改动，**必须在提交瞬间原子完成索引写入 + 提交**，
     中间任何让别的会话 `git add` 的窗口都会被吞。
   - 提交后必须 `git show <commit> --stat` 核验文件清单，并 `git show <commit>:<path> | grep <对方标记>`
     核验没夹带（本次两处都是靠这一步发现的，只看 `--stat` 的文件清单不会发现夹带，因为文件是对的）。
6. **现状核验**：`a44d646` 只含 `roleplay_prompt_assembly.py` 一个文件；HEAD 里 `[MVU-LOOKBACK]` /
   `[EXTRA-STR-FIX]` 标记为 **0**，即那 22 行已回到**未提交**状态还给其作者；该会话另外 3 个文件的
   暂存内容与工作区改动全程未被触碰。