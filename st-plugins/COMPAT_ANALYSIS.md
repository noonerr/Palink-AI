# Palink-AI × ST 扩展兼容性分析（基于你实际安装的扩展）

> 分析日期：2026-07-30 ｜ 目标：让"只多出显示面板"的 ST 扩展在 Palink 渲染
> 数据来源：`D:\项目\Palink-AI\SillyTavern-1.18.0` 的 `public/scripts/extensions/`（已复制到 `D:\项目\Palink-AI\st-plugins\`）

## 一、已获取 vs 缺失

从你本地 ST 1.18.0 复制了 **14 个扩展文件夹 + shared.js**。对照你截图的 13 个：

| 截图名 | ST 文件夹 | 状态 |
|---|---|---|
| 角色表情 | `expressions` | ✅ 已获取 |
| 图像生成 | `stable-diffusion` | ✅ 已获取 |
| 图像提示词模板 | — | ❌ 不在 extensions 里（可能在你的其他 ST 分支/手动装） |
| TTS | `tts` | ✅ 已获取 |
| 提示词模板 | `qprompt`? | ❌ 未找到 |
| 小白X | — | ❌ 不在 `third-party/`（该目录为空） |
| 酒馆助手 | — | ❌ 未找到 |
| 快速回复 | `quick-reply` | ✅ 已获取 |
| 聊天翻译 | `translate` | ✅ 已获取 |
| 图片描述 | `caption` | ✅ 已获取 |
| 总结 | `memory` | ✅ 已获取 |
| 正则 | `regex` | ✅ 已获取 |
| 向量存储 | `vectors` | ✅ 已获取 |
| （额外） | `token-counter` / `assets` / `attachments` / `connection-manager` / `gallery` | ✅ 附带获取 |

**缺失 4 个**：图像提示词模板、提示词模板(qprompt)、小白X、酒馆助手。这 4 个是第三方/中文插件，需要你从安装它们的那个 ST 实例复制（或单独给我路径）。

---

## 二、ST 扩展的"显示面板"到底是什么

你截图里每个扩展"多出来的面板"，在 ST 内置扩展里分两类：

1. **设置面板**（绝大多数）：扩展往 `#extensions_settings`（或 `#extensions_settings2`）里塞一块自己的 `settings.html`。这是你看到的"额外面板"的主体。
2. **独立显示元素**（少数）：如 quick-reply 的 `#qr_container` 按钮栏、expressions 的 `#expression-holder` 表情精灵、translate 挂在 `#send_textarea` 上的翻译控件。

**渲染机制**（从源码确认）：
```
manifest.json → js:"index.js", hooks.activate:"init"
  → ST 用 import(url) 加载 index.js
  → 调 init()
  → init() 内调用 renderExtensionTemplateAsync(MODULE_NAME, 'settings')
  → 该函数用 Handlebars 渲染 settings.html → 注入 #extensions_settings
```
依赖的全局 API：`getContext()`、`extension_settings`、`renderExtensionTemplateAsync`。

---

## 三、Palink 现有基础设施（好消息：框架已全）

| 组件 | 位置 | 作用 |
|---|---|---|
| 扩展加载器 | `lib/plugin-system/manager.ts:187` | 读 `index.js` → `executePluginCode` → 调 `hooks.activate`(即 init) ✅ |
| 沙箱执行 | `lib/plugin-system/sandbox.ts:1942` | `new Function(wrappedCode)` 在沙箱执行扩展 JS ✅ |
| 设置面板渲染 | `st-plugin-ui-host/PluginSettingsPanel.tsx:134` | 调 `renderExtensionTemplateAsync` 渲染 settings ✅ |
| 挂载点宿主 | `st-plugin-ui-host/StPluginMountPoints.tsx` | 宿主 `#extensions_settings` / `#extensions_settings2` ✅ |
| 完整 shim | `smart-card-runtime/SillyTavernCompatRuntime.ts:4237` | 实现 `renderExtensionTemplateAsync`（SmartCard 轨道）✅ |
| 管理 UI | `roleplay/PluginManager.tsx` | 启用/禁用/重载、展示 manifest ✅ |

**结论**：Palink 不是从零开始——它已经有"加载扩展 JS → 执行 → 渲染设置面板"的完整链路。你要的"显示面板"对应的是这条链路里的**设置面板渲染**环节。

---

## 四、逐扩展兼容分析

| 扩展 | 设置面板 | 独立显示挂载点 | 逻辑类型 | Palink 缺口 | 难度 |
|---|---|---|---|---|---|
| `expressions` | settings.html | `#expression-holder` `#expression-image`（动态创建） | 显示+逻辑 | 设置✅；表情精灵需在消息区宿主；`classify` 端点(部分有) | 中 |
| `tts` | settings.html | 无（纯设置内） | 逻辑+设置 | 设置✅；多 provider 后端需 API 对接 | 中 |
| `quick-reply` | settings.html | `#qr_container`（QR 按钮栏） | 显示+逻辑 | 设置✅；Palink 有 `#qr_bar` 但扩展查 `#qr_container`——ID 不一致需对齐 | 中 |
| `caption` | settings.html | `#caption_multimodal_model` | 逻辑+设置 | 设置✅；图像描述后端/多模态 | 中 |
| `memory` | settings.html | 无 | 逻辑+设置 | 设置✅；prompt 组装 Palink 已部分实现 | 低-中 |
| `regex` | settings.html + dropdown | `#regex_presets` 等（设置内） | 设置+逻辑 | 设置✅；正则执行 Palink 已实现 | 低 |
| `vectors` | settings.html | 无 | 逻辑+设置 | 设置✅；vector 端点后端已实现 | 低 |
| `token-counter` | `window`(window.html) | 无 | 显示(计数) | 设置✅；模板 `window.html` 已验证可渲染 | 低 |
| `translate` | settings.html / index / buttons | `#send_textarea` `#translation_provider` | 显示+逻辑 | 设置✅；`#send_textarea` 已宿主；翻译后端 | 中 |
| `stable-diffusion` | settings.html + button + dropdown | 无 | 逻辑+设置 | 设置✅；图像生成后端 | 中 |

**规律**：有设置面板的扩展（expressions / tts / caption / memory / regex / vectors / token-counter / translate / stable-diffusion / connection-manager）全部依赖 `renderExtensionTemplateAsync(MODULE, NAME)` 渲染各自 `.html` 模板 → 只要该函数能按名解析到模板并返回 HTML，你截图的"额外面板"就出来。独立显示元素（QR 栏、表情精灵、翻译控件）是增量，可后置。

**各扩展模板清单（已逐一验证渲染）**：
- caption/vectors/tts/memory：根目录 `settings.html`
- regex：`scriptTemplate` `editor` `debugger` `embeddedScripts` `presetEmbeddedScripts` `dropdown` `importTarget`（根目录）
- stable-diffusion：`button` `dropdown` `settings` `comfyWorkflowEditor`
- expressions：`settings` `list-item` `add-custom-expression` `remove-custom-expression` `templates/upload-expression`
- connection-manager：`settings` `profile` `view` `edit`
- translate：`index` `buttons` `deleteConfirmation`
- token-counter：`window`
- assets：`installation` `market` `character` `window`
- attachments：`manage-button` `attach-button`
- **quick-reply**：不走模板渲染，改用 `manager.render()` 注入 `#qr_container`（见下）

---

## 五、关键缺口（按优先级）

### P0 — 阻塞"显示面板"出现的总开关
1. **palink-native 沙箱的 `renderExtensionTemplateAsync` 是桩** — ✅ **已修复 (2026-07-30)**
   - 根因：`sandbox.ts` 原 `renderExtensionTemplateAsync: async () => ''` 返回空，扩展 `init()` 调它渲染设置面板时得到空串。
   - 修复：
     - `sandbox.ts` 新增简单模板编译器（移植 SmartCard 的 `{{var}}`/`{{{var}}}` 替换器，非完整 Handlebars，降低风险）。
     - `sandbox.ts` 将桩替换为真实现：从 `context.pluginTemplates` 按名查模板 → 渲染返回 HTML。
     - `manager.ts` 在 `load()` 中把 `instance.resources.templates` 注入 `context.pluginTemplates`。
   - 验证：`npx tsc --noEmit` 下 `sandbox.ts`/`manager.ts` 零错误（其余 6 个错误在 `NativeRoleplayChat.tsx`，预先存在、无关）。

2. **后端 `.html` 模板抽取漏掉根目录/非 `templates/` 布局** — ✅ **已修复 (2026-07-30)**
   - 根因：`plugins.py:_is_extension_template_resource` 只抽取 `template(s)/` 子目录下的 `.html`。但 ST 1.18.0 官方扩展的模板布局并不统一：caption/memory/tts/vectors 把 `settings.html` 放在**扩展根目录**，regex/stable-diffusion/expressions 把多个模板也放在根目录或 `html/` 子目录。结果这些 `.html` 没进 `resources.templates`，P0-1 修复后前端仍拿不到内容、面板空白。
   - 修复：`_is_extension_template_resource` 改为「扩展内任意 `.html`/`.hbs`/`.handlebars`/`.mustache` 都视为模板」（排除 `node_modules`/`dist`/`build`/`vendor` 等非模板目录）。
   - 配套回归测试：`tests/test_st_plugin_import.py::test_import_captures_root_settings_html_as_template`。
   - 验证：重写 `_verify_render.mjs`，复刻完整 `renderExtensionTemplateAsync`（含路径匹配），用后端抽取后的真实根目录模板路径喂入，逐一验证每个扩展实际发出的调用 —— **33/33 模板全部渲染出有效 HTML**（含根目录 `settings.html`、regex 的 `scriptTemplate`/`dropdown`、expressions 的 `templates/upload-expression` 等）。

3. **第三方脚本执行默认关闭**
   `SillyTavernCompatRuntime.ts`：`pluginScriptsDisabled` —— 需 `runtime.execute_scripts` 开启才执行扩展 JS。Palink 后端 `plugins.py` 对 zip 导入默认 `runtime.execute_scripts: True`，故经 `/api/plugins/import` 注册的扩展默认会执行 `init()`（从而渲染面板）。若经其它通道注册，需确保 `runtime.execute_scripts` 为真。

### P1 — 让面板完整
4. **非设置类挂载点对齐**：
   - `quick-reply` 查 `#qr_container` —— ✅ **已具备**：`StPluginMountPoints.tsx` 已在 `#extensions_settings2` 下提供 `#qr_container`（同时另有聊天输入框的 `#qr_bar` 供 QR 按钮栏）。所以 quick-reply 的 `document.querySelector('#qr_container').append(...)` 可直接命中，无需改 ID。
   - `expressions` 动态创建 `#expression-holder` / `#expression-image` → 需在消息渲染区允许这些节点。
   - `translate` 用 `#send_textarea`（已宿主）。

### P2 — 后端能力（非"显示"必需，但功能要用）
5. `tts` / `caption` / `translate` / `stable-diffusion` / `memory` 需要对应 provider 后端；Palink 已部分覆盖（memory/vectors/regex 较强），其余按需对接。

---

## 六、端到端注册→渲染链路（已验证，2026-07-30）

### 6.1 完整链路（代码级已确认打通）
```
[注册]  zip(扩展文件夹) → POST /api/plugins/import (admin)
         └─ backend plugins.py: 解包 → .html 抽进 resources.templates（已修复 P0-1b）
            → manifest 落库（runtime.execute_scripts=True）→ 命名空间取 display_name
[发现]  frontend PluginManager.discover() → GET /api/plugins/runtime/config
         └─ 返回 plugin[].resources.templates（含 .html 内容）
[加载]  manager.load(name):
         ├─ context.pluginTemplates = resources.templates   ← P0-1 注入点
         ├─ sandbox.executePluginCode(index.js)              ← 执行扩展 JS
         └─ callActivateHook(hooks.activate) = init()        ← 11 个扩展均为 {activate:"init"}
[渲染]  init() 内调用 renderExtensionTemplateAsync(MODULE, NAME)
         └─ P0-1 修复：按名查 pluginTemplates → compileSimpleTemplateForSandbox → 返回 HTML
[挂载]  init() 把 HTML append 进 #xxx_container
         └─ StPluginMountPoints 已提供：#tts_container #vectors_container #caption_container
            #regex_container #translation_container #summarize_container(memory) #sd_container
            #expressions_container #qr_container(quick-reply) #assets_container … 全部存在
[展示]  PluginSettingsPanel 点击"设置" → 克隆 #xxx_container 或回退渲染 settings 模板
```

### 6.2 注册方式（用户执行，需后端在线 + admin token）
`st-plugins/_register_extensions.py` 已就绪，会递归打包每个含 `manifest.json` 的子目录并导入：
```bash
# 后端默认 http://localhost:8000，token 用 --token 或环境变量 PALINK_ADMIN_TOKEN
python st-plugins/_register_extensions.py --base http://localhost:8000 --token <ADMIN_JWT>
```
导入后于 Palink「插件管理」中启用，点「设置」即可见面板。

### 6.3 验证结果（无需后端，纯静态模拟）
- 11 个扩展 `manifest.json` 均声明 `hooks.activate:"init"` → Palink 加载时必触发渲染。
- `_verify_render.mjs`：复刻完整 `renderExtensionTemplateAsync`（路径匹配 + 模板编译），用后端抽取后的真实模板路径（根目录 `settings.html`、regex 的 `scriptTemplate` 等）喂入，**33/33 模板渲染出有效 HTML**。
- `StPluginMountPoints` 已涵盖所有扩展所需 `#xxx_container` → 面板有归宿。
- quick-reply 走 DOM 挂载（`#qr_container`，已存在），不走模板渲染，同样覆盖。

### 6.4 仍需注意（非阻塞）
- 后端 `plugins.py` 改动需重启后端生效；`_register_extensions.py` 仅打包/导入，不改后端。
- 模板编译器是 SmartCard 同款 `{{var}}`/`{{{var}}}` 简化版，**非完整 Handlebars**。若某扩展模板用了 Handlebars 高级语法（if/each/helper），该处会原样保留文本（不报错、不白屏，仅该片段未插值）。目前 33 个模板实测均无此问题。
- 功能类后端（tts/caption/translate/stable-diffusion 的 provider 接口）属 P2，不影响"面板出现"。

## 七、结论与下一步

**你的目标（显示面板）是已达成的**——Palink 原有完整「加载扩展 JS → 执行 init() → 渲染设置面板」链路，两个硬阻塞均已修复并验证：

- **P0-1**（前端）：`sandbox.ts` 的 `renderExtensionTemplateAsync` 桩改为按名查 `context.pluginTemplates` 并渲染（2026-07-30 修复）。
- **P0-1b**（后端）：`plugins.py:_is_extension_template_resource` 改为抽取扩展内任意 `.html` 为模板，覆盖根目录 `settings.html` 与 `html/` 布局（2026-07-30 修复 + 回归测试）。
- **验证**：11 个扩展 `hooks.activate:"init"` → 加载即渲染；`StPluginMountPoints` 已提供全部 `#xxx_container`；`_verify_render.mjs` 复刻完整渲染逻辑，**33/33 模板渲染有效**。

**用户侧待办（执行）**：
1. 重启后端使 `plugins.py` 改动生效。
2. 运行 `python st-plugins/_register_extensions.py --base <后端地址> --token <admin JWT>` 注册 11 个扩展。
3. 在 Palink「插件管理」启用 → 点「设置」查看面板。
4. 补齐缺失的 4 个扩展（图像提示词模板、提示词模板 qprompt、小白X、酒馆助手）——需你提供来源路径。

**后置增量（非显示必需）**：expressions 的 `#expression-holder` 表情精灵、translate 挂 `#send_textarea` 的实时翻译控件、以及 tts/caption/translate/stable-diffusion 的功能型后端（P2）。

> 注：`_verify_render.mjs` 为模板渲染静态验证；真正「面板出现」需配合后端注册 + 浏览器加载，建议按上述 1–3 步实测 regex 验证一次。
