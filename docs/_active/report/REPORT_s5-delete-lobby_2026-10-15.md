# S5 删大堂（六步最后一步）完工报告

> 日期：2026-10-15｜分支：**`s5-delete-lobby`**（基线 `395a7ac`，**未 merge**，留分支等主控合）
> 提交：`f5c1a86`（**删码单独一笔**）+ `fc6aa9a`（测试清理/改写）
> 性质：删码（风险最高）｜方式：主工作区串行 + 真机
> 删除口径：**宽口径·整体退役**（主控 2026-10-15 裁决，见 `docs/_active/HANDOFF_提示词_S5删大堂_2026-10-15.md` 第 55-90 行，由 commit `3e7bef0` 定稿）
> 报告口径：每项给「验了什么 / 怎么验的 / 结果 / 证据」。未验成的明确写未通过或无法验证。
>
> ✅ **后续状态（2026-10-16 补记）**：本分支已于 **2026-10-15 18:16 merge 入主干**（merge `e86ad9a`，tag `s5-done`）；
> 随后 **A–H 八组实机评估全过**（C/D 两张口子已真跑），报告
> [`REPORT_s5-arch-e2e_2026-10-15.md`](./REPORT_s5-arch-e2e_2026-10-15.md)。下文的「未 merge」均为成文时点的事实。

---

## 0. 三十秒速览

| 项 | 结果 |
|---|---|
| 删除面 | `frontend/src/utils/sillyTavernPluginRuntime.ts` **整文件删除**（2447 行） |
| 外部触点 | `CharacterChat.tsx` / `CharacterView.tsx` 已同步清理，tsc 无悬空引用 |
| 前端门禁 | **74 文件 / 960 passed / 3 skipped / 0 failed** + `tsc --noEmit` exit 0 |
| 后端门禁 | **2060 passed / 23 skipped / 0 failed**（与基线一致） |
| 真机 | 站点 200，浏览器实载新入口 `index-2sAXca_F.js`；大堂指纹在产物中 **0 命中** |
| 5 插件探针 | **不退化**：4/5 init + 7 条斜杠命令，与基线逐项一致 |
| 单间轨 | iframe bootstrap 仍工作；单间轨运行时产物 **S5 前后字节一致** |
| 偏离登记 | 总闸 `palink_st_plugin_main_page_injection` **一并删**（对方案附录 B 的显式偏离） |
| 验收 #3 | ~~kill switch 三态有效~~ → **作废**（替代兜底 = `git revert f5c1a86`） |

---

## 1. 删除面（按消费方切，不按行数切）

### 1.1 整文件删除

`frontend/src/utils/sillyTavernPluginRuntime.ts`（**2447 行**）。依据（ro-survey §3 实测 + 本轮按消费方复核）：

| 段 | 行范围 | 行数 | 文件外消费方 | 处置 |
|---|---|---|---|---|
| 总闸 `ST_PLUGIN_MAIN_PAGE_INJECTION_KEY` + `isMainPageStPluginInjectionEnabled` | ~16–52 | ~37 | 仅 `CharacterChat.tsx` 两处，均在要删的注入流程内 | **随删**（见 §6 偏离登记） |
| 类型 `SillyTavernChatMessage/Character/Context` | ~54–121 | ~68 | 文件外零消费（本轮 grep 复核） | 随删 |
| `emitClassicPluginEvent` | 122–127 | 6 | `CharacterView.tsx` 唯一调用点，但其监听者只挂在大堂实例上 | 随删 |
| fetch 守卫 `installGlobalFetchGuard` / `restoreGlobalFetchGuard` | 129–203 | ~75 | 仅注入段内部调用 | 随删 |
| `SETUP_PLUGIN_ID` / `InjectIntoContainerOptions` / `computePluginDiff` / `SELF_EMITTED_EVENTS` | ~205–256 | ~70 | 文件外零消费 | 随删 |
| `class SillyTavernPluginRuntime` | 258–2447 | ~2190 | 仅 `CharacterChat.tsx:417` `new`（注入流程内） | 随删 |

> 中口径（只删 `injectIntoContainer`）会留下约 700 行死代码，保守口径（只摘调用点）留约 2400 行，
> 两者都违反「删掉大堂轨」的目的 —— 这是选宽口径的核心理由。

### 1.2 两个外部触点（同步清理，否则 tsc 悬空）

**`frontend/src/components/views/character/CharacterChat.tsx`**
- 删 `card-script-runner` import（原 35-41）+ `sillyTavernPluginRuntime` import（原 74-78）+ `ensureStThirdPartyGlobals` import（原 46-49）
- 删 `stRuntimeRef` 实例化（原 415-418）
- 删 4 个 effect：插件注入（原 1607-1644）、主页面卡脚本执行（原 1655-1704）、离开页清理（原 1706-1716）、设置更新 reload（原 1718-1730）
- 删 `setContext`（原 1773）与 `emit` 四处（原 854 / 866 / 1850 / 1870）
- 删随之失引的 `sessionVariablesRef`

**`frontend/src/components/views/CharacterView.tsx`**
- 删 `emitClassicPluginEvent` import（原 :28）+ 调用（原 :1645）+ 其注释

### 1.3 最后一处运行时引用（死兜底）

`smart-card-runtime/frame-shim/legacy-st-sim-parts/part-b.ts`：删 `window.__palinkStRuntime?.context?.stat_data` 兜底。
该实例从未在 iframe 域被赋值 ⇒ 恒 `undefined`（死表达式），删除后运行时零变化。

字节同一性校验（`frontend/scripts/verify-shim-identity.mjs`，须在 `frontend/` 下跑两步）：

```
[snapshot] 基线（HEAD）SHA256: f5d7089b83dfab07d2e358369eae28805ad9d83ec127fde4ea255058da6395f2  (136590 字符)
[snapshot] 当前        SHA256: 83b384ee8604e6e27d2e436c352bd3a928725d89191513479583a4b2fc6c3011  (136603 字符)
[compare] ❌ 不一致，首个差异位置：偏移 52640
```

⚠️ **这条是预期的不一致，不是失败。** S5 是**删码**，shim 内容被有意改动，字节同一性在语义上不可能成立
（手令里「期望 ✅ 完全一致」沿用的是 S4「机械拆分不得改变产物」的判据，对删码不适用）。
差异范围已逐行核对，**仅限 1107-1112 → 1107-1110 这一处**：

```diff
-    // 防御性补全：避免覆盖 sillyTavernPluginRuntime 已设置好的 stat_data。
-    // 优先 ctx，回退到 runtime 已存的 context，再回退空对象。
-    stat_data:
-      ctx?.stat_data ||
-      window.__palinkStRuntime?.context?.stat_data ||
-      {},
+    // [S5 2026-10-15] 原兜底读主页面大堂轨实例挂在 window 私有键上的 context.stat_data。
+    // 该大堂轨（utils/sillyTavernPluginRuntime.ts）已整体删除，且该实例从未在 iframe 域
+    // 被赋值 ⇒ 该兜底恒为 undefined（死表达式），删除后运行时零变化。
+    stat_data: ctx?.stat_data || {},
```

> 注：初版订正注释里写了 `window.__palinkStRuntime` 字面量，它作为模板串内容会进产物，
> 导致 `grep __palinkStRuntime dist` 仍有 1 命中 ⇒ 已改写为不含该标识符的措辞后重新构建（见 §5）。

---

## 2. 反向红线复核（禁止随删的东西，逐项验证）

| 对象 | 判据 | 结果 |
|---|---|---|
| `lib/sillytavern/card-script-runner.ts` **未被整文件删** | `git status` 无该文件条目；`:457` 消费方仍在 | ✅ 文件原样保留 |
| `buildCardScriptFrameBootstrap` 仍被 `CharacterCardRenderer.tsx:14-16` import、`:457` 调用 | grep 命中 | ✅ |
| frame bootstrap 产物仍在 | 产物里 `palink-smart-card-parent` 命中 2 个 chunk（entry + smart-card-runtime） | ✅ |
| `lib/sillytavern/slash-commands-compat.ts` 仍在 | 源码在；产物里 `runPalinkSlashCommands` / `Palink slash-commands` 均命中 | ✅ |
| `getContext.ts` `[S5-GDEP1]` / `[S5-GDEP2]` 段仍在 | 未动该文件；`getcontext-parity.test.ts`（145 API）全绿 | ✅ |
| 3 个卡片测试随迁且绿 | `card-script-runner.test.ts` / `card-script-storage.test.ts` / `card-script-bridge-write-degradation.test.ts` | ✅ 随全量门禁绿 |
| 5 个保留测试全绿 | `st-plugin-import-wrapper-collision`(16) / `sandbox-dep-decouple`(12) / `slash-commands-sink`(绿) / `getcontext-parity`(145 API) / `st-module-shim-contract` | ✅ 均在 960 passed 内 |
| 旧键兼容未删 | 未动 `smart-card-runtime/storage.ts` 旧键段 | ✅ |
| UI 可见性口径 (c)：11 个离屏挂载桩保留 | 未动 `ensureStPluginMountPointsCompat` | ✅ |
| 5 个测试插件保留 | 未动生产库插件注册 | ✅（探针仍跑出 5 个 holder） |

---

## 3. 门禁（本机实测，改前基线 + 改后复跑，均自跑不转录）

| 门禁 | 基线（`s5-delete-lobby` @ `395a7ac`，改前） | S5 后 | 结论 |
|---|---|---|---|
| `npx vitest run`（frontend） | **79 文件 / 1040 passed / 3 skipped / 0 failed**（15:02:06 起跑，31.96s） | **74 文件 / 960 passed / 3 skipped / 0 failed** | `failed = 0` ✅ |
| `npx tsc --noEmit` | exit 0 | exit 0 | ✅ |
| `py -3 -m pytest tests/ -q --basetemp=/tmp/pb_$RANDOM`（backend） | — | **2060 passed, 23 skipped, 0 failed**（147.43s） | ✅ 与手令基线一致 |

⚠️ **用例数净减少 80（1040 → 960）**，完全来自删大堂专测（见 §4）。
按主控 2026-10-15 裁决「以 `failed=0` 为准，允许净减少」执行 —— 手令正文验收第 4 条仍写「用例数不得减少」，
本报告按主控后续裁决为准并在此显式登记分歧。

---

## 4. 测试处置（含手令漏列的 3 个）

### 4.1 删除（守护对象已被删，无单间轨等价物）

| 文件 | 原由 |
|---|---|
| `utils/__tests__/plugin-runtime-diff-hotswap.test.ts` | 大堂差集热插拔 + 总闸三态断言（总闸已删，gate 对象不存在） |
| `utils/__tests__/plugin-runtime-l1-settings.test.ts` | 大堂轨 `getPresetNames` / `getCharLorebooks` 只读数据源 |
| `utils/__tests__/plugin-runtime-setup-script-parses.test.ts` | 大堂 setup 脚本模板串解析守卫，守卫对象是该文件内的大模板串 |
| `utils/__tests__/plugin-runtime-extprompt-contract.test.ts` | 按源码文本断言该文件的 `setExtensionPrompt` wiring |
| `utils/__tests__/st-plugin-shared-partition.test.ts` | B4 共用插件分区 rebind —— **手令漏列的第 5 个**，实测 `:16` 真的 `import { SillyTavernPluginRuntime }` |

### 4.2 改写（保留存活链路守卫）

- **`lib/sillytavern/__tests__/slash-commands-sink.test.ts`**
  - 删 §C（大堂轨行为对照，靠 `injectIntoContainer` 造真 `window.__palinkBridge`）+ §D 里两条读已删文件源码的断言；
  - 新增**删码守卫**（S5 特有契约）：`utils/sillyTavernPluginRuntime.ts` 源文件必须不存在，
    且存活两轨（沙箱轨 / getContext 轨）不得残留 7 分支内联实现；保留「防假绿」自证断言；
  - A 段（逐命令行为）/ B 段（window 哨兵反证）/ E 段（getContext 轨行为）原样保留。
- **`smart-card-runtime/__tests__/getcharworldbooknames-contract.test.ts`**
  - 删 `MAIN_TRACK_SOURCE` 读取（指向已删文件）+ `MAIN_TRACK_BODY` / `LOREBOOKS_BODY` 切片 + `buildMainTrack` + 6 个主页面轨用例；
  - 帧内两轨（单间轨 shim + 单间轨 runtime）用例与「同步返回 `{primary, additional}`」契约原样保留。

### 4.3 仅注释引用、无需处置（复核实测）

`char-worldbook-fallback-contract.test.ts` / `lorebook-family-contract.test.ts` —— 只在注释里提该文件名，无 import、无源码读取。

### 4.4 全仓悬空引用 grep（验收 #5）

```
grep -rn "sillyTavernPluginRuntime|emitClassicPluginEvent|isMainPageStPluginInjectionEnabled|
         injectIntoContainer|MAIN_TRACK_BODY|LOREBOOKS_BODY|buildMainTrack|LOBBY_SRC|
         LOBBY_SID|LOBBY_UUID|ST_PLUGIN_MAIN_PAGE_INJECTION_KEY|computePluginDiff" frontend/src
```
→ 命中 **25 处全部是注释**（历史沿革说明 / 坐标引用），**零代码引用**。
`grep -rn "__palinkStRuntime" frontend/src` → 零命中。

---

## 5. dist 重建 + 真机三步验证（验收 #8 / #10）

### 5.1 重建流程（禁 `npm run build`、禁 `mv` 重命名）

```
# 备份（palink-ai-repo-ops §3 强制）
_BACKUPS/2026-10-15_dist_S5删大堂重建前/dist   286M；index.html sha16 = 5c15db0454424650；拷贝后校验一致
# 构建 → 纯增量合并 → gzip（只增不删）
VITE_OUT_DIR=dist_s5 node scripts/build-vite.mjs      # ✓ built in 39.24s
cp -r dist_s5/. dist/
node scripts/gzip-dist.cjs                            # 2098 个 .gz
```

### 5.2 产物指纹（新 `dist_s5`，期望全 0）

| 指纹 | 旧构建（备份）命中 chunk 数 | 新构建（`dist_s5`） |
|---|---|---|
| `palink_st_plugin_main_page_injection` | 12 | **0** |
| `__palink_runtime_setup__` | 36 | **0** |
| `__palinkSetExtensionPrompt` | 36 | **0** |
| `__palinkStRuntime` | 72 | **0** |

正向对照（确认不是「整包没更新」）：新产物 entry chunk 内 `Palink slash-commands` = 1、`runPalinkSlashCommands` = 1、
`palink-smart-card-parent`（frame bootstrap）= 命中。

### 5.3 真机三步（`curl` 均加 `--noproxy '*'`，端口 14700）

```
① curl -s http://127.0.0.1:14700/                     → 200
② 入口 chunk = index-2sAXca_F.js
③ curl -s -o /dev/null -w "%{http_code}" .../assets/index-2sAXca_F.js → 200
   大堂指纹在该 chunk 内：4 项全部 0 命中
```

**浏览器实载确认**（playwright，非只看 curl）：页面 `script[src]` = `["/assets/index-2sAXca_F.js", "/bootstrap.js"]`
⇒ 浏览器确实加载了 S5 后的新入口，不是命中历史堆积 chunk。

### 5.4 真机运行时信号（DOM / 运行时对象，不靠 console —— 生产包 `drop_console` 会剥日志）

- `document.getElementById('palink-st-plugin-host')` → **false**（大堂不再建宿主容器）
- `window.__palinkStRuntime` → **undefined**、`window.__palinkBridge` → **undefined**（大堂注入的 window 桥已随删）
- 卡 iframe 内 bootstrap 仍活：`getScriptId` / `insertOrAssignVariables` / `tavern_events` 全部 **true**（验收 #7 ✅）

---

## 6. 偏离登记（对方案附录 B 的显式偏离，主控已批准）

**方案附录 B** 原文：「总闸 `palink_st_plugin_main_page_injection` 保留到 S5 之后的下一个版本」。

**本次处置：随大堂一并删除**（含 `ST_PLUGIN_MAIN_PAGE_INJECTION_KEY` + `isMainPageStPluginInjectionEnabled`）。

理由：
1. 它唯一 gate 的对象就是本次要删的注入流程（`CharacterChat.tsx:1621` / `:1720` 两处开关检查）；
2. 保留它**不提供任何回退能力** —— 真正的回退路径是 `git revert f5c1a86`，而 revert 会把开关一起恢复；
3. 留着只会制造「还有回退开关」的错觉。

**连带：验收标准第 3 条「kill switch 三态有效（拨动后能切回）」作废。**
替代兜底 = `git revert f5c1a86`（删码单独一笔 commit，revert 成本最低）。
对应守卫测试 `plugin-runtime-diff-hotswap.test.ts`（`:101-106` 断言三态）已在「改写而非保留」清单内随之处置。

---

## 7. 5 插件端到端探针（验收 #6，重跑后对比基线）

脚本：`D:\项目\_palink-s0-20261012\_probe_s5_delete_lobby.js`（照抄 `_probe_s3_fix_verify10.js`）
留底：`_probe_s5_delete_lobby_raw.txt`

| 项 | 基线（`_probe_s3_fix_verify12_raw.txt`） | S5 后 | 判定 |
|---|---|---|---|
| `2e1fa886b439` | ok | ok | 一致 |
| `43ef24b1a3ba` | ok | ok | 一致 |
| `01db1f12ddd0` | ok | ok | 一致 |
| `4d61e879d0c5`（quick-reply） | throw `Failed to fetch` | throw `Failed to fetch` | 一致（未通，非 S5 回归） |
| `ca0611884034` | ok | ok | 一致 |
| `75e4266b4991` | no-init-export | no-init-export | 一致 |
| `slashAfter` | **7** | **7** | 一致 |
| slash 命令名 | translate/regex/regex-state/regex-toggle/regex-preset/summarize/count | 同左，逐项相同 | 一致 |

⇒ **4/5 init + 7 条斜杠命令不退化**，「单间轨独扛」成立。

---

## 8. 验收标准逐条对照

| # | 标准 | 结果 |
|---|---|---|
| 1 | 故意抛错的卡脚本不影响其他消息与页面 | ⚠️ **部分**：机制由 `card-script-runner.test.ts`（单条失败隔离、幂等、止血开关）守护且全绿；`buildCardScriptFrameBootstrap` 每条脚本各自 try/catch + `report()` 上报，产物中仍在工作（§5.4）。**本次未做「故意抛错卡脚本」真机注入演练**（需构造带坏脚本的卡），沿用手令原有的 S3 补测结论 —— 如实标注未本轮复验。 |
| 2 | 所有静默失效落降级统计，且插件管理页可见 | ⚠️ **部分**：`recordStubHit` → `syncWindow()` 写 `window.__palinkCompatStats` 的链路完好，由 `slash-commands-sink.test.ts`（`/profile-list` 登记 `slash:profile-list`）与 `getcontext-parity.test.ts` 守护且全绿。真机上本角色/本卡**未触发任何降级桩**（`__palinkCompatStats` 为 undefined 属正常——它只在首次 `recordStubHit` 时惰性创建），故未取到非空样本；**插件管理页可见性沿用 S3 Phase A 截图结论，未本轮复验**。 |
| 3 | kill switch 三态有效 | ⛔ **作废**（随总闸删除；替代兜底 `git revert f5c1a86`）。见 §6。 |
| 4 | 门禁全绿 + tsc 0 | ✅ 前端 74 文件/960 passed/3 skipped/**0 failed** + tsc 0；后端 **2060 passed / 23 skipped / 0 failed**。用例数按主控裁决允许净减少（§3）。 |
| 5 | grep 无悬空引用 | ✅ 25 处命中全为注释，零代码引用；`__palinkStRuntime` 零命中。 |
| 6 | 5 插件探针不退化 | ✅ 4/5 init + 7 命令，与基线逐项一致（§7）。 |
| 7 | `CharacterCardRenderer.tsx:457` iframe bootstrap 仍工作 | ✅ 卡 iframe 内 `getScriptId` / `insertOrAssignVariables` / `tavern_events` 全 true。 |
| 8 | `card-script-runner.ts` 未被整文件删 | ✅ 文件原样保留，frame bootstrap 在产物中仍命中。 |
| 9 | `slash-commands-compat.ts` 与 `getContext.ts` `[S5-GDEP1]/[S5-GDEP2]` 仍在 | ✅ 源码在 + 产物命中 + 145 API 契约测试绿。 |
| 10 | dist 重建到 S5 分支 + 真机三步验证 | ✅ 入口 `index-2sAXca_F.js` 200 + 新指纹 0 命中 + 浏览器实载确认 + 大堂 4 项指纹全 0。 |
| 11 | 完工不 merge，留 `s5-delete-lobby` 分支 | ✅ 未 merge。 |

---

## 9. 本轮发现（登记为未做项，非 S5 回归）

**单间轨 iframe 的 `SillyTavern.getContext()` 不暴露 `triggerSlash`。**
真机实测：卡 iframe 内 `window.triggerSlash` 不是函数；`window.SillyTavern.getContext()` 里也没有 `triggerSlash`
⇒ 卡内脚本/插件在单间轨走「Palink 专有 9 命令名」这条路**走不通**（只能拿到插件自注册的 7 条）。

已证伪「S5 引入」：单间轨运行时产物 `palink-smart-card-runtime-1a15e6820ae7.js` 在
**S5 前后 sha256 完全相同**（`1a15e6820ae710da1601687c3ce5a0cc433cbcbd5655f5022c23305f3af3e03d`，364466 B），
且旧产物内 `triggerSlash` 计数本来就是 **0** ⇒ 属既有缺口，不是本次删除造成。

⇒ 建议并入「单间轨接口缺口」议题（与 §5.1 quick-reply 的 iframe fetch、§5.3 MVU 世界书同批），**本次不动**。

---

## 10. 环境与后续待办

- 备份：`_BACKUPS/2026-10-15_dist_S5删大堂重建前/`（286M，`BACKUP_INFO.md` 已建，`_INDEX.md` 已登记）。
  回滚 = `cp -r <该目录>/dist/. frontend/dist/`（**勿先删 dist**，bind mount）。
- 构建目录 `frontend/dist_new` 与 `frontend/dist_s5` 需隔离到 `_BACKUPS/_QUARANTINE_2026-10-15/`（禁 `rm`）。
- tag `s5-done` 待打；仓库外 bundle 更新后须 `grep refs/heads` 确认 `s5-delete-lobby` 在内。
- **未 merge**：本分支留在 `s5-delete-lobby` 等主控合；合并后若动过 `docs/` 须重跑 `gen_docs_catalog.py`。
