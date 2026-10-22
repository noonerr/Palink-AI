# BACKUP_INFO — 2026-10-07_记忆注入元组解包修复

## 1. 备份日期

2026-10-07（16:4x，GMT+8）

## 2. 原始来源路径

```
D:\项目\Palink-AI\backend\app\memory_module\retriever.py
```

备份物：

- `retriever.py.bak` —— 修改前的原文件（13419 字节，与改前逐字节一致）

## 3. 备份原因

修复线上 P0：记忆注入恒为 0。

`retriever.py:134-137`（改前）对 `semantic_search` 的返回值
`List[Tuple[MemoryEntry, float]]` 按 `m.message_id` 取字段 ⇒ `AttributeError` ⇒
被同函数 `except`（`:181-190`）兜住返回空结果 ⇒ 动态上下文一个字都不注入（连 STM 一起丢）。

生产日志铁证（同一秒内相邻两行）：

```
[INFO]  MemoryModule: 语义检索完成: 找到 50 条记忆，最低相似度: 0.5983****0369, 作用域: session
[ERROR] MemoryModule: 检索记忆失败: 'tuple' object has no attribute 'message_id'
```

即：**向量引擎是好的**（Ollama bge-m3 1024 维在位，665/723 条带向量，检索确实命中 50 条），
坏的只是"检索结果组装"这一步。

引入时间：`git blame` → 2026-08-29 `ff9c1e7`（"记忆 STM 去重"），已坏约 5 周。

按「备份与清理规范」第 1、2、3 条，改代码前先做物理备份并登记。

## 4. 后续待办清单

1. ✅ **已完成**：`retriever.py:134-137` 改为按 `(mem, sim)` 解包。
2. ✅ **已完成**：补回归测试 `backend/tests/test_memory_exclude_recent.py::TestLtmExcludeWithRealEmbeddings`（2 例）。
   - 既有 5 例全绿却没拦住该 bug 的原因已查明：它们插入的记忆 **embedding 全为 NULL**，
     而 `semantic_search` 的 SQL 带 `AND embedding IS NOT NULL` ⇒ 候选恒空 ⇒
     `if semantic_candidates:` 跳过 ⇒ **出错行从未被执行**。
   - 变异验证已做：回退成旧写法后，**恰好新增 2 例变红、原有 5 例仍绿**（反证力确认）。
3. ⏳ **待做**：`docker compose build backend && up -d backend` —— 后端**不是 bind mount**，
   容器内跑的是镜像里的旧代码，不重建镜像则线上仍是坏的。
4. ⏳ **待做（真机验收，只有用户能做）**：重建后发一轮对话，确认
   ① 后端日志出现「语义检索完成: 找到 N 条」且**不再出现**「检索记忆失败」；
   ② 装配报告里 `memory` 项状态为 `included`。
5. ⏳ **待做**：提交入库（多 agent 合住仓库，**禁止 `git add -A`**，逐项 pathspec）。
6. 📌 **登记在别处**：`docs/OPEN_ISSUES.md` 已加 **[P0-0]** 条目；
   完整排查过程见 `docs/_active/report/REPORT_线上三问题排查_变量展示_记忆注入_功能按钮_2026-10-07.md` §1。

## 5. 回滚方法

```bash
cp "D:\项目\Palink-AI\_BACKUPS\2026-10-07_记忆注入元组解包修复\retriever.py.bak" \
   "D:\项目\Palink-AI\backend\app\memory_module\retriever.py"
docker compose build backend && docker compose up -d backend
```

⚠️ 回滚即恢复"记忆注入恒为 0"，仅在修复引发新问题时使用。
