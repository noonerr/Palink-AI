# 交接文档：酒馆助手（JS-Slash-Runner）插件在 Palink 跑通

> 交接时间：2026-07-31
> 上一份文档：`docs/handover-plugin-system-2026-07-31.md`（**其 §2.3 关于 jQuery 的描述是错的**，见本文 §4.1）
> 目标读者：接手"让 ST 插件在 Palink 原生 UI 跑起来"这条线的 agent

---

## 0. 三十秒速览

**做了什么**：把「酒馆助手（tavern_helper）插件从数据库 → 下发 → 前端沙箱执行 → 调用 API」这条链路从完全不通打到能执行。改了 3 个文件，共 +682/-29 行。

**现在卡在哪**：脚本能执行了，但它的 UI 渲染由 `eventOn(tavern_events.CHAT_CHANGED / GENERATION_STARTED / ...)` 驱动，**Palink 从未 emit 过这些事件**，回调永不触发。这是下一步第一优先。

**最大的教训**：CSP 的 `unsafe-eval` 缺失让 `new Function()` 被浏览器直接拦截，导致此前所有 API 补全工作全是空转——**脚本一行都没跑过**。排查任何"插件不生效"问题，先确认代码真的执行了，再谈功能对不对。

**当前状态**：代码改动全部在工作区（未 commit）。Docker daemon 在交接时处于停止状态，需要先启动 Docker Desktop 再验证。

---

## 1. 背景与目标

用户的原始诉求是两件事：

1. 装在 Palink 里的 ST 插件前端 UI 不渲染
2. 角色扮演不按角色卡作者的设定回答，"像是把所有东西一股脑发给模型，没按作者意图注入关键信息"

排查后确认这是**两条独立断裂的链路**，第 2 条的根因是角色卡里作者写的剧情机制（MVU 变量维护、格式规则注入、prompt 动态注入）从来没被后端读取过。

用户明确拍板的范围：**只要酒馆助手这一个插件跑通**，对照 https://github.com/N0VI028/JS-Slash-Runner 源码做适配。不要通用翻译层，不要走 st-native 逃生舱。

**战略约束（用户 2026-07-30 明确要求，不可违背）**：ST 兼容不得牺牲 Palink 自主性。真实 ST 后端只能是 opt-in 的逃生舱，绝不能成为主路径。本次所有工作都在 Palink 自有沙箱内完成，符合该约束。

---

## 2. 当前插件数据

| 项 | 值 |
|---|---|
| plugin id | `eb1d50e9-9f19-43ea-a362-75e4266b4991` |
| name | `酒馆助手` |
| plugin_type | `tavern_helper` |
| source_type | `character_card_extension` |
| enabled | `true` |
| config | `{"character_card_extension": true, "global_runtime": false}` |

关联 `plugin_scripts` 两条（都是 `script_type='script'`，非 regex）：

| order_no | script_name | 大小 |
|---|---|---|
| 0 | 对话渲染系统 v7.1 | 237 KB |
| 1 | 数据库界面插件(@bubble改造版) | 4 MB |

脚本原始内容备份在 `/tmp/tavern_scripts/combined.js`（Git Bash 路径，实际是 `C:\Users\Pall\AppData\Local\Temp\tavern_scripts\combined.js`），4.3 MB，两段用 `===SCRIPT_N===` 分隔。**这是唯一备份，原始 `BanG_City.json` 角色卡文件不在仓库里。建议尽快把它复制到项目内持久位置。**

恢复插件的方法（脚本丢失时）见 §6.4。

---

## 3. 已完成的修复

### 3.1 `frontend/security-headers.conf`（1 行，但是最关键的一行）

CSP `script-src` 加了 `'unsafe-eval'`：

```
script-src 'self' 'unsafe-inline' 'unsafe-eval' 'nonce-palink-smart-card'
```

没有这个，`sandbox.ts` 里的 `new Function(code)` 会被浏览器直接抛 `EvalError`，插件代码一行都执行不了。

**安全代价是实打实的**：放开 `unsafe-eval` 意味着任何注入的字符串都可能被当作代码执行。当前是为了让插件能跑而做的取舍，需要产品侧知情。若要收紧，替代方案是把插件执行搬进 iframe（配独立 CSP）或 Web Worker——这也正好和 JS-Slash-Runner 自身的 iframe 模型对齐，见 §7.2。

### 3.2 `backend/app/api/plugins.py`（3 处，+114 行）

| 位置 | 改动 | 原因 |
|---|---|---|
| `/runtime/config` 端点的过滤循环 | `if config.get("global_runtime") is False and plugin.plugin_type != "tavern_helper": continue` | 原来 `global_runtime=False` 直接 skip，tavern_helper 永远不下发到前端 |
| `_effective_runtime_for_plugin` | 加 `elif` 分支，tavern_helper 强制 `execute_scripts=True` + `script_policy='sandbox'` + `enabled=True` | 原来只有 `sillytavern_extension` 会被强制开启脚本执行 |
| `_plugin_runtime_payload` | 对 tavern_helper：从 `plugin.scripts`（relationship backref）读出 `script_type='script'` 且 enabled 的脚本，用 **IIFE 包裹后拼接成单个 `index.js`** 放进 `resources.js`，同时补最小 manifest `{js:'index.js', loading_order:100}` | ① tavern_helper 的脚本存在 `plugin_scripts` 表，不在 `config.resources`，原函数读不到；② 前端 `manager.load()` 只执行**一个**入口文件，多脚本必须拼接；③ IIFE 包裹是为了避免两个脚本的顶层 `const`/`let` 同名冲突 |

### 3.3 `frontend/src/lib/plugin-system/sandbox.ts`（+595 行，改动主体）

| 行号 | 内容 |
|---|---|
| 34 | `tavernVariableStore = new Map<string, Record<string, any>>()` —— 模块级变量存储，按 type 分区，跨插件共享 |
| 37 | `deepMergeObjects()` —— 递归深合并，对齐源码的 `_.mergeWith` |
| 844 | Proxy handler：`top` / `parent` 与 `window`/`self`/`globalThis` 一样返回 `sandboxedWindow` 自身 |
| 1034 | `ST_MOUNT_POINT_IDS` —— 37 个 ST 标准挂载点 id 白名单 |
| 1088 | `createSandboxedJQuery` CSS 选择器分支：沙箱容器查不到时，若选择器是白名单内的 `#id`，**回退查真实 document** |
| 2213 | `buildWrappedCode` 注入 `var TavernHelper = __sandbox.window.TavernHelper`（以及 35+ 个全局函数声明） |
| 2562+ | sandbox 对象上补齐全部酒馆助手 API（明细见下表） |
| 2806 | 在 `sandboxedWindow` 上挂 `TavernHelper` 全局对象，结构对照源码 `getTavernHelper()` |

**补的 API 分三档，接手时必须清楚哪些是真的、哪些是假的：**

| 档位 | API | 说明 |
|---|---|---|
| **真实可用** | `eventOn` / `eventOff` / `eventEmit` / `eventRemoveListener` | 转发到沙箱已有的 `eventSource`（完整 EventEmitter） |
| **真实可用** | `getVariables` / `setVariables` / `replaceVariables` / `getVariable` / `setVariable` / `deleteVariable` / `insertOrAssignVariables` | 读写 `tavernVariableStore`。已对照 `src/function/variables.ts` 修正：深拷贝返回、点号路径支持、深合并 |
| **真实可用** | `tavern_events` / `iframe_events` / `getButtonEvent` | 事件常量，`tavern_events` 映射到 ST `eventTypes` |
| **真实可用** | `setExtensionPrompt` / `substituteParams` / `substitudeMacros` | 沙箱原有能力转发（注意源码里就是拼错的 `substitude`） |
| **尽力而为** | `getChatMessages` / `getLastMessageId` / `getCharacter` / `getCurrentCharacterName` / `getCharData` / `getCharacterNames` | 尝试从 `window.__palinkChatMessages` 或 `window.SillyTavern.getContext()` 读取，**这两个全局目前都不存在** → 实际返回空数组 / -1 / undefined |
| **stub 不崩** | `triggerSlash` / `generate` / `generateRaw` / `setChatMessages` / `deleteChatMessages` / `injectPrompts` / `uninjectPrompts` / `openCharacterChat` / `getWorldbook` 等 | `console.warn` + 返回空值。只保证不抛 `is not defined`，**没有任何实际效果** |

---

## 4. 关键认知（含被推翻的错误认知）

### 4.1 上一份交接文档 §2.3 是错的 —— 沙箱 jQuery 不是真实 jQuery

它写的是「`$`/`jQuery` = 真实 jQuery（查真实 document）」。**实际不是**：`createSandboxedJQuery`（sandbox.ts:1034 附近）把 `$()` 的查询范围锁死在插件私有容器 `palink-extension-container-{id}` 里，`sandboxedDocument.querySelectorAll` 同样。

后果极其隐蔽：ST 插件标准写法 `$('#extensions_settings').append(html)` 查到 0 个元素 → jQuery 语义下**静默 return**，不报错、不打日志、什么都不发生。这就是之前四层"修复"都进了包却始终不渲染的真凶。

**方法论**：遇到"改了但没效果"，优先怀疑**静默失败**（空集合链式调用、catch 吞异常、CSP 拦截），而不是继续叠加修复。

### 4.2 CSP 是最外层的门，且报错只在浏览器可见

`new Function()` 被 CSP 拦截时，后端日志、容器日志、构建日志**全部正常**，grep 产物也能证明代码进了包。只有浏览器 F12 才看得到 `EvalError`。

**方法论**：涉及前端运行时的问题，必须尽早向用户要 F12 Console 输出，不要靠静态验证自证清白。这次因为没早点要，白做了两轮 API 补全。

### 4.3 JS-Slash-Runner 的真实架构

- 所有 API（200+ 个）挂在 `globalThis.TavernHelper` 上，**不是散落的全局函数**
- 脚本在 **iframe 沙箱**里执行，通过 postMessage 与主页面通信；iframe 内会把 `TavernHelper` 的成员解构成全局函数，所以脚本里能直接写 `eventOn(...)`
- 脚本通过 `topWindow?.TavernHelper?.xxx`（`topWindow = window.top`）跨 frame 访问 API —— 这就是为什么必须让沙箱的 `window.top` 返回 `sandboxedWindow`（sandbox.ts:844）
- 变量系统有 7 种 type：`chat` / `character` / `preset` / `global` / `message` / `script` / `extension`
- `getVariables` 用 `klona` 深拷贝返回；`deleteVariable` 支持点号路径（`_.unset` 语义）并返回 `{variables, delete_occurred}`；`insertOrAssignVariables` 用 `_.mergeWith` 深合并

Palink 用 `new Function` 而非 iframe，是一个**模型差异**。目前靠注入全局变量硬凑，能跑但不等价。长期看 iframe 方案更贴合（见 §7.2）。

### 4.4 角色扮演不按设定回答的完整链路断点

角色卡的 `extensions.tavern_helper.scripts` 里确实有作者写的剧情机制（`Magical Fairy` 卡就有 "MVU载入"、"变量结构" 等脚本）。但：

- `roleplay_prompt_assembly.py` 只读 `extensions.depth_prompt`（约 :4449）和 `extensions.regex_scripts`（约 :4190），全文 grep `tavern_helper` **零命中**
- 唯一接触插件的回调 `apply_plugin_regex_scripts`（`character_ext.py:1399`）硬过滤 `script_type == "regex"`，而 tavern_helper 脚本是 `script_type = "script"`，永远命中不了
- 常规角色卡导入 `character_import_service.py:592` 只把 `extensions.tavern_helper` 原样存进 JSON 字段，**不创建 Plugin 记录**；Plugin 表那条记录只能管理员走 `/api/plugins/import` 时由 `_import_from_character_card_extensions`（`plugins.py:916`）创建，且与角色卡**无外键绑定**

所以作者设计的剧情机制从未进过 prompt。**这不是 bug，是从未实现的特性。** 本次工作只打通了前端执行侧，后端 prompt 装配侧完全没动（见 §5.4）。

---

## 5. 未解决问题（严格按优先级）

### 5.1 【最高】ST 事件总线从未 emit —— UI 大概率仍不渲染

脚本靠事件驱动 UI：

```js
eventOn(tavern_events.CHAT_CHANGED, renderUI);
eventOn(tavern_events.GENERATION_STARTED, ...);
eventOn(tavern_events.MESSAGE_RECEIVED, ...);
eventOn(tavern_events.STREAM_TOKEN_RECEIVED_FULLY, ...);
```

Palink 的角色扮演流程（`websocket.py` 的 `_gen` 循环、前端聊天视图）**从来没 emit 过这些事件**，回调注册了但永远不会被调用。

**建议做法**：在前端聊天视图的关键时点调用沙箱 `eventSource.emit(...)`：

| 时点 | 事件 |
|---|---|
| 切换会话/角色 | `CHAT_CHANGED` |
| 发起生成 | `GENERATION_STARTED` |
| 收到流式 chunk | `STREAM_TOKEN_RECEIVED_FULLY` |
| 生成结束落库 | `GENERATION_ENDED` / `MESSAGE_RECEIVED` |

注意后端多人对话已有 `group_speaker_start` / `group_speaker_end` 广播（见项目记忆），可以顺带映射。

### 5.2 【高】`window.__palinkChatMessages` 没暴露

`getChatMessages` / `getLastMessageId` 依赖它，目前必然返回空。需要在聊天视图里维护 `window.__palinkChatMessages = 当前消息数组`（结构要对齐 ST 的 `chat` 数组：`{name, is_user, is_system, mes, send_date, swipes, extra}`）。

### 5.3 【中】stub 类 API 无实际效果

`triggerSlash` / `generate` / `generateRaw` / `setChatMessages` / `injectPrompts` 都是空壳。脚本调用它们不会崩，但也不会发生任何事。要不要实现取决于脚本实际依赖程度——建议等 5.1 做完、UI 能渲染后，看 Console 里 `[PluginSandbox] xxx stub` 的 warn 频次再决定优先级。

### 5.4 【中，但这是用户原始诉求的最后一环】后端 prompt 装配完全不接插件

即使前端脚本算出了变量和格式规则，也回不到 prompt 里。需要：

1. `setExtensionPrompt` / `injectPrompts` 在前端把注入内容回传后端（走 WebSocket 或随 chat_request 带上）
2. `roleplay_prompt_assembly.py` 在装配时读取这些注入内容，按 depth/position 插入

这是"角色扮演不按角色卡设定回答"能真正闭环的必要条件。**在这之前，前端插件跑得再好，模型侧行为也不会变。**

### 5.5 【中】`/runtime/config` 单次返回 4.2 MB JSON

酒馆助手脚本本身就 4.27 MB，全塞在一个 JSON 响应里，首屏性能有风险。建议改成脚本内容走单独端点按需拉取（`/api/plugins/{id}/resource/{path}`），`/runtime/config` 只返回元信息。

### 5.6 【已知风险】CSP `unsafe-eval`

见 §3.1。

### 5.7 【未查清的异常，别写进结论】插件记录曾意外消失

一次 `docker compose down` + `up` 后，`plugins` 表空了。我当时推断是"down 清空了 volume"——**这个推断是错的**：`docker-compose.yml:184` 的 `postgres_data` 是具名 volume，不带 `-v` 的 `down` 不会删除它。

真实原因未查清。可能方向：后端启动时的 alembic 迁移 drop/recreate 了表、某处 seed/reset 逻辑、或 compose project name 变动导致挂了另一个 volume。**接手时如果再遇到数据消失，请优先查后端启动日志里的 alembic 输出**，不要沿用我那个错误结论。

---

## 6. 操作手册

### 6.1 前置

Docker daemon 在交接时是停止的。先启动 Docker Desktop，确认：

```bash
docker ps --format "table {{.Names}}\t{{.Status}}"
```

应有 4 个容器：frontend / backend / db / sillytavern。

### 6.2 构建与重启

```bash
cd "D:/项目/Palink-AI"
docker compose -f docker-compose.yml build frontend   # 约 50s
docker compose -f docker-compose.yml build backend    # 约 10s
docker compose -f docker-compose.yml up -d frontend backend
```

**不要用 `docker compose down`**，用 `up -d` 直接滚动重启，规避 §5.7 那个未查清的数据消失问题。

### 6.3 验证改动是否真的进了产物

前端 chunk 名每次构建会变，**且可能含下划线和连字符**（踩过坑：正则写 `index-[A-Za-z0-9]+\.js` 会漏掉 `index-_4aVQZqh.js`）：

```bash
docker compose -f docker-compose.yml exec -T frontend sh -c \
  "CURRENT=\$(grep -oE 'index-[A-Za-z0-9_-]+\.js' /usr/share/nginx/html/index.html | head -1); \
   echo \"chunk: \$CURRENT\"; \
   grep -oh 'TavernHelper\|substitudeMacros\|insertOrAssignVariables\|accuweather_container' \
     /usr/share/nginx/html/assets/\$CURRENT | sort | uniq -c"
```

验证 CSP 头：

```bash
curl -sI http://localhost:3000/ | grep -i content-security-policy
# 必须含 'unsafe-eval'
```

验证后端下发（后端端口未映射到宿主机，只能容器内跑）：

```bash
docker compose -f docker-compose.yml exec -T backend python3 -c "
from app.api.plugins import _plugin_runtime_payload
from app.models.plugin import Plugin
from app.database import SessionLocal
db = SessionLocal()
p = db.query(Plugin).filter(Plugin.plugin_type=='tavern_helper').first()
payload = _plugin_runtime_payload(p)
js = payload['resources'].get('js', [])
print('manifest.js:', payload['manifest'].get('js'))
print('execute_scripts:', payload['runtime'].get('execute_scripts'))
print('js:', len(js), 'len:', len(js[0]['content']) if js else 0)
db.close()
"
```

期望：`manifest.js=index.js`、`execute_scripts=True`、`js=1`、`len≈4271644`。

### 6.4 插件丢失时的恢复

```bash
# 1. 拷脚本进容器（Git Bash 下 docker cp 需要 Windows 路径）
docker cp "C:\Users\Pall\AppData\Local\Temp\tavern_scripts\combined.js" \
  palink-ai-backend-1:/tmp/combined.js

# 2. 解析并入库
docker compose -f docker-compose.yml exec -T backend python3 -c "
import re
from app.api.plugins import _import_tavern_helper
from app.database import SessionLocal
raw = open('/tmp/combined.js', encoding='utf-8').read()
parts = re.split(r'^===SCRIPT_(\d+)===\s*\n', raw, flags=re.MULTILINE)  # MULTILINE 必须有
scripts = [{'name': f'Script {parts[i]}', 'type': 'script', 'enabled': True,
            'content': parts[i+1].strip()} for i in range(1, len(parts), 2)]
db = SessionLocal()
p = _import_tavern_helper(db, {'scripts': scripts, 'variables': {}}, '酒馆助手',
    source_type='character_card_extension', enabled=True,
    config={'character_card_extension': True, 'global_runtime': False})
print('imported', p.id, len(p.scripts))
db.close()
"
```

漏了 `re.MULTILINE` 会只解析出 1 个脚本 —— 踩过。

### 6.5 浏览器侧排查

打开 http://localhost:3000，F12 Console：

- `[PluginSandbox]` 前缀是沙箱的全部日志出口
- `xxx is not defined` → 还有 API 没补，在 sandbox.ts 加，别忘了同时改 `buildWrappedCode` 的 `var xxx = __sandbox.xxx` 声明（**两处都要改，只改一处不生效**）
- 面板位置：设置 → 管理员 → 插件管理 → 点插件的 ⚙
- 查容器是否注入：`document.getElementById('酒馆助手_container')` 或在 `#extensions_settings` 下找 id 前缀匹配的节点

---

## 7. 给接手人的建议

### 7.1 下一步就做事件总线（§5.1）

其他都可以往后放。脚本现在能执行，但事件不 emit 就等于跑了个空转的状态机。做完这一步才能第一次看到真实的 UI 渲染结果，也才能判断剩下的 stub API 哪些真的需要实现。

### 7.2 中期考虑把插件执行搬进 iframe

现在用 `new Function` + 注入全局变量的方式，和 JS-Slash-Runner 的 iframe 模型不等价，注定要不断打补丁（`window.top`、`TavernHelper` 对象、全局变量声明都是为了模拟 iframe 环境）。搬进 iframe 有三个好处：与上游模型对齐、可以撤掉 `unsafe-eval`（iframe 配独立 CSP）、天然隔离。代价是要实现 postMessage 桥接。

### 7.3 不要偏离用户拍板的战略约束

- 不追求通用 ST 插件适配，就针对具体插件逐个做通
- 真实 ST 后端只能是 opt-in 逃生舱，不能进主路径
- SillyTavern 是 AGPL-3.0，复用其代码有合规风险

### 7.4 少数几条硬经验

1. 先证明代码真的执行了，再谈功能对不对
2. 静默失败（空 jQuery 集合、CSP 拦截）是这套系统的主要故障形态，不会报错
3. 补 API 时对照 https://github.com/N0VI028/JS-Slash-Runner 的 `src/function/*.ts` 源码，别猜签名——我第一版全靠猜，深拷贝/深合并/路径删除三处全错
4. sandbox.ts 里加 API 要改**两处**：sandbox 对象 + `buildWrappedCode` 的全局声明；挂 `TavernHelper` 的话是三处

---

## 8. 文件索引

| 文件 | 本次改动 |
|---|---|
| `frontend/security-headers.conf` | CSP 加 `'unsafe-eval'` |
| `frontend/src/lib/plugin-system/sandbox.ts` | +595 行，主体改动 |
| `backend/app/api/plugins.py` | +114 行，3 处 |

**未改但相关**：

| 文件 | 关系 |
|---|---|
| `frontend/src/lib/plugin-system/manager.ts` | `discover`/`enable`/`load`/`executePluginCode`，`load()` 只执行一个入口 |
| `frontend/src/components/st-plugin-ui-host/StPluginMountPoints.tsx` | 真实 `#extensions_settings` 等挂载点所在 |
| `frontend/src/components/st-plugin-ui-host/PluginSettingsPanel.tsx` | ⚙ 面板，有按 id 前缀查容器的兜底逻辑 |
| `backend/app/services/roleplay_prompt_assembly.py` | prompt 装配，§5.4 要改这里 |
| `backend/app/api/websocket.py` | 生成主循环，§5.1 的事件时点参考 |
| `backend/app/api/character_ext.py:1399` | `apply_plugin_regex_scripts`，硬过滤 `script_type=='regex'` |
