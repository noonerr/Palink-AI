# BACKUP_INFO — 2026-10-05 变量形状修复

## ① 备份日期

2026-10-05（当日 04:2x，GMT+8）

## ② 原始来源路径

| 备份内相对路径 | 原始来源 |
|---|---|
| `pre/session_chat_metadata.json` | 会话 `40d9b7cc-fd8c-49dc-91de-3f4ed640c4ff` 的 `character_chat_sessions.chat_metadata`（解码后） |
| `pre/session_chat_metadata.b64` | 同上，原样 base64（防编码损失） |
| `pre/msg_<id>_extra.json` | 该会话 10 条含 stat_data 的消息的 `character_chat_messages.extra`（解码后） |
| `pre/messages_extra.b64.json` | 同上，全部 base64 原样 |

**修改前的库内原值全部留存**，可原样回滚（见 ④）。

## ③ 备份原因

用户报「数值变化后角色面板乱套、直接进默认值 0/100/0」。
诊断见 `docs/DIAG_变量形状漂移导致状态栏回默认值_2026-10-05.md`：

卡 schema 要 `露缇雅.状态.爱意`（三层），实际数据变成
`露缇雅.状态 = "一段描述文本"` 且 `爱意/魔力值/当前动作或体位` 被提到 `露缇雅` 下
当兄弟键 ⇒ 卡状态栏 `_.get(vars,'stat_data.露缇雅.状态.爱意', 0)` 穿不过字符串
→ 回落 prefault **0 / 100 / 0**（与用户描述逐字一致）。

本次是**直接改用户数据**，故先把将被改动的行整体备份。

## ④ 回滚方法

```bash
# 会话级
python -c "..."   # 见下方说明：把 pre/session_chat_metadata.json 的内容 base64 后
# UPDATE character_chat_sessions SET chat_metadata =
#   convert_from(decode('<b64>','base64'),'UTF8') WHERE id='40d9b7cc-...';
# 消息级
# 用 pre/messages_extra.b64.json 里的原 b64 逐条 UPDATE character_chat_messages.extra
```

（`pre/messages_extra.b64.json` 里存的就是可直接写回的 base64，无需再编码。）

## ⑤ 修复内容

走 `backend/scripts/_fix_stat_shape.py`（**默认干跑**，`--apply` 才写库）：

- 会话级 `chat_metadata.variables`：3 个裸挂键搬回 `露缇雅.状态.*`；
  `状态` 原文本归档到 `露缇雅.状态._漂移前文本`；`饥饿度`/`当前位置` 按 schema prefault 补齐。
- 消息级快照 7 条同样处理（装配侧 `_load_effective_stat_data` 是消息级优先，
  只修会话级不够 —— 否则喂给模型的仍是坏结构，会自我强化）。
- **复验**：卡片状态栏读的全部 22 条路径 **22/22 恢复**（修前 17/22）。

**非破坏性**：原文本没有丢弃，存进了 `_漂移前文本`
（下划线前缀 → 被 `_flatten_stat_data` 跳过、被 `apply_patches` 只读前缀挡住、
卡片也不读，是零干扰的存档位）。

## ⑥ 防复发（同批落地，需重建后生效）

- 新增 `backend/app/services/mvu_stat_normalize.py`：按 schema 形状归一化 stat_data。
- 接进生成链路 `character_message_builder.apply_mvu_reply_to_session`（
  `[MVU-SHAPE-GUARD 2026-10-05]` 块）：每轮补丁应用后归一化一次，
  等价于 ST 的 MVU 在应用命令后跑 zod（prefault/transform 修结构）那层语义。
- **安全边界**：解析不出 schema 骨架 → 原样返回，绝不擅改数据；
  归一化抛异常 → 只告警，不影响生成主流程。

⚠️ **本次修复的数据改动已即时生效（改的是库）；但防复发层需重建 backend 容器才生效**，
本批**未重建**（另一 agent 的记忆镜像重构尚有 8 例测试红，重建会把那一状态推上线）。

## ⑦ 后续待办

1. **未复现验证**：修完之后没有再用真实生成跑一遍确认「不再漂移」，需真机观察。
2. 诊断报告 §6 的方案 **D**（`_flatten_stat_data` 保留层级）未做 —— 那是从源头
   降低漂移概率，本批只做了「事后修」。
3. 只有 1 个会话可对照；建议再攒几次复现确认触发条件。
4. 恢复数据后，`露缇雅.状态._漂移前文本` 若确认无用可删（用户决定）。
