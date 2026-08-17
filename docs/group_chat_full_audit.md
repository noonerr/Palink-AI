# 后端群聊（ST 1.18.0 对齐）完整审计 · 保守版

> 审计日期：2026-07-23
> 审计者：Backend Architect（磐石石）
> 审计方式：**逐条对照实际代码**核实既往阶段声明，而非采信历史结论。所有结论附 `文件:行号` 证据。
> 基线：`pytest tests/` → **354 passed / 0 failed / 36 skipped**（~14s）。

## 定级图例

| 标记 | 含义 |
|------|------|
| 已验证(代码+测试) | 代码实现已读且存在专门测试覆盖 |
| 代码已验证·测试薄弱 | 代码已读确认，但仅经集成/e2e 间接覆盖，缺针对性单元测试 |
| 仅声明/本轮未深核 | 既往阶段声明存在，本轮未独立复核到底层行为 |
| 发现缺口 | 实际代码与声明不符或存在遗漏 |

---

## 一、基线测试

- 全量 `pytest tests/`：**354 passed, 0 failed, 36 skipped**。套件全绿，无回归。
- 群聊相关专门测试文件（均通过）：
  - `test_st_compat_group_chat_e2e.py`（3 例：装配触发 `_resolve_group_speaker` / `_build_group_profile_context`）
  - `test_st_compat_group_generation_mode.py`（5 例：SWAP/APPEND/APPEND_DISABLED/非群/合并卡宏）
  - `test_f1_speaker_queue.py`（队列解析：disabled_members、NATURAL/POOLED/TALKATIVE/VOTING→None、LIST→队列）
  - `test_d3_speaker_card_swap.py`（SWAP 群聊发言者卡绑定）
  - `test_worldbook_group_and_position.py`（群世界书 haystack + WI 深度枚举映射）
  - `test_st_compat_wi_format.py` / `test_st_compat_names_behavior.py` / `test_st_compat_jailbreak.py` / `test_st_contract.py`（含 `activation_strategy` / `allow_self_responses` 契约）

---

## 二、逐项核查

### 阶段 1（群聊基础）

| 特性 | 证据 | 定级 |
|------|------|------|
| `disabled_members` 强制过滤（激活侧+上下文注入侧） | `_enabled_member_ids` :1421-1441；`_build_group_profile_context` 排除 disabled :2203-2261；`_load_members` :1595 | 已验证(代码+测试) `test_f1_speaker_queue.py:26` |
| `allow_self_responses` 接入 | 字段 :386；`_resolve_group_speaker` 归一化 :2052；`_select_natural_speaker` 防连续判断 :1697, :1725, :1733 | 代码已验证·契约测试仅验字段形态（`test_st_contract.py:758-763`），行为（防连续豁免）无专门单测 |
| 成员名填充（群成员名列表注入） | `group_members` 透传 :3064 → builder 替换 `{{group}}` :538-539 | 代码已验证 |
| 群语义修正（new_group_chat_prompt / group_nudge） | `new_group_chat_prompt` :3062, `group_nudge` :3063 → builder :824 | 代码已验证 |
| MANUAL(2) 无选角跳过 AI | 队列返回 `[]` :1473-1475；`_resolve_group_speaker` 置 `manual_skip_ai` :2126 | 已验证(代码+测试)（e2e/F1 队列） |
| `follower_members` 注入（被动跟随标注） | `_build_group_profile_context` :2280-2305 | 代码已验证·单测薄弱 |

### 阶段 2（激活策略）

| 特性 | 证据 | 定级 |
|------|------|------|
| NATURAL(0)：提及强制 + 概率激活 + 防连续 | `_select_natural_speaker` :1687-1739；提及强制 :1716-1719；防连续 :1725, :1733 | 代码已验证·**选角内部逻辑缺单测**（仅经 e2e/contract 间接覆盖） |
| follower 衰减系数（FOLLOWER_DAMPING） | `_eff` 衰减 :1710-1714；常量 :1590 | 代码已验证·未单测衰减效果 |
| POOLED(3)：从未发言成员随机 | `_select_pooled_speaker` :1784-1802；`_collect_spoken_since_last_user` :1742-1781 | 代码已验证·未单测 |
| LIST(1)：名册顺序轮转 | `_resolve_group_speaker` 单发言者轮转 :2141-2155（fallback 路径）；**F1 队列返回全启用成员实现多成员串联** :1471-1472 | 已验证(代码+测试)（多成员串联由 F1 队列覆盖） |
| D1 st-compat 注入 member 身份 / jailbreak | `jailbreak=jailbreak_for_st` :3027（不再硬编码空串）；`group_profile_part` 注入 st-compat system :2939-2942 | 已验证(代码+测试)（`test_st_compat_jailbreak.py`） |
| D2 native 群 history「Name: content」归属 | `build_character_chat_messages` :191-196 按发言者名前缀；另 :733-744 | 已验证(代码+测试)（`test_st_compat_names_behavior.py` / `wi_format`） |

### 阶段 3 C1+C2（generation_mode 分流）

| 特性 | 证据 | 定级 |
|------|------|------|
| `generation_mode` 读取并透传 | `assemble_roleplay_prompt` :2355-2385；透传 builder :3066 | 已验证(代码+测试)（`test_st_compat_group_generation_mode.py`） |
| SWAP(0)：单发言者卡 | `group_combined_card=None` :3001-3003 | 已验证(代码+测试) |
| APPEND(1)/APPEND_DISABLED(2)：合并卡 | `_build_group_combined_card` :1618-1685；装配构建 :2999-3011；builder 覆盖 desc/pers/scen/example :574, :584, :596, :654 | 已验证(代码+测试)（5 例覆盖三模式 + 宏） |
| APPEND_DISABLED 保留 disabled 仅作上下文 | `_build_group_profile_context` :2259-2261 + `_load_all_members` :1607 | 代码已验证·未单测 |

### 阶段 3 F1（多人串联流式）

| 特性 | 证据 | 定级 |
|------|------|------|
| `resolve_group_speaker_queue` 解析队列 | :1444-1477（LIST→全启用成员；MANUAL 无选角→`[]`；其余→`None`） | 已验证(代码+测试) |
| `_gen` 逐发言者装配+流式+落库 | `websocket.py` :1513-1642；`for speaker_id in speaker_ids` :1531 | 已验证(代码+测试) |
| 每发言者重置 StreamSession（独立 chunk…done 周期） | :1534-1537 | 代码已验证 |
| `group_speaker_start` / `group_speaker_end` 广播 | :1593-1598, :1635-1640（仅 `len(speaker_ids)>1`） | 协议已就绪·**前端未接入**（用户要求暂搁置） |
| 多 speaker 落库 `name` 正确归属 | `_resolved` → `speaker_char` :1565-1572 → `run_character_chat_generation(char=speaker_char)` :1625 | 代码已验证 |
| 用户消息 `include_user_message=False` 避免重复注入 | :1559 | 代码已验证 |

### 阶段 3 D3（SWAP 群聊 char 身份绑定）

| 特性 | 证据 | 定级 |
|------|------|------|
| 装配前回填 `req_local.char = speaker_char` | `websocket.py` :1561-1571（先 `_resolve_group_speaker` 再回填） | 已验证(代码+测试)（`test_d3_speaker_card_swap.py`） |
| 1:1（`group_id=None`）行为不变 | `_resolve_group_speaker` 早返回 :2040-2041；`_gen` 单发言者路径 :1527-1529 | 代码已验证 |

### E1 / E2（世界书）

| 特性 | 证据 | 定级 |
|------|------|------|
| E1 per-member 世界书（world_info_character_strategy: one/all/group） | 读策略 :2383；应用：`all`/`group` 时加载启用成员并入 `build_worldbook_context(group_chars=)` :3474-3492 | 已验证(代码+测试)（`test_worldbook_group_and_position.py:100-132`） |
| E2 WI 枚举偏移 | 全代码库无 `enum_offset`/`wi_offset`/`position_offset` 显式标记；对应能力疑为世界书深度枚举映射（ST 0-9 depth），由 `test_worldbook_group_and_position.py`（`test_st_integer_enum_full_range` / `test_at_depth_five_maps_to_at_depth_four` / `test_st_string_names`）覆盖 | 仅声明+枚举测试·**本轮未定位到群专属偏移实现**，建议专项复核 |

---

## 三、跨切面风险与死代码

1. **`manual_skip_ai` 为死字段**（`roleplay_prompt_assembly.py`）
   - 声明 :382，写于 :2126（`MANUAL(2)` 无选角分支），但**全代码库无任何读取点**（grep 仅 3 处：声明/赋值/注释）。
   - 实际 MANUAL 跳过已由 websocket 层 `resolve_group_speaker_queue` 返回 `[]` 驱动，**该字段已无作用**。属遗留死代码，建议删除字段及 :2350 注释。
   - 风险：低（无害），但增加阅读误导。

2. **两处过期注释**
   - :2144「多成员一次性响应待阶段 3 补全」——F1 已实现 LIST 多成员串联（队列驱动），注释应更新。
   - :2350「manual_skip_ai 已在 _resolve_group_speaker 置位」——该字段已死，注释误导。

3. **st-compat 模式对 TALKATIVE(4)/VOTING(5) 降级为 NATURAL**（:2064-2070）
   - 原生模式（`palink-native`）完整支持 0-5；但 `st-compat` 模式下收到 4/5 会 `strategy = 0` 并记 warning。
   - 注释称「st-compat 仅接受 ST 标准策略 0-3」。若目标对齐 ST 1.18.0，其标准策略集实际含 4(TALKATIVE)/5(VOTING)，则此降级属**潜在对齐缺口**；若对标更早期 ST 版本则为有意简化。
   - 建议：对照目标 ST 版本的 `activation_strategy` 枚举定义，确认是否为预期行为并补注释依据。

4. **无 TODO/FIXME/HACK/临时绕过硬编码**（grep 仅命中 `replace_placeholders` 函数名与正常的「跳过 AI 生成」业务注释）。

---

## 四、已知缺口与未覆盖路径

| 缺口 | 说明 | 严重度 |
|------|------|--------|
| NATURAL/POOLED 选角内部逻辑无单测 | 提及强制、follower 衰减、防连续、POOLED 未发言集计算均仅集成覆盖 | 中（回归风险） |
| `allow_self_responses` 防连续豁免无行为单测 | 仅契约验字段 | 低 |
| APPEND_DISABLED「仅上下文」语义无单测 | 代码存在 :2259-2261，缺断言 | 低 |
| E2 群专属 WI 偏移实现未定位 | 见上「仅声明」项 | 待确认 |
| 前端群聊 UI 接线 | `group_speaker_start/end` 后端协议就绪，前端未接 | 阻塞项（用户要求暂搁置） |
| 空群 / 单成员群 / 全 disabled 边界 | 代码有防御（如 VOTING 无成员抛 400 :2077），但未专门测试 | 低 |
| LIST 多成员串联的中间失败处理 | `_gen` 单发言者异常被 `logger.exception` 捕获 :1629-1633，不中断其余成员；行为合理但缺测试 | 低 |

---

## 五、保守对齐评估（不使用虚高百分比）

既往记录标注「后端群聊对齐 ≈82–85%」。本轮**逐条代码核实**后，结论应修正为：

- **已实现且代码+测试双重验证**：disabled_members 过滤、MANUAL 跳过、generation_mode 三模式（SWAP/APPEND/APPEND_DISABLED）合并卡、F1 多发言者流式编排、D3 发言者卡绑定、D1/D2 身份与群历史归属、E1 per-member 世界书。这些是本审计的**高信心**项。
- **已实现但单测薄弱（仅集成覆盖）**：NATURAL/POOLED/LIST 选角内部逻辑、allow_self_responses 行为、follower 衰减、APPEND_DISABLED 仅上下文。功能大概率正确，但**回归保障不足**。
- **需确认**：E2 群专属 WI 偏移实现位置；st-compat 模式 4/5 降级是否对齐目标 ST 版本。
- **未做**：前端群聊 UI 接线（协议已就绪）。

**结论**：后端群聊「已实现功能」的代码正确性**高信心**；但「测试覆盖完整性」未达可对等宣称 85% 的程度——选角核心逻辑缺单测、两处死代码/过期注释、E2 与 st-compat 4/5 待确认。综合建议将对外表述定为 **「后端群聊已实现功能约 80–85% 代码对齐，测试覆盖约 70%（核心路径绿、选角逻辑待测），剩余为前端接线与 2 项确认点」**，而非单一高百分比。

---

## 六、后续建议（按优先级）

1. **补选角单测**：为 `_select_natural_speaker` / `_select_pooled_speaker` / `_resolve_group_speaker` 各分支加单测（提及强制、防连续、allow_self、follower 衰减、POOLED 未发言集）。——最高优先级，消除回归盲区。
2. **清理死代码**：删除 `manual_skip_ai` 字段及 :2350 注释；更新 :2144 过期注释。
3. **确认 E2**：定位群专属 WI 偏移实现，或在报告中明确其等价于 `test_worldbook_group_and_position.py` 已测的深度枚举映射。
4. **确认 st-compat 4/5**：对照目标 ST 版本枚举，决定保留降级或补齐 TALKATIVE/VOTING 的 st-compat 路径。
5. **边界用例**：补空群/单成员/全 disabled/ LIST 中间失败的测试。
6. **前端接线**：待用户解除搁置后，接入 `group_speaker_start/end`。
