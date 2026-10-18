/**
 * 智能卡 COMPAT_V2 运行时的**两种测试载体** —— 选错就假绿，import 前请先读完本节。
 *
 * ── 载体一 `COMPAT_V2_RUNTIME_SOURCE`：仓库源码文本（**未求值**）──────────────
 * SillyTavernCompatRuntime.ts 的运行时体原本是一个巨型模板字符串（原第 270-7312 行）。
 * S4 按行把它机械拆成了 `runtime-body/part-01..08.ts`，仍然按单文件 readFileSync 的旧测试
 * 会拿不到被搬走的片段。这里按拆分前的**原文顺序**（入口文件 + 各段）把源码拼回整段文本 ——
 * 断言的依旧是仓库里的真实源码，不是重写出来的副本。
 *
 * ⚠️ 顺序即原文件顺序：入口文件（TS 头 + 拼接壳）在前，part-01..08 按行号升序在后。
 *    不可调换；新增段时必须同步加进 PARTS。
 *
 * 为什么用 readFileSync 而不是 import 各段常量：各段是模板字符串，import 进来拿到的是
 * 求值后的产物；这里要的是「源码文本」本身（含尚未求值的插值占位 `${bootHeader}`、以及
 * TS 侧的 `buildSmartCardCompatRuntimeBootPayload` 白名单），与拆分前完全一致。
 *
 * ⇒ **只准用于字符串断言**（toContain / toMatch / 顶层键名统计）。
 *
 * ── 载体二 `COMPAT_V2_RUNTIME_ARTIFACT`：生产实际注入 iframe 的脚本（**已求值**）──
 * 直接取生产入口 `buildSmartCardCompatRuntimeExternalScript()` 的返回值 ——
 * 与浏览器里那张卡片的 iframe 跑的那段文本**逐字节相同**（同一函数、同一模板求值）。
 * ⇒ **凡 `new Function(...)` 执行并断言行为的测试必须用它**，没有例外。
 *
 * ── 为什么两者不可互换（2026-10-18 包L 实测）──────────────────────────────
 * 运行时体是模板字符串：想让 iframe 看到「反斜杠 + d」，源码里必须写**两个**反斜杠。
 * ⇒ 载体一的文本拿去 `new Function` 执行，**两个方向都会错**（实测探针见报告）：
 *   · 源码写单反斜杠 `/^\d+$/`：载体一执行 = 「一位以上数字」（测试绿），
 *     生产 iframe 拿到的是 `/^d+$/` = 只匹配字母 d（线上坏）
 *     —— 包H 查出的 part-07 `normalizeCompatEntries` 就是这一类，还原条目数实测 2 vs 0；
 *   · 源码写双反斜杠 `/^\\d+$/`（正确写法）：生产 iframe 得到 `/^\d+$/`（对），
 *     而载体一执行时双反斜杠被当成正则里的「字面量反斜杠 + d」⇒ 还原条目数实测 0 vs 2。
 * 也就是说：**载体一执行出来的行为跟生产没有任何对应关系**，本地绿不说明线上好，
 * 本地红也不说明线上坏 —— 它测的是「这份 .ts 文本自己作为 JS 是什么」。
 *
 * 求值后产物里还剩哪些反斜杠丢失点，由
 * runtime-source-carrier-fidelity.test.ts 逐条登记（含坐标），别再靠人记。
 *
 * 两个载体一共有**三处**系统性口径差（同一份源码的三个差异维度）：
 *   ① 反斜杠转义：见上，两个方向都会错，是最要命的一条；
 *   ② 插值占位：载体一保留 `${bootHeader}` / `${IDB_NS_RUNTIME_SOURCE}` /
 *      `${VARIABLES_COMPAT_SOURCE}` 原文，载体二里是求值后的真源码 —— 所以「白名单里
 *      有没有这个键」这类断言只能用载体一，「帧内有没有这行」只能用载体二；
 *   ③ 行尾：源文件是 CRLF，模板求值按 ECMAScript 把 CR/CRLF 归一成 LF。
 *      跨行 toContain / 区域逐字节比对前先归一行尾，否则会出现「只差一个回车」的假阴性。
 *
 * 附带事实：legacy 段的 `LEGACY_ST_SIM_SEGMENT` 本身就是模板字符串常量，import 进来
 * 即求值后产物 —— 所以老那一侧的测试天然用载体二语义，**不需要**改造。
 *
 * 假绿清单、探针输出与迁移登记表：
 * docs/_active/report/REPORT_包L_测试载体不保真假绿清单_2026-10-18.md
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSmartCardCompatRuntimeExternalScript } from '../SillyTavernCompatRuntime';

const RUNTIME_RELATIVE_DIR = 'src/components/ui/custom/smart-card-runtime';
const PARTS_RELATIVE_DIR = `${RUNTIME_RELATIVE_DIR}/runtime-body`;

/** 顺序 = 原模板行号顺序（part-01 起 270 行，part-08 止 7312 行）。 */
const PARTS = [
  'part-01.ts',
  'part-02.ts',
  'part-03.ts',
  'part-04.ts',
  'part-05.ts',
  'part-06.ts',
  'part-07.ts',
  'part-08.ts',
];

/** 载体一：未求值源码文本。**只做字符串断言**，执行型测试请用载体二。 */
export const COMPAT_V2_RUNTIME_SOURCE: string = [
  // 入口文件：TS 头（类型、boot payload 白名单等断言目标都在这一段）+ 拼接壳
  readFileSync(join(process.cwd(), RUNTIME_RELATIVE_DIR, 'SillyTavernCompatRuntime.ts'), 'utf8'),
  ...PARTS.map((file) => readFileSync(join(process.cwd(), PARTS_RELATIVE_DIR, file), 'utf8')),
].join('');

/**
 * 载体二：与生产逐字节一致的求值后运行时体（外部脚本路径，即默认生产路径）。
 * 内联回退路径只有 boot header 不同，part-01..08 主体一致，切片类测试无需区分。
 */
export const COMPAT_V2_RUNTIME_ARTIFACT: string = buildSmartCardCompatRuntimeExternalScript();
