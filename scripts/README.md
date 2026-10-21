# scripts/

本目录是仓库的**一次性/生成类工具**落点。本文件目前只登记**生成器**类脚本 —— 也就是说，
"仓库里有一份机器生成的产物，它由谁产出、什么时候必须重跑"。其余调试/探针脚本暂不在这里索引。

---

## `gen-bundled-plugin-css.mjs` —— 生成 `bundled-plugin-css.generated.ts`

```bash
node scripts/gen-bundled-plugin-css.mjs           # 写盘（同内容时 NO-CHANGE，不空写）
node scripts/gen-bundled-plugin-css.mjs --check    # 只比对，漂移退出 1（不改文件）
node scripts/gen-bundled-plugin-css.mjs --stdout   # 打到标准输出，不写文件
```

产物：`frontend/src/lib/sillytavern/bundled-plugin-css.generated.ts`
（导出 `REGEX_DEBUGGER_CSS`，被 `bundled-plugin-css.ts` 的 `BUNDLED_ST_PLUGIN_CSS` 表消费，
用于构建期内联 `st-plugins/regex/style.css` 首行的 `@import "debugger.css";`）。

### 什么时候必须重跑

1. **`st-plugins/regex/debugger.css` 内容变了**（改样式、改换行、改编码都算）。
2. **守卫测试红了**：
   `frontend/src/lib/sillytavern/__tests__/bundled-plugin-css.generated.test.ts`
   里那条 `REGEX_DEBUGGER_CSS 与 st-plugins/regex/debugger.css 逐字节相等`。
   这条测试就是用来抓"改了源 CSS 忘了重跑本脚本"的 —— 它红了先确认源文件的改动是有意的，
   然后跑本脚本，**不要手工编辑 `.generated.ts`**。
3. **新增同类资产**（"仓内有、插件 source_data 里没有、站点也不下发"的 CSS）：
   往 `gen-bundled-plugin-css.mjs` 的 `SOURCES` 加一行 → 重跑 → 同步
   `bundled-plugin-css.ts` 的 `BUNDLED_ST_PLUGIN_CSS` 表 key → 补守卫断言。
   注意 `SOURCES` 顺序会改变产物字节，别无害调序。

### 逐字节契约

产物 = 固定头注释 + 每源一行
`export const <NAME>: string = JSON.stringify(readFileSync(源, 'utf8'));` + 换行。

头注释**不含生成时间戳**（写死"批次E2b 2026-10-21 生成"作为来源标记而非时刻），
所以同一份源反复生成必得同一份字节，可以拿 `sha256sum` 对。源文件的 CRLF/BOM 一律不加工 ——
守卫测试用的是同一个 `readFileSync(..., 'utf8')` 口径。

> 历史：这份产物在 2026-10-21 批次E2b 里是**一次性手写**的，仓内没有生成脚本，
> 只有逐字节守卫（只能报"漂了"、不能"修回去"）。该遗留登记在
> `docs/_active/report/REPORT_第三次上线实测_批次E2b与UI1_2026-10-21.md` §4 遗留①，
> 本脚本即其收口。
