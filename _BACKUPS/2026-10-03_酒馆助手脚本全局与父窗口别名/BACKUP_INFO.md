# BACKUP_INFO

| 项 | 内容 |
|---|---|
| **① 备份日期** | 2026-10-03 |
| **② 原始来源路径** | `D:\项目\Palink-AI\frontend\src\components\ui\custom\smart-card-runtime\frame-shim\legacy-st-sim.ts`<br>`D:\项目\Palink-AI\frontend\src\components\views\character\CharacterChat.tsx` |
| **③ 备份原因** | 修复「酒馆助手插件在智能卡 iframe 里认不出当前角色（`currentCharId: default`）→ 面板/按钮不出现」以及「卡内脚本因缺 `z`/`Vue` 全局而整段失效」。改动前留档，便于回退与比对。 |

## ④ 后续待办清单

1. **`legacy-st-sim.ts` 的 `[PARENT-ALIAS]` 白名单需扩表**：`makeAlias()` 目前只放行
   `postMessage / jQuery / $ / document / localStorage / sessionStorage / addEventListener /
   removeEventListener / dispatchEvent / parent / top / self / window / globalThis /
   frames / length / location`，**其余一律返回 `undefined`**。
   生态脚本惯用 `topWindow.SillyTavern` / `topWindow.Mvu` / `topWindow.TavernHelper` /
   `topWindow.getVariables` 跨帧读父页面，落到这里全成 `undefined` → 插件回退 `"default"`。
   需把上游 `src/iframe/predefine.js` 的放行清单（`EjsTemplate / TavernHelper / YAML /
   showdown / toastr / z` + `SillyTavern` / `Mvu`）并入白名单，**返回 iframe 自己的同名全局**
   （与本文件已有的 `jQuery`/`$` 同策略），不要返回真实父帧对象（安全面不变）。
2. **主页面缺 `z`(zod v4) / `Vue`(3.5.x) / `YAML` / `showdown` / 完整 `_`(lodash)**：
   上游 `third_party_object.ts` 把 `zod` 挂 `globalThis.z`、`YAML` 挂 `globalThis.YAML`，
   `third_party_script.html` 在脚本 iframe 里从 CDN 加载 Vue + vue-router。
   Palink 一个都没有 → 卡内 `mvu_zod.js` 报 `z is not defined`、`MagVarUpdate` 报
   `Vue is not defined` → 变量系统（状态栏/好感度/变量面板）整体失效。
3. **改完必须重跑门禁**：`cd frontend && npx tsc --noEmit`、`npx vitest run`。
4. **改完必须重建前端产物并确认容器服务新指纹**（提交 ≠ 上线）。
5. `legacy-st-sim.ts` 是模板字符串常量，改动后按文件头注释第 3 条重跑
   `node scripts/verify-shim-identity.mjs` 更新字节快照（或说明差异）。
