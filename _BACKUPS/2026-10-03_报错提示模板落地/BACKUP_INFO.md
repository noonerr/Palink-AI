# BACKUP_INFO

## ① 备份日期
2026-10-03

## ② 原始来源路径
`D:\项目\Palink-AI\` 下 23 个文件，`pre/` 目录按原相对路径摆放，附 `_manifest.tsv`（sha256 逐文件校验，23/23 一致）：

**前端（20）**
- `frontend/src/App.tsx`（Toaster 挂载点）
- `frontend/src/components/ui/custom/ErrorToast.tsx`
- `frontend/src/components/ui/custom/NetworkStatus.tsx`
- `frontend/src/components/ui/custom/ErrorBoundary.tsx`
- `frontend/src/components/ui/custom/InlineCardRenderer.tsx`
- `frontend/src/components/views/character/CharacterChat.tsx`
- `frontend/src/hooks/useCharacterChat.ts`
- `frontend/src/hooks/useChatView/index.ts`
- `frontend/src/lib/errorHandler.ts`
- `frontend/src/lib/error-handler/index.ts`
- `frontend/src/components/ui/alert.tsx`
- `frontend/src/index.css`
- `frontend/src/types/index.ts`
- `frontend/eslint.config.js`
- `frontend/src/utils/sillyTavernPluginRuntime.ts`
- `frontend/src/lib/sillytavern/getContext.ts`
- `frontend/src/lib/plugin-system/sandbox.ts`

**后端（3）**
- `backend/app/api/character_ext.py`
- `backend/app/api/websocket.py`
- `backend/app/services/character_message_builder.py`

**文档原型（3）**
- `docs/报错提示系统重写_手机端UI原型_2026-09-30.html`（原件，禁止改动）
- `docs/报错提示系统重写_手机端UI原型_v2_2026-10-02.html`
- `docs/报错提示系统UI设计原型_2026-10-03.html`

**工作区快照**：`git stash create` 快照 sha `b570f1428bd9030869f397625b9aca598f070ad1`，
已 `git tag -f snapshot-pre-error-notify-20261003` 固化为 tag（基线 HEAD = `d153009`，分支 `st-plugin-compat-20260727`）。
恢复命令：`git stash apply b570f14` 或 `git checkout snapshot-pre-error-notify-20261003 -- <path>`。
（不跑 `git stash push -u`：本环境已知会因含大目录被进程级监控 SIGKILL 并损坏 `.git`。）

## ③ 备份原因
执行 `docs/PROMPT_报错提示模板落地_2026-10-03.md`（及其上游权威件 `docs/PROMPT_报错提示系统重写_2026-09-30.md`）
的「报错提示系统重写」批次动工前备份。改动面横跨前端提示通道（sonner / ErrorToast / NetworkStatus / 内联报错卡）
与后端 SSE 落库守卫（`is_error_only()`），属高爆半径批次，故先留物理回滚点。

## ④ 后续待办清单
1. **阶段一**：按 PROMPT §3 复制 `报错提示系统重写_手机端UI原型_2026-09-30.html` 为
   `报错提示系统重写_手机端UI原型_Palink风格_2026-10-03.html` 并换皮（色温/字体/字号/blur/圆角/图标），
   原件不得改。交付前必须无头渲染截图自检。
2. **阶段二 · 批 1 止血**：1.1 Toaster 加 offset+closeButton；1.2 NetworkStatus 顶部避让；
   1.3 底部错误卡按 D2 结论处理；1.4 超时条降级；1.5 失败消息改 `extra.ignore` 节点并统一两个聊天页模板；
   1.6 后端 SSE 轨补 `is_error_only()` 守卫。
3. **阶段二 · 批 2 归一**：2.1 新建 `lib/notify.ts` 唯一入口 + ESLint `no-restricted-imports` 挡新增裸 sonner import；
   2.2 合并两套错误模型；2.3 插件 toastr 三出口归一；2.4 内联红字对比度修复。
4. **待用户决策的冲突点**（PROMPT §7.4 要求显式提出，不得静默按自己判断改）：
   - 10-03 落地文档 §1 K1 要求「报错卡内联在消息流，不许改成浮层」，
     而 09-30 权威件 §3 D2 推荐 (b) 顶部常驻，且 `docs/报错提示系统UI设计原型_2026-10-03.html` 已按 (b) 出图 —— 二者冲突。
   - 后端 1.6(c) 动 `character_message_builder.py` 前需先跑 SQL 量影响面（`branch_id IS NULL` 占比 / 现存 `Error:` 行数 /
     正文尾部带 `[...]` 后缀的行数），SQL 须由用户在容器内执行，本机不直连生产库。
5. **未做**：`frontend/dist` 未备份也未改动（bind mount 在用产物，红线区）。

## 红线遵守声明
- 未删除或改写任何存量备份；未触碰 `frontend/dist`、`backend/data`、根级 `图片/`、`记忆/`、`*.mp4`、各 agent 配置目录。
- 暂存/提交一律逐项 pathspec，禁止 `git add -A`。
