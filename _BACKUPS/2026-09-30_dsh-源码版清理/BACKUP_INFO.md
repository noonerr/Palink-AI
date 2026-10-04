# BACKUP_INFO — dsh 源码版清理前备份

## ① 备份日期

2026-09-30

## ② 原始来源路径

| 备份内子目录 | 原始来源 | 说明 |
|---|---|---|
| `launcher-scripts/` | `D:\app\tool\` 下 7 个散装文件 | `dsh-run.js`、`dsh-run.js.bak-pre-singleinstance`、`dsh-web.log`、`fs-breakdown-shim.cjs`、`gh-tree.cjs`、`start-dsh.bat`、`wrap-better-sidebar.js` |
| `repo-local-patches/` | `D:\app\tool\deepseek-harness\` 内本地新增/改动 | 自制构建与重启脚本 4 个 + 日志 + 仓内 `.npmrc`（`safe-delete=false`）+ 被改过的 `pnpm-workspace.yaml`（含 upstream 原件与 diff） |
| `desktop/` | `C:\Users\Pall\OneDrive\桌面\` | `DeepSeek Harness (dsh).vbs`、`Stop DeepSeek Harness (dsh).bat`、`DSH 启用侧边栏(better-sidebar).bat` |
| `dot-dsh/` | `C:\Users\Pall\.dsh\` | 用户数据：`settings.yaml`（模型服务商配置）、`.credentials.yaml`、`cordis.patch.yml`、`sessions/`（2 个会话 9.1M）、`profiles/web/` 配置文件与其 4 个 `_backup_pre-*`、`profiles/node_modules` |
| `npm-global-config/` | `C:\Users\Pall\.npmrc` | 2026-08-14 18:38 装 dsh 时被加入 `safe-delete=never` 一行 |

**未备份（可从网上重新获取，删了不心疼）**：
`D:\app\tool\deepseek-harness`（1.6G，node_modules 1.1G）、`pnpm-store`（134M）、`_npmtest`（34M）、`dsh-ads-src`（85K）、`.dsh\profiles\web\node_modules`（383M）。
被删源码仓的身份已记录在此，需要时按此重建：远端 `https://github.com/deepseek-ai/deepseek-harness.git`，分支 `master`，HEAD **47f943859bef60e4160492346772ded9b24f765a**（2026-08-13，Merge PR #2519 feat/npm-public），`package.json` 版本 **0.1.0-rc.5**。tracked 文件仅 `pnpm-workspace.yaml` 一处改动（其余全是 untracked 本地脚本与构建产物）。

完整文件级校验：见同目录 `_manifest.tsv`（170 行，sha256 + 备份内相对路径 + 原始绝对路径；路径写成 Git Bash 风格 `/c/...`、`/d/...`）。

## ③ 备份原因

用户要把本地这套 **dsh（DeepSeek Harness）** 换掉。现状不是官方发行版，而是此前由 WorkBuddy 从 GitHub 克隆源码、用 Node 直接跑起来并打了本地补丁的版本：

- 启动链：桌面 `DeepSeek Harness (dsh).vbs` → `dsh-run.js`（`NODE_OPTIONS=--require fs-breakdown-shim.cjs`）→ `apps/cli/src/bin.ts web` → 监听 127.0.0.1:3080；另有 `start-dsh.bat` 走 WorkBuddy 自带的 Node 22.22.2。
- 本地改造：`wrap-better-sidebar.js` + `.dsh-build-better-sidebar.mjs` 侧边栏插件、`.dsh-restart*.cjs` 重启脚本、`pnpm-workspace.yaml` 关掉 pnpm `safe-delete`（沙箱回收站失败）。
- 官方渠道核对结果：GitHub **无 release**（API 返回 404），npm `@deepseek-ai/dsh` dist-tags `latest = 0.2.0-rc.2`、`alpha = 0.1.7-alpha.2` —— 即官方目前也只发 rc，且本地这份落后约 6 周。

用户确认的删除范围包含源码本体、包缓存、自制脚本、桌面启动器、`~/.dsh` 全部（账号配置与会话也一并清掉，全新开始）。其中**自制脚本与用户配置/会话不可再生**，故先物理备份再删。

## ④ 后续待办清单

1. **官方版落地**（用户自行执行，本次未代装）：`npm i -g @deepseek-ai/dsh`，装到 `C:\Users\Pall\AppData\Roaming\npm`（已在 PATH），系统 Node v25.2.1 满足 `engines: ^22.19.0 || >=24.0.0`。装完核对 `dsh -v` 是否 0.2.0-rc.2。
2. **全新开始的后果**：`~/.dsh` 已清空 → 需重新登录、重配模型服务商。若不想重来，从本备份 `dot-dsh/settings.yaml` + `.credentials.yaml` + `cordis.patch.yml` + `sessions/` 拷回即可（拷回前先确认官方版配置格式未变，rc 版之间字段可能漂移）。
3. **侧边栏功能**：官方 npm 包不含本仓自制的 better-sidebar。若官方版仍缺该能力，用 `repo-local-patches/` + `launcher-scripts/wrap-better-sidebar.js` 在新环境重做；注意 `.dsh-build-better-sidebar.mjs` 是按源码仓路径写的，需改路径。
4. **`~/.npmrc` 的 `safe-delete=never`**：本次未改动（仅原件入备份）。该行现会让每条 npm 命令报 `Unknown user config "safe-delete"` 警告；确认官方版不再需要后可删该行，恢复方式见 `npm-global-config/home-npmrc`。
5. **有意保留、未删**：`C:\Users\Pall\.workbuddy\binaries\node\versions\22.22.2-3`（341M）—— 09-25 被 WorkBuddy 重新解压刷新过，属其他 agent 在用运行时，不是 dsh 残留；用户如仍要清，需先确认 WorkBuddy 侧无依赖。
6. 清理后需复查的残留引用（无害，仅记录）：`C:\Users\Pall\.workbuddy\artifact-index\*.json`、`.workbuddy\audit-log\2026-08-1{4,5,6}.jsonl`、`C:\Users\Pall\WorkBuddy\2026-08-14-21-32-15\` 下的 4 个 dsh 安装脚本与《DSH插件安装指南.md》——这些是另一 agent 的历史日志，**本次未动**。
