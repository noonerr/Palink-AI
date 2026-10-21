# REPORT_批次WU_插件网络白名单UI_2026-10-21

> 状态：**已完工，前端门禁全绿，尚未重建 dist 上线**（本批纯前端）。
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

判据按 `failed=0`（用例数随并行会话增长，今天 1684 不是基线）。后端与文档门禁见下节。

**未做的验证**：真机浏览器读数（需要重建 dist，见 §5）；
以及 OPEN_ISSUES [P2-14] 验收 ①「真插件复跑后 `Embedding model fetch failed` 消失」——
本批只保证**加白名单这件事用户能自己点**，那条真插件复跑要在上线后跑一次探针才算闭环。

## 5. 上线待办（下一个 agent / 主脑复跑时照做）

1. `tar` 备份现 `frontend/dist` 进 `_BACKUPS/2026-10-21_dist重建前_WU白名单UI/`（含 BACKUP_INFO.md + 台账行）。
2. `VITE_OUT_DIR=dist_x node scripts/build-vite.mjs` → 校验指纹 → `cp -r dist_x/. dist/` → `node scripts/gzip-dist.cjs`。
   纯前端改动，backend 镜像没动，不需要 `docker compose build backend`。
3. 字符串指纹：`grep -c "插件网络白名单" dist/assets/*.js`（**只能 grep 字面量**，标识符会被压缩抹掉）。
4. 真机探针（playwright，独立会话名，付费端点 `page.route` 挡掉）：
   打开 设置 → 插件 → 该栏存在且可见；加 `localhost`；
   `localStorage.getItem('palink_plugin_fetch_whitelist') === 'localhost'`（**逗号，不是 JSON**）；
   复跑 Smart Memory 真插件，看 `Embedding model fetch failed (…11434…)` 是否消失。
   这一步是唯一能证明"用户点的东西真的到达运行时"的证据，别只凭 vitest 绿就宣布闭环。

## 6. 没做 / 不该在本批做的事

- **按插件细分白名单**：现在是全局一条名单，所有插件共享。ST 也没有这个粒度，不做。
- **服务端兜底**：白名单是前端守卫，主文档里跑的经典插件本就能绕（`PLUGIN_SECURITY_MODEL.md`
  §已承认的边界，含 `<script src>`/`<img>` 不经守卫）。本批没有收紧也没有放松这条边界。
- **默认放开本机 AI 端口**：用户裁定是"要开白名单"，不是"默认放开"。默认值仍为空，
  且「加本机 AI 服务」是**要点一下**的按钮 —— 恶意插件探测用户本机服务的风险没有因为本批变大。
- OPEN_ISSUES [P2-14] 第 2 条（`extension_settings.memory` 缺子键导致 `lastActive` 报错）**未动**。
- `docs/PLUGIN_SECURITY_MODEL.md` §用户可配置项已同步改成"先说 UI、手工写法保留"，
  避免两处文档给互相矛盾的操作路径。
