// tsx 加载器：为契约测试提供 CSS / CJS / 浏览器包兼容支持
//
// 用途：`npx tsx --import ./_tsx-loader.mjs <test-file>.ts`
//
// 解决的问题：
//   1. toastr/build/toastr.min.css 等 .css 副作用导入在 Node.js ESM 下无法解析
//      → 将 .css 导入替换为空模块
//   2. showdown / dompurify 等 CJS 包的具名导入在 Node.js ESM 下报错
//      → 对特定 CJS 模块生成 ESM 包装器，透传 default 与具名导出
//   3. dompurify 在 Node.js 下无法自动初始化（需要 window 对象）
//      → 提供 mock 实现（addHook/no-op + sanitize/identity）
//   4. jquery / select2 / toastr 在 Node.js 下无 window/document
//      → 提供链式调用 mock / no-op factory
import { register } from 'node:module';

// ============================================================
// 全局环境 mock：Node.js 下缺少浏览器全局对象
// 在 --import 阶段执行，先于测试文件加载
// ============================================================

// localStorage mock（Node.js v25 可能有不完整的内置实现，强制覆盖）
{
  const _store = new Map();
  globalThis.localStorage = {
    getItem: (key) => _store.has(String(key)) ? _store.get(String(key)) : null,
    setItem: (key, value) => { _store.set(String(key), String(value)); },
    removeItem: (key) => { _store.delete(String(key)); },
    clear: () => { _store.clear(); },
    key: (i) => Array.from(_store.keys())[i] ?? null,
    get length() { return _store.size; },
  };
}

// sessionStorage mock
{
  const _store = new Map();
  globalThis.sessionStorage = {
    getItem: (key) => _store.has(String(key)) ? _store.get(String(key)) : null,
    setItem: (key, value) => { _store.set(String(key), String(value)); },
    removeItem: (key) => { _store.delete(String(key)); },
    clear: () => { _store.clear(); },
    key: (i) => Array.from(_store.keys())[i] ?? null,
    get length() { return _store.size; },
  };
}

// window mock（极简：仅满足 getContext.ts 中的 window.xxx 访问）
if (!globalThis.window) {
  globalThis.window = {
    localStorage: globalThis.localStorage,
    sessionStorage: globalThis.sessionStorage,
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    addEventListener: () => {},
    removeEventListener: () => {},
    chat_metadata: undefined,
  };
}

// document mock（极简：仅满足 document.querySelector / document.createElement）
if (!globalThis.document) {
  const _noop = () => {};
  const _element = {
    style: {}, classList: { add: _noop, remove: _noop, toggle: _noop, contains: () => false },
    appendChild: () => _element, removeChild: () => _element,
    insertBefore: () => _element, setAttribute: _noop, getAttribute: () => null,
    addEventListener: _noop, removeEventListener: _noop,
    querySelector: () => null, querySelectorAll: () => [],
    scrollTop: 0, scrollHeight: 0, innerHTML: '', textContent: '',
    getContext: () => null,
  };
  globalThis.document = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ ..._element }),
    createTextNode: (text) => ({ textContent: String(text) }),
    createTreeWalker: () => ({ nextNode: () => null }),
    addEventListener: _noop,
    removeEventListener: _noop,
    body: _element,
    head: _element,
    documentElement: _element,
  };
}

// navigator mock
if (!globalThis.navigator) {
  globalThis.navigator = { userAgent: 'node', language: 'en' };
}

// 使用数组拼接避免模板字面量嵌套转义问题
const loaderLines = [
  'export async function load(url, context, nextLoad) {',
  '  // 1. .css 文件 → 空模块（toastr.min.css 等副作用导入）',
  "  if (url.endsWith('.css')) {",
  "    return { format: 'module', source: '', shortCircuit: true };",
  '  }',
  '',
  '  // 2. showdown CJS interop: formatting.ts 使用 import { Converter } from "showdown"',
  "  if (url.includes('/node_modules/showdown/') && url.endsWith('.js')) {",
  "    const src = [",
  "      \"import { createRequire } from 'node:module';\",",
  "      'const _req = createRequire(' + JSON.stringify(url) + ');',",
  "      'const _mod = _req(' + JSON.stringify(url) + ');',",
  "      'export default _mod;',",
  "      'export const Converter = _mod.Converter;',",
  "    ].join('\\n');",
  "    return { format: 'module', source: src, shortCircuit: true };",
  '  }',
  '',
  '  // 3. dompurify mock: 在 Node.js 下无法自动初始化（需要 window），提供测试用 mock',
  "  if (url.includes('/node_modules/dompurify/') && (url.endsWith('.js') || url.endsWith('.mjs'))) {",
  "    const src = [",
  "      'const _noop = () => {};',",
  "      'const _identity = (x) => x;',",
  "      'const DOMPurify = (x) => x;',",
  "      'DOMPurify.addHook = _noop;',",
  "      'DOMPurify.sanitize = _identity;',",
  "      'DOMPurify.removeAllHooks = _noop;',",
  "      'DOMPurify.removeHook = _noop;',",
  "      'DOMPurify.version = \"3.0.0-mock\";',",
  "      'DOMPurify.isSupported = true;',",
  "      'DOMPurify.removed = [];',",
  "      'export default DOMPurify;',",
  "    ].join('\\n');",
  "    return { format: 'module', source: src, shortCircuit: true };",
  '  }',
  '',
  '  // 4. jquery mock: Node.js 下无 window/document，提供链式调用 mock',
  "  if (url.includes('/node_modules/jquery/') && url.endsWith('.js')) {",
  "    const src = [",
  "      'const _noop = () => {};',",
  "      'const _fn = function(sel, ctx) { return _fn; };',",
  "      '_fn.ready = _fn;',",
  "      '_fn.on = _fn;',",
  "      '_fn.off = _fn;',",
  "      '_fn.find = _fn;',",
  "      '_fn.each = _fn;',",
  "      '_fn.html = _fn;',",
  "      '_fn.text = _fn;',",
  "      '_fn.val = _fn;',",
  "      '_fn.append = _fn;',",
  "      '_fn.remove = _fn;',",
  "      '_fn.attr = _fn;',",
  "      '_fn.prop = _fn;',",
  "      '_fn.css = _fn;',",
  "      '_fn.addClass = _fn;',",
  "      '_fn.removeClass = _fn;',",
  "      '_fn.toggleClass = _fn;',",
  "      '_fn.trigger = _fn;',",
  "      '_fn.bind = _fn;',",
  "      '_fn.unbind = _fn;',",
  "      '_fn.click = _fn;',",
  "      '_fn.change = _fn;',",
  "      '_fn.submit = _fn;',",
  "      '_fn.show = _fn;',",
  "      '_fn.hide = _fn;',",
  "      '_fn.fadeIn = _fn;',",
  "      '_fn.fadeOut = _fn;',",
  "      '_fn.slideUp = _fn;',",
  "      '_fn.slideDown = _fn;',",
  "      '_fn.animate = _fn;',",
  "      '_fn.stop = _fn;',",
  "      '_fn.delay = _fn;',",
  "      '_fn.promise = () => Promise.resolve(_fn);',",
  "      '_fn.then = (cb) => { try { cb && cb(); } catch(e){} return _fn; };',",
  "      '_fn.done = _fn.then;',",
  "      '_fn.fail = _fn.then;',",
  "      '_fn.always = _fn.then;',",
  "      '_fn.fn = { select2: _noop, extend: Object.assign };',",
  "      '_fn.ajax = () => Promise.resolve({});',",
  "      '_fn.get = () => Promise.resolve({});',",
  "      '_fn.post = () => Promise.resolve({});',",
  "      '_fn.extend = Object.assign;',",
  "      '_fn.noConflict = () => _fn;',",
  "      'export default _fn;',",
  "    ].join('\\n');",
  "    return { format: 'module', source: src, shortCircuit: true };",
  '  }',
  '',
  '  // 5. select2 mock: jQuery 插件，在 Node.js 下无法初始化',
  "  if (url.includes('/node_modules/select2/') && url.endsWith('.js')) {",
  "    const src = 'const _noop = () => {}; _noop.default = _noop; export default _noop;';",
  "    return { format: 'module', source: src, shortCircuit: true };",
  '  }',
  '',
  '  // 6. toastr mock: 浏览器端通知库，在 Node.js 下无 window',
  "  if (url.includes('/node_modules/toastr/') && (url.endsWith('.js') || url.endsWith('.mjs'))) {",
  "    const src = [",
  "      'const _toastr = function() {};',",
  "      '_toastr.success = () => _toastr;',",
  "      '_toastr.info = () => _toastr;',",
  "      '_toastr.warning = () => _toastr;',",
  "      '_toastr.error = () => _toastr;',",
  "      '_toastr.clear = () => {};',",
  "      '_toastr.remove = () => {};',",
  "      '_toastr.options = {};',",
  "      'export default _toastr;',",
  "    ].join('\\n');",
  "    return { format: 'module', source: src, shortCircuit: true };",
  '  }',
  '',
  '  // 7. handlebars: CJS 包，Node.js 下 default import 应可通过 interop 正常加载',
  '  // 若实际加载失败，可在此添加 mock（注意：单引号字符串不能跨行）',
  '',
  '  // 8. Vite 虚拟模块（smart-card-runtime-asset 插件注入）：tsx/node 下无法解析，',
  '  //    返回空串默认导出（与 verify-shim-identity.mjs 的 runtimeUrl stub 一致）',
  "  if (url.startsWith('virtual:')) {",
  "    const src = \"const runtimeUrl = ''; export default runtimeUrl;\";",
  "    return { format: 'module', source: src, shortCircuit: true };",
  '  }',
  '',
  '  return nextLoad(url, context);',
  '}',
  '',
  'export async function resolve(specifier, context, nextResolve) {',
  '  return nextResolve(specifier, context);',
  '}',
].join('\n');

register(
  'data:text/javascript,' + encodeURIComponent(loaderLines),
  import.meta.url,
);
