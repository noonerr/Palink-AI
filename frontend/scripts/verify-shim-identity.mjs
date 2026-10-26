/**
 * buildShim 产物逐字节校验工具
 *
 * 用途：CharacterCardRenderer.tsx 拆分模块时，验证 buildShim() 生成的 srcDoc 脚本
 * 字符串在重构前后完全一致（"纯机械拆分不碰逻辑"的硬性证明）。
 *
 * 原理：
 *   1. esbuild 打包 .tsx：**相对路径的本地模块内联进来**（拆分出去的 frame-shim/* 必须真实参与），
 *      裸包名与 @/ 别名一律 external（避免把 299KB 的 SillyTavernCompatRuntime 拖进来）
 *   2. 剥掉残留的 external import 语句，注入最小 stub（React/DOMPurify/api 等在 buildShim 路径上用不到）
 *   3. 在 node:vm 沙箱里求值，取出 buildShim（兼容 esbuild 的 buildShim2 之类重命名）
 *   4. 用固定 context 调用，输出 SHA-256 + 全文快照
 *
 * 用法：
 *   node scripts/verify-shim-identity.mjs snapshot <tsx路径> <输出.txt>
 *   node scripts/verify-shim-identity.mjs compare  <基线.txt> <当前.txt>
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

/** 固定输入，保证两次快照可比 */
const FIXED_CONTEXT = {
  characterId: 'fixture-character-0001',
  characterName: '桃汐',
  userName: '测试用户',
  language: 'zh',
  messageId: 42,
  messageContent: '固定消息内容 for shim identity check',
  chatMessages: [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好呀' },
  ],
  persistedStorage: { localStorage: { k: 'v' }, sessionStorage: {} },
  firstMes: '初次见面',
  alternateGreetings: ['问候A', '问候B'],
  sessionId: 'fixture-session-0001',
  variables: { stat_data: { '桃汐.好感度': 50, '世界信息.日期时间': '2026-08-07' } },
  depth: 0,
  isInit: false,
  trustedNative: false,
  sourceFingerprint: 'fixture-fingerprint',
  presentationMode: 'inline',
  viewport: null,
};
const FIXED_FRAME_ID = 'palink-frame-fixture-0001';

function buildStubPrelude() {
  const noop = 'function(){}';
  return `
const __mkProxy = (name) => new Proxy(function(){}, {
  get: (t, p) => (p === 'memo' || p === 'forwardRef' || p === 'createElement' || p === 'Fragment')
    ? ((x) => x) : __mkProxy(name + '.' + String(p)),
  apply: (t, thisArg, args) => (args && args.length ? args[0] : undefined),
  construct: () => ({}),
});
const React = { memo: (x) => x, forwardRef: (x) => x, createElement: ${noop}, Fragment: 'Fragment',
  useCallback: (f) => f, useEffect: ${noop}, useMemo: (f) => f, useRef: () => ({ current: null }),
  useState: (v) => [v, ${noop}] };
const createPortal = ${noop};
const DOMPurify = { sanitize: (v) => String(v == null ? '' : v), addHook: ${noop} };
const ReactMarkdown = ${noop};
const remarkGfm = ${noop}; const remarkMath = ${noop}; const rehypeKatex = ${noop};
const Maximize2 = ${noop}, Shield = ${noop}, ShieldCheck = ${noop}, X = ${noop};
const cn = (...a) => a.filter(Boolean).join(' ');
const api = __mkProxy('api');
const buildSillyTavernCompatRuntimeV2Shim = () => '';
// runtime-url.ts 经 virtual module 导入（esbuild 视为 external、import 被剥除），
// 需 stub 顶替，否则 SMART_CARD_RUNTIME_URL 求值时 ReferenceError
const runtimeUrl = '';
// legacy-url.ts 同为 virtual module 导入，需 stub 顶替；React2 是 esbuild 对
// 内联模块 React 导入的重命名，import 剥除后同样需顶替
const legacyUrl = '';
const React2 = React;
`;
}

function extractBuildShim(tsxPath) {
  // bundle：相对路径本地模块内联，其余（裸包名 + @/ 别名）一律 external。
  // packages:'external' 的判定是"路径不以 . 或 / 开头"，@/xxx 正好落入 external，
  // 因此 SillyTavernCompatRuntime(299KB) 不会被拖进来，与 stub 行为一致。
  const result = esbuild.buildSync({
    entryPoints: [tsxPath],
    bundle: true,
    write: false,
    format: 'esm',
    target: 'es2022',
    jsx: 'transform',
    packages: 'external',
    // 必须显式 external @/*：源文件在 frontend/ 内时 esbuild 会读 tsconfig 的 paths
    // 把 @/ 解析成真实文件并内联，而备份基线文件在 .backup/ 下找不到 tsconfig 会走 external，
    // 两者不对称会导致快照无法比较。这里统一强制 external。
    external: ['@/*'],
    tsconfigRaw: '{}',
    // 允许直接对备份快照（如 *.tsx.before）取基线
    loader: { '.before': 'tsx', '.bak': 'tsx', '.orig': 'tsx' },
    logLevel: 'silent',
  });

  let code = result.outputFiles[0].text;

  // 剥掉残留的 external import 语句（含多行形式），由 stub 顶替
  code = code.replace(/^\s*import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '');
  code = code.replace(/^\s*import\s+['"][^'"]+['"];?\s*$/gm, '');
  // 剥掉 export 关键字，避免 vm 里的 ESM 语法错误
  code = code.replace(/^\s*export\s+(?=(const|function|type|interface|class|let|var))/gm, '');
  code = code.replace(/^\s*export\s+\{[\s\S]*?\};?\s*$/gm, '');
  code = code.replace(/^\s*export\s+default\s+/gm, 'const __default = ');

  // esbuild 打包时可能因命名冲突把 buildShim 重命名为 buildShim2 等，这里动态定位
  const nameMatch = /\bfunction\s+(buildShim\d*)\s*\(/.exec(code);
  if (!nameMatch) {
    throw new Error(`打包产物中未找到 buildShim 函数声明（${tsxPath}）`);
  }
  const shimName = nameMatch[1];

  const script = `${buildStubPrelude()}\n${code}\n;globalThis.__buildShim = typeof ${shimName} === 'function' ? ${shimName} : null;
globalThis.__buildLegacyExternal = typeof buildSmartCardLegacyExternalScript === 'function' ? buildSmartCardLegacyExternalScript : null;
globalThis.__legacySegment = typeof LEGACY_ST_SIM_SEGMENT !== 'undefined' ? LEGACY_ST_SIM_SEGMENT : null;`;

  const sandbox = {
    globalThis: undefined,
    console,
    window: undefined,
    document: undefined,
    localStorage: undefined,
    navigator: undefined,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Set, Map, WeakSet, WeakMap, JSON, Math, Date, RegExp, Error, Number, String, Boolean, Array, Object,
    TextEncoder, URL, encodeURIComponent, decodeURIComponent, btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: path.basename(tsxPath), timeout: 30000 });

  const fn = sandbox.__buildShim;
  if (typeof fn !== 'function') {
    throw new Error(`未能从 ${tsxPath} 取出 buildShim（可能已重命名或未定义）`);
  }
  return {
    buildShim: fn,
    buildLegacyExternal: sandbox.__buildLegacyExternal,
    legacySegment: sandbox.__legacySegment,
  };
}

/**
 * [LEGACY-EXTERNAL 2026-10-18] 外部化等价性校验。
 *
 * 为什么不能沿用 `compare` 的「整份产物逐字节一致」：外部化必然把 ~135KB 代码搬出
 * srcdoc、换成两个 <script> 标签 —— 整份产物的字节**注定**不同，拿它当判据只会
 * 得到必然的假失败。
 *
 * 真正的判据是「只搬位置、不改行为」，拆成两条可机器校验的命题：
 *   1. body 逐字节一致：内联产物与外部资产源码，从 LEGACY_ST_SIM_SEGMENT 起点
 *      到 IIFE 收尾必须完全相同（只允许引导头不同）；
 *   2. 引导数据完整：外部化产物的内联脚本必须定义 window.__palinkLegacyBoot__，
 *      且其中 ctx / frameId 与内联路径的 ctx / frameId 同值。
 */
function cmdLegacyIdentity(tsxPath) {
  const { buildShim, buildLegacyExternal, legacySegment } = extractBuildShim(tsxPath);
  if (typeof buildLegacyExternal !== 'function') throw new Error('未能取出 buildSmartCardLegacyExternalScript');
  if (!legacySegment) throw new Error('未能取出 LEGACY_ST_SIM_SEGMENT');

  const externalUrl = '/assets/palink-smart-card-legacy-verify000000.js';
  const inline = buildShim(FIXED_CONTEXT, FIXED_FRAME_ID);
  const external = buildShim(FIXED_CONTEXT, FIXED_FRAME_ID, { externalLegacyUrl: externalUrl });
  const assetSource = buildLegacyExternal();

  const tail = (text) => String(text).slice(String(text).indexOf(legacySegment)).replace(/\s*<\/script>\s*$/, '');
  const inlineBody = tail(inline);
  const assetBody = tail(assetSource);
  const shaInline = crypto.createHash('sha256').update(inlineBody, 'utf8').digest('hex');
  const shaAsset = crypto.createHash('sha256').update(assetBody, 'utf8').digest('hex');

  // 引导数据同值校验：从两条产物里各取一段 JSON 比较
  const grab = (text, from, to) => {
    const start = String(text).indexOf(from);
    if (start < 0) return null;
    const rest = String(text).slice(start + from.length);
    const end = rest.indexOf(to);
    return end < 0 ? null : rest.slice(0, end);
  };
  const inlineCtx = grab(inline, 'const ctx = ', ';\n  const frameId');
  const bootCtx = grab(external, 'ctx: ', ',\n  frameId');
  const inlineFrameId = grab(inline, 'const frameId = ', ';\n');
  const bootFrameId = grab(external, 'frameId: ', ',\n};');

  const checks = [
    ['body 逐字节一致', shaInline === shaAsset, `${shaInline.slice(0, 16)}… vs ${shaAsset.slice(0, 16)}…`],
    ['引导 ctx 与内联 ctx 同值', inlineCtx !== null && inlineCtx === bootCtx, `${(inlineCtx || '').length} 字符`],
    ['引导 frameId 与内联 frameId 同值', inlineFrameId !== null && inlineFrameId === bootFrameId, `${inlineFrameId}`],
    ['外部资产不含 HTML 外壳', !/^\s*<script/i.test(assetSource), '首字符 ' + JSON.stringify(assetSource.slice(0, 12))],
    ['外部资产从引导对象取数', assetSource.includes('window.__palinkLegacyBoot__'), ''],
  ];

  console.log(`[legacy] 源文件        : ${tsxPath}`);
  console.log(`[legacy] 内联产物字节  : ${Buffer.byteLength(inline, 'utf8')}`);
  console.log(`[legacy] 外部化后字节  : ${Buffer.byteLength(external, 'utf8')}`);
  console.log(`[legacy] 外部资产字节  : ${Buffer.byteLength(assetSource, 'utf8')}`);
  console.log(`[legacy] body 字节     : ${Buffer.byteLength(inlineBody, 'utf8')} / ${Buffer.byteLength(assetBody, 'utf8')}`);
  let failed = 0;
  for (const [label, ok, detail] of checks) {
    if (!ok) failed += 1;
    console.log(`[legacy] ${ok ? '✅' : '❌'} ${label}${detail ? '  (' + detail + ')' : ''}`);
  }
  console.log(`\n[legacy] failed = ${failed}`);
  if (failed) process.exitCode = 1;
}

function cmdSnapshot(tsxPath, outPath) {
  const { buildShim } = extractBuildShim(tsxPath);
  const out = buildShim(FIXED_CONTEXT, FIXED_FRAME_ID);
  if (typeof out !== 'string' || !out.length) {
    throw new Error('buildShim 返回值非字符串或为空');
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, out, 'utf8');
  const sha = crypto.createHash('sha256').update(out, 'utf8').digest('hex');
  console.log(`[snapshot] 源文件 : ${tsxPath}`);
  console.log(`[snapshot] 输出   : ${outPath}`);
  console.log(`[snapshot] 长度   : ${out.length} 字符 / ${Buffer.byteLength(out, 'utf8')} 字节`);
  console.log(`[snapshot] SHA256 : ${sha}`);
}

function cmdCompare(baselinePath, currentPath) {
  const a = fs.readFileSync(baselinePath, 'utf8');
  const b = fs.readFileSync(currentPath, 'utf8');
  const sa = crypto.createHash('sha256').update(a, 'utf8').digest('hex');
  const sb = crypto.createHash('sha256').update(b, 'utf8').digest('hex');
  console.log(`[compare] 基线 : ${sa}  (${a.length} 字符)`);
  console.log(`[compare] 当前 : ${sb}  (${b.length} 字符)`);
  if (sa === sb) {
    console.log('\n[compare] ✅ 完全一致 —— 拆分未改变任何产物字节');
    return;
  }
  console.log('\n[compare] ❌ 不一致，首个差异位置：');
  const min = Math.min(a.length, b.length);
  let i = 0;
  while (i < min && a[i] === b[i]) i += 1;
  const from = Math.max(0, i - 120);
  console.log(`  偏移 ${i}`);
  console.log(`  基线: ...${JSON.stringify(a.slice(from, i + 120))}`);
  console.log(`  当前: ...${JSON.stringify(b.slice(from, i + 120))}`);
  process.exitCode = 1;
}

const [, , cmd, arg1, arg2] = process.argv;
try {
  if (cmd === 'snapshot' && arg1 && arg2) cmdSnapshot(arg1, arg2);
  else if (cmd === 'compare' && arg1 && arg2) cmdCompare(arg1, arg2);
  else if (cmd === 'legacy-identity' && arg1) cmdLegacyIdentity(arg1);
  else {
    console.error('用法:\n  node scripts/verify-shim-identity.mjs snapshot <tsx路径> <输出.txt>\n  node scripts/verify-shim-identity.mjs compare <基线.txt> <当前.txt>\n  node scripts/verify-shim-identity.mjs legacy-identity <tsx路径>');
    process.exitCode = 2;
  }
} catch (err) {
  console.error(`[error] ${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
}
