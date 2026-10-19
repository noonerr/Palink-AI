# BACKUP_INFO — 2026-10-19_包U中断现场

## ① 备份日期
2026-10-19（约 16:2x，Git Bash 实测）。

## ② 原始来源路径
仓库 `D:\项目\Palink-AI`，分支 `three-tracks-merge-20261012`，备份时点 **HEAD = `696aa79`**。
备份的是**当时工作区里未提交的后端在途改动**（包U）：

- `tracked-backend-wip.patch` —— `git diff -- backend/`，580 行，覆盖 7 个已跟踪文件：
  `app/api/websocket.py`（108 行，最大）、`app/api/chat.py`、`app/api/character_ext.py`、
  `app/services/mvu_engine.py`、`app/services/status_bar_detector.py`、`app/utils.py`、
  `tests/test_mvu_sse_wiring.py`。
- `untracked/backend/app/services/assistant_reply_persist.py` —— 本包的核心交付物（"解析→剥离→落库"统一出口）。
- `untracked/backend/tests/test_mvu_persist_exit.py` —— 按落库路径覆盖的断言测试。

⛔ **不含前端**：同一时刻 `frontend/src/lib/sillytavern/formatting.ts`（+22）与
`frontend/src/utils/__tests__/display-pipeline-script-integrity.test.ts`（新文件）也是未提交状态，
但它们属于**并行在跑的包T**，不是本包的现场，故**未纳入本备份、也不允许接手者回退**。

## ③ 备份原因
执行包U（助手回复落库路径统一"解析→剥离"）的子 agent 在 **150 轮上限被强制中断**，
最后一句是 "Found a second, real defect. Let me fix it" ⇒ **改动量大（580 行）但未跑全量门禁、一笔未提交、未写报告**。
中断前它还发现"第二个真缺陷"，但没有留下任何书面记录，接手者需要在 diff 里把它找出来。
主控实测其目标测试在容器内 **96 passed**（`test_mvu_persist_exit.py` + `test_mvu_sse_wiring.py` +
`test_mvu_variable_block_aliases.py`），主体是健康的，属"差收尾"而非"写坏了要重来"。

## ④ 后续待办清单
1. 接手者（`pkg-u2`）按序做：① 逐文件判定"已完成/半截/没做"；② 从 diff 里找出"第二个真缺陷"（找不到就如实写"未能确定"，不许编）；
   ③ 跑 `bash scripts/gate.sh backend` 全量，**只认 failed=0 且 errors=0**；④ 补齐"每条落库路径都有断言"的覆盖；
   ⑤ 反证一次（改回手抄 strip 必红、还原必绿）；⑥ 分两笔 `git commit -o -- backend/...`。
2. **禁止碰 `frontend/`**（包T 的在途改动在里面），也禁止 `git add -A` 把两者混提。
3. 后端代码烤进镜像、无 `--reload` ⇒ 接手者 `docker cp` 只影响运行容器，**必须 `docker compose build backend && up -d backend` 才上线**，
   这一步归主控做，做完回生产端口复跑：真实回复落库正文不得含 `<UpdateVariable>` 及别名块。
4. 包Q 报告的剩余项 R3（前端识别面）/R4（记忆入库清洗不认别名，高优先）/R5（状态栏与格式说明探测）/R6（Analysis 抢先兜底）
   的完成状态要在接手报告里区分"已做/仅登记"，别当成全部已闭环。
5. 本批改动进主干后，本目录降级为隔离/清理候选（走 `_QUARANTINE_<日期>`，禁直删）。
6. 备注：本目录的说明文件**首次不需要 `git add -f`** —— 2026-10-19 已修 `.gitignore` 里
   `_BACKUPS/` 目录级排除使 allowlist 失效的自相矛盾（见提交 `696aa79`）。
