# REPORT_批次WU_插件网络白名单UI_2026-10-21

> 状态：**已完工并已上线**（纯前端，第九次上线窗口；真机读数见 §5）。
> 施工范围：把一条"机制早就通、只有手工敲 localStorage 才能用"的能力变成用户点得到的设置。
> 用户裁定原文：`要开白名单`（对应 `docs/OPEN_ISSUES.md` [P2-14] 补记 第 1 条）。

## 0. 一句话结论

白名单**不是缺机制**，是缺入口。本批加入口，并把"UI 写的格式"和"沙箱读的格式"合并成同一份实现，
用两文件 25 个用例钉住整条链（点按钮 → 落盘逗号格式 → `isUrlAllowedByPluginWhitelist` 真放行）。

## 1. 开工时现场（前一个 agent 被打断，留了半成品）

`git status` 现场是三个文件的**未完成态**，逐文件核对结果：

| 文件 | 现场状态 | 本批做了什么 |
|---|---|---|
| `plugin-fetch-whitelist.ts`（新增，133 行） | **完整**：解析/序列化/归一化/读写 + 文件头把"JSON 为什么是拒绝而不是兼容"讲清了 | 未改动，只补测试 |
| `sandbox.ts` | **完整**：删掉内联的 `DEFAULT_CDN_WHITELIST` 与旧解析，改调 `readEffectivePluginFetchWhitelist()` | 未改动，只记行号漂移 |
| `AdminPluginsTab.tsx` | **半成品**：import/state/handler 都在，**JSX 一行没写** —— `userHosts`/`hostInput`/`hostError`/`Globe`/三个 handler 全是死变量 | 补渲染段 + 两处逻辑修正 |

⇒ 现场可以直接接着做，不需要回退。但"state 齐全、JSX 缺失"这种半成品 **tsc 不报错**
（项目没开 `noUnusedLocals`），也就是说：**只跑 tsc 会当它是完工的**。这是本批最值得记的一条。

## 2. 改动清单

### 2.1 `AdminPluginsTab.tsx` 新增「插件网络白名单」栏（插在「导入说明」之后、降级统计卡之前）

- 固定放行五项（`cdn.jsdelivr.net` / `unpkg.com` / `cdnjs.cloudflare.com` /
  `raw.githubusercontent.com` / `github.com`）以**只读 chip** 展示，明确写"不可删除"；
  它们不写进 localStorage，所以用户删不掉、也不会被误当成自己加过的。
- 输入框 + 「添加」+ 回车同效；`host:port` 与完整 URL 会被收成裸主机名（`normalizeWhitelistHostInput`）。
- 「加本机 AI 服务」一次补 `localhost` + `127.0.0.1`，**已存在的跳过**（现场那版是无条件 push，
  连点两次会在 state 里留下重复项；虽然后端序列化会去重，但 UI 会闪重复 chip ⇒ 改成先过滤）。
- 每条用户项带删除按钮；删到空 ⇒ 键被 `removeItem`（回到"默认保持空"的初始态）。
- 非法输入：就地报错「请输入合法主机名，例如 localhost 或 127.0.0.1」，**不写盘、不产生条目**。
- 每次变更立即落盘。判定侧每次请求现读（`readPluginFetchWhitelist` 没有缓存），
  所以"对下一次插件请求立即生效"这句文案是真的，不是安慰话。

### 2.2 一处语义收窄（现场没有，本批加的）

`handleAddHost` 现在先看**固定名单**：用户加 `unpkg.com` 时提示"本来就在固定放行名单里"，
**不落成用户项**。否则会造出一条"删了也照样放行"的假条目 —— 这正是历史上
「假开关」那类投诉的形状（批次UI1-4 刚删过一个指向不存在开关的文案）。

### 2.3 测试两文件

- `frontend/src/lib/plugin-system/__tests__/wu-plugin-fetch-whitelist.test.ts`（17 例）
  格式契约（逗号 / 非 JSON / 去重 / 默认项在前 / 空列表删键）+ **直接调沙箱那个导出判定**
  复核放行，不是再读一遍 localStorage。
- `frontend/src/components/views/settings-tabs/__tests__/wu-plugin-whitelist-ui.test.tsx`（8 例）
  真渲染 `AdminPluginsTab`（jsdom + `react-dom/client`，`api`/`sonner` 打桩，沿用
  `prompt-settings-ui1.test.tsx` 的套路），断言"点 UI → 存储 → 判定"整链贯通。
  这文件才是本批真正的守卫：单测解析函数抓不到"UI 写了运行时不认的格式"。

## 3. 推翻的一条我自己写错的断言

原打算钉"畸形 URL 判 false 不抛"。实测 `isUrlAllowedByPluginWhitelist('not a url')` = **true**。
原因：判定里是 `new URL(url, window.location.href)`，带基址 ⇒ 相对写法被解析成**本站同源**
⇒ 走"同源恒放行"那条分支。而**这条是必须的**：P-6 路由里插件就是靠
`fetch('/scripts/extensions/…/settings.html')` 这类相对路径加载自身模板。
⇒ 真返回 false 的只有"URL 构造本身失败"（`http://`）。测试按实测改写，并把这个反证留在注释里。

**安全边界要说清**：放开 `localhost` 等于放开本机**所有端口**（判定只比 hostname，端口不参与）。
这是既有语义（本批没改判定逻辑），但对"我只想放开 Ollama 11434"的用户是反直觉的，
所以 UI 文案写明"端口和路径会被忽略，判定只看主机名"。要做端口级细粒度是**另一个批次**，
不是这里顺手能加的（加了就得改判定 + 所有已存值的语义）。

## 4. 门禁与验证

```
bash scripts/gate.sh frontend
  ✓ 前端 tsc --noEmit
  ✓ 前端 vitest   Test Files 130 passed (130) / Tests 1684 passed | 3 skipped
  全部门禁通过（rc=0）
```

判据按 `failed=0`（用例数随并行会话增长，今天 1684 不是基线）。文档门禁同批跑过：
`bash scripts/gate.sh docs` → 目录一致 + ST 上游引用可复核，`failed = 0`，rc=0。

## 5. 上线（第九次上线窗口，纯前端）

```
备份   _BACKUPS/2026-10-21_dist重建前_WU白名单UI/frontend_dist.tar.gz（236 MB）
构建   VITE_OUT_DIR=dist_wu node scripts/build-vite.mjs → ✓ built in 44.16s（196 文件）
覆盖   cp -r dist_wu/. dist/（只增不删：8866 → 8988 文件）
gzip   node scripts/gzip-dist.cjs → 3878 个 .gz
指纹   dist 里 插件网络白名单 / 加本机 AI 服务 / palink_plugin_fetch_whitelist / 当前没有自定义放行主机 全部命中
服务   curl :16000/ 入口 = index-B1gYRfbW.js（旧 index-CikMaYdG.js 仍在盘上，已开着的页面不会被抽掉 chunks）
```

`grep 字面量` 是唯一可信的产物校验（标识符与路径会被压缩抹掉），四个字符串各命中 1–2 次。
backend 镜像没动，未重建容器。

### 5.1 真机读数（playwright 会话 `wu_live1`，`.tmp_probe/wu_live.js`）

走的是**用户会走的那条路**：设置 → 插件管理 → 这一栏。

```json
{ "login": 200, "tabClicked": true, "sectionVisible": true,
  "defaultChips": ["cdn.jsdelivr.net","unpkg.com","cdnjs.cloudflare.com","raw.githubusercontent.com","github.com"],
  "emptyStateShown": true,
  "afterUrlAdd": "localhost",            // 粘的是 http://localhost:11434/api/tags
  "chipLocalhost": true,
  "afterPreset": "localhost,127.0.0.1",  // 已存在的 localhost 没被重复加
  "invalidErrorShown": true, "afterInvalid": "localhost,127.0.0.1",   // 报错且没写盘
  "afterDefaultAdd": "localhost,127.0.0.1", "userChipUnpkg": false,   // 固定项不落成用户项
  "afterRemove": "localhost",
  "finalStored": "localhost,127.0.0.1", "storedIsCommaNotJson": true }
```

⇒ **本批的核心承诺（UI 写出来的东西 = 运行时认的格式）在真机上成立**：
落盘是 `localhost,127.0.0.1`，逗号、裸主机名、无引号无方括号。

### 5.2 ⚠️ 一条我打算验证却**没验成**的事（基线自己消失了）

原计划：上线后复跑 Smart Memory 真插件，看 `Embedding model fetch failed (…:11434…)`
从"有"变"没有"，作为 [P2-14] 验收① 的闭环。
跑了 A/B（`.tmp_probe/wu_ab.js`，同一张卡、同样 16s 等待，只是白名单一臂删空一臂填上）：

```json
{ "noWhitelist":   { "stored": null, "kinds": 27, "n11434": 0, "nLastActive": 0 },
  "withWhitelist": { "stored": "localhost,127.0.0.1", "kinds": 27, "n11434": 0, "nLastActive": 0 } }
```

**双臂都是 0 —— 不是"白名单生效所以错误消失"，是插件根本没发那个请求。**
查 `/api/plugins`（`.tmp_probe/wu_plugins.js`，只取 name/type/enabled/count）：

```
Smart Memory  sillytavern_extension  enabled=false
ComfyInject   sillytavern_extension  enabled=false
Kimi Thinking Prefill  …             enabled=false
Regex / Summarize / Token Counter / Chat Translation / Quick Replies / 酒馆助手  enabled=true
```

⇒ **Smart Memory 现在是关的**，所以它不联网、不报错，A/B 失去对照组。
21:04 那轮日志（`console-…T13-04-35…log`：`11434` 命中 5 次、`Embedding model fetch failed` 2 次）
时它是开的 —— **在 21:04 与 21:37 之间被关掉了，不是我关的**（本批所有探针没有发过
任何 `PUT /api/plugins/{id}/toggle`，只读 + 重建 dist）。
谁关的我不知道，留给用户确认；这条不作为本批结论。

⇒ 所以 [P2-14] 验收① 的准确表述是：**"UI 写入格式正确 + 运行时读同一份"已由真机 + 25 个用例证明；
"真插件因此联网成功"这一环本轮无法证伪也无法证实**。要补的话，得先把 Smart Memory 打开再跑
`.tmp_probe/wu_ab.js`（⛔ 那是全局插件，开启会影响其他用户的插件面，需用户点头或改用自己的私有插件）。
`lastActive`（[P2-14] 第 2 条）同样因为插件没跑而本轮读不到，既没修好也没坏。

## 6. 没做 / 不该在本批做的事

- **按插件细分白名单**：现在是全局一条名单，所有插件共享。ST 也没有这个粒度，不做。
- **服务端兜底**：白名单是前端守卫，主文档里跑的经典插件本就能绕（`PLUGIN_SECURITY_MODEL.md`
  §已承认的边界，含 `<script src>`/`<img>` 不经守卫）。本批没有收紧也没有放松这条边界。
- **默认放开本机 AI 端口**：用户裁定是"要开白名单"，不是"默认放开"。默认值仍为空，
  且「加本机 AI 服务」是**要点一下**的按钮 —— 恶意插件探测用户本机服务的风险没有因为本批变大。
- OPEN_ISSUES [P2-14] 第 2 条（`extension_settings.memory` 缺子键导致 `lastActive` 报错）**未动**。
- `docs/PLUGIN_SECURITY_MODEL.md` §用户可配置项已同步改成"先说 UI、手工写法保留"，
  避免两处文档给互相矛盾的操作路径。
