# 包AA 中断现场（2026-10-20）

## ① 备份日期

2026-10-20 01:31。

## ② 原始来源路径与逐文件归属

工作区 `D:\项目\Palink-AI`，子 agent **pkg-AA**（任务书
`docs/_active/HANDOFF_提示词_紧要批次甲类第一批与三项小收尾_2026-10-19.md` §1 的 A/B/C 三件）
**被中断时未提交**的全部改动：

| 备份内文件 | 原相对路径 | 归属 / 当时状态 |
|---|---|---|
| `aa-uncommitted.patch` | `git diff --` 下列四文件（24,764 字节） | 包AA 全部在途源码改动 |
| `runtime-body/part-07.ts` | `frontend/src/components/ui/custom/smart-card-runtime/runtime-body/part-07.ts` | A（别名进表的帧内半边）+ C（宏成员键） |
| `slash-engine/st-command-catalog.ts` | `frontend/src/lib/slash-engine/st-command-catalog.ts` | A 的 176 条 alias→base 表 |
| `slash-engine/st-compat-commands.ts` | `frontend/src/lib/slash-engine/st-compat-commands.ts` | B（listvar 缺省改 ST） |
| `controller/SmartCardCompatController.ts` | `frontend/src/components/ui/custom/smart-card-runtime/SmartCardCompatController.ts` | A 的宿主下发（names + aliases） |
| `probe/` | `.tmp_probe/AA/` 全份（7 个文件：对账脚本、`alias_map.json`、`reconcile_out.txt` 等） | 包AA 的对账产物，**不入库**，只作可复核原料 |

同期工作区里 `.workbuddy-ai/**` 属另一会话，未纳入本备份也不许动。

## ③ 备份原因

pkg-AA 最后一次写文件是 01:17，此后 14 分钟无动静、无提交；界面显示其回复被终止。
主控实测当时工作区**处于编译不过的状态**：它在模板字符串 `part-07.ts` 的**注释里写了反引号**
（677、1019、1020 行），那段大字符串以反引号为界 ⇒ 注释里的反引号把字符串提前掐断，
`npx tsc --noEmit` 报 5 个 TS1005。也就是说：**如果现场没被固化，随后一次清理或回退就会把
A/B/C 三件事的源码全部丢掉，而且没人知道它坏在哪一行。**

## ④ 后续待办清单

- [x] 主控把那三行注释里的反引号换成单引号（只改注释文字，不动逻辑），`tsc` 恢复干净。
- [x] 主控用门禁量出缺口：`tsc` 绿、vitest 3 文件 6 条红，全部是"源码改了、测试与记账未跟上"，
      不是功能写坏 ⇒ 派收尾者 pkg-AA2（现场 + 6 条红清单 + 两处守卫改判的裁决与依据一并交给它）。
- [x] pkg-AA2 交回五笔（`8ac5568` / `fe11053` / `e40aa65` / `121836d` / `68ad9eb`），主控独立复跑
      `gate.sh frontend` rc=0（101 文件全绿）并复核别名条数（fixture 一手数到 **176**，与实现一致）。
- [x] 已上线（见同目录 `_BACKUPS/2026-10-20_dist_包AA上线重建前/`）。
- [ ] 收尾者自报"用 `git apply --cached` 按 hunk 把 `part-07.ts` 拆进 A 与 C 两笔"——主控已复看
      两笔的文件清单与内容，**后续若 `part-07.ts` 出问题要记得它曾被按 hunk 拆过两笔**。
- [ ] 本目录只作留档。回退**禁止**整包 `git apply -R`（同一文件后来还有两笔提交），
      需要回到中断态请逐文件从本目录拷回。

## 附带教训（已回写记忆）

给下游的禁令写在提示词里**不等于**它会生效：本例中"模板串注释里不许出现反引号"这条
主控已明写，pkg-AA 仍踩，且因为它没跑门禁就中断，禁令没有任何拦截力。
⇒ 真正的拦截只能是**主控自己复跑 tsc/parse-guard**，以及把"注释里不许反引号"下沉成自动化守卫
（下一步可做：给 `runtime-body/part-*.ts` 加一条"模板串区域内禁止出现第三个反引号"的字面量检查）。
