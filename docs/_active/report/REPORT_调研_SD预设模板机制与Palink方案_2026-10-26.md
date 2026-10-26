# 调研：SD 预设模板机制与 Palink 空模板库方案
> 状态：已完工待审读（只读查验·2026-10-26）

## 背景

主脑任务 T8：Palink 的预设模板库（context / instruct / sysprompt / reasoning 相关表）据称全空（导入器没做），直接搬 SillyTavern（下称 ST）的文本有版权顾虑。用户指示：看看 Stable Diffusion WebUI（下称 SD/A1111）是怎么做的，据此给 Palink 出方案。

本报告做了三件事：① 核实 SD WebUI 与 ComfyUI 的出厂模板/预设机制；② **就地订正任务前提**（本地实测发现模板库并非全空）；③ 给出 Palink 的自带模板 + 导入导出方案与落地清单。

## 方法

- **本地代码**：Read / grep 核对 `backend/app/models`、`backend/app/core/*_seeds.py`、`backend/app/api/presets.py`、`backend/app/api/prompt_manager.py`、前端 `PresetManager.tsx` / `RoleplayEngineTab.tsx`。
- **本地数据**：对运行中的 `palink-ai-db-1`（pgvector/pgvector:pg15，库 `ai_hub`）执行 `docker exec palink-ai-db-1 psql -U ai_user -d ai_hub -t -A -c "SELECT ..."`（**纯 SELECT 只读**，无外部输入拼接，符合参数绑定纪律）。
- **ST 参照树**：`_reference/sillytavern-1.18.0/` 在场（注意：该拷贝被裁剪，`default/content` 与 `data/default-user` 不在，见发现 4）。
- **网络**：WebSearch 可用；**WebFetch 在本机全部失败**（`unable to verify the first certificate`，github.com 与 raw.githubusercontent.com 均如此；`curl` 亦 http_code=000），因此**无法直接打开 GitHub 页面/文件核对**，网面结论以搜索摘要为据并在文中标注。网络面没有跑通的部分如实标注。

## 发现

### 1. 前提订正：Palink 模板库并非「全空」（实测，重要）

任务前提「context / instruct / sysprompt / reasoning 相关表全空」**与实测不符**。DB 实测（2026-10-26，命令见方法节）：

```
context_templates|4
instruct_templates|17
prompt_presets|0
generation_presets|27
```

- `context_templates` 4 行，全部 `is_builtin=t`（Default / Classic / ChatCompletion / Instruct），来自启动播种 `backend/app/main.py:93-111` + 种子文件 `backend/app/core/context_template_seeds.py:18-75`。
- `instruct_templates` 17 行 = 5 行系统预置（user_id 为空：Llama 2 / Llama 3 / Mistral / ChatML(默认) / Alpaca，`backend/app/core/instruct_template_seeds.py:20-106`）+ 12 行 user_id=4 的 `TestInstruct` 测试行。
- `generation_presets` 27 行 = 各用户的「平衡/自由/严谨」三件套（`backend/app/api/presets.py:298-333` 的 ensure-defaults）。
- **真正空的是 `prompt_presets`（0 行）**，模型见 `backend/app/models/prompt_preset.py:5-23`。
- **sysprompt / reasoning 没有专表**：全 models 目录 grep `sysprompt|reasoning` 无表命中；两者以 `power_user` JSON 键存在（`backend/app/services/st_power_user_defaults.py:201-218`：`sysprompt.content=""`、`reasoning.prefix="<think>"`）。

即：**已内置的都是「结构/格式」模板**（story_string 占位符、API 序列分隔符），**空的是「内容型」预设**（完整提示词预设、系统提示词文案、推理模板文案）。方案应按这个口径定覆盖面（→ 待主脑裁定 ①）。

### 2. SD WebUI（A1111）的 styles 机制

> 以下为 WebSearch 摘要所得（未能直接开页核对，本机 TLS 拦截）；置信度按来源标注。

- **存储格式**：安装根目录 `styles.csv`，最多 3 列：`name, prompt, negative_prompt`。样式 = 选中后**追加**到正向/负向提示词的文本片段，**不含**采样器/CLIP skip 等参数。来源：[issue #14122](https://github.com/AUTOMATIC1111/stable-diffusion-webui/issues/14122)、promptus.ai 指南。
- **出厂形态：空（或缺失）**。全新安装可能连文件都没有，启动日志报 `Style database not found` 警告但不影响使用；保存第一个样式时才自动创建。来源：[issue #14863](https://github.com/AUTOMATIC1111/stable-diffusion-webui/issues/14863)、[Reddit "styles.csv not found"](https://www.reddit.com/r/StableDiffusion/comments/18opvsi/stablediffusion_getting_stylescsv_not_found_error)、stable-diffusion-art.com 入门指南。**即 A1111 的答案是「零内置 + 自助保存」，不附带任何样式包。**
- **导入导出与社区分享**：经典版 A1111 没有应用内导入第三方样式包的入口，社区惯例是**整包 `styles.csv` 文件下载后替换/放进根目录**（GitHub / Reddit / Civitai 分发，如 [#10129 讨论的高质量样式合集](https://github.com/AUTOMATIC1111/stable-diffusion-webui/discussions/10129)、promptus.ai 收录页）。
- **官方为什么不内置第三方内容**：**没有找到官方声明明说"因为版权"——此条是推断，非事实**。最接近的硬证据是 #10129：样式合集整理者自述**"不得不移除一些样式，因为它们不被 GPL 许可证覆盖"**（prompt 文本的署名/许可状态模糊，把社区 prompt 打包进 GPL 仓库有法律与署名摩擦）。生态已形成"作者单独分发、用户自行放入"的规范，正好绕开了这个风险。

### 3. 对照：ComfyUI 的内置工作流模板

> 同为 WebSearch 摘要；模板总数未能核验（bundles.json 内容不在搜索摘要里）。

- **出厂自带一套内置模板库**：新前端有「Workflow → Browse Templates」模板浏览器，官方文档页 [docs.comfy.org/interface/features/template](https://docs.comfy.org/interface/features/template) 明确支持原生模型工作流与自定义节点示例，**只认 JSON 格式**。
- **模板内容单独维护在独立仓库** [Comfy-Org/workflow_templates](https://github.com/Comfy-Org/workflow_templates)：每个模板一个 bundle，`bundles.json` 做索引清单；与主程序代码解耦，模板更新不必动主程序。
- **导入导出**：导出 = JSON 文件（或把工作流**嵌进 PNG metadata**）；导入 = 直接把 JSON/PNG 拖到画布。社区分发同样以 JSON 文件为主（beam.cloud / Reddit 汇总帖）。

### 4. ST 1.18.0 自己怎么管这四类（参照树就地核实，硬证据）

Palink 的问题域和 ST 完全同构，而 ST 参照树就在仓库里（`_reference/sillytavern-1.18.0/`）：

- **四类预设统一按「类型 → 目录 → JSON 文件」管理**：服务端 `src/endpoints/presets.js:27-34` 把 `instruct / context / sysprompt / reasoning` 四个类型分别映射到各自目录下的 `.json` 文件；端点只有 `save/delete/restore`（`presets.js:42/60/83`），导入 = 用户在前端选文件再 save。
- **出厂内容**：ST release 分支在 `default/content/presets/<type>/*.json` 附带默认预设（网上确认存在如 `sysprompt/Actor.json`，另有 `index.json` 清单）。**参照树被裁剪，`default/content` 目录不在本地，ST 出厂到底带了几条 sysprompt/reasoning 预设未能核验**（网络面也只确认了目录结构）。
- **ST 的默认 sysprompt 就是一句英文**（`public/scripts/power-user.js:267-272`）：
  ```
  sysprompt: { enabled: true, name: 'Neutral - Chat',
               content: 'Write {{char}}\'s next reply in a fictional chat between {{char}} and {{user}}.',
               post_history: '' }
  ```
  这就是"版权顾虑"的具体标的——**要回避的是这类句子原文与近似改写**。
- **reasoning 默认**：`power-user.js:274-281`（prefix `<think>` / suffix `</think>` / separator `\n`，默认模板名 'Think XML'）；运行时模板列表是空数组由服务端数据填充（`public/scripts/reasoning.js:32-34`、`:1615`；`public/scripts/sysprompt.js:15/50-52` 同构）。
- **instruct 键名对照**（做 ST JSON 兼容导入时要用）：ST 用 `_sequence` 后缀（`input_sequence` / `output_sequence` / `system_sequence` 等，`power-user.js:221-231`），Palink `InstructTemplate` 用 `_prefix` / `_suffix`（`backend/app/models/system.py:202-233`）——**同义不同名，映射表见方案 b**。

### 5. 三个参照系提炼出的共同模式

| | 出厂自带 | 内容与程序的关系 | 分享方式 |
|---|---|---|---|
| A1111 styles | **零内置**（空 CSV） | 内容=用户数据文件，程序只管读写 | 整包 CSV 文件社区分发 |
| ComfyUI 模板 | **自带一套**（独立模板仓） | 模板仓与主程序解耦，bundle+索引清单 | JSON/PNG 文件 |
| ST 预设 | 自带少量默认 JSON | 类型→目录→JSON，manifest 清单 | JSON 文件 |

共性结论：**程序只做「格式的读写与分类管理」，内容要么为零、要么极少量且刻意中性；第三方内容一律以文件为单位由用户自行引入，责任随内容走**。Palink 已有同款基因：`st_power_user_defaults.py:35-46` 的版权边界（只取键名/类型/标量默认值，`sysprompt.content`→`""`，instruct 序列属格式分隔符可留，`<think>` 属标签配置）。

## 结论与建议

### a) 自带一份自制中文默认模板（建议，数字可调）

总量 **10 条左右**，人工可逐条审。全部自写中文，不出现 ST 文本原文/近似改写：

| 类 | 条数 | 落点 | 说明 |
|---|---|---|---|
| context | +2 | `context_templates`（表已在） | 现有 4 条是结构模板，补中文叙事场景的组装风格：「沉浸叙事」「极简」 |
| instruct | +2 | `instruct_templates`（表已在） | 序列是 API 格式事实，重点是中文常用组合：「对话体」「小说正文体」 |
| sysprompt | 4 | **无专表**（→ 裁定 ②） | 沉浸第一人称 / 旁白叙事 / 轻松休闲 / 严谨考据 |
| reasoning | 2 | **无专表**（→ 裁定 ②） | 标准 `<think>`；显式分步。**标签保持 ASCII**（协议性配置，中文标签可能破坏模型端解析） |

示例草稿（sysprompt「沉浸第一人称」，自写）：

> 你是{{char}}本人。始终以第一人称行动与说话：只描写你的言行、神态与内心，不代{{user}}做决定、不替{{user}}写台词。用具体的动作与细节推进剧情，单次回复以二至四段为宜。若{{user}}的输入含糊，按人物性格自然衔接，不要出戏询问。

上线前用参照树 `power-user.js:267-272` 的 ST 默认句做一次**人工近似度复核**（我的草稿句式、结构、内容均与 ST 默认不同，但复核这步不能省）。

### b) 用户侧导入导出 JSON 草案（字段对齐现有表）

沿用 Palink 已有先例 `backend/app/api/presets.py:224-248`（export 带 `_palink_version` / `_source` 标记）与 `:251-295`（import 限 5MB、重名加 `(imported)` 后缀）：

单条文件（kind 决定分发去向）：

```json
{
  "format": "palink-preset",
  "version": 1,
  "kind": "context",
  "name": "沉浸叙事",
  "display_name": "沉浸叙事（自制）",
  "story_string": "{{description}}\n\n{{personality}}\n\n当前情境：{{scenario}}",
  "chat_start": "",
  "system_prompt": "",
  "jailbreak": "",
  "normal_prompt": "",
  "group_prompt": "",
  "_palink_version": "0.22.0",
  "_source": "palink-ai"
}
```

- `kind: context` → `context_templates`，字段同名直映（`system.py:127-145`：name/display_name/story_string/chat_start/system_prompt/jailbreak/normal_prompt/group_prompt）。
- `kind: instruct` → `instruct_templates`，字段同名直映（`system.py:198-250`）。
- `kind: sysprompt` / `kind: reasoning` → **无专表**，短期建议落 `power_user` 键或 `prompt_presets`（entries/config 是 JSON Text 列，`prompt_preset.py:11-12`），→ 裁定 ②。
- 打包文件：`{"format":"palink-preset-pack","version":1,"items":[…每项含 kind…],"_source":"palink-ai"}`。
- **可选的 ST 兼容导入**（→ 裁定 ③）：按发现 4 的键名对照做映射（`input_sequence→input_prefix`、`output_sequence→output_suffix`、`system_sequence→system_sequence`，余键对照 `system.py:202-233`）。导入 ST 文件属用户行为，内容责任自负。

### c) 版权口径一句话

> 自带模板全部为 Palink 自写内容（只含结构与自撰中文文案，不搬运 ST/第三方原文）；用户通过导入功能引入的第三方内容，著作权与合规责任由导入者自行承担。

### d) 落地文件与工作量

| # | 动什么 | 文件 | 估时 |
|---|---|---|---|
| 1 | 种子内容 | 新建 `backend/app/core/preset_pack_seeds.py`（仿 `context_template_seeds.py` 形状）+ `main.py` 加播种函数（仿 `main.py:93-123`） | 0.5 天（含版权自审） |
| 2 | sysprompt/reasoning 落点 | 裁定 ② 后：A 案（轻）用 `prompt_presets`/power_user 现有列；B 案（重）新表 + alembic 迁移 | A 案 ≈0，B 案 ≈1 天 |
| 3 | 导入导出 API | `api/prompt_manager.py`（现状无 import/export，端点清单 `prompt_manager.py:65-304`）与 `api/context_templates.py`、`api/instruct_templates.py` 各加 `/import` `/export`（仿 `presets.py:211-295`）；或新建统一路由 | 0.5-1 天 |
| 4 | 前端 UI | `RoleplayEngineTab.tsx` 加模板库分组（已有 ensure-builtin 调用先例 `:638-639`）+ `PresetManager.tsx:227-269` 的导入/导出按钮模式套用 | 0.5-1 天 |
| 5 | 测试与门禁 | pytest / vitest / `bash scripts/gate.sh` | 0.5 天 |

**合计约 2-3 个工作日**（A 案）；B 案 +1 天。

### 待主脑裁定

1. **覆盖面口径**：任务前提"全空"与实测不符（发现 1）——方案按"内容型预设为空"的口径做（prompt_presets + sysprompt/reasoning），还是按原口径把 context/instruct 也当空表处理？前者不推翻已有种子，后者会重复建设。
2. **sysprompt/reasoning 落点**：A 案（复用 `prompt_presets`/`power_user`，不加表）还是 B 案（新表 + alembic）？
3. **ST 原生 JSON 兼容导入**是否本期做（涉及映射表与"用户自负"边界文案）。

### 附注

- 本报告落盘后**未刷新 `_CATALOG.md`**：只读任务纪律禁止我写报告以外的文件，而 `python scripts/docs/gen_docs_catalog.py` 会改写 `_CATALOG.md`。请主脑收录本报告时统一跑一次（`--check` 应转为 OK）。
- 网络面局限：WebFetch/curl 在本机均因 TLS 校验失败不可用，GitHub 页面未能直接核对；上文 A1111/ComfyUI/ST 出厂清单中凡标注"搜索摘要"者置信度低于本地代码引用。
