# SPEC — 角色扮演动作流 reasoning-only 防护（思考链死循环落库修复）

> 日期：2026-08-24
> 分工：本 spec 由审计线编写，施工由修复 agent 执行，完工后由审计线验收。
> 关联事故：2026-08-23「我被猫娘包围了！」卡 swipe 重roll 思考链无限复读（消息 2248）。

---

## 1. 事故记录（证据链，全部实证）

### 1.1 现象

用户对角色卡「我被猫娘包围了！」（副本 `e77c00b9`，2026-08-23 16:04 导入）执行 swipe 重roll，
生成结果为：**content 空、extra.reasoning 2060 字**，内容全部为无限重复的
`(You are admin. 请以我被猫娘包围了！的身份进行回复。)(请以我被猫娘包围了！的身份回复admin。)…`。

消息 2248 特征（DB 实测）：

| 字段 | 值 | 指纹意义 |
|------|-----|---------|
| extra 键 | `['reasoning', 'reasoning_type', 'swipe_info']` | **无 gen_id / model / token_count** → 排除 websocket 流式 persist_snapshot 与 REST 生成端点（两者必写 gen_id），指向 SSE 动作端点 persist_fn |
| swipe_id | 2 | swipe 追加产物 |
| 会话消息数 | 仅此 1 条 assistant | 新会话首次重roll 即死循环，无历史污染 |

### 1.2 三层根因

**第一层（装配层，诱因）：st-compat 路径缺标签平衡守卫 + 身份锚点真空**

- admin 账号 `silly_tavern_mode='st-compat'`，走 [character_message_builder.py:511](../backend/app/services/character_message_builder.py#L511) `build_st_compat_messages`
- 该路径世界书/深度注入出口**均无 `balance_custom_tags` 调用**；palink-native 路径已全覆盖（[roleplay_prompt_assembly.py:4627](../backend/app/services/roleplay_prompt_assembly.py#L4627-L4690) 含 depth 队列）
- 该副本卡实测：description/personality/scenario/system_prompt 全空；28 条 enabled 世界书中 7 条为 `@activate`+EJS 人设控制器（被 [worldbook_service.py:1614](../backend/app/services/worldbook_service.py#L1614) strip_template_syntax 剥成空串→六名角色人设消失）；脏标签裸进 prompt（角色总览 `<user>` 1开0闭、猫神说话格式 `<猫神>` 3开2闭）；first_mes 尾部带 HTML div/span
- main prompt 仅 ST 默认一句英文 → 模型身份锚点真空，在思考链中自发合成"身份校准指令"并陷入复读熵崩塌

**第二层（判定层，直接原因）：`has_content` 把 reasoning 计入"有内容"**

[stream_builder.py:23-24](../backend/app/services/stream_builder.py#L23-L24)：

```python
def has_content(self) -> bool:
    return bool(self.full_content or self.full_reasoning)
```

**第三层（持久层，落库通道）：SSE 动作流 finally 判定放行了 reasoning-only**

[character_ext.py:5524](../backend/app/api/character_ext.py#L5524) `_run_action_stream` 的 finally：

```python
if result.has_content and not result.full_content.strip().startswith("Error:"):
    message_id, final_content = persist_fn(save_db, result)
```

reasoning-only 时 `has_content=True`、`full_content=""` 不满足 `startswith("Error:")` → persist_fn 执行。
而 `/swipe`（L5972-6000）与 `/regenerate`（L5729-5758）的 persist_fn 均：

- `current_swipes.append(final)` —— 不校验 final 为空
- `msg.content = final` —— 空正文覆盖
- `if regexed_reasoning: current_extra["reasoning"] = ...` —— 思考链无条件入库

对照组（正确行为）：websocket 主路径 [websocket.py:404-411](../backend/app/api/websocket.py#L404-L411) 用
`if not result.full_content:` 只看正文，有 `[NO-CONTENT-FINAL]` 报错拦截；
其 persist_snapshot [websocket.py:598](../backend/app/api/websocket.py#L598) 也有空正文不入库守卫。
**SSE 动作流是唯一漏网出口。**

### 1.3 影响面

- 用户看到空正文消息挂思考链，观感即"思考链无限重复"
- 死循环烧 completion tokens（本例 2060 字符）
- 空 assistant 消息进入后续轮次上下文成为噪声

---

## 2. 修复项

### R1（核心代码）：`_run_action_stream` 持久化判定改为「仅正文」

**位置**：[character_ext.py:5522-5532](../backend/app/api/character_ext.py#L5522-L5532)（finally 块）

**方案（最小 diff，单点覆盖 continue/regenerate/swipe 三端点）**：

```python
finally:
    try:
        final_body = (result.full_content or "").strip()
        if final_body and not final_body.startswith("Error:"):
            message_id, final_content = persist_fn(save_db, result)
            if message_id is not None:
                yield f"data: {json.dumps({'type': 'final_content', 'content': final_content, 'message_id': message_id}, ensure_ascii=False)}\n\n"
        elif not final_body and (result.full_reasoning or "").strip():
            # [NO-CONTENT-FINAL] 动作流版：reasoning-only 不落库（对齐 websocket 主路径行为）
            logger.error(
                "[NO-CONTENT-FINAL-ACTION] session=%s type=%s reasoning_len=%d（reasoning-only，不落库）",
                session_id, getattr(req, "type", "action") if hasattr(req, "type") else "action",
                len(result.full_reasoning or ""),
            )
            yield f"data: {json.dumps({'type': 'error', 'error': True, 'message': '模型未输出正文，仅返回思考链，已丢弃本次生成。请重试或切换模型。'}, ensure_ascii=False)}\n\n"
    except Exception as e:
        save_db.rollback()
        logger.warning(f"Action persist failed: {e}")
    finally:
        save_db.close()
```

约束：

1. 错误事件格式对齐 N12 惯例（`{'type': 'error', 'error': True, 'message': ...}`，参照 stream_builder.py:148）；施工前先确认前端 action-stream 解析器能识别该事件（搜索前端 SSE 解析处对 `type: 'error'` 的处理；若不识别，补前端 toast 提示，改动保持最小）
2. CancelledError 分支已把 full_content 置为 Error 文本 → 被 startswith 守卫挡住，行为不变
3. 日志标签用 `[NO-CONTENT-FINAL-ACTION]` 与主路径区分，便于检索
4. **不改** StreamResult.has_content 本身（stream_builder 其他调用点依赖现语义：超时分支 L78/L145/L228 用它判断"完全无输出"，改语义会破坏这些场景）

### R2（运维操作，非代码）：admin 切 palink-native 模式

- 设置页把 admin 账号 `silly_tavern_mode` 切到 `palink-native`（默认模式），获得 balance_custom_tags 全链路守卫 + palink-native 身份模板补锚点
- 用同卡新建会话 + swipe 重roll 实测：不再出现 reasoning-only 死循环
- 由审计线/用户操作，不在修复 agent 施工范围

### R3 数据处置（待用户拍板，默认不动）

消息 2248 是死循环病理性产物。两个选项：

- a) 删除该消息（会话将变为空会话）
- b) 保留现状（作为观察样本）

R1 上线后此类消息不会再产生。**未经用户确认不得删除任何数据行。**

## 3. 非目标（红线）

1. **不给 st-compat 补 balance_custom_tags**——违反 AGENTS.md 冻结红线（st-compat 已封存待删除）。除非用户明确授权，否则不动 character_message_builder.py 的 build_st_compat_messages
2. **不实现 EJS/MVU 渲染运行时**——strip_template_syntax 剥离行为保持不变；EJS 重卡在本平台属"残血"状态是已知产品边界
3. **不改三层默认提示词模板**（default_prompts.py）——经查证与本次事故无关（st-compat 下根本未注入）
4. **不动 websocket 主路径**的既有守卫逻辑

## 4. 测试要求

1. 新增单测（backend/tests/，命名如 test_action_stream_no_content_guard.py）：
   - 构造 StreamResult(full_content="", full_reasoning="x")，断言 persist_fn 未被调用且 SSE 流中出现 error 事件
   - 构造 full_content="hi", full_reasoning="x"，断言正常持久化（防误伤）
   - 构造 full_content="Error: x"（CancelledError 注入路径），断言不持久化、无 error 事件（维持旧行为）
2. 全量回归基线：`cd backend && python -m pytest tests/` → **898 passed / 4 failed（存量：mvu_engine/p1_fixes/st_contract/st_plugin_import），零新增失败**
3. 前端：`cd frontend && npx tsc --noEmit` 通过（若涉及前端 error 事件补充处理）
4. 手工冒烟（可选，由审计线做）：swipe 重roll 正常卡 → 功能不受影响

## 5. 验收清单（审计线使用）

- [ ] diff 仅触碰 character_ext.py `_run_action_stream` finally 块（±前端 error 事件消费点）
- [ ] reasoning-only 场景：DB 无新行产生（可用 sqlite/pg 查询或日志佐证）
- [ ] 单测 3 例全过；全量 898/4 基线零新增失败；tsc 干净
- [ ] 无 st-compat / default_prompts 改动
- [ ] 提交信息含事故编号（2248）与守卫标签说明
