#!/usr/bin/env node
/**
 * gen-bundled-plugin-css.mjs —— 生成 frontend/src/lib/sillytavern/bundled-plugin-css.generated.ts
 *
 * 背景（批次E2b 2026-10-21 立的遗留①，本脚本是收口）：
 *   `st-plugins/regex/style.css` 首行 `@import "debugger.css";`，但 debugger.css 不在插件
 *   source_data 里、站点也不下发 `/st-plugins/*` ⇒ 浏览器发请求必 404/MIME 拒绝。
 *   修法是构建期把内容内联，内容以 TS 字符串模块形式存在（不能用 `?raw`，原因见
 *   bundled-plugin-css.ts 文件头：该模块会被 vite.config.ts 的配置期导入链吃到）。
 *   此前那份 .generated.ts 是一次性手写产物，**没有生成脚本** ⇒ 改坏了只能人肉回忆，
 *   守卫测试只能报"漂了"不能"修回去"。本脚本补上这条退路。
 *
 * 契约（逐字节，脚本与守卫测试两侧口径一致）：
 *   产物 = 固定头注释 + `export const <NAME>: string = JSON.stringify(源文件 utf8 全文);` + `\n`
 *   守卫 frontend/src/lib/sillytavern/__tests__/bundled-plugin-css.generated.test.ts
 *   用 `readFileSync(源, 'utf8')` 与导出的常量比 `toBe` ⇒ 只要产物里是
 *   `JSON.stringify(readFileSync(源,'utf8'))`，两侧就永远同源。
 *   头注释**不含时间戳**（写成固定的"批次E2b 2026-10-21 生成"来源标记），
 *   所以同一个源文件反复生成必然是同一份字节 —— 这是"能还原"的前提。
 *
 * 什么时候必须重跑（详见 scripts/README.md）：
 *   - 上表 SOURCES 里任何一个 .css 源文件被改（内容/换行/编码）；
 *   - 新增"仓内有、插件资产里没有"的 CSS（往 SOURCES 加一行，并同步
 *     bundled-plugin-css.ts 的 BUNDLED_ST_PLUGIN_CSS 表与守卫测试）；
 *   - 守卫测试报 `REGEX_DEBUGGER_CSS 与 st-plugins/regex/debugger.css 逐字节相等` 失败时
 *     —— 先确认源文件改动是有意的，再跑本脚本，不要手工编辑产物。
 *
 * 用法：
 *   node scripts/gen-bundled-plugin-css.mjs            # 写盘
 *   node scripts/gen-bundled-plugin-css.mjs --check    # 只比对，漂移则退出 1（不改文件）
 *   node scripts/gen-bundled-plugin-css.mjs --stdout   # 打到标准输出，不写文件
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 产物路径（相对仓库根）。 */
const OUTPUT_REL = 'frontend/src/lib/sillytavern/bundled-plugin-css.generated.ts';

/**
 * 源清单：一个导出常量对应一个仓内真实 CSS 文件。
 * 顺序即产物里的声明顺序 —— 改动顺序会让产物字节漂移，别无谓调。
 */
const SOURCES = [
  {
    exportName: 'REGEX_DEBUGGER_CSS',
    relPath: 'st-plugins/regex/debugger.css',
  },
];

/**
 * 固定头注释。不带生成时间戳，保证同输入同输出（可逐字节还原）。
 * 这段文字与 2026-10-21 那份手写产物的头部完全一致，末尾必须自带换行。
 */
const HEADER = `/**
 * AUTO-GENERATED — 不要手工编辑。
 * 来源：${SOURCES.map((s) => s.relPath).join('、')}（批次E2b 2026-10-21 生成）
 * 重新生成：见 scripts/README 或报告 docs/_active/report/REPORT_批次E2b_正则脚本形状与宏注册与debuggercss_2026-10-21.md。
 * 守卫：frontend/src/lib/sillytavern/__tests__/bundled-plugin-css.generated.test.ts 逐字节比对源文件。
 */
`;

function build() {
  const lines = [HEADER];
  for (const { exportName, relPath } of SOURCES) {
    const abs = join(REPO_ROOT, relPath);
    // utf8 读，与守卫测试的 readFileSync(..., 'utf8') 完全同一口径（CRLF/BOM 都不加工）。
    let css;
    try {
      css = readFileSync(abs, 'utf8');
    } catch (e) {
      console.error(`[gen-bundled-plugin-css] 源文件读取失败：${relPath}`);
      console.error(String(e && e.message ? e.message : e));
      process.exit(2);
    }
    lines.push(`export const ${exportName}: string = ${JSON.stringify(css)};\n`);
  }
  return lines.join('');
}

const outAbs = join(REPO_ROOT, OUTPUT_REL);
const produced = build();

let current = null;
try {
  current = readFileSync(outAbs, 'utf8');
} catch {
  current = null;
}

const mode = process.argv[2] || '--write';

if (mode === '--stdout') {
  process.stdout.write(produced);
  process.exit(0);
}

if (mode === '--check') {
  if (current === null) {
    console.log(`[gen-bundled-plugin-css] MISSING ${OUTPUT_REL}`);
    process.exit(1);
  }
  if (current === produced) {
    for (const { relPath } of SOURCES) {
      console.log(
        `OK ${relPath} bytes=${Buffer.byteLength(readFileSync(join(REPO_ROOT, relPath), 'utf8'))}`,
      );
    }
    console.log(`[gen-bundled-plugin-css] UP-TO-DATE ${OUTPUT_REL}`);
    process.exit(0);
  }
  console.log(`[gen-bundled-plugin-css] STALE ${OUTPUT_REL} 与源文件不一致`);
  console.log(`  修复：node scripts/gen-bundled-plugin-css.mjs`);
  process.exit(1);
}

if (current === produced) {
  console.log(`[gen-bundled-plugin-css] NO-CHANGE ${OUTPUT_REL}（已是最新）`);
  process.exit(0);
}
writeFileSync(outAbs, produced, 'utf8');
console.log(
  `[gen-bundled-plugin-css] WROTE ${OUTPUT_REL} bytes=${Buffer.byteLength(produced)}`,
);
