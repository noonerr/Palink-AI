# SPEC — 二期批次：世界书 vectorized 接线 + N-8 止血滑动续期（2026-08-25）

> 分工：单 agent 施工（两域文件不重叠），审计线验收。
> 基线：宿主 pytest **996 passed / 0 failed**；容器内 **988 passed / 0 failed**（C7 对齐已达成）。
> ⚠️ 施工前备份（用户强制要求）：见 §4。

---

## 背景

### vectorized 孤岛（D-7/j-1）

ST 的 World Info 支持 vectorized 检索：条目标记 `vectorized=true` 后不参与关键词
扫描，而是被向量化入库；每轮生成时用**最近对话**作为查询，语义检索 top-K 相似条目
注入——让"没有命中关键词但语义相关"的条目也能被想起。

本项目基建**已全部就绪但从未接通**：
- `services/worldbook_vector_service.py`：`sync_worldbook_vectors`（全量同步
  vectorized 条目→pgvector）/ `query_entries`（cosine 检索，threshold 0.25）/
  `delete_vectors` 三件套完整
- DB：`world_book_entry_vectors` 表（pgvector `<=>>` 算子在用）+
  `world_book_stages.vectorized` 列 + 导入/导出/编辑全链路字段映射齐全
- 嵌入：`embed_text` Ollama bge-m3 降级链路现成

**唯一缺口 = 两个调用点不存在**：没有任何地方触发 sync，也没有任何地方调用 query
把命中条目送进装配。

### N-8 止血

JWT 存 localStorage（HttpOnly Cookie 迁移为远期 N-8 本体），当前有效期 12h
（config.py:16 `ACCESS_TOKEN_EXPIRE_MINUTES=60*12`，env 可配），jti 每次签发随机。
止血目标：**活跃用户无感、被盗令牌窗口有界、无需 refresh 架构**。

---

## §1 V 线：vectorized 接线（3 子项）

### V-1 同步触发（保向量库新鲜）

三处触发点，均为 fire-and-forget（asyncio.to_thread / 后台任务，失败仅 warning）：

1. **编辑即同步**：`api/worldbook.py` 世界书保存端点与条目增删改路径——commit 后
   若该书存在任一 `vectorized=true` 条目，调 `sync_worldbook_vectors(world_book_id)`
2. **ST 导入/更新对齐**：silly_tavern.py 的世界书写入路径同样触发
   （若该文件仍处禁改状态则登记顺延，本批先覆盖 api/worldbook.py 主路径）
3. **装配兜底懒同步**（防绕过编辑 API 的写入）：装配入口检测该书向量库
   stale（比较 stages 更新时间戳 vs 向量行 created_at 的轻量查询）→ 陈旧则先同步再检索；
   实现成本高可降级为"文档注明依赖编辑触发"，二选一在报告中说明取舍

### V-2 检索注入（核心）

`roleplay_prompt_assembly.py` 世界书装配段：

1. 对每本启用且**含 vectorized 条目**的世界书：
   - query 文本 = 最近对话拼接（复用既有 history 尾窗来源，建议最后 4 条消息
     content 拼接，截断至 ~2000 字符）
   - `query_entries(world_book_id, query, top_k=5, threshold=0.25)`
     （top_k/threshold 进 WI 全局设置或 env，默认值如前）
2. 命中 entry_id 集合内的 vectorized 条目 → **跳过关键词匹配直接进入激活管线**
   （位置/budget/decorators/balance 全部复用既有逻辑——它们已在 activated 集合，
   后续管线天然处理）
3. 未命中的 vectorized 条目维持 ST 语义：不参与关键词扫描、不注入
4. 报告可见性：命中条目在 debug report 标注 `vectorized_hit(score=0.xx)`

**关键正确性约束**：vectorized 条目**不再参与常规关键词扫描**（对齐 ST——它们
已被向量库接管）；非 vectorized 条目完全不受影响。嵌入失败/服务不可用时静默降级
为"本轮无 vectorized 命中"，绝不阻塞主对话。

### V-3 开关与配置

- WI 全局设置新增 `vectorized_enabled`（默认 **false**——存量行为零突变，
  用户显式开启才生效）
- top_k / threshold 可 env 覆盖（`WI_VECTOR_TOP_K=5` / `WI_VECTOR_THRESHOLD=0.25`）

### V 线测试

- sync：vectorized 条目入库/取消 vectorized 清除/内容变更重嵌（content_hash 生效）
- 注入：命中条目进 activated 且带 vectorized_hit 标注；未命中不进；开关关闭时
  整条链路旁路（回归）；嵌入抛异常 → 主流程不受影响
- 导入往返：vectorized 字段经导入导出保真（已有映射，补断言）

## §2 S 线：N-8 止血滑动续期（2 子项）

### S-1 后端续期头

`api/dependencies.py` get_current_user 成功鉴权后：计算剩余寿命，当
`剩余 < ACCESS_TOKEN_EXPIRE_MINUTES / 3`（即 <4h）→ 用同一用户身份签发新 token
（全新 jti，旧 token 不拉黑——它会在原过期时刻自然失效，避免误杀多端会话），
挂到 `request.state.token_refresh`；由各路由响应头统一输出不可行（Depends 无
response 句柄），采用**中间件方案**：新增轻量中间件读取 `request.state.token_refresh`
写入 `X-Palink-Token-Refresh: <new_jwt>` 响应头。

约束：仅对携带 Authorization Bearer 的请求签发（query token/uploads 通道不参与）；
新令牌 claims 与旧一致（sub/jti/exp 新算），**不带 scope**（upload 通道隔离不变）。

### S-2 前端拦截器

`services/api.ts` 响应拦截器：检测到 `X-Palink-Token-Refresh` 头 →
`localStorage.setItem('palink_token', newValue)`（键名以现有存储实现为准）。
其余逻辑（401 处理等）不动。被盗令牌最长存活 = 12h 窗口（受害者本人活跃会持续
刷新自己的，攻击者副本无法获得受害者后续续期——因为攻击者用的是自己偷到的旧串，
其请求产生的续期头只会回到攻击者自己的响应里，不影响受害者侧安全性；反之亦然）。

### S 线参数（一步到位定稿）

- `ACCESS_TOKEN_EXPIRE_MINUTES` 默认 **720（12h）保持**，env 已可配
- 续期阈值 = 有效期/3（<4h 时续）；活跃使用永不掉线；停止使用 ≥12h 后令牌必死
- 未来 HttpOnly Cookie 迁移落地时，本机制整体退役（无沉没成本）

### S 线测试

- 剩余 >2/3 → 无续期头
- 剩余 <1/3 → 有 X-Palink-Token-Refresh 且解码 sub 一致、exp 更晚、jti 不同
- upload-scope 令牌请求（无 sub 场景按现有 401 路径）不触发续期
- 前端拦截器：源码契约断言（检测头并 setItem）

## §3 Non-goals

1. 不实施 HttpOnly Cookie 迁移本体（N-8 远期另立项）
2. 不做 refresh token 双令牌架构（滑动续期已达成止血目标且零架构成本）
3. vectorized 不做 UI 设置界面（全局开关走 env/设置 JSON 即可，UI 另批）
4. 不删除 worldbook_vector_service 任何既有接口

## §4 备份要求（用户强制）

施工开始前执行：

```
backup/2026-08-25_vectorized-n8-stopgap/
├── roleplay_prompt_assembly.py.bak
├── worldbook_vector_service.py.bak（如有微调）
├── api/worldbook.py.bak
├── api/dependencies.py.bak
├── app/main.py.bak（如中间件落此）
├── services/api.ts.bak
└── MANIFEST.txt（逐文件 sha256）
```

还原口径：任一文件出问题 `copy item.bak item` 即回到施工前状态。

## §5 统一约束

- 禁改：openai_compat.py / memory_module/**（除非 V-1 复用 embed_text 的只读调用）/ 
  character_message_builder.py / stream_builder.py / 封存集合 / st-vec::
- 不 npm run build、不 git commit、不动容器（审计线统一收尾）
- 宿主自验：pytest 全绿（基线 996 passed / 0 failed，新增上涨正常）+ tsc 干净

## §6 交卷报告格式（精简模板，同清理批次惯例）

```
## 结果矩阵
| 子项 | 结论结论✅/⚠️/❌ | 文件:行 | 一句话说明 |
## 自验计数
pytest / tsc 末尾各一行
## 甄别记录
仅判定变化/影响面/参数取舍时写，每条 ≤5 行
## 备份清单
MANIFEST 摘要一行
```

## §7 验收清单（审计线）

- [ ] V-1 三处触发点生效；V-2 命中注入+非命中不注入+开关关闭旁路；嵌入失败降级不阻塞
- [ ] S-1/S-2 续期四态测试过；upload 通道不受污染
- [ ] 备份目录与 MANIFEST 齐全
- [ ] 宿主全量 0 failed；tsc 干净；统一 build；容器重建 healthy
