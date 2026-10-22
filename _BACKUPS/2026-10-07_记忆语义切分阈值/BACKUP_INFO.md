# BACKUP_INFO — 2026-10-07_记忆语义切分阈值

## 1. 备份日期

2026-10-07（17:0x，GMT+8）

## 2. 原始来源路径

```
D:\项目\Palink-AI\backend\app\memory_module\config.py
```

备份物：

- `config.py.bak` —— 修改前的原文件（3904 字节，改前逐字节一致，含 `CHUNK_DISTANCE_EPSILON = "0.12"`）

## 3. 备份原因

修「记忆语义切分**完全失效**」——`CHUNK_DISTANCE_EPSILON = 0.12` 比实测距离最大值还高。

**实测证据**（容器内跑 `semantic_chunker` 中间步骤，5 条真实回复 1322~1700 字）：

```
[cfg] epsilon=0.12 min=120 max=450 trigger=250 buffer=1

msg=2786 正文1322字 句数=30 断点=0 块数=1 块长=[1322]
msg=2784 正文1641字 句数=44 断点=0 块数=1 块长=[1641]
msg=2782 正文1535字 句数=42 断点=0 块数=1 块长=[1535]
msg=2780 正文1651字 句数=37 断点=0 块数=1 块长=[1651]
msg=2778 正文1700字 句数=43 断点=0 块数=1 块长=[1700]

=== 全体相邻句余弦距离（n=191）===
  p50 = 0.0708   p90 = 0.0868   p95 = 0.0897   p99 = 0.0976
  mean=0.0703  std=0.0130  max=0.1010
  >= 当前 epsilon(0.12) 的比例: 0.0%
```

⇒ **断点恒为 0**，`semantic_split` 返回单块，实际由末尾的「超 `CHUNK_MAX_CHARS` 强制再分」
救场切成 440 字左右的块 —— 即**退化成"按 450 字在句边界硬切"**，语义切分形同虚设。

**根因公式**：`semantic_chunker._detect_breakpoints` 的判定下限是
`floor = max(epsilon, mean(dists))`。epsilon 一旦低于文本的 mean，阈值就由 mean 主导（自适应）。
0.12 高于实测 max(0.101)，等于**把自适应机制废掉**。
实测：阈值降到 0.075 以下后，从 0.075 一路降到 0.050 **结果完全不动**（都是 6.8 块 / 均 230 / 134~441），
证明此时已由 mean 主导 ⇒ epsilon 只该当"兜底下限"。

按「备份与清理规范」第 1、2、3 条，改配置前先做物理备份并登记。

## 4. 后续待办清单

1. ✅ **已完成**：`config.py:45` 默认值 `0.12` → `0.05`，并重写误导性注释
   （原注释未提 `floor = max(epsilon, mean)`，后人会以为 0.12 是最优值）。
2. ✅ **已完成**：离线正反对照（同批消息，只换阈值）：
   - 块内内聚度 0.5467 → 0.5534（**仅 +1.2%**，推翻"块内更聚焦"的预期）
   - **话题分离度 margin 0.0376 → 0.0638（+69.9%）** ← 真正的收益（块与块更分得开）
   - 块数 24 → 43（+79%，存储同比例增长）
3. ✅ **已完成**：`pytest -k 'semantic or chunk or memory'` → **219 passed / 28 skipped / 0 failed**。
4. ⏳ **待做**：`docker compose build backend && up -d backend`（后端非 bind mount）。
5. ⏳ **待做（真机验收，只有用户能做）**：同批问题改前/改后召回质量对照；
   `[Relevant Memories]` 是否出现更多"小而准"的块；反向对照（改回 0.12 应回到原状）；
   记忆行数增速是否符合 +79%。
6. 📌 **暂缓（用户已确认）**：存量 723 条仍是按 450 硬切的块，**不重算**。
   将来若要一致，参照 `backend/scripts/reembed_all_to_bge_m3.py` 做"重切+重嵌"；
   ⚠️ 全量重跑嵌入、占满 ollama，低峰做且先备份记忆表。
7. 📌 **局限（引用结论前必读）**：样本仅 **6 条消息**，+69.9% 不要当精确值；
   margin 是**代理指标**，测的是"向量空间可区分性"，不等于真实检索准确率。
   完整记录见 `docs/_active/report/REPORT_线上三问题排查_变量展示_记忆注入_功能按钮_2026-10-07.md` §8。

## 5. 回滚方法

```bash
cp "D:\项目\Palink-AI\_BACKUPS\2026-10-07_记忆语义切分阈值\config.py.bak" \
   "D:\项目\Palink-AI\backend\app\memory_module\config.py"
docker compose build backend && docker compose up -d backend
```

⚠️ 回滚即恢复"语义切分失效、按 450 字硬切"的旧行为。
⚠️ 注意：本次只改默认值，若 `.env` / `docker-compose.yml` 里显式设了
`MEMORY_CHUNK_DIST_EPSILON`，该环境变量会**覆盖**默认值 —— 回滚时需一并检查。
