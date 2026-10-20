# PROMPT — 对话派包 · 批次 E2（宿主插件沙箱两处「帧内已修、宿主漏修」+ debugger.css 的 @import）2026-10-21

> 状态：**待施工**（主脑已备好，等上线窗口一起走）。零上下文执行件。复核方 = Qoder「分配分包派遣任务」会话（主脑）。
> 通用红线读 `docs/_active/HANDOFF_提示词_已授权批次_写桥与人设角色库与getContext与服务端留痕_2026-10-20.md` §0。
> 起因 = 实机取证：`docs/_active/report/REPORT_控制台报错九类定性_2026-10-21.md`（9 类里 6 类是我们的锅），
> 优先级登记在 `docs/OPEN_ISSUES.md` [P2-12] 第 17 行。**本批只做其中最便宜、最确定的三条。**

## 0. 为什么这三条最划算
它们的共同点是：**同一处缺陷在"帧内运行时"里早就修好了，宿主插件沙箱漏修**，
所以修法不用发明，照抄已验证的实现即可，风险极低、收益是消掉真机上两类高频报错。

## 1. 三个缺陷与已核实的锚点（主脑 2026-10-21 逐条 grep 过，行号仍以标识符复核为准）

### E2-1 `extension_settings` 缺 ST 预置命名空间 ⇒ 插件 init 直接抛
- 真机报错：`[PluginSandbox] … Chat Translation … init …: TypeError: Cannot convert undefined or null to object`
  （`Object.hasOwn(undefined)`；memory 扩展同因，报的是 `Object.keys(undefined)`）。
- **帧内已修**：`frontend/src/components/ui/custom/smart-card-runtime/runtime-body/part-01.ts:745-755`
  —— 预置 `disabledExtensions`（数组）、`['quickReply','quickReplyV2','translate','memory','regex']`
  五个命名空间（非对象就重置成 `{}`）、`regex_presets`（数组），注释里点名了这两个报错。
- **宿主漏修**：`frontend/src/lib/plugin-system/sandbox.ts:3065` 调 `migrateLegacyExtensionSettings()`，
  紧接着 `:3066-3090` 那个 Proxy 的 `get` 对未知键**返回 `undefined`**（`:3078-3081`，
  注释写的是"对齐 ST 1.18.0：未知属性返回 undefined"）。
- 要做：在宿主侧**同样预置那一份名单**（照抄帧内的键名与形状），
  ⚠️ 但**保留**"真正未知的键仍返回 `undefined`"这条 ST 语义 —— 别把 Proxy 改成什么都返回 `{}`，
  那会让插件的 `if (extension_settings.foo)` 探测全部失真。
- 名单唯一来源：把这份键名列表抽成**一处常量**并让帧内/宿主都能引用它
  （帧内在模板字符串里，不能 `import` ⇒ 允许两边各写一份，但**必须加一条守卫测试断言两份名单一致**，
  否则迟早就漂）。

### E2-2 转译器规则 11 就地赋值 ⇒ `export { X }` 早于 `const X` 时撞 TDZ
- 真机报错：`[PluginSandbox] … Summarize …: ReferenceError: Cannot access 'MODULE_NAME' before initialization`。
- **帧内已修**：`runtime-body/part-02.ts:700-707` —— 用**活绑定**
  `Object.defineProperty(exports, "<exported>", { enumerable: true, get: function () { return <local>; } })`，
  注释里写明依据：`memory/index.js:34` 的 `export { MODULE_NAME }` 早于 `:36` 的 `const`，
  ES module 是懒绑定，立即赋值必撞 TDZ。
- **宿主漏修**：`sandbox.ts:2621-2635` 规则 11 仍是 `module.exports.X = X;` 立即赋值。
- 要做：把规则 11 改成与帧内同形的活绑定；顺带检查**同一函数里其它规则**（`export const/let/var`、
  `export class`、`export default`、hoistedExports 那段 `:2637-2640`）有没有同样的"早引用"隐患，
  有就一并按活绑定改，没有就在报告里写明"逐条看过、只有规则 11 有这个问题"。

### E2-3 `debugger.css` 的 `@import` 无人重写 ⇒ 每轮 14 次 MIME 报错
- 源头：`st-plugins/regex/style.css:1` 就是 `@import "debugger.css";`（主脑已核）。
- 这是**批次Q1 放开同源后新出现的可见报错**（opaque 帧不发这个请求），属良性副作用、零功能损害，
  但每轮刷屏 14 条会淹掉真报错。
- 要做（择一，报告里写明选了哪个与理由）：
  (a) 在注入插件 CSS 的那一处把 `@import "<name>.css"` 重写成可解析的形态（数据 URI 或已注册的 blob/URL）；
  (b) 若重写代价大，就把这类"已知无害的资产 404/MIME"在**取证面**降噪（⚠️ 不是把 console 关掉，
      是给我们的诊断记录器加一条已知项白名单，并留一条"被降噪了几次"的计数，不许静默）。
- ⚠️ 若走 (a) 且需要改 `runtime-body/part-*.ts`：**先确认没有别的 agent 在改同一个 part 文件**
  （批次P3 正在改 `part-07.ts`），撞车就改走 (b) 并在报告里说明。
  模板串纪律：内部只能 ES5、禁反引号、禁 `${`、反斜杠成对写；改完必须跑
  `runtime-body-template-literal-guard.test.ts` 与 `generated-script-parse-guard.test.ts`，**不能只信 tsc**。

## 2. 验收判据
1. **可执行测试**（jsdom/vitest，⛔ 不许只写"源码里含有某字符串"的文本断言）：
   - E2-1：宿主沙箱起来后 `extension_settings.translate` 等五个键都是对象、`regex_presets` 与
     `disabledExtensions` 是数组；**未知键仍返回 `undefined`**；两份名单一致的守卫测试。
   - E2-2：把一段"`export { MODULE_NAME }` 在 `const MODULE_NAME = …` 之前"的插件源码喂给宿主转译器，
     求值后 `exports.MODULE_NAME` 能读到正确值且不抛 TDZ；**再用真实插件源码**
     （`st-plugins` 里 memory/summarize 那个 `index.js` 的对应片段）跑一遍。
   - E2-3：按你选的方案给判据（重写后 URL 可解析 / 降噪计数可见）。
2. **反证**（每条都要"先红、再还原、再绿"）：把 E2-1 的预置名单去掉 ⇒ 对应测试红；
   把规则 11 改回立即赋值 ⇒ TDZ 测试红；E2-3 同理。
3. `bash scripts/gate.sh frontend` **rc=0 且 failed=0 且 errors=0**（passed 数字不是验收线）；
   `npx tsc --noEmit` 干净；动了 `docs/` 就 `py scripts/docs/gen_docs_catalog.py --check` 必须 `OK`
   （本机 `python` 是空壳，**用 `py`**）。
4. ⚠️ **实机判据由主脑来跑**：这三条都要重建 dist 才生效，而**只有主脑能上线**。
   你交付后主脑会部署并复跑 `.tmp_probe/errtriage_full.js`，看那两类报错是否真消失。
   所以你的报告里要写清"预期上线后哪几条报错归零、哪几条不变"，让主脑能对着核。

## 3. ⛔ 禁止清单
- 不动 `runtime-body/part-07.ts`、`SmartCardCompatController.ts`、`CharacterCardRenderer.tsx`、
  `backend/app/services/preset_overlay.py`、`backend/app/api/prompt_manager.py`
  （**批次P3 的外部 agent 正在改这些**，撞车会毁掉两批）。
- 不动 `backend/app/services/character_message_builder.py`（批次JB 刚提交）。
- 不重建 `frontend/dist`、不启动/重启 Docker、不做任何上线动作、不调用付费 API。
- 不建表、不加列、不写迁移。不新增 `skip` / `|| true` / `continue-on-error`。
- 不改插件源码本身（`st-plugins/**` 是第三方插件的原文，改它等于改别人的卡）。
- 不把 console 报错"消音"当作修复：降噪必须留计数、可复核。

## 4. 提交纪律
- 开工前 `git status --porcelain` 原样贴进报告；**工作区里现在有大量别人的在途改动**
  （preset 域 + part-07 + 控制器 + 渲染器 + `backend/tests/test_p3_*`），一律不碰、不一起提交。
- 临时索引提交：`GIT_INDEX_FILE=<仓内临时文件> git read-tree HEAD` → 逐项 `git add <自己的 path>` →
  `git write-tree` → `git commit-tree -p <旧 HEAD>` → **先 `unset GIT_INDEX_FILE`** →
  `git update-ref refs/heads/three-tracks-merge-20261012 <新> <旧>` → 最后 `git reset -q HEAD -- <自己的 path>`。
- ⛔ 禁止 `git add -A` / `git add .` / `--no-verify` / amend 别人的提交。
- **门禁不绿就不许提交**：共享树可能因为别人的在途改动而红，这时把红按文件归属列出来、
  用干净 worktree（`git worktree add --detach <路径> HEAD` + 只拷你这批文件）自证绿，
  ⚠️ 后端隔离验证要先 `mkdir -p backend/data`（sqlite 用相对路径 `./data/palink.db`，
  新 worktree 里没这个目录会出 4 条假 error）。

## 5. 报告格式
`docs/_active/report/REPORT_批次E2_宿主沙箱两处照抄与debuggercss_2026-10-21.md`：
① 每条做了什么 + 文件:行号；② 可执行测试的用例数与断言要点；③ 反证各红了什么、怎么恢复；
④ 门禁 rc 与 failed/errors 两数；⑤ **预期上线后报错变化表**（哪几条归零、哪几条不变、为什么）；
⑥ 没做的事与原因；⑦ 与本件不一致处单列"否证主脑"——发现前提不对就停下回报，不要照错的做，也不要默默改设计。
