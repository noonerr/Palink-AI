# BACKUP_INFO — 2026-10-05 MVU 变量更新指令让位卡片自带声明

## ① 备份日期

2026-10-05。基线 `HEAD.txt` = `9eda04b`（分支 `st-plugin-compat-20260727`）。
⚠️ **备份在动工之前完成**，且拷贝的是**当前工作区状态**（含并行会话对该文件的未提交改动，见下）。

## ② 原始来源路径

`pre/` 按原相对路径存放，逐文件 sha256 见 `_manifest.tsv`（5 行）：

| # | 原始路径 | 本次作用 |
|---|---|---|
| 1 | `backend/app/services/roleplay_prompt_assembly.py` | 主装配。**待改的写死模板在 :4239-4278**；`_insert_depth_prompt` 在 :5521，调用点 :4160。⚠️ 该文件另有并行会话的**未提交改动 +23 行**，全部落在 `_load_effective_stat_data`（:5183-5207），**与本批改区不重叠** |
| 2 | `backend/app/services/status_bar_detector.py` | 新增判据函数 `card_declares_mvu_update_rules`；既有 `_card_has_mvu_scripts`（:347）是本批注入门的现成判据 |
| 3 | `backend/app/services/worldbook_service.py` | 仅当实测证明「卡片自带的变量结构说明被 token 预算砍掉」时才动 `_apply_budget`（:1351-1399） |
| 4 | `backend/app/core/default_prompts.py` | `[MVU-EXEMPT]`（:263-287）措辞跟随——它引用「按变量更新指令输出」，删掉模板后该引用物可能不存在 |
| 5 | `backend/tests/test_depth_injection_order.py` | 新断言落点；`:158 test_cross_depth_insert_positions` 是 depth=0 落末尾**唯一活着的**断言 |

## ③ 后续待办清单（备份之后要做的事）

1. 用现成端点 `POST /api/character-sessions/{sid}/debug-prompt-assembly`（`character_ext.py:5223`）**实测**：
   4 条 `[mvu_update]`/`变量列表` 条目的 activated/trimmed 状态、`mvu_user_tail` 是否 included、
   `messages_preview` 末尾几条落位、`{{format_message_variable::stat_data}}` 是否解析成 JSON。**不许凭猜改码。**
2. 主改：卡片已自带并**真的落进提示词**时不注入；否则注入**不含任何角色名/字段名**的通用兜底。
3. 条件改：若被预算砍掉 → 运行时对「声明变量结构的卡片条目」免预算放行，并在注释登记为对 ST 的有意例外。
4. 新增 2 条守门断言（含**负断言**：兜底文本不得含 `桃汐|世界信息|好感度|性欲值|发情期|内心想法`）。
5. 门禁 `cd backend && py -3 -m pytest tests/ -q` → failed=0；重建后端容器并容器内 grep 确认新代码在跑。
6. 真机：**新会话**跑 ≥3 轮 + 双卡回归 + 反证（还原改动必须变回坏的样子）。
7. 交付报告并如实标注未做项。

## ④ 备份原因（含已定性的证据）

用户报障：卡片 `露缇雅1.2` 状态栏三条进度条（爱意/魔力值/饥饿度）永远不动。
承接 `docs/PROMPT_MVU变量结构注入修复_2026-10-05.md`，并已独立复核该交接文档（代码行号/调用点/数据楼层**全部对得上**）。

生产库 `character_chat_messages`（会话 `94ba57d6-c2c1-4653-97b6-f179286d5d41`，属主 `admin`/user_id=1）实测：

| 楼层 | `stat_data.露缇雅.状态` | 顶层分组 | 模型实际发出的 patch path |
|---|---|---|---|
| 2595 | object ✓ | `环境\|露缇雅` | —（初始化正确） |
| 2597 | object | 多出 `世界信息` | `/露缇雅/好感度`、`/露缇雅/性欲值`、`/世界信息/日期时间` |
| 2599 | **string** ✗ | `世界信息\|环境\|露缇雅\|露缇雅1.2` | `/露缇雅1.2/{好感度,关系,性欲值,发情期,内心想法}` |
| 2601 | string ✗ | 同上 | `{"op":"replace","path":"/露缇雅/状态","value":"…一句话"}` ← 结构在此被摧毁 |

卡片真实结构是 `露缇雅.状态.{爱意,魔力值,饥饿度}` + `环境.时间.{年,月,日,…}`；
上表的字段名**逐字来自** `roleplay_prompt_assembly.py:4250/:4256/:4259` 写死的别卡示例
（`/桃汐/好感度`、`/世界信息/日期时间` + "好感度、关系、性欲值、服饰、内心想法、发情期"六个字段名）。
卡片自己的声明在其自带世界书（book `41b91f4e`，19 条全 constant，**0 条含 initvar**）里：
`[mvu_update]变量更新规则`(3589) / `[mvu_update]变量输出格式`(1698) / `变量列表`(97) / `变量输出格式强调`(159)，
均 position=4 / depth=0 / order=200 / ignore_budget=false / enabled。

**对交接文档的三点订正**：

1. **因果机制说反了一半**。文档假设我们的模板是"最后一条指令"。实测装配序：`4160` depth 插入**早于**
   `4239` user-tail，而 `_insert_depth_prompt:5609-5610` 对 depth=0 取 `insert_index = len(messages)` →
   **卡片那份说明落在我们模板之后**，更贴近模型。所以真正的病灶不是"谁在最后"，
   而是**模板里的别卡字段名被模型当成了结构定义**。按文档 §3 判定表属于「卡片条目已落在末尾 → 删模板」一支。
2. **文档漏了一个能让修复失效的风险**：`worldbook_service.py:2120` 的 `_apply_budget` 在位置路由**之前**
   对所有激活条目做预算，`:1686` 已按 order **降序**排（order=200 的 MVU 条目排最前、最先吃预算），
   `_estimate_tokens:105-126` 无 tokenizer 时按 `中文字符×2` 估算。该卡 19 条共 27,708 字符、
   `ignore_budget` 全 false、全局预算默认 25% → **那份 3589 字的结构说明有可能被 trimmed**，
   此时删模板 = 模型彻底没有结构可照。必须先测。
3. **文档漏了脏快照自我强化**：`变量列表` 靠 `{{format_message_variable::stat_data}}`
   （`macro_service.py:581-598`，读**会话级** `chat_metadata.variables.stat_data`）每轮回灌，
   而该快照实测已脏（顶层键同样含 `世界信息|露缇雅1.2`）→ 旧会话会一直坏下去，**验收必须用新会话**。
   另：`_flatten_stat_data`（`5019`，唯一调用点 `5320`）也把当前 stat_data 压平进动态上下文，
   但它用的是**消息级优先**的 `_load_effective_stat_data`，与会话级宏口径不一致（并行会话正在改的那 23 行）。

**现网数据分布（决定验收能做到什么程度）**：全库只有 2 张 MVU 卡（`_card_has_mvu_scripts` 为真）——
`露缇雅1.2` ×2（user 1）与 `我被猫娘包围了！` ×3（user 40/42），**都自带** `[mvu_update]` 声明条目
→ 「兜底分支」在现网**没有真实对应卡**，只能由单测覆盖；`extract_schema_defaults` 接入主提示词、
`mvu_secondary.py:82-85` 的别卡示例，均按用户裁定**不在本批**。

## 回滚路径

`cp _BACKUPS/2026-10-05_MVU变量更新指令让位卡片自带声明/pre/<相对路径> <相对路径>`（逐文件），
再按 `_manifest.tsv` 校验 sha256。⚠️ 回滚 #1 会**连带回退并行会话在 `_load_effective_stat_data` 的未提交改动**，
如需只退本批，改从 `git diff` 里挑 :4239-4278 与 :5183-5207 之外的部分手工还原。
