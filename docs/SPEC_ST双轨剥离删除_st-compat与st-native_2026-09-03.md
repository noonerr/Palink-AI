# SPEC — ST 双轨剥离删除方案：st-compat 与 st-native（2026-09-03）

> **本文档性质**：只读调研产物。写作过程中**零代码改动**（仅新增本文档）。
> 数据来源 = 工作区快照（branch `st-plugin-compat-20260727`，2026-09-03）全仓 grep + 逐文件精读 + 测试面专项盘点。
> **行号均为快照时点值**，施工时行号必然漂移，一律按文中给出的**符号名重新 grep 定位**后再动手。
> 关联决策：`TODOS.md`「[已完成] 运行时强制封存 st-compat / st-native（[MODE-SEALED] 2026-08-24 用户拍板）」、根目录 `AGENTS.md`。

---

## 0. 结论速览（TL;DR）

三种 silly_tavern_mode 的处置：

| 模式 | 现状 | 本方案处置 |
| --- | --- | --- |
| `palink-native` | 主攻、唯一可达 | **全部保留**（红线见 §5） |
| `st-compat` | 封存（装配入口归一化，运行时不可达） | **第一批删除**：装配函数族 + 守卫 + 测试（§3） |
| `st-native` | 封存（UI 禁用 + iframe 不可达） | **第二批删除**：iframe 线 + ST sidecar 专属文件 + SillyTavern 容器 + 30MB 静态副本（§4） |

两批可以独立施工、独立验收。第一批（st-compat）体量小、边界清、风险低，建议先行；第二批（st-native）涉及部署链与 983 个 git 追踪文件，单独立批。

**核心甄别结论**（决定"删了不伤别人"的三条事实）：

1. **st-compat 装配线是纯函数孤岛**：`build_st_compat_messages`（character_message_builder.py L540-1042）与 RPA 的 `if _is_st_compat_mode(st_mode):` 分支只在模式值命中时执行；封存后（`SEALED_ST_MODES` 入口归一化）运行时永不可达，删除 = 移除死分支 + 拍平 if/else，palink-native 链路零变化。
2. **st-native 的 sidecar 三文件在 Palink 前端零调用**：`st_sync.py`（/api/st/sync）、`st_groups.py`、`st_resources.py` 的消费方只有 ST iframe 内的 ST 前端本体（grep 前端业务代码零命中）。但注意 `st_sync_service.py` 是**共用模块**（被 character/personas/worldbook/character_ext 等主链路引用），只能删 `st_sync.py` 路由层，服务层保留（§5）。
3. **智能卡与插件不依赖任何待删物**：智能卡运行时是 Vite 插件从 `SillyTavernCompatRuntime.ts` 源码生成的独立资产（`/assets/palink-smart-card-runtime-<hash>.js`，`frontend/vite-plugins/smart-card-runtime-asset.ts`），与 `public/st/palink-smart-card.js` 无运行时依赖（后者只被 st-native 的 nginx 8081 与 ST 静态副本引用）；前端 `SillyTavernCompatRuntime.ts` 里出现的 `'st-compat-v2'` 只是**运行时版本标签**，与 silly_tavern_mode 无关。

---

## 1. 背景与现状盘点

### 1.1 封存机制（现存三层守卫，删除时全部拆除）

| 层 | 位置 | 机制 |
| --- | --- | --- |
| 装配入口 | `roleplay_prompt_assembly.py` L56/L63/L66-77：`ST_COMPAT_MODES`、`SEALED_ST_MODES`、`_st_mode_effective()`、`_is_st_compat_mode()` | 读取 user_setting 后先过 `_st_mode_effective`，封存值归一为空串 → 走 palink-native 分支 |
| API 出入口 | `users.py` L22-33 与 `silly_tavern.py` L576-590 的 `_normalize_silly_tavern_mode()`（各自持有一份 `_SEALED_ST_MODES` 字面量） | GET 一律报告 palink-native；PUT 提交封存值直接落库 palink-native |
| 设置 UI | `SettingsView.tsx` L308-311 `stModes` 数组中 st-compat/st-native 两项 `sealed: true` 灰化 | 入口禁用 |

另有别名归一：`users.py` L15 附近 `_SILLY_TAVERN_MODE_ALIASES`（"iframe"→st-native、"native"→palink-native 等）。

### 1.2 silly_tavern_mode 数据字段触点（删除时一并处置）

- `backend/app/models/system.py` L47：`silly_tavern_mode = Column(String, default="palink-native")`
- `backend/app/core/migrations.py` L14：启动自动补列清单含 `("user_settings", "silly_tavern_mode", sa.String())` —— **陷阱**：若删了模型列但不清这行，重启后端会把列自动加回来（见 §9 陷阱 T1）
- `backend/app/schemas/user.py` L33：`Literal["compat", "st-compat", "st-native", "palink-native", "iframe", "native"]`
- 读写点：`users.py` L75/L122-123、`silly_tavern.py` L1885/L2004
- 前端：`SettingsView.tsx` L220/L226/L239/L243-248、`CharacterView.tsx` L143/L461/L532-533、`types/index.ts`（silly_tavern_mode 类型声明）
- 调试脚本：`backend/scripts/_verify_mode_sealed.py`、`_verify_stcompat_e2e.py`、`_inspect_stcompat_tail.py`、`_verify_mvu_after_fix.py`

### 1.3 st-native 部署链全貌（待拆除物）

```
浏览器 ── 3000:8080 nginx（Palink 主站，保留）
   │        └─ /st/ 静态块 → public/st/（ST 1.18.0 前端完整副本 30MB，待删）
   ├── 9061:8081 nginx（st-native 专用 server 块，待整块删）
   │        ├─ auth_request → /api/st/native/auth（silly_tavern.py，待删）
   │        ├─ /__palink_st_native_login → /api/st/native/login（待删）
   │        └─ 其余 proxy_pass → sillytavern:8000 容器（待删）
   └── SillyTavernIframe.tsx ─fetch /api/st/native/status─→ 后端取容器 URL（待删）

docker-compose.yml：
  sillytavern 服务（build ./SillyTavern-1.18.0/SillyTavern-1.18.0，441MB，git 追踪 983 文件）
  4 个专用卷 sillytavern_config/data/plugins/extensions
  frontend.depends_on.sillytavern（service_started）
  backend env：ST_NATIVE_URL / ST_NATIVE_PUBLIC_PORT / ST_NATIVE_SERVICE_URL /
               ST_NATIVE_SERVICE_KEY / ST_NATIVE_PALINK_OPENAI_URL / ST_NATIVE_DEFAULT_MODEL
```

`openai_compat.py`（`/api/openai/v1`，OpenAI 兼容推理端点）**唯一外部消费者就是 ST 容器**（`ST_NATIVE_PALINK_OPENAI_URL`），配合 N-6 的 HMAC `X-Palink-User-Id/-Sig` 头使用；Palink 自身推理走 inference_dispatcher，不经它。属于 st-native 专属，随第二批删除（含 `config.py` L71/L150 一带的 ST_NATIVE 配置与警告注释、`.env.example` L176-193）。

---

## 2. 施工总原则

1. **两批独立 PR/commit**：第一批 st-compat（纯后端装配 + 三处守卫 + 测试）；第二批 st-native（前端 + 后端 sidecar 专属 + 部署链）。任一批单独回滚都不影响另一批。
2. **每步红绿验证**：删除前先跑基线（后端 `docker exec palink-ai-backend-1 sh -c "cd /app && python -m pytest tests/ -q"`，前端 `npx tsc --noEmit` + `npm run test:contract`），删除后同口径复跑，数字必须可勾稽。
3. **共用符号先确认调用方再删**：凡 §5 红线清单里的名字，删除动作只允许发生在"确认剩余调用方全部属于 palink-native"之后。
4. **部署知识**（复用既有经验）：后端改代码必须 `docker compose build backend && up -d`（烤镜像）；前端是 dist 卷直挂，必须本地 `npm run build`；`silly_tavern_mode` 若走删列迁移需手动 `python -m alembic upgrade head`（`RUN_MIGRATIONS_ON_STARTUP=false`）。
5. **多 agent 纪律**：本批次删除面横跨后端/前端/部署，若并行分派，禁止任何人整文件覆写 `formatting.ts` 等有契约守卫的文件；TODOS.md 先登记本 spec 再动工。

---

## 3. 第一批：删除 st-compat 装配线

### 3.1 `backend/app/services/roleplay_prompt_assembly.py`

删除/拍平清单（符号定位）：

| 符号/位置 | 动作 |
| --- | --- |
| L41 `from ..services.character_message_builder import ... build_st_compat_messages` | import 去掉 build_st_compat_messages |
| L53-56 `ST_COMPAT_MODES = {"st-compat", "compat"}` | 删 |
| L58-63 `SEALED_ST_MODES` + 注释 | 删 |
| L66-72 `_st_mode_effective()` | 删（三处调用点见下） |
| L75-76 `_is_st_compat_mode()` | 删（所有调用点随分支一起消失；固化测试同步删，见 §6） |
| L828 附近 `_should_split_char_fields_for_order(preset, st_mode)` 调用（在 `_extract_char_field_messages_for_order` 内） | 保留函数本体，**去掉 st_mode 形参**并简化其内部的 st-compat 强制拆分逻辑（该函数 palink-native 也用，L4043-4044） |
| L2280+ `_select_natural_speaker(..., st_mode=...)` | 去掉 st_mode 形参（调用点 L2700 一带随群聊分支一起简化；`test_group_speaker_selection.py::test_natural_stcompat_ignores_follower` 会因 TypeError 暴露漏改，先删该测试） |
| L2697-2700 群聊策略消费点：`st_mode = _st_mode_effective(...) or "palink-native"` 与 `if _is_st_compat_mode(st_mode) and strategy in (TALKATIVE, VOTING)` | 整段删（palink-native 语义 = 两种策略都可用，删掉 if 即可） |
| L3555 世界书扫描消费点：`and _is_st_compat_mode(_st_mode_effective(getattr(user_setting, "silly_tavern_mode", "")))` | 拍平为恒 False 分支删除，保留 palink-native 扫描路径（depth 注入队列） |
| L3741-3992 主装配分支：`if _is_st_compat_mode(st_mode): ... return build_st_compat_messages(...)  else:`（L3755 取值、L3758 进入、L3930 调用、L3992 return、L4002 else 收口） | **拍平 if/else**：整个 st-compat 分支体（world_info_before/after 拼装、char_system_prompt、persona_desc、an_text/an_depth、instruct skip_examples、jailbreak D1 合并链等）删除，palink-native 侧（原 else 体）上移 |
| L4043 `if not _is_st_compat_mode(st_mode):` | 条件取反拍平（直接执行体内代码） |
| L4348 `prompt_sources = _collect_prompt_sources(...) if not _is_st_compat_mode(st_mode) else []` | 恒取前者 |
| L4353 `if prompt_preset is not None and not _is_st_compat_mode(st_mode)` | 去掉第二个条件 |
| L4364 `if not _is_st_compat_mode(st_mode):` 分支（内含 `_apply_dynamic_trimming` L4365）与 L4371 `_apply_st_compat_history_trim(...)` else 侧 | 拍平：保留 `_apply_dynamic_trimming` 路径，删 `_apply_st_compat_history_trim` 调用 |
| L1289-1402 `_apply_st_compat_history_trim_inner`、L1403-1485 `_apply_st_compat_history_trim` | 两函数**整体删除**（全库唯一调用方 = L4371；st-compat 轨道专属，palink-native 历史管理走 `_apply_dynamic_trimming`） |
| 文件头 docstring L7-10 | 更新方向声明（移除"st-compat 待删除"字样） |

**注意**：`_collect_prompt_sources`、`_apply_dynamic_trimming`、`_apply_full_prompt_order`、`DepthInjection` 队列、`_append_worldbook_context`、`_collect_extension_prompts` 都是 palink-native 在用，**只删调用分支、不删函数**。

### 3.2 `backend/app/services/character_message_builder.py`

- `build_st_compat_messages`（L540-1042，约 500 行）**整体删除**。
- 以下共用辅助函数被两个 builder 共用（`build_st_compat_messages` 内部有引用），**保留**：`parse_system_commands`、`clean_smart_card_trigger_context`、`is_smart_card_trigger_message`、`clean_display_markup_for_prompt`、`_apply_context_template`、`_sanitize_name`、`_apply_wi_format`、`_apply_field_format`、`_split_example_blocks`、`_parse_example_chat`。
- 删除后 `npx`-式的死代码复核：grep 文件内是否还有仅被 `build_st_compat_messages` 调用的私有 helper（如 L984 附近引用 trim_inner 的注释连带清理）。
- `backend/app/api/character_ext.py` L5514 与 `websocket.py` L2026 附近的两处**注释**提到 st-compat（L858-861/char_system_prompt 字样）：注释随之更新，逻辑不动。

### 3.3 API 守卫与数据字段

- `users.py`：删 `_SEALED_ST_MODES`（L22）与 `_LEGAL_ST_MODES`（L23）；`_normalize_silly_tavern_mode`（L26-33）简化。**两个方案二选一（拍板点 A）**：
  - **A1（推荐）**：`silly_tavern_mode` 字段全链删除（models 列 + schemas + GET/PUT 字段 + SettingsView 面板 + `core/migrations.py` L14 补列行 + alembic drop column 迁移）。前端 `CharacterView`/`SettingsView` 不再读该字段，`sillyTavernMode` state 删除后所有 `=== 'st-native'` 分支自然消失（与第二批有耦合，见 §4.1 顺序建议）。
  - **A2（保守）**：字段保留为纯摆设（DB 与 API 里恒 "palink-native"，normalize 简化为 `return "palink-native"`），仅删除装配分支。好处：前后端契约零变化、第二批未动工前 UI 不塌；代价：留一根死字段。
  - 推荐 **A1+A2 分步**：第一批先做 A2（彻底解耦装配线），第二批删 st-native UI 时顺手执行 A1 的前端半，最后单独一笔做 A1 的 DB 列迁移。
- `silly_tavern.py` L576-590 `_normalize_silly_tavern_mode` 与 L1885/L2004 两处消费：同 users.py 口径。
- `backend/app/core/config.py` 中如有 ST_NATIVE 之外与模式相关的配置则一并核对（本次调研未见）。

### 3.4 前端（第一批范围内）

- `SettingsView.tsx` L220-248 `stMode` state/loadMode/handleModeChange + L305-345 模式选择器（`stModes` 数组含两个 `sealed: true` 项）：**整个模式选择器卡删除**（或按 A2 暂时保留 palink-native 单选只读卡，随拍板点 A 定）。删除时同步删 toast labels 里 'st-compat'/'st-native' 键。
- 其余前端模式消费（`CharacterView`/`CharacterChat`/`App.tsx` 的 `sillyTavernMode`）主要服务于 st-native iframe 隔离，归第二批（§4.1）；但其中 `types` 里 `silly_tavern_mode` 的 Literal 类型定义与 `'st-compat'` 成员，随第一批从类型中移除。

### 3.5 第一批验收

- grep 断言归零：`build_st_compat_messages`、`_is_st_compat_mode`、`_st_mode_effective`、`SEALED_ST_MODES`、`ST_COMPAT_MODES`、`_apply_st_compat_history_trim` 在 `backend/app/` 零命中（测试目录见 §6 白名单外也应归零）。
- 全量 pytest 无新增失败（对照基线扣除 §6 中删除的用例数，精确勾稽）。
- 手工冒烟：任一存量用户（DB 里 admin 存量值仍是 st-compat 也不影响——装配直接走 palink-native）发起角色扮演对话，prompt 形态与删除前一致（可对比 `PromptAssemblyReport`）。

---

## 4. 第二批：删除 st-native 链路

### 4.1 前端

| 文件 | 动作 |
| --- | --- |
| `components/sillytavern/SillyTavernIframe.tsx`（177 行） | 整文件删 |
| `components/views/character/CharacterChat.tsx` | 删 import（L36）、`sillyTavernMode` prop 与默认值（L329/L451）、4 处 `if (sillyTavernMode === 'st-native') return;` 守卫（L1498/L1523/L1542/L1624——这些守卫删除后智能卡 bridge effect 在 palink-native 下行为不变，因为 palink-native 从不等于 st-native）、L1791 条件渲染 `<SillyTavernIframe>` 整个分支（保留 else 侧主聊天区） |
| `components/views/CharacterView.tsx` | 删 `sillyTavernMode` state（L143）、settings 读取（L461）、事件 detail 消费（L532-533）、`palink:stNativeActiveChanged` 派发 effect（L1679-1686）、传参（L1877） |
| `components/views/SettingsView.tsx` | 模式选择器卡（若第一批按 A2 保留，此处彻底删）；`userSettingsUpdated` detail 中 sillyTavernMode 键 |
| `components/roleplay/RoleplayModeSwitcher.tsx` | **整文件删**（全库零引用的死组件，内含自己的 iframe/native 切换与第二个 SillyTavernIframe 引用） |
| `App.tsx` | 删 `stNativeActive` state + `palink:stNativeActiveChanged` 监听（L476/L487-489）、移动端 dock 条件里的 `!stNativeActive`（L1094/L1105）；L729-826 的 `localStorage.removeItem('palink-silly-tavern-mode'/'-theme')` 属登出清理，可留可删（建议随批删除；对未清理过的旧浏览器残留键，多留一句无副作用清理亦可） |
| `frontend/public/st/`（30MB：bridge.js、script.js、lib/、locales/、img/ 等） | 整目录删。**删除前置检查**：确认 `dist/assets/palink-smart-card-runtime-*` 由 Vite 插件生成、与 `/st/` 无关（已确认，`frontend/vite-plugins/smart-card-runtime-asset.ts`）；确认无其他 `/st/` URL 引用（当前唯一引用 = SillyTavernIframe.tsx L129） |
| `frontend/public/palink-silly-tavern-loader.js`、`palink-silly-tavern-theme.css`、`palink-smart-card.js`（public 根） | 整文件删（唯一引用方 = nginx 8081 alias；智能卡 iframe 渲染不消费它们） |
| `frontend/nginx.conf` | 删 `location ^~ /st/` 及 img/sounds/backgrounds/themes/webfonts 长缓存块与无前缀回退块（`/locales/`、`/scripts/`、`/lib/`、`/css/`、`/templates/`、`/user/`、`/worlds/`、`/movingUI/`、`/quick-replies/`、无前缀 `/img/` 等，注意这些 root 指向 `html/st`）、**整个 8081 server 块**（L212 起，含 `@st_native_unauthorized`、`__palink_st_native_auth/login`、三个 loader/smart-card/theme alias、ST API 反代与 `proxy_pass http://sillytavern:8000` 兜底 location） |
| `types/index.ts` | `silly_tavern_mode` 相关类型与 `'st-native'` 成员（随拍板点 A1/A2） |

### 4.2 后端专属文件与端点

| 目标 | 动作 |
| --- | --- |
| `backend/app/api/st_sync.py`（/api/st/sync 路由） | 整文件删 + `api/__init__.py` L34/L54 挂载摘除 |
| `backend/app/api/st_groups.py`（ST 群组聊天兼容 API） | 整文件删 + 挂载 L35/L55 摘除（Palink 自有群聊在别处，前端对 `chats/group` 零调用） |
| `backend/app/api/st_resources.py`（backgrounds/avatars/sprites/assets ST 形状端点） | 整文件删 + 挂载 L41/L59/L101 摘除（前端零调用；智能卡资产走独立的 `smart_card_assets.py`，勿混淆） |
| `backend/app/api/openai_compat.py`（/api/openai/v1） | 整文件删 + 挂载 L32/L96 摘除；同步删 `config.py` 的 `ST_NATIVE_*` 配置与 L150 警告注释、`.env.example` L176-193、compose 中 backend 的 6 个 ST_NATIVE_* env |
| `backend/app/api/silly_tavern.py` 内 `/api/st/native/status|auth|login`（L1995/L2027/L2044）与 `/api/st/version`、`/csrf-token|/api/st/csrf-token`（L1985-2097） | **先甄别后删**：status/auth/login 为 st-native 专属（消费方 = SillyTavernIframe + nginx 8081，均随批删除）可删；`/csrf-token` 与 `/api/st/csrf-token` 有历史 iframe/bridge 兼容流量（CSRF 双提交静态分支的豁免依据，见 csrf_guard 注释），删除前 grep 消费方确认 |
| `backend/app/services/st_sync_service.py` | **保留**（共用模块：`clean_smart_card_markup` 等被 character/personas/worldbook/character_ext/silly_tavern/character_service 引用）。其中仅服务 ST 文件镜像的函数（`async_sync_*`、`get_sync_status` 等只被 st_sync.py 调用的）可随后摘除——摘除前逐函数 grep 调用方 |
| `backend/app/core/config.py` | 删 `ST_NATIVE_*` 字段；`ST_NATIVE_DATA_ROOT` 相关（st_sync_service 消费）在 service 摘除后同步删 |
| `docker-compose.yml` | 删 `sillytavern` 服务整段（L39-85）、4 个专用卷（L307-310）、`frontend.depends_on.sillytavern`（L13-14）、backend env 6 项（L228-233） |
| `SillyTavern-1.18.0/` 目录 | `git rm`（983 个追踪文件、441MB）。**建议用 `git rm -r` 保留历史可回溯，不建议 filter-repo 清史**（与密码清史同口径：破坏面大于收益） |

### 4.3 `silly_tavern.py` 主体的端点级甄别（本批只做甄别登记，删除另立批次）

8764 行、约 100 个 ST 形状端点。**大部分必须保留**——它们同时是 palink-native 插件/智能卡/设置 UI 的后端。已实证的保留红线（消费方证据）：

| 端点族 | palink-native 侧消费方 |
| --- | --- |
| `POST /api/settings/get|save` | SettingsView（世界书全局设置卡）、`worldbook-global-settings.ts`、`getContext.ts`、`extension-settings-store.ts`（扩展设置存储）、智能卡 runtime |
| `POST /api/characters/*`（all/get/edit/merge-attributes/import/export/chats 等） | CharacterView（import/parse/translate）、智能卡（characters/all、merge-attributes=writeExtensionField 正典路径）、插件 runtime |
| `GET /api/st/characters/{avatar}`、`GET /thumbnail` | 智能卡 runtime、inline-st-globals（头像/缩略图） |
| `POST /api/chats/get|save` | 插件经典轨（sillyTavernPluginRuntime：聊天读写/saveChat） |
| `POST /api/worldinfo/get|edit|list` | 插件经典轨、世界书 UI |
| `POST /api/variables/global/*` | 插件全局变量（`lib/variables/global.ts`） |
| `POST /api/tokenizers/*` | `lib/tokenizer/service.ts`、`getContext.ts` |
| `POST /api/plugins/runtime/config|settings` | 插件沙箱 + 经典轨 |
| `POST /api/secrets`、`POST /api/backends/chat-completions/generate` | 智能卡 runtime 请求拦截链 |
| `POST /api/speech/*`、`/api/tts` 相关 | tts 链（`synthesize_tts_st_compat` 是**命名陷阱**：它是 form-encoded 的 Palink TTS 端点，前端 usePushToTalk/tts 在用，**保留**，见 §9 T6） |
| `POST /api/vector/*` | ST vectors 插件端点 + Palink 记忆 `st-vec::` 集合（`test_st_vectors_full.py` 回归）——保留 |

**可删候选**（纯 ST 前端独占功能，Palink 前端/插件无消费——第二批不删，留待"第三批端点瘦身"逐个复核后再动）：`/api/backends/chat-completions/status`、`/api/backends/text-completions/generate`、`/api/backends/kobold/embed`、`/api/chats/search|rename|continue|regenerate|swipe*|impersonate|hide|unhide|delete-message|rename-session|find|recent`（ST 前端会话操作；插件只用 get/save）、`/api/chats/group/*`、`/api/summarize`、`/api/translate*`、`/api/search`、`/api/modules`、`/api/extra/classify*|caption`、`/api/images/upload|list|folders`、`/api/openai/generate-voice|generate-image`（智能卡走 `/api/images/generate` 是 Palink 自有端点，勿混淆）、`/api/variables/get|set|delete`（会话级；插件只用 global 族）、`/api/quick-replies/*`、`/api/characters/rename|duplicate|edit-avatar|edit-attribute` 等。**每删一族必须**：① grep `frontend/src` + `st-plugins/` + 智能卡 runtime 三处零命中；② 在运行中的 ST 静态副本已删除的前提下确认；③ `test_st_contract.py` 对应用例同步处置。

### 4.4 第二批验收

- 前端：tsc 零错误、`test:contract` 全绿、`npm run build` 成功；浏览器冒烟 = 登录 → 角色扮演对话（智能卡渲染、插件面板、世界书设置卡全部正常）。
- 后端：pytest 全量绿（对照 §6 勾稽）；`docker compose config` 合法；`docker compose up -d` 后 sillytavern 容器不再出现、frontend 不再依赖它；3000 端口全功能冒烟。
- 端口冒烟：9061（8081）不再监听；`/st/index.html` 404。
- 仓库体检：`git status` 确认 983 文件删除已入库；`.env.example` 与 compose 无 ST_NATIVE 残留。

---

## 5. 不可删红线清单（共用设施，删前逐条对照）

| 设施 | 位置 | 归属证据 |
| --- | --- | --- |
| 插件沙箱/经典轨 runtime | `frontend/src/lib/plugin-system/`、`lib/sillytavern/`（getContext/runtime/extension-settings-store）、`utils/sillyTavernPluginRuntime.ts`、`st-plugins/` 目录 | AGENTS.md 明文：全部属于 palink-native；前端 `if (sillyTavernMode === 'st-native') return;` 只是 iframe 隔离守卫 |
| 智能卡运行时 | `smart-card-runtime/`（SillyTavernCompatRuntime.ts 等）、`CharacterCardRenderer.tsx`、`SmartCardCompatController` | palink-native 主功能；`'st-compat-v2'` 是运行时版本标签非模式值 |
| regex 引擎 | `lib/sillytavern/regex/`（pipeline/engine） | palink-native |
| `st_sync_service.py` | `backend/app/services/` | 被 character/personas/worldbook/character_ext/silly_tavern/character_service 六处引用（`clean_smart_card_markup` 等） |
| `silly_tavern.py` 中的共享机制 | `get_st_current_user`/`_token_from_request`（Cookie 兜底）、`_normalize_silly_tavern_mode` 之外的鉴权/CSRF、`_worldbook_to_charbook` 权威实现（character_ext F1 导出委托）、`_sanitize_relative_path` | 多处主链路依赖 |
| 前端 tokenizer/expression/image-gen | `lib/tokenizer/service.ts`（/api/tokenizers/*）、`lib/expression/manager.ts`（/api/expressions/analyze——Palink 自有 expressions.py）、`lib/image-gen/service.ts`（/api/images/*——Palink 自有） | 命名近 ST 但定义在自有路由 |
| 记忆向量 `st-vec::` 前缀 | `silly_tavern.py` `_ST_VEC_PREFIX` 一带 | 记忆向量集合命名，与模式无关 |
| 智能卡资产 | `smart_card_assets.py` | 独立于 st_resources.py |

---

## 6. 测试处置清单（来自专项盘点，约 284 用例涉及）

### A 类：纯测 st-compat，随第一批整文件删除（9 文件 / 92 用例）

`test_st_compat_assembly_order.py`(24)、`test_st_compat_golden_vector.py`(2，**连同 `backend/tests/st_compat/golden_vectors/` 5 对 json 同批删**，否则 `test_at_least_one_fixture_discovered` FAIL)、`test_st_compat_group_generation_mode.py`(5)、`test_st_compat_jailbreak.py`(5)、`test_st_compat_names_behavior.py`(8)、`test_st_compat_p2_features.py`(11)、`test_st_compat_token_budget.py`(6)、`test_st_compat_wi_format.py`(7)、`test_extension_prompts_st_compat.py`(24)。

### B 类：测封存守卫语义，随守卫删除/改写

- `test_st_mode_normalization.py`(21)：16 个守卫直测用例随删；2 个 HTTP 级用例（PUT 落库重定向 / GET 报告不回写）若走 §3.3-A1 则改写为"字段不存在/非法值拒绝"的正向断言。
- `test_e2e_roleplay_phase6.py::subtask_6_1_4`（L748）+ 文件内本地 `_normalize_mode` 复制品（L727/L736）：同上改写或删。
- `test_p1_fixes.py::test_should_split_returns_false_for_st_compat`（L135）：随 st_mode 形参删除而删/改。
- `backend/scripts/_verify_mode_sealed.py`：随守卫删。

### C 类：混合文件，精确摘用例（勿整删！）

| 文件 | 处置 |
| --- | --- |
| `test_st_compat_group_chat_e2e.py`(3) | **保留**（实测跑的是 `silly_tavern_mode="palink-native"` 群聊 D8 行为；且其 mock 基建 `_make_request/_make_mock_db/_make_deps/_make_group/_run_assembly` 被 `test_single_chat_no_group_leakage.py` 跨文件 import——按文件名批量删会打断非回归测试）。建议改名为 native 语义名 |
| `test_st_contract.py`(47) | 保留 ~44 个 `/api/*` 端点契约用例；仅删 3 个 bridge.js 用例（`test_bridge_js_file_exists`/`test_real_api_paths_non_empty`/`test_palink_owned_endpoints_in_bridge_js`），且必须与 `frontend/public/st/` 同批（第二批），否则文件消失导致 FAIL |
| `test_group_speaker_selection.py`(25) | 保留 22 个 native 策略用例；删 3 个：`test_natural_stcompat_ignores_follower`（向 `_select_natural_speaker` 传 st_mode，参数删除后是 TypeError 而非断言失败，容易漏）、`test_resolve_sealed_stcompat_talkative_uses_native_selector`、`test_resolve_sealed_stcompat_voting_uses_native_selector` |
| `test_single_chat_no_group_leakage.py`(6) | 删 2 个直调 build_st_compat_messages 的用例（L118/L132），保留 4 个 native 用例 |
| `test_d3_speaker_card_swap.py`(2) | 保留（实为 palink-native 行为测试，docstring 提 st-compat 仅是历史注记） |

### 随第二批处置

- `backend/tests/run_st_acceptance.py`：容器内验收 harness，9 个 WP 中仅 WP-K（L892-896）直调 build_st_compat_messages——第一批删 WP-K，第二批（/api 端点与容器删除后）整文件删。
- `backend/tests/st_chat_jsonl_roundtrip_check.py`、`st_worldinfo_roundtrip_check.py`：依赖 st_sync_service / silly_tavern.py 权威函数，**保留**（st_sync_service 保留的前提下）。
- `smoke_st_vectors.py`：/api/vector 冒烟，保留。
- `test_n8_cookie_auth.py::TestStRouterCookieAuth`(4)：打的是 `/api/characters/import` 的 Cookie 认证（依赖 `get_st_current_user`），**保留**——"st_router" 指认证依赖而非独立进程。

### 前端

- `lib/sillytavern/__tests__/` 全部 5 个测试文件**零改动**（lib/sillytavern 是插件体系依赖）。
- 受影响仅 `runtime-contract.test.ts` L168 一条注释提及 SillyTavernIframe（it.skip 项），随批清理注释。
- 智能卡三个契约测试不受影响（`'st-compat-v2'` 标签无关）。

### 勾稽预期

第一批删除约 **92（A）+ 19（B）+ 8（C 内）≈ 119 用例**；全量从基线（当前 1289 宿主口径）降至约 1170，需在施工记录里精确对账。容器口径差 3 条 skip 属环境差异，不计。

---

## 7. 脚本处置清单

| 脚本 | 处置 | 批次 |
| --- | --- | --- |
| `scripts/st-compat/`（card_compat.py、st_card_roundtrip.mjs、prompt_golden/ 全套、fixtures/results） | 整目录删（编排 sillytavern 容器或服务 golden vector 测试；golden vector 测试同批删） | 一 |
| `backend/scripts/_verify_stcompat_e2e.py`、`_inspect_stcompat_tail.py`、`_verify_mvu_after_fix.py` | 删（MVU 引擎本体是 native 能力，`test_mvu_engine.py` 覆盖不受影响） | 一 |
| `backend/scripts/_verify_mode_sealed.py` | 删（守卫随批消失） | 一 |
| `scripts/extract_st_golden_vector.py`（根 scripts/） | 删（golden vector 生产者） | 一 |
| `scripts/st_audit/` | **保留**（安全审计工具，打普通 /api/*，与 ST 模式无关） | — |
| `backend/scripts/_diag_*`、`_cleanup_*` 等历史诊断脚本 | 不属本批次，不动 | — |

---

## 8. 建议施工顺序（每步含验证）

**第一批（st-compat，1-2 天量级）**
1. 删 9 个 A 类测试 + golden_vectors 目录 + 4 个脚本 + scripts/st-compat/（先删测试防红）
2. `character_message_builder.py` 删 `build_st_compat_messages`（L540-1042）→ py_compile
3. RPA 按 §3.1 逐点删/拍平（建议自上而下：常量 → 守卫函数 → 三个消费点 → trim 双函数 → 主分支拍平）→ py_compile
4. users.py / silly_tavern.py / schemas / SettingsView 按 §3.3-§3.4（A2 口径）
5. 全量 pytest（勾稽 ~-119）+ tsc + contract + 容器重建 + 冒烟 → commit

**第二批（st-native，2-3 天量级，依赖第一批完成后做更干净）**
1. 删死组件 RoleplayModeSwitcher → tsc（验证确实零引用）
2. 前端：SillyTavernIframe、CharacterChat/CharacterView/App 守卫、SettingsView 收尾、types → tsc + contract
3. 删 `frontend/public/st/` + public 根三文件 + nginx（/st/ 块与 8081 server 块）→ 本地 build + 端口冒烟
4. 同批删 test_st_contract 3 个 bridge.js 用例
5. 后端：st_sync.py、st_groups.py、st_resources.py、openai_compat.py、/api/st/native/*、挂载摘除、st_sync_service 内 ST 文件镜像函数摘除（逐函数 grep）→ py_compile + pytest
6. compose：sillytavern 服务/卷/depends_on/env、config.py ST_NATIVE_*、.env.example → `docker compose up -d` 冒烟
7. `git rm -r SillyTavern-1.18.0/`（983 文件）→ commit（此 commit 建议单独一笔，便于回溯）
8. （可选第三批，另立 spec）silly_tavern.py 端点瘦身 + `silly_tavern_mode` DB 列 drop 迁移（A1 收尾）

---

## 9. 风险与陷阱汇总

- **T1（高）补列清单复活陷阱**：`core/migrations.py` L14 的启动自动补列清单含 `silly_tavern_mode`。若只删 models 列不清这行，后端重启会把列自动加回来（且 alembic drop column 也会被它"复活"）。删列必须三件套同步：models 列 + 补列清单行 + alembic 迁移。
- **T2（高）按文件名/关键词批量删测试必翻车**：`test_st_compat_group_chat_e2e.py` 实测 palink-native；`test_batch_a_st_compat_debt.py`(24) 全走 native 路径只是名字带 st_compat；`test_group_speaker_selection` 里 stcompat 前缀用例只有 3 个；`test_p1_fixes` 仅 1 条。删除必须按 §6 清单点名，删除前先跑定向确认每删一个红一个。
- **T3（中）跨文件测试导入**：`test_single_chat_no_group_leakage` import 自 `test_st_compat_group_chat_e2e`——后者只能改名不能删。
- **T4（中）TypeError 型漏改**：`_select_natural_speaker(..., st_mode=)` 与 `_should_split_char_fields_for_order(preset, st_mode)` 去参后，漏改的调用点表现为 TypeError（测试红灯才算兜住），grep 形参名复核。
- **T5（中）`/csrf-token` 静态豁免链**：CSRF 守卫的静态 `palink-csrf` 分支注释声明"保留给 ST iframe/bridge 兼容流量"。删 ST 静态副本后该豁免理论上可收窄，但动它影响面在 CSRF 安全链，建议第三批单独评估，第二批不动。
- **T6（低）命名陷阱**：`synthesize_tts_st_compat`（form-encoded TTS，前端在用，保留）；`'st-compat-v2'`（智能卡运行时版本标签，保留）；`st-vec::`（记忆向量前缀，保留）；`get_st_current_user`（共享认证依赖，保留）；`_preserve_sillytavern_fields`/`palink_sillytavern` extensions 键（角色卡导入字段保全，与模式无关，保留）。
- **T7（低）`depends_on` 连锁**：compose 里 frontend 依赖 sillytavern（service_started），删服务必须同步删依赖，否则 `docker compose up` 直接报错。
- **T8（低）旧浏览器残留**：`palink-silly-tavern-mode/theme` localStorage 键与 `palink_st_native` cookie 在用户浏览器有残留，删除后端/前端不清理也无功能影响；如需彻底清理可在登出链保留一段时期的 removeItem 兜底（App.tsx L729-826 已有类似清理）。
- **T9（信息）441MB 历史清偿**：SillyTavern-1.18.0 已在 git 历史（983 文件），本次 `git rm` 后历史体积不变；是否 filter-repo 清史维持项目既有口径（不清，破坏面大于收益）。

---

## 10. 待用户拍板点

1. **拍板点 A**：`silly_tavern_mode` 字段走 A1（全链删除 + DB 列 drop）还是 A2（保留死字段）或分步（推荐：第一批 A2、第二批收尾 A1）。
2. **拍板点 B**：第三批（silly_tavern.py 端点瘦身，§4.3 可删候选 ~20 端点族）是否立项、何时做。
3. **拍板点 C**：本 spec 施工是否由本会话继续执行，还是按项目惯例派修复 agent 施工 + 审计线验收（涉及分批派单与禁改矩阵）。

---

*调研过程中的全部判定均可在本仓库复核：符号名 + 文件路径已内文给出；行号为 2026-09-03 工作区快照。*
