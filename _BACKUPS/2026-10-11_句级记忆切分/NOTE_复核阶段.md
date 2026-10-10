# 复核阶段补充说明（2026-10-11）

本目录的 `pre/` 是「句级记忆切分」**首次施工前**（提交 `1137ed3` 之前）的快照。

首次提交后，用户要求"再仔细排查一遍"，复核中发现 3 处问题并修复
（详见 `docs/_active/spec/SPEC_句级记忆切分_2026-10-11.md` §11.6）：

1. 关键词路候选池未与向量路同步放大（配套遗漏）；
2. 同批记忆排序键只有时间、不含 id（句级放大后 12 句话会乱序注入）；
3. STM 补位量按"一条消息一条记忆"估算，实测被排除集吃光（既有缺陷，句级放大缺口）。

涉及文件：

- `backend/app/memory_module/config.py`
- `backend/app/memory_module/retriever.py`
- `backend/tests/test_memory_exclude_recent.py`

## ⚠️ 回退基线说明

**复核阶段的回退基线是提交 `1137ed3`，不是本目录的 `pre/`。**
用 `pre/` 回退会把首次施工的改动一起抹掉。只回退复核改动：

```bash
git checkout 1137ed3 -- backend/app/memory_module/config.py \
    backend/app/memory_module/retriever.py \
    backend/tests/test_memory_exclude_recent.py
```

本文件为**新增**说明，未改动原 `BACKUP_INFO.md`（仓库规范：存量备份只增不改）。
