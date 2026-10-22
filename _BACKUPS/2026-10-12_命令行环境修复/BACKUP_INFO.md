# BACKUP_INFO — 2026-10-12 命令行环境修复

## ① 备份日期
2026-10-12

## ② 原始来源路径
- 注册表键：`HKEY_CURRENT_USER\Environment` 的 `Path` 值（类型 `REG_EXPAND_SZ`）
- 关联只读来源（**本次未改动**）：`HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Session Manager\Environment\Path`

## ③ 备份原因
体检发现 HKLM 的系统 Path 被存成 `REG_SZ`（应为 `REG_EXPAND_SZ`），导致其中
`%SystemRoot%\System32\WindowsPowerShell\v1.0\` 与 `%SystemRoot%\System32\OpenSSH\`
两条条目**永不展开** —— 整机所有进程（含 cmd）按名字都调不到 `powershell`，
这是各 agent 在本机反复误用 PowerShell、调用失败重试的根因。

因修 HKLM 需管理员权限且风险面大，本次只做**用户级追加**（不改 HKLM），
故先把 HKCU Path 原值落盘，保留一键回退能力。

## ④ 后续待办清单
- [ ] **重启 agent 应用**（Qoder / Codex / Claude Code / TRAE）后验证：`powershell -NoProfile -Command $PSVersionTable` 与 `pwsh -v` 能按名调用。
      环境变量在进程启动时快照，不重启不生效。
- [ ] HKLM 那条 `REG_SZ` 病根仍在。如要根治（改类型为 `REG_EXPAND_SZ` 或写成绝对路径），
      需管理员权限，且**必须**先导出 `HKLM\...\Session Manager\Environment` 整个键再动。
- [ ] `%INTEL_DEV_REDIST%redist\intel64_win\compiler` 同样是未展开死条目，
      若本机 Intel 编译器已不用，可从 HKLM Path 清掉（同批备份）。
- [ ] 若 PowerShell 7 安装失败或用户不再需要，回退命令：
      `winget uninstall --id Microsoft.PowerShell`
- [ ] 本机 PATH 全量回退：
      `reg.exe add "HKCU\Environment" /v Path /t REG_EXPAND_SZ /d "<hkcu-path-orig.txt 内容>" /f`
      （执行前 `export MSYS_NO_PATHCONV=1`）

## 本目录文件
| 文件 | 用途 |
|---|---|
| `hkcu-path-orig.txt` | 修复前的 HKCU Path 原值（单行，逐字） |
| `hkcu-path-new.txt` | 修复后写入的值 |
| `fix_user_path.sh` | 实际执行的修复脚本（幂等：已存在则跳过） |
