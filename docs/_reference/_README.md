# docs/_reference —— 长期参考文档

> 建立日期：2026-10-05 ｜ 建立者：文档治理（图书管理员角色）
> 与 `docs/_archive/` 的区别：这里的东西**不过期**，是随时可能需要查的常备资料。

## 收容判据

同时满足：① 内容描述的是**长期有效的配置/契约/用法**，不是某次施工的记录；
② 零入链（搬动不会断链）。其余进 `_archive/`。

## 目录内容

| 文件 | 内容 | 备注 |
|---|---|---|
| `SEARXNG_GUIDE.md` / `SEARXNG_ANTI_BAN.md` | SearXNG 代理部署与反封禁 | 本仓有 `searxng-proxy/` 实目录，文档与之对应 |
| `prompt_config_guide.md` | 提示词配置文件位置与用法 | 353 行，长期有效 |
| `prompts_zh.md` | 提示词中文文档 | 290 行 |
| `CASDOOR_INTEGRATION_PRD.md` / `_CHECKLIST.md` / `_TECHNICAL_ARCHITECTURE.md` | Casdoor 统一认证集成 | ⚠️ **三份都是 PRD 阶段产物，是否已实施未验证**；本仓现有登录走自建方案，用前先确认 |

## 纪律

- 同样**只进不出**。
- 内容若被证明已过期（比如 Casdoor 最终没上），移入 `_archive/2026-10/`，不要就地删。