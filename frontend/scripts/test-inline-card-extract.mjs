/**
 * 内联卡片脚本抽取的冒烟测试。
 *
 * 用真实角色卡（明月秋青）的状态栏 HTML 跑一遍 extractInlineCardScripts，
 * 验证：脚本被完整抽走、顺序正确、DOMContentLoaded 被改写、数据块不被当 JS、
 * 且抽取后的 HTML 里不再残留任何 <script>。
 *
 * 用 esbuild 把 TS 源码转成 ESM 后动态 import，保证测的是真实现而不是副本。
 *
 * 运行： node frontend/scripts/test-inline-card-extract.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const srcFile = path.join(
  repoRoot,
  'frontend/src/components/ui/custom/smart-card-runtime/inline/inline-sanitize.ts',
);

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log('  ✅ ' + name);
  } else {
    fail += 1;
    console.log('  ❌ ' + name + (detail ? '  → ' + detail : ''));
  }
}

// 只编译 extract 相关的纯逻辑：把 DOMPurify 与 html-extract 依赖 stub 掉（它们需要 DOM）
const stubPlugin = {
  name: 'stub-dom-deps',
  setup(build) {
    build.onResolve({ filter: /^dompurify$/ }, () => ({ path: 'dompurify', namespace: 'stub' }));
    build.onResolve({ filter: /html-extract$/ }, () => ({ path: 'html-extract', namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
      contents: args.path === 'dompurify'
        ? 'export default { sanitize: (h) => h };'
        : 'export function removeFullDocumentShell(h) { return h; }',
      loader: 'js',
    }));
  },
};

const result = await esbuild.build({
  entryPoints: [srcFile],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  plugins: [stubPlugin],
  logLevel: 'silent',
});

// 写进 node_modules/.cache（已被忽略），不做删除：
// 工作区启用了 safe-delete 护栏，unlinkSync 会走回收站并可能失败。
const cacheDir = path.join(repoRoot, 'frontend', 'node_modules', '.cache', 'inline-card-test');
fs.mkdirSync(cacheDir, { recursive: true });
const tmp = path.join(cacheDir, 'inline-sanitize.mjs');
fs.writeFileSync(tmp, result.outputFiles[0].text, 'utf8');
const mod = await import(pathToFileURL(tmp).href + '?t=' + Date.now());

const { extractInlineCardScripts, INLINE_CARD_INIT_EVENT } = mod;

/* ── 1. 合成用例：覆盖各种 script 形态 ────────────────────────────── */
console.log('\n[1] 合成用例');
const synthetic = `
<div id="panel">hello</div>
<script>document.addEventListener('DOMContentLoaded', function(){ init(); });</script>
<script src="https://cdn.example.com/lib.js"></script>
<script type="application/json" id="card-data">{"a":1,"b":"</div>"}</script>
<script type="module">const x = 1; console.log(x);</script>
<script type="text/template" id="tpl"><div>{{name}}</div></script>
<p>tail</p>
`;
const out = extractInlineCardScripts(synthetic, 'test');

check('抽取到 5 个 script', out.scripts.length === 5, '实际 ' + out.scripts.length);
check('HTML 中已无 <script> 残留', !/<script/i.test(out.html));
check('占位符数量与脚本数一致',
  (out.html.match(/data-palink-script=/g) || []).length === out.scripts.length);
check('DOMContentLoaded 已改写为 ' + INLINE_CARD_INIT_EVENT,
  out.scripts[0].type === 'inline' && out.scripts[0].code.includes(INLINE_CARD_INIT_EVENT)
  && !out.scripts[0].code.includes('DOMContentLoaded'));
check('外链脚本识别正确',
  out.scripts[1].type === 'external' && out.scripts[1].src === 'https://cdn.example.com/lib.js');
check('JSON 数据块标记为 data（不会被当 JS 执行）',
  out.scripts[2].type === 'data' && out.scripts[2].mimeType === 'application/json');
check('JSON 数据块保留原属性（id 可被 getElementById 取到）',
  (out.scripts[2].rawAttrs || '').includes('id="card-data"'));
check('type=module 降级为可执行 inline（共享全局作用域）',
  out.scripts[3].type === 'inline');
check('text/template 标记为 data',
  out.scripts[4].type === 'data' && out.scripts[4].mimeType === 'text/template');
check('脚本顺序与文档顺序一致',
  out.scripts[0].type === 'inline' && out.scripts[1].type === 'external');

/* ── 2. 真实角色卡 HTML 样本（从角色库导出） ───────────────────────── */
console.log('\n[2] 真实角色卡 HTML 样本');
const sampleDir = path.join(repoRoot, '.backup');
const samples = fs.existsSync(sampleDir)
  ? fs.readdirSync(sampleDir).filter((f) => /^statusbar-sample-\d+\.html$/.test(f)).sort()
  : [];

if (samples.length === 0) {
  console.log('  ⚠️  未找到样本（.backup/statusbar-sample-*.html），跳过');
} else {
  const globalUsage = new Set();
  let totalScripts = 0;

  for (const file of samples) {
    const html = fs.readFileSync(path.join(sampleDir, file), 'utf8');
    const realOut = extractInlineCardScripts(html, file.replace(/\D+/g, ''));
    const originalScriptCount = (html.match(/<script\b/gi) || []).length;
    const inlineScripts = realOut.scripts.filter((s) => s.type === 'inline');
    totalScripts += realOut.scripts.length;

    const codeKB = (inlineScripts.reduce((n, s) => n + (s.code || '').length, 0) / 1024).toFixed(1);
    console.log('  ── ' + file + '  ' + (html.length / 1024).toFixed(1) + 'KB'
      + '  脚本 ' + realOut.scripts.length + ' 段 / 代码 ' + codeKB + 'KB');

    check(file + ' 抽取数与原始 <script> 数一致',
      realOut.scripts.length === originalScriptCount,
      '抽到 ' + realOut.scripts.length + ' / 原有 ' + originalScriptCount);
    check(file + ' 抽取后无 <script> 残留', !/<script\b/i.test(realOut.html));
    // 长度守恒校验：剩余 HTML 应约等于「原始 - 被抽走的 <script> 整块 + 占位符」。
    // 不能用固定百分比阈值——脚本占比高的卡（如 sample-3 有 92% 是 JS）会误报。
    const scriptBlockChars = (html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gim) || [])
      .reduce((n, s) => n + s.length, 0);
    const placeholderChars = realOut.scripts
      .reduce((n, s) => n + ('<div data-palink-script="' + s.id + '"></div>').length, 0);
    const expected = html.length - scriptBlockChars + placeholderChars;
    const drift = Math.abs(realOut.html.length - expected);
    check(file + ' 长度守恒（除 script 外无内容丢失）',
      drift <= 8,
      '实际 ' + realOut.html.length + ' / 期望 ' + expected + ' / 偏差 ' + drift);
    check(file + ' 无残留 DOMContentLoaded 监听',
      !inlineScripts.some((s) => (s.code || '').includes("addEventListener('DOMContentLoaded")
        || (s.code || '').includes('addEventListener("DOMContentLoaded')));

    const allCode = inlineScripts.map((s) => s.code || '').join('\n');
    for (const g of ['waitGlobalInitialized', 'getAllVariables', 'eventOn', 'errorCatched',
      'Mvu', 'TavernHelper', 'getContext', 'eventSource', 'stat_data', 'jQuery', '$(', '_.']) {
      if (allCode.includes(g)) globalUsage.add(g);
    }
  }

  console.log('\n  样本总计 ' + samples.length + ' 个卡片 / ' + totalScripts + ' 段脚本');
  console.log('  卡片实际引用的 ST 全局: ' + ([...globalUsage].join(', ') || '(无)'));
  console.log('  → 上述全局必须由 inline-st-globals.ts 提供，否则内联后卡片会报 ReferenceError');
}

console.log('\n结果: ' + pass + '/' + (pass + fail) + ' 通过');
if (fail > 0) {
  console.log('存在失败 ❌');
  process.exit(1);
}
console.log('全部通过 ✅');
