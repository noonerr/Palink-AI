# BACKUP_INFO

> ⚠️ **本说明为 2026-10-03 补写**（原备份未留说明，按 AGENTS.md 第 2 条本应属无效备份）。
> **补写时未改动本目录内任何原有文件**，内容零改动，仅新增本文件。
> ①②④ 三项中凡标注「据内容推断」者，均为原记录已佚后的还原，非原始记录。

## ① 备份日期

**2026-09-30**（据目录名）

## ② 原始来源路径

| 备份内相对路径 | 原始绝对路径 | sha256 |
|---|---|---|
| `frontend/security-headers.conf` | `D:\项目\Palink-AI\frontend\security-headers.conf`（**据内容推断**：路径层级 `frontend/` + 文件名 `security-headers.conf`） | `b26c94624b9b045415c2d7e706839c8e009c86ae7fbedc82febc549743418ed1` |

- 原始来源路径**未能确证**：原备份未留记录。
  后续若 nginx 配置有疑问，用本文件而非推断路径作对照。

## ③ 备份原因

**据内容推断**：nginx 安全响应头配置（CSP 等）改动前的留档。

对应线索：本目录名 `plugininject-csp改前` 表明与
「插件注入 + CSP 放宽」这批施工有关。同批次另有
`2026-09-30_plugininject-注入断点修复前`、`2026-09-30_plugininject-dist重build前`
两个备份目录（两者**均已登记台账且有说明书**），本目录夹在二者之间，
时间线上属于同一批施工的中间留档。

⚠️ **关联未确证**：`TODOS.md` 全文检索 `csp改前` / `plugininject-csp` **零命中**，
即该批次的施工记录未写进待办文件。相关背景见
`docs/PROMPT_卡脚本本地存储按角色与账号隔离_2026-10-02.md` 与
`TODOS.md` 中「插件注入」系列条目（但均未点名本备份）。

## ④ 后续待办清单

1. **原始来源路径待查**：`frontend/security-headers.conf` 为推断值。
2. **CSP 现状口径以代码为准**：AGENTS.md 与多份文档记载「页面 CSP 含 `unsafe-inline` +
   `unsafe-eval`，`connect-src` 放通任意 https/wss/ws/http」，且**登记为刻意不动**。
   若将来要收紧 CSP，**必须先比对本备份**——它是改动前的原始状态。
3. **本批施工记录缺失**：`plugininject` 批的 SPEC/复核文档未在 `docs/` 与 `TODOS.md` 中找到，
   若要追溯该批做了什么，需从 git 历史 + 另两个同批备份反推。
