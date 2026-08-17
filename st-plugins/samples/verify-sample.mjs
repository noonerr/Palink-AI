// 在 Node 环境实跑 Palink 轻插件范本（palink-sample-extension），验证 Palink 原生 UI
// 沙箱（sandbox.ts）对轻量 ST 扩展的兼容链路。
//
// 复刻 sandbox.ts 的双源 transpile + makeRequire 逻辑（与 2026-07-30 修复一致），
// 并 mock 真实 jQuery / extension_settings 共享 store / document，
// 加载真实 index.js，断言：
//   1) 多文件模块加载（import ./core/constants.js 解析）
//   2) extension_settings[EXT_ID] 初始化
//   3) jQuery('#extensions_settings').append 注入设置面板（含 container id）
//   4) 复选框 change 更新 settings 并触发 saveSettingsDebounced
//
// 运行：node verify-sample.mjs

import { readFileSync } from 'node:fs';

const SAMPLE_DIR = new URL('./palink-sample-extension/', import.meta.url);
const indexCode = readFileSync(new URL('index.js', SAMPLE_DIR), 'utf8');
const constCode = readFileSync(new URL('core/constants.js', SAMPLE_DIR), 'utf8');

// ---- 复刻 sandbox.ts: transpileEsmToCommonJS（核心部分） ----
function parseNamedBindings(bindings) {
  return String(bindings).split(',').map((s) => s.trim()).filter(Boolean)
    .map((s) => { const m = s.match(/^(\w+)\s+as\s+(\w+)$/); return m ? `${m[1]}: ${m[2]}` : s; });
}
function transpileEsmToCommonJS(code) {
  let result = code;
  result = result.replace(/\bimport\s*\{\s*([^}]+?)\s*\}\s*from\s*(['"])([^'"]+)\2\s*;?/g,
    (_m, bindings, _q, path) => `var { ${parseNamedBindings(bindings).join(', ')} } = require(${JSON.stringify(path)});`);
  result = result.replace(/\bimport\s+(\w+)\s+from\s*(['"])([^'"]+)\2\s*;?/g,
    (_m, name, _q, path) => `var ${name} = (() => { var __m = require(${JSON.stringify(path)}); return __m.default !== undefined ? __m.default : __m; })();`);
  result = result.replace(/\bimport\s*(\w+)\s*,\s*\{\s*([^}]+?)\s*\}\s*from\s*(['"])([^'"]+)\3\s*;?/g,
    (_m, defName, bindings, _q, path) => {
      const names = parseNamedBindings(bindings);
      let out = `var __mod_${defName} = require(${JSON.stringify(path)}); `;
      out += `var ${defName} = __mod_${defName}.default !== undefined ? __mod_${defName}.default : __mod_${defName};`;
      if (names.length) out += ` var { ${names.join(', ')} } = __mod_${defName};`;
      return out;
    });
  result = result.replace(/\bimport\s*['"]([^'"]+)['"]\s*;?/g, (_m, p) => `require(${JSON.stringify(p)});`);
  result = result.replace(/\bexport\s+default\s+/g, 'module.exports.default = ');
  result = result.replace(/\bexport\s+(const|let|var)\s+(\w+)\s*=/g, (_m, k, n) => `${k} ${n} = module.exports.${n} =`);
  result = result.replace(/\bexport\s+(async\s+)?function\s+(\w+)/g, (_m, a, n) => { hoisted.push(n); return `${a || ''}function ${n}`; });
  result = result.replace(/\bexport\s+class\s+(\w+)/g, (_m, n) => { hoisted.push(n); return `class ${n}`; });
  result = result.replace(/\bexport\s*\{\s*([^}]+?)\s*\}/g, (_m, b) => parseNamedBindings(b).map((i) => {
    if (i.includes(':')) { const p = i.split(':').map((s) => s.trim()); return `module.exports.${p[1]} = ${p[0]};`; }
    return `module.exports.${i} = ${i};`;
  }).join(' '));
  if (hoisted.length) result += '\n' + hoisted.map((n) => `module.exports.${n} = ${n};`).join('\n');
  return result;
}
const hoisted = [];

// ---- 复刻 sandbox.ts: 双源解析辅助 ----
const dirOf = (p) => { const i = p.lastIndexOf('/'); return i >= 0 ? p.slice(0, i) : ''; };
const joinLocalPaths = (baseDir, rel) => {
  const parts = baseDir ? baseDir.split('/') : [];
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop(); else parts.push(seg);
  }
  return parts.join('/');
};
const normalizeLocalPath = (p) => String(p || '').replace(/^\.\//, '').replace(/^\//, '');

// ---- mock 宿主：extension_settings 共享 store ----
const extension_settings = {};
let saveCalls = 0;
const saveSettingsDebounced = () => { saveCalls++; };

// ---- mock 真实 jQuery（查真实 DOM 树，记录 append / on） ----
const dom = { '#extensions_settings': { html: '' } };
const appended = [];
const handlers = {};
function $(selector) {
  const node = dom[selector];
  return {
    length: node ? 1 : 0,
    append(html) { if (node) node.html += html; appended.push({ selector, html }); },
    on(evt, cb) { (handlers[selector + ':' + evt] ||= []).push(cb); },
    find() { return { length: 0 }; },
  };
}

// ---- mock document / window ----
const document = { readyState: 'complete' };
const window = { addEventListener() {} };

// ---- 双源 makeRequire ----
const local = new Map([['core/constants.js', constCode]]);
const ST = {}; // 本范本不依赖 ST 模块
const makeRequire = (baseDir) => (importPath) => {
  const normalized = String(importPath).replace(/^\.?\/?/, '').replace(/^(\.\.\/)+/, '').replace(/^scripts\//, '');
  if (ST[normalized]) return ST[normalized];
  const localKey = importPath.startsWith('.') ? joinLocalPaths(baseDir, importPath) : normalized;
  if (local.has(localKey)) {
    const module = { exports: {} };
    const fn = new Function('require', 'module', 'exports', transpileEsmToCommonJS(local.get(localKey)));
    fn(makeRequire(dirOf(localKey)), module, module.exports);
    return module.exports;
  }
  throw new Error('MODULE_NOT_FOUND: ' + importPath + ' -> ' + localKey);
};

// ---- 执行入口 index.js（复刻 sandbox wrappedCode 的全局注入） ----
const module = { exports: {} };
const wrapped = transpileEsmToCommonJS(indexCode);
const executor = new Function(
  'require', 'module', 'exports',
  'extension_settings', '$', 'saveSettingsDebounced', 'document', 'window',
  wrapped,
);
executor(makeRequire(''), module, module.exports, extension_settings, $, saveSettingsDebounced, document, window);

// ---- 断言 ----
let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

const EXT_ID = 'palink-sample-extension';
console.log('\nPalink 轻插件范本验证：');
assert(
  extension_settings[EXT_ID] && extension_settings[EXT_ID].enabled === true,
  '1) extension_settings[' + EXT_ID + '] 被初始化',
);
assert(
  appended.length === 1 && appended[0].selector === '#extensions_settings' && appended[0].html.includes(EXT_ID + '_container'),
  '2) 设置面板通过 jQuery 注入真实 #extensions_settings（含 container id）',
);
assert(
  appended[0].html.includes('v1.0.0'),
  '3) VERSION 来自 ./core/constants.js —— 多文件模块加载（双源解析）成功',
);

// 触发复选框 change
const cb = handlers['#' + EXT_ID + '_enabled:change']?.[0];
assert(typeof cb === 'function', '4) 复选框 change 处理器已绑定');
if (cb) {
  cb({ target: { checked: false } });
  assert(extension_settings[EXT_ID].enabled === false, '   4a) change 更新 settings.enabled');
  assert(saveCalls === 1, '   4b) saveSettingsDebounced 被调用（持久化）');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
