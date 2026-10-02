# BACKUP_INFO

## ① 备份日期
2026-10-02

## ② 原始来源路径
| 备份内相对路径 | 原始绝对路径 | sha256 |
|---|---|---|
| `pre/backend/app/services/roleplay_prompt_assembly.py` | `D:\项目\Palink-AI\backend\app\services\roleplay_prompt_assembly.py` | `6d5ca893739e12e9e4d52e84ee7088b39ecb2be29d8a02b12b5e5765a39bc8f7` |
| `pre/backend/tests/test_bubble_injection_gate.py` | `D:\项目\Palink-AI\backend\tests\test_bubble_injection_gate.py` | `58d20b16bd68b38f4370d861a6e0bbd83ad79774fa03b32cc12f98230ced3af5` |
| `pre/backend/tests/test_bubble_single_layer_downgrade.py` | `D:\项目\Palink-AI\backend\tests\test_bubble_single_layer_downgrade.py` | `a72851f32ad3c9154617467690f3dc51eaac0d3ca016978a643d3bdd32cc9c76` |

- 仓库基线：`git rev-parse --short HEAD` = `d84a758`（工作区在途态，非干净树；本批只碰上述 3 个文件）
- 备份方式：`cp` 物理拷贝（未做 stash；与并行会话的在途改动无交集）

## ③ 备份原因
「格式规范注入残本修复 + A/B 重测」批次动工前留档。
对应文档 `docs/PROMPT_接手批_格式规范残本与A_B重测_2026-10-02.md`。
本批要改 `_strip_bubble_marker_instructions` 的段落丢弃判据（标题字面量 → 内容判定）、
新增 `PALINK_BUBBLE_LEGACY_SECTION_STRIP` 调试开关、给
`extra.ext_prompts.applied` 补 `chars_reported` / `chars_injected` / `dropped_sections` 三项证据。

## ④ 后续待办清单
1. 施工：按上述三项改 `roleplay_prompt_assembly.py`（含 `_strip_bubble_marker_instructions` 重写、
   `_strip_bubble_marker_instructions_detailed` 新增、`_downgrade_bubble_injections` /
   `_collect_extension_prompts` 加可选出参、证据字段扩展）。
2. 测试：更新 `test_bubble_injection_gate.py::TestStripBubbleSection` 中两条「按标题删」断言、
   `test_bubble_single_layer_downgrade.py::test_bubble_sections_removed`；新增「段内含非 @bubble 行不得整吞」回归。
3. 门禁：`docker compose build backend && up -d` 后跑整条 `pytest tests/ -q`；前端 `npx tsc --noEmit`、`npx vitest run` failed=0。**不重建前端 dist。**
4. A/B：改出采样脚本（A=修好、B=设调试开关），去掉 400 字符提前 break；每次输出喂卡「正文美化」真正则，只输出命中次数与成对外壳率。
5. 结论落 `TODOS.md`；若 A 组也跳壳再议 P3 预填。

## ⚠️ 复核中确认的偏差（照抄文档会带偏）
- 文档 §3 所述 DB 行 `source_key='fnv1a-v71-selftest'` / `content` 752 字符 **已过期**：
  当前实为 `source_key='fnv1a-pggfwp'` / `content` **1796** 字符（该卡在文档成稿后被重新导入，真实哈希替换了自测行）。
- 由此文档中的 `752 → 265 → 237`（31.5%）全部作废；容器内实跑真实函数得 **1796 → 413 → 385**（到场 **21.4%**）。

## 恢复方式
```
cd /d/项目/Palink-AI
cp "_BACKUPS/2026-10-02_格式规范残本修复/pre/backend/app/services/roleplay_prompt_assembly.py" backend/app/services/
cp "_BACKUPS/2026-10-02_格式规范残本修复/pre/backend/tests/test_bubble_injection_gate.py" backend/tests/
cp "_BACKUPS/2026-10-02_格式规范残本修复/pre/backend/tests/test_bubble_single_layer_downgrade.py" backend/tests/
```
（恢复后 app/ 侧改动需 `docker compose build backend && docker compose up -d backend` 才进容器）
