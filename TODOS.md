# TODOS.md — 跨 agent 待办与决策记录

> 本项目所有 agent（Claude Code / Codex / TRAE / 其他）在动工改代码前，请先阅读本文件。
> 这是跨会话/跨 agent 的遗留任务、方向决策与进行中工作项的唯一入口。修改前先同步，完成后更新状态。

---

## 待办任务（进行中 / 未完成）

### [已完成] 思考/正文分离存储（2026-08-23 六步实施 + 四项遗留处置全部收尾）
- **实施交接文件**: `HANDOFF_分离存储实施_2026-08-22.md`（六步全部执行完毕）
- **Step 0 备份** ✅: `_backup/20260823_separate_storage/`（DB 26 行全量导出 SHA256 校验一致 + 12 文件快照）
- **Step 1 访问器** ✅: `utils.py` `[REASONING-ACCESSOR]` get_message_extra/get_message_reasoning/get_display_content + strip_inline_think_full（多块+未闭合尾全量剥离）；13 单测
- **Step 2 写入侧切换** ✅: stream_builder.final_text 纯正文；websocket.py/character_ext.py 包裹拼接删除；`_apply_reasoning_regex` 二元组重构（regenerate 思考丢失修复、continue 追加进 extra）；chat.py 与 api/websocket.py 普通聊天切纯正文+extra；websocket_manager 双分支接线（该函数当前为死代码无调用方）；messages 表新增 extra 列
- **检查点联调冒烟** ✅: 真实 deepseek-v4-flash 全链路（流式→持久化→历史加载→折叠展开）+ 存量混合行不变形 + 控制台零错误
- **Step 3 存量迁移** ✅: `_migrate_messages_separate_storage.py` 用户批准 --apply——1292 swipes 清洗落库；2241/2242 剥离后正文为空按保守策略跳过（维持原状，前端 parse 路径正常显示）
- **Step 4 前端消费点** ✅: useCharacterChat 5 处拼接删除（流式 pending 分离携带 reasoning → extra）、onSync 追赶动画只作用正文、useChatMessages 快照分离持有、messageUtils.buildAssistantContent 废弃删除；Message.tsx memo 兜底直读 message.extra.reasoning（唯一渲染挂点，新旧双兼容）
- **Step 5 插件边界** ✅: CharacterChat.smartCardChatMessages 与 NativeRoleplayChat.toStMessages 预剥离 think 并把提取思考注入 extra.reasoning 兜底（源码不可改的随卡插件靠此保兼容）
- **Step 6 回归** ✅: 后端全量 887 过/4 存量失败零新增；前端 tsc 零错误；dist 重建；后端镜像定稿重建 healthy；真实对话复验（新格式行 DB 干净+历史加载双块渲染+插件边界零泄露）
- **验收标准对照**: 新消息 content=纯正文+extra.reasoning 单份 ✅ / 存量显示导出不变形 ✅ / 折叠展示正常 ✅ / 插件边界剥离生效 ✅ / 测试零新增失败+容器 healthy ✅
- **遗留事项**: ① ~~websocket_manager.save_stream_to_db 死代码~~ → **已删除（2026-08-23 用户拍板）**：save_stream_to_db/update_stream_in_db 两方法及 SessionLocal/ChatMessage/CharacterChatMessage 导入一并移除，守卫测试改写为断言已删除；② ~~2241/2242 病例行~~ → **已删除（2026-08-23 用户拍板）**：2241 经消息删除 API 删除，2242 随「冒烟测试员二」角色级联删除；③ ~~「冒烟测试员二」角色~~ → **已整角色删除（2026-08-23 用户拍板）**：角色+会话+消息级联清除，角色列表仅剩「我被猫娘包围了！」；④ 容器 /tmp root 脚本残留 → **已清除（2026-08-23 docker 恢复后镜像重建完成）**：/tmp 仅剩运行时产物，死代码删除已生效于运行镜像（grep 复核 0 匹配），容器 healthy
- **插件影响审计已完成**（2026-08-22）: 唯一风险点为读 chat[i].mes 的 iframe 类插件（BubbleDialogue 等），缓冲方案=传给 iframe 边界处用 extractReasoningTags 预剥离；ST 生态插件反而更兼容；自研渲染组件正面收益（提取补丁退役）
- **背景**: 当前 assistant 消息 content 列混存 `<think>` 包裹体，且 extra.reasoning 双写同一思维链——同一份思考存两份
- **收益测算**: 典型推理回复（思维链2000字/正文500字）省约 60% 该消息体积；模型思维链越长省越多；存量数据需一次性迁移脚本拆冗余
- **前置条件**（缺一不可，故列为远期）:
  1. 后端访问器封装 `get_display_content(msg)` / `get_message_reasoning(msg)`，所有消费方改走访问器
  2. 前端 8 处消费点迁移（useCharacterChat.ts ×5 / useChatMessages.ts L123 / messageUtils.ts L20 / 渲染层提取逻辑）
  3. 存量数据一次性拆分脚本
- **架构决策记录**: 见 `.trae/specs/separate-reasoning-pipeline/tasks.md` 底部；`<think>` 内联格式是前后端契约（前端主动拼接+渲染层提取），不可单方面后端改造
- **关联**: ST 参照实现 `reasoning.js`（五层体系）；本期已完成的来源归一化/统一解析器为其第 1/2 层基础
- **实施进展（2026-08-23）**: 用户批准动工。Step 0 备份完成（`_backup/20260823_separate_storage/`：DB 全量 26 行导出+SHA256 校验一致；文件快照 12 个）。摸底：content 含内联块行=2、extra 带 reasoning 行=0（存量全为单写形态）。Step 1 完成：`utils.py` 新增 `[REASONING-ACCESSOR]` 三访问器（get_message_extra/get_message_reasoning/get_display_content，extra 权威+未闭合块截尾语义），11 单测全过；全量 871 过/4 存量失败零新增。写入点审计补充发现：`websocket_manager.save_stream_to_db` 为 assistant 写入点但历来只存纯正文不写 reasoning（Step 2 需补接线）；`slash_command_service._cmd_send` 仅写 user 消息无需改
- **实施进展二（2026-08-23，Step 2+冒烟检查点完成）**: Step 2 写入侧切换完成——stream_builder.final_text 改纯正文；websocket.py L651 / character_ext.py L4580 包裹拼接删除；continue/regenerate 经重构的 `_apply_reasoning_regex`（二元组返回）写入 extra.reasoning（regenerate 此前思考只进包裹体属丢失，已修复）；chat.py 与 api/websocket.py 普通聊天路径切纯正文+extra 接线；websocket_manager 双分支接线（**注意：该函数全库无调用方，当前为死代码**）；messages 表新增 extra 列（模型+_RUNTIME_COMPAT_COLUMNS 自动建列）。前端 formatting.ts 兜底直读 extra.reasoning（Step 4 表格该项前置落地，pipeline+Message.tsx 三层打通，dist 已重建）。新增 14 单测，全量 885 过/4 存量失败零新增。联调冒烟检查点全过（真实 deepseek-v4-flash 对话：DB content 无包裹体+extra.reasoning 223 字+swipes 干净；刷新后「模型思考」折叠正常、内容与 DB 一致；存量混合行显示不变形；控制台零错误；测试角色/消息已删）。Step 3 脚本 `_migrate_messages_separate_storage.py` 就绪，dry-run 结果：匹配 3 行=A 类 0+B 类 3，其中 id=1292 仅 swipes 含块可清、id=2241/2242 剥离后正文为空按保守策略跳过；**--apply 待用户批准**

### [已完成] 思考链路对齐 ST：来源归一化 + 统一解析器（spec: separate-reasoning-pipeline，2026-08-22）
- **背景**: 研究 ST reasoning 五层体系后对齐；实施前复核发现 `<think>` 内联格式是前后端存储契约（前端 8 处消费点），原"持久化分离"方案降级为架构决策记录
- **改动**:
  - `stream_builder.py` ×2 + `websocket.py` ×1: 推理 delta 归一化，同时识别 `reasoning` 与 `reasoning_content` 字段（OpenAI 兼容生态两大变体）
  - `utils.py`: 新增 `split_inline_think` / `strip_inline_think` 统一解析器（与历史清洗正则同语义，未闭合兜底全归思考）
  - `character_message_builder.py`: 历史注入的临时正则改用统一解析器（行为等价）
- **验证**: 新增 10 单测全过（`test_reasoning_parse.py`）；全量 860 过/4 存量失败（基线一致）；容器 healthy 镜像冒烟通过；备份 `_backup/20260822_reasoning_pipeline/`
- **架构决策存档**: content 列 `<think>` 内联格式为前后端契约不做分离改造；ST 第 5 层"思考回填 prompt"列为未来可选项

### [已完成] 修复推理模型"一直在思考"无正文（标签平衡守卫，2026-08-22）
- **症状**: 新导入角色卡生成时模型把全部输出写进 `<think>`、正文为空；思维链复读尾部指令出不来（用户视角=一直在思考）。实测两条坏消息：id=2241（think 内 4868 字含指令无限复读+`</Input>` 补关）、id=2242（`<think></p>` + 剧情在 think 内被截断）
- **根因**（日志+DB 实证）: 角色卡「我被猫娘包围了！」自带不平衡标签——世界书「猫神说话格式」（constant）`<猫神>` 开标签无配对闭合、「角色总览」（constant）裸 `<user>`；叠加 Galgame 类插件注入的 `<Input>/<Admin's recent behavior>/<世界状态>` 结构。推理模型遇未闭合标签先"补关"再认为后续都在结构内 → 死循环
- **与同日改动无关的判定**: 坏消息均为新卡导入后第一轮生成（记忆库空、问题标签不经过当日改动的 depth 队列路径），旧注入逻辑同样会把这些标签送入 prompt
- **修复**: `utils.py` 新增 `balance_custom_tags()` [TAG-BALANCE-GUARD]——开>闭补齐文末闭合（后开先闭）、闭>开剥离孤立闭合、void 元素豁免、支持中文标签名；应用到全部注入出口（世界书 8 位置/AN/persona//inject/插件三态/smart_card/记忆行）
- **验证**: 新增 9 单测全过（含真实卡组合复现）；全量 850 过/4 存量失败（基线一致）；容器 healthy 镜像内冒烟通过
- **注意**: 卡数据本身的脏标签建议作者侧修正（引擎守卫只保证不触发死循环，不改变条目原意）

### [已完成] 向量记忆语义切分（方案 B，2026-08-22；存量迁移 2026-08-23 执行完毕）
- **状态**: 代码已上线（容器 healthy）；存量迁移经用户批准于 2026-08-23 执行 `--apply`
- **交付**: `SPEC_向量记忆语义切分_2026-08-22.md`（完整规格）+ 实施代码
- **已完成改动**:
  - `backend/app/memory_module/semantic_chunker.py`（新建）: 语义切分（批量嵌入 1 次调用/缓冲窗口±1/**局部峰值断点检测**/尺寸整形 120~450 字）
  - `storage.py`: `store_chunks()`（批量嵌入+单事务直写 embedding+失败降级逐条）、`get_adjacent_chunks()`（turn_hash 定位 idx±1）、`_chunk_topics/_parse_chunk_meta`（topics JSON 编码块元数据，**免 schema 迁移**）
  - `service.py`: `store_memory` 内部接线（assistant 长回复 ≥250 字自动切分，4 调用点零改动）；`get_context` 邻居扩展（命中块带 idx±1，受 max_tokens 预算约束）
  - `utils.py`: `build_memory_context` 废除 200 字砍头 → 命中块完整注入；预算不足整条跳过；遗留巨物兜底截断
  - 3 个调用点传预算（assembly 1500 / websocket 2000 / chat 2000）
  - `backend/scripts/_rechunk_memories_semantic.py`: 存量重切脚本（默认 dry-run）
  - 新测试 24 个全过；全量 841 过/4 存量失败（与基线一致）
- **⚠️ 算法二次修正（2026-08-22 复核）**: 初版 percentile-95 与 mean+std 全局阈值在"多处话题跳变"的短文本上漏切（跳变越多阈值被抬越高，只认唯一最强跳变，实测 4 场景只切出 2 块）。已改为**局部峰值法**（TextTiling 谱系）：距离为相邻局部最大且 ≥ max(绝对下限 0.12, 全体均值) 即断开，对跳变数量不敏感。参数 `MEMORY_CHUNK_DIST_EPSILON` 可调。
- **参数**（env 可调）: `MEMORY_SEMANTIC_CHUNKING=false` 一键回滚；TRIGGER 250 / MIN 120 / MAX 450 / DIST_EPSILON 0.12 / BUFFER 1 / NEIGHBOR_EXPAND true
- **dry-run 实测（2026-08-22, 局部峰值法）**: 12 条存量长记忆（573~1204 字）→ 切成 2~4 块，边界落在场景/情绪转折处
- **已知小瑕疵**: 长对话段可能从「」引号中间切开（」不在句终止符集），块仍完整可读；后续可将闭合引号纳入切分参考
- **存量迁移执行记录（2026-08-23）**: 用户批准后 `--apply` 落库——12 行 → 29 块（2~4 块/行），0 跳过 0 失败；验证全过：旧 id 无残留、全部带 #chunk 标记、created_at/session/branch/importance 按组保留（12 组与原行一一对应）、抽查块完整可读、全库向量 1024 维一致无维度警告、检索命中正常、全量测试基线不变（860 过/4 存量失败）。临时验证脚本已清理
- **备份**: `_backup/20260822_semantic_chunk/`（7 个改动文件的原状副本）

### [进行中] ST 1.18.0 对比分析的后续实施（2026-08-20）
- **状态**: 分析已完成（报告落盘）；待办 3（depth 队列排序权重）已于 2026-08-22 实施 ✅，其余待办未开始
- **交付**: `PALINK_VS_SILLYTAVERN_COMPARISON.md`（完整对比）+ `HANDOFF_ST对比分析_2026-08-20.md`（交接）
- **待办**（按优先级）:
  1. 仅补 `{{time}}` 本地时区支持（**`{{banned}}`/`{{reverse}}`/`{{roll}}` 经 2026-08-20 核对已实现，见 `macro_service.py` L570/705/673，已从待办移除**）；低成本高兼容
  2. 补 chara note 三态
  3. ~~depth 队列补 ST 一致的顺序权重~~ → **已完成（2026-08-22）**：palink-native 引入统一 `DepthInjection` 队列（`roleplay_prompt_assembly.py`），5 来源（世界书 atDepth/AN/persona//inject/插件 IN_CHAT/角色卡 depth_prompt）汇入单管线，三级确定序 depth↓→order↑→role(assistant→user→system)→key 字母序（对齐 ST `populationInjectionPrompts`/`getExtensionPrompt`/`doChatInject`；key 等价物 `0_palink_injection`/`1_persona_description`/`2_floating_prompt`/`DEPTH_PROMPT`/`customDepthWI_{d}_{r}`/插件 identifier），同 (depth,order,role) 合并单条 join('\n')；删除 ext_depth_entries 第二遍插入；st-compat 分支未动（clear() 守卫保留）。新测试 `backend/tests/test_depth_injection_order.py` 7 用例全过；全量 817 过/4 存量失败（stash 基线对照确认与本次无关）；容器已重建 healthy
  4. 核对 `setExtensionPrompt` 沙箱签名与 ST 七参一致性
  5. 补齐未覆盖对比：memory_module/、worldbook_vector_service.py、前端 regex、sillyTavernPluginRuntime.ts、st-plugins/、plugins.py
- **约束**: st-compat 已封存保持冻结；主攻 palink-native
- ⚠️ **已更正（2026-08-20 核对）**：对比报告原"缺失宏 `{{banned}}`/`{{reverse}}`/`{{roll}}`"结论错误——三者均已在 `backend/app/services/macro_service.py` 实现（L570/705/673）。请勿据此重复实现。
- ⚠️ **报告 §8/§9/§10 部分缺失项声明已过时（2026-08-22 核对）**：`renderExtensionTemplateAsync` 已实现（sandbox.ts P-8）；tokenizers 已实现（K-9）；jailbreak 在 palink-native 有 PHI+模板等价物（st-compat 有完整 D1 合并链）；`{{/regex}}` 宏两边源码均不存在。实施前请勿照抄报告缺失清单。

### [进行中] Palink 本体无限加载排查（backend 内存飙升卡死）
- **状态**: 排查中（2026-08-19），根因未定位
- **现象**: 前端登录页/主界面无限加载；frontend nginx 日志 `/api/auth/config` 反复 499；backend 不响应 /health
- **已确认**: backend 内存飙到 1.975GiB/2GiB 卡死，事件循环阻塞；重启后恢复（177MB）
- **时间线**: backend 重建(19:08) → 导入角色卡(19:15:04) → WebSocket 连接+StreamSession(19:15:28) → tokenizer 下载超时(19:15:40) → backend 卡死 → 重启恢复(19:24)
- **已排除**: tokenizer 下载（后台线程）、Ollama embedding（卡死期间无 /api/embed 请求）、本地 GGUF 加载（无日志）、sentence-transformers（未安装）
- **待办**: 修复/重启 `backend/scripts/_monitor_backend.py` 监控脚本，复现并抓线程栈定位内存来源
- **详见**: `HANDOFF_Ollama部署与无限加载排查_2026-08-19.md`

### [进行中] 统一向量引擎 / 换库（跨两个项目）
- **状态**: Ollama 已 Docker 部署并激活（2026-08-19），存量记忆已全部清除（用户决策，不再重算）
- **来源**: 与用户讨论第二轮对话思维链死循环时由用户提出
- **目标**: 统一 Palink-AI 与另一个项目（奈酱/hemers 助手）的向量引擎
- **决策（2026-08-18 用户拍板）**:
  - 部署拓扑: Palink 与奈酱**同机部署在 NAS**（i3-1315U / UHD 32EU 核显已透传 Ollama Vulkan / 16GB 单通道）
  - 引擎: **Ollama + bge-m3（1024 维）**——核显已验证加速 +57%，效果最强，两项目共享同一常驻模型（内存最优）
  - 存储: Palink 保留 PostgreSQL（多租户刚需），奈酱保留 JSON（集中只读够用）——只统一嵌入层
- **已完成改动**:
  - `backend/app/memory_module/embedder.py`: 新增 `OllamaEmbedder`（httpx 调 `/api/embed`，bge-m3 1024 维），**运行时降级**：Ollama 不可达自动回退 fastembed（不崩溃）
  - `backend/app/memory_module/config.py`: 新增 `OLLAMA_HOST` / `OLLAMA_MODEL`（bge-m3）/ `OLLAMA_TIMEOUT`
  - `docker-compose.yml`（2026-08-19）: 新增 `ollama` 服务（`ollama/ollama:latest`，绑定 `frontend-backend` 网络，端口 11434 映射宿主机便于调试，`ollama_data` 卷持久化模型，`OLLAMA_KEEP_ALIVE=24h` 常驻）；backend `OLLAMA_HOST` 改为 **`http://ollama:11434`（compose 网络服务名直连）**，`depends_on` 加 `ollama: service_healthy`
  - 容器已重建 healthy；backend 容器内实测 `OllamaEmbedder` 激活（dim=1024，`/api/embed` 返回 200）
  - bge-m3 模型已 `ollama pull` 就绪（1.2GB，`ollama list` 可见）
- **⚠️ 其他 agent 的误改（2026-08-18 已纠正）**:
  - 其他 agent 声称"无法安装 Ollama"，改走 SentenceTransformer 加载 bge-m3，并在 requirements.txt 加了
    `sentence-transformers==6.0.0 / torch==2.13.0 / transformers==5.15.0`——**这些版本不存在且容器 Python 3.10
    装不上，导致 docker build 失败**。已移除这些依赖，compose 改回 `MEMORY_EMBEDDING_PROVIDER=ollama`。
    正确路径就是 Ollama（Docker 部署，绑定 palink 网络）。
- **待办（NAS 部署后）**:
  1. ~~存量记忆重算~~ → **已取消（2026-08-19 用户决策：不重算，全部清除）**。`conversation_memories` 已 `TRUNCATE` 清空（0 条），新对话将直接用 Ollama bge-m3 写入 1024 维向量，无需迁移
  2. 奈酱侧无需改动（本就是 bge-m3），两边自动统一
- **验收**: 两项目向量维度（1024）、语义基准一致；Ollama 故障时 Palink 记忆功能不崩溃

### [已完成] 存量脏记忆数据清理
- **状态**: 已完成（2026-08-18）
- **背景**: 历史 assistant 回复中的 `<UpdateVariable>` 块 / 残缺标签可能已写入记忆库
- **动作**: 一次性脚本 `backend/scripts/_clean_memory_pollution.py`（容器内执行），
  扫描 `conversation_memories` 中 role='assistant' 的记录，用 `clean_memory_content()` 清洗
  并重算 embedding（`embed_text`）
- **结果**: 扫描 543 条 assistant 记忆 → 清洗 17 条（剥离功能块后重 embedding），
  526 条本就干净，0 删除，0 失败；数据库残留脏标签 0 条（剩余 3 条为 user 角色用户
  手动输入的状态指令，属用户内容，不在清洗范围）

---

## 已完成工作（记录留档）

### [已完成] MVU 副 AI 变量更新（2026-08-19，解决面板时间/角色信息空白）
- **背景**: 空响应修复后，正文正常输出，但角色面板"时间/角色信息"仍空白。实测根因：deepseek-v4-flash 对"每条回复末尾输出 `<UpdateVariable>` 变量块"的遵循率不稳定（约 50%），主模型没输出块 → stat_data 中时间/天气/地点/服饰/内心想法等字段保持初始空 → 面板空白。这是模型能力问题，非 Palink bug（ST 生态同样存在，社区推荐"副 AI"方案）。
- **方案（用户拍板）**: 副 AI 兜底——主模型未输出变量块时，用独立副模型解析剧情 + 当前 stat_data，生成 `<UpdateVariable>` 块补写变量。适配所有带变量系统的角色卡（schema 从角色卡 tavern_helper 自动提取，不特调）。
- **改动**:
  - `backend/app/models/system.py`: UserSetting 新增 `mvu_secondary_model`（副模型 ID，空=不启用）+ `mvu_secondary_enabled`（开关）
  - `backend/app/schemas/user.py` + `backend/app/api/users.py`: 新字段读写
  - `backend/app/services/mvu_secondary.py`（新建）: 副 AI 服务——构造 prompt（系统指令 + 当前 stat_data + schema 结构 + 剧情），调 `complete_text_completion`（temperature 0.2），解析 `<UpdateVariable>` 块
  - `backend/app/api/websocket.py`: `_run_secondary_mvu_sync` 辅助函数（查询配置 + 跨线程调副 AI）+ persist_snapshot MVU 分支：主模型 `mvu_logs` 为空且副 AI 开启时，用 `apply_patches` 应用副 AI patches
  - `backend/alembic/versions/0060_add_user_setting_mvu_secondary.py`: 迁移（手动执行 `python -m alembic upgrade head`，因 RUN_MIGRATIONS_ON_STARTUP=false）
  - `frontend/src/components/views/SettingsView.tsx`: 设置 UI（副 AI 开关 + 副模型 ID 输入）
- **验证**: 副 AI 服务单测（真实角色 schema + 真实剧情）生成 6-7 个 patches，完整填充世界信息（日期/天气/风力/地点）+ 桃汐（服饰/好感度 50→53/内心想法）；端到端 `_run_secondary_mvu_sync` 链路正常；配置读写正常；前端 tsc 无错误
- **守卫（不特调 + 不乱输出）**: `[MVU-SECONDARY-GUARD]`——`_run_secondary_mvu_sync` 与 `run_secondary_mvu` 均检查：无 schema 且无 stat_data 结构（= 角色卡无变量系统/面板）时副 AI 完全不介入，返回空，不调副模型。仅当卡定义了 tavern_helper schema（z.object）或已有 stat_data 时才触发。实测：有 schema → 介入（2 patches）；无 schema 无 stat → 不介入（0 patches）；无 schema 但有 stat_data → 介入。通用适配所有卡，不特调，无面板的卡不乱输出
- **使用**: 设置 → 开启"副 AI 变量更新" → 填副模型 ID（建议比主模型强，如 deepseek-v4-pro）→ 保存。主模型正常输出变量块时以主模型为准，副 AI 仅在主模型没输出时兜底
- **注意**: 副 AI 每轮多一次模型调用（仅主模型没输出块时），有 token 成本；副模型需在模型列表可用

### [已完成] 修复第二轮对话 100% 空响应（真正根因：IN_PROMPT 注入 append 到 prompt 末尾，2026-08-19 二次定位）
- **日期**: 2026-08-19（两次排查：第一次修错了分支，第二次定位真正根因）
- **背景**: 2026-08-18"记忆污染修复"正确且已生效（本轮实测记忆库数据干净）。2026-08-19 上午第一次排查误将根因定位为"in_chat depth=0 注入"，修了 `_collect_extension_prompts` 的 IN_CHAT depth=0 防护——**用户实测"依旧如此"**。二次排查发现真正根因在另一条分支。
- **真正根因（对照实验 100% 复现）**:
  1. 用户 `silly_tavern_mode = 'st-compat'`（DB user_settings 实测），装配走 `build_st_compat_messages`，而非 palink-native——第一次排查的修复点（roleplay_prompt_assembly 的 palink-native 分支）根本不执行
  2. 前端"对话渲染系统 v7.1"（BubbleDialogue）插件的 `injectPrompts` 在 Palink 是 stub（sandbox.ts），回退走 `setExtensionPrompt(key, content, **position=0(IN_PROMPT)**, 0, false, 0)` → WS extension_prompts(position=0) → st-compat builder 内部把 IN_PROMPT 条目 **append 到 messages 最末尾**（jailbreak 之后 = prompt 最后一条 system 注入，紧贴模型续写位置）
  3. 对照实验（基于真实第二轮 prompt，各 3 次真实调用）：append 末尾 0/3（`</now_plot>` 结尾 → completion=1 立即 EOS；普通结尾 → 模型把剧情正文写进 reasoning 不写 content，与用户日志 attempt 1 的 343 字符剧情 reasoning 完全吻合）；追加到 system prompt 末尾 3/3 正常
- **为什么第一轮正常、第二轮必挂**: 插件异步初始化（applyInjection）——第一轮发出时注入尚未就绪（正常），第二轮注入已生效（必挂）
- **改动**（IN_PROMPT 注入位置修正，对齐 ST 1.18.0 getPromptPosition(IN_PROMPT)='end' = system prompt 末尾语义）:
  - `backend/app/services/character_message_builder.py`（st-compat 路径，**用户实际在用**）: `build_st_compat_messages` 的 ep_in_prompt 处理从"append 到 messages 末尾"改为"并入 messages[0]（system prompt）文本末尾"
  - `backend/app/services/roleplay_prompt_assembly.py`（palink-native 路径，防御同源 bug）: IN_PROMPT 注入同样改为并入 messages[0]
  - 保留第一次的 IN_CHAT depth=0 防护（`_collect_extension_prompts` 的 depth 0→1 + 剥离结尾裸闭合标签，对两条装配路径共用，属合理防御）
  - `backend/tests/test_extension_prompts_st_compat.py`: 7 个断言旧行为的测试更新为新语义（IN_PROMPT 并入 system prompt；role 归一化改在 IN_CHAT 场景验证）
- **验证**: 装配断言（注入进 messages[0]、末尾无注入）+ 真实模型 3/3 正常（且模型正确按 @bubble 格式输出——插件注入真正生效）；相关 pytest 150 全过（全量 798 过/1 失败为 mvu_engine 存量问题，与本次无关）；容器已重建，镜像内复验通过
- **附带清理**: 删除 conversation_memories 中 3 条占位向量 `[1.0,0.0,0.0]` 脏数据（造成检索维度警告）
- **实验脚本留档**: `backend/scripts/_experiment_in_prompt.py`（IN_PROMPT 根因复现）、`_verify_in_prompt_fix.py`（修复验证）、`_debug_inj_location.py`（注入定位）、`_dump_second_turn_prompt.py`（prompt dump）
- **教训**: ① 修 bug 前必须确认用户实际运行模式（本次 st-compat vs palink-native 分支差异导致第一次修错）；② ST 对齐注释声称的行为要与 ST 源码实际语义核对（'end' 指 system prompt 末尾，不是 messages 数组末尾）

### [已完成] 修复第二轮对话思维链死循环（记忆污染）
- **日期**: 2026-08-18
- **根因**: assistant 记忆入库不干净——`<UpdateVariable>`(含内嵌 `<Analysis>`/`<JSONPatch>`) 大 XML 功能块、以及 `<thinking>` 思维链块整块进向量记忆库；注入 prompt 时又被 `content[:200]` 硬截断，切出残缺半截标签 → 推理模型思维链反复自我审查 → 死循环/空响应
- **改动**:
  - `backend/app/utils.py`: 新增 `clean_memory_content()`（剥离 UpdateVariable/thinking 块与孤立标签残余）、`_truncate_by_sentence()`（按句边界安全截断）；`build_memory_context()` 注入前清洗+按句截断
  - `backend/app/api/websocket.py`: 两处 `store_memory(role="assistant")` 改传 `clean_memory_content(full_content)`
  - `backend/app/api/character_ext.py`: SSE 链路同类 assistant 入库也做清洗
- **验证**: 清洗/截断定向单测全过；`py_compile` 三个改动文件通过
- **容器验证**: 已 `docker compose up -d --build backend` 重建，容器内实测
  `clean_memory_content()` 完整剥离 `<UpdateVariable>` 块只留剧情正文，容器 healthy

---

## 决策记录
- 2026-08-18: 死循环修复 = 入库清洗 + 注入按句截断，不依赖换库即可解决；换库是独立的"统一两项目"诉求，后置。