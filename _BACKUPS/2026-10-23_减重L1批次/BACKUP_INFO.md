# BACKUP_INFO

## ① 备份日期

2026-10-23（10:41 前后，Git Bash）

## ② 原始来源路径

`D:\项目\Palink-AI\`（工作区，未提交状态；基线 commit 见 `_manifest.tsv` 同级的 `baseline_sha.txt`，如无则为工作区当前 HEAD）

备份内容：`pre/` 下按**原相对路径**保存的 35 个文件，均为「减重 L1 批次」计划改动的目标文件：

```
backend/app/models/base.py
backend/app/models/*.py            （20 个含 utc_now 定义的模型文件）
backend/app/utils.py
backend/app/api/connection_profiles.py
backend/app/api/extension_prompts.py
backend/app/api/prompt_manager.py
backend/app/api/plotline.py
backend/app/api/regex_scripts.py
backend/app/api/personas.py
backend/app/api/worldbook.py
backend/app/api/st_groups.py
backend/app/api/silly_tavern.py
backend/app/services/preset_overlay.py
backend/app/services/st_sync_service.py
frontend/src/components/ui/custom/CodeBlock.tsx
frontend/src/lib/worldbook/scanner.ts
```

校验：`_manifest.tsv` 为 `sha256<TAB>相对路径`，35 行，可用
`cd pre && sha256sum -c ../_manifest.tsv`（需先转成 `sha256  path` 格式）或逐行比对。

## ③ 备份原因

执行「项目减重」L1 批次（计划见 `docs/_active/PLAN_项目减重_2026-10-23.md`，实现细节见
`docs/_active/IMPL_项目减重_2026-10-23.md`）。本批做的是**函数级去重**，会改动 30+ 个后端文件的
import 与少量前端文件；虽为低风险，但涉及模型默认值与上传读取等主链路，按仓库规范先落 pre 快照。

**核验中已纠正 4 处方案错误**（详见 `docs/_active/PLAN_项目减重_2026-10-23.md` 的「§6 核验订正」）：

1. `_safe_json_loads` 四份**语义不等价**（plugins 强制 dict、silly_tavern 把 `"null"` 转 fallback），
   只合并 st_groups 与 st_sync 两份逐字相同的。
2. `api/models.py` 走 `get_flat_model_list()`（统一模型表 + 展示层覆盖），与 ST 面
   `_public_models` 的 `get_providers()` 拼装**不是同一份计算** ⇒ 原 L1-4 取消。
3. 三份 `getByPath` **语义不同**（part-a 支持 `[key]` 方括号语法 + `hasOwnProperty`；
   part-01 遇 `null` 即回退；inline 只认 `undefined`）⇒ 原 L1-6 取消。
4. `stream_builder._estimate_tokens` 的回退值会写进 `msg.tokens` 并显示在消息列表
   ⇒ 改公式属用户可见变化，原 L1-7 降级为 L2 待决。

## ④ 后续待办清单

- [ ] 按 PLAN §6 订正后的范围实施：L1-1（utc_now 30→1）、L1-2（safe_json 2→1）、
      L1-3（删 `_st_read_upload`）、L1-5（仅 CodeBlock 的 escapeHtml）、L1-8（worldbook 同函数）。
- [ ] 门禁：`cd backend && py -3 -m pytest tests/ -q`（认 `failed = 0`）、
      `cd frontend && npx tsc --noEmit` + `npx vitest run`。
- [ ] 真机基线：露缇雅1.2 `c28061bb-a9b7-46a9-a255-2692d57001fc`，7 帧、getContext 194 键不变。
- [ ] 待决（需产品拍板，勿擅自改）：
      - L2-1 默认模型对齐（会改变原生导入链路选的模型）
      - L2-2 ST 面认证是否补滑动续期
      - L2-3 SSE 收口（会新拿到原本被丢弃的 `data:` 事件）
      - L2-4 错误文案合并（需逐条比对措辞）
      - L2-5（原 L1-7）token 估算公式改校准值（会改 `msg.tokens` 显示）
- [ ] 回滚：`cp -rp pre/. ../../../` 逐文件覆盖，或 `git checkout -- <path>`（本批改动均已入库时）。

⚠️ 本备份**不得删除或改写**；如需补说明请新增文件。
