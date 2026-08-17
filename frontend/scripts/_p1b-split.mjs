// P1-b 机械拆分：把 helpers.ts 的 104 个纯函数按无环依赖图拆成 9 个主题模块。
// 逻辑零改动。buildShim 与 smartCardRuntimeConfigFallback 的 let 声明位置特殊处理。
import fs from 'fs';
import path from 'path';

const HELPERS = 'src/components/ui/custom/smart-card-runtime/helpers.ts';
const DIR = 'src/components/ui/custom/smart-card-runtime';
const src = fs.readFileSync(HELPERS, 'utf8');
const lines = src.split('\n');

// ---------- 1) 解析原 import 行 -> importMap ----------
const importMap = {}; // name -> source
const defaultNames = new Set(); // 默认导入名（import X from '...'）
const typeNames = new Set(); // 仅类型导入名（import type { ... }）
const importLines = [];
for (let i = 0; i < Math.min(lines.length, 20); i++) {
  const m = lines[i].match(/^import\s+(.+?)\s+from\s+['"](.+?)['"];?$/);
  if (!m) continue;
  const clause = m[1];
  const source = m[2];
  // 拒绝非法模块说明符（如被误解析为 'function toString() { [native code] }' 的垃圾行）
  if (!/^[\w@./:-]+$/.test(source)) continue;
  importLines.push({ raw: lines[i], source });
  const isType = /^type\b/.test(clause);
  const body = clause.replace(/^type\s+/, '').trim();
  // default import: import X from '...'
  const def = body.match(/^([A-Za-z_$][\w$]*)$/);
  if (def) { importMap[def[1]] = source; defaultNames.add(def[1]); continue; }
  // named: import { a, b as c } from '...'  (含 type 前缀)
  const named = body.replace(/^\{/, '').replace(/\}$/, '');
  named.split(',').forEach((part) => {
    const mm = part.trim().match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
    if (mm) { const n = mm[2] || mm[1]; importMap[n] = source; if (isType) typeNames.add(n); }
  });
}

// ---------- 2) 解析顶层 decl (col 0) ----------
const declRe = /^(?:export\s+)?(?:async\s+)?(function|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;
const decls = [];
for (let i = 0; i < lines.length; i++) {
  const m = declRe.exec(lines[i]);
  if (m) decls.push({ kind: m[1], name: m[2], line: i + 1 });
}
decls.sort((a, b) => a.line - b.line);
for (let i = 0; i < decls.length; i++) {
  decls[i].end = (i + 1 < decls.length ? decls[i + 1].line - 1 : lines.length);
}
const declByName = new Map(decls.map((d) => [d.name, d]));

// ---------- 3) MODULE_MAP ----------
const MODULE_MAP = {
  // primitives: 全部叶子函数（内部零回调）
  normalizeHtmlCandidate: 'primitives', htmlUsesViewportHeight: 'primitives', htmlSupportsOuterCollapse: 'primitives',
  hashSmartCardSource: 'primitives', preloadSmartCardRuntimeConfig: 'primitives', getSmartCardTrustKey: 'primitives',
  compactSmartCardChatMessages: 'primitives', getCurrentInterfaceLanguage: 'primitives', isIOSLikeDevice: 'primitives',
  clampColorByte: 'primitives', getRelativeLuminance: 'primitives', getDefaultImmersiveTheme: 'primitives',
  clampSmartCardHeight: 'primitives', getVisualViewportHeight: 'primitives', getLayoutViewportHeight: 'primitives',
  isSmartCardVisualKeyboardLikelyOpen: 'primitives', roundSmartCardNumber: 'primitives', getNearestScrollContainer: 'primitives',
  findPalinkHtmlBlock: 'primitives', dedupeHtmlParts: 'primitives', stripHtmlFenceLeftovers: 'primitives', safeJson: 'primitives',
  normalizeSmartCardStorageId: 'primitives', escapeHtmlAttribute: 'primitives', escapeQuotedScriptNewlines: 'primitives',
  loosenSmartCardGlobalLexicalDeclarations: 'primitives', normalizeSmartCardResourceUrl: 'primitives', classifySmartCardResource: 'primitives',
  getSillyTavernPluginAssetUrl: 'primitives', mergeSmartCardResourcePlans: 'primitives', getSmartCardHintPreloadAs: 'primitives',
  getSmartCardCacheValue: 'primitives', setSmartCardCacheValue: 'primitives', REGEX_PRECEDING_KEYWORDS: 'primitives',
  isCrossOriginResource: 'primitives', hintSmartCardOrigin: 'primitives', postSmartCardAssetPrefetch: 'primitives',
  scheduleSmartCardIdleTask: 'primitives', cancelSmartCardIdleTask: 'primitives', resolveHtmlRenderMode: 'primitives',
  toSmartCardRuntimeMode: 'primitives', sanitizeCss: 'primitives', scopeSelector: 'primitives', findMatchingBrace: 'primitives',
  extractTagContent: 'primitives', collectInlineStyles: 'primitives',
  // hashing
  stableSmartCardStringify: 'hashing', hashSmartCardUnknown: 'hashing', getSmartCardBootContextSignature: 'hashing', adaptSmartCardRuntimeAccess: 'hashing',
  // storage
  getSmartCardStorageNamespace: 'storage', getSmartCardStorageKey: 'storage', readSmartCardStorageBucket: 'storage',
  writeSmartCardStorageBucket: 'storage', readSmartCardPersistedStorage: 'storage', applySmartCardStoragePatch: 'storage',
  readSmartCardTrustGrant: 'storage', writeSmartCardTrustGrant: 'storage', SMART_CARD_STORAGE_PREFIX: 'storage', SmartCardPersistedStorage: 'storage',
  // html-detect
  isFullHtmlDocument: 'html-detect', looksLikeSmartCardHtml: 'html-detect', looksLikeRenderableCardHtml: 'html-detect',
  htmlPrefersAvailableHeight: 'html-detect', htmlPrefersImmersive: 'html-detect', htmlNeedsIframe: 'html-detect',
  // viewport-theme
  parseCssColor: 'viewport-theme', rgbaToCss: 'viewport-theme', flattenColorOver: 'viewport-theme', resolveImmersiveTheme: 'viewport-theme',
  extractSmartCardCssColors: 'viewport-theme', inferImmersiveThemeFromHtml: 'viewport-theme', estimateIframeInitialHeight: 'viewport-theme',
  estimateIframeMaxHeight: 'viewport-theme', clampSmartCardAvailableHeight: 'viewport-theme', getSmartCardComposerHeight: 'viewport-theme',
  getSmartCardSafeAreaTop: 'viewport-theme', getSmartCardAvailableHeight: 'viewport-theme', collectSmartCardViewportContext: 'viewport-theme',
  // script-norm
  normalizeSmartCardScriptBlocks: 'script-norm', addSmartCardScriptNonce: 'script-norm', addAttributeToHtmlTag: 'script-norm',
  // html-extract
  looksLikeRawSmartCardRemainder: 'html-extract', extractFullHtmlDocuments: 'html-extract', settleExtractedSmartCard: 'html-extract',
  appendMarkdownPart: 'html-extract', findHtmlCodeFence: 'html-extract', findFullHtmlDocument: 'html-extract', findNextHtmlBlock: 'html-extract',
  normalizeRemainingMarkdown: 'html-extract', extractHtmlBlocks: 'html-extract', extractHtmlRenderParts: 'html-extract',
  getHtmlRenderSignature: 'html-extract', removeFullDocumentShell: 'html-extract',
  // resource
  getSmartCardAssetProxyUrl: 'resource', rewriteSmartCardAssetUrlsForProxy: 'resource', fetchWarmSmartCardResource: 'resource',
  warmSmartCardResource: 'resource', getSmartCardRemoteAssetUrls: 'resource', prefetchSmartCardAssets: 'resource',
  optimizeSmartCardHtmlForRuntime: 'resource', buildSmartCardResourcePlan: 'resource', buildSillyTavernPluginResourcePlan: 'resource',
  buildSmartCardResourceHints: 'resource', scheduleSmartCardResourceWarmup: 'resource',
  // adapter-css
  scopeCss: 'adapter-css', buildSmartCardAdapterStyle: 'adapter-css', prepareInlineHtml: 'adapter-css',
};
const KEEP_IN_HELPERS = new Set(['buildShim']); // 留在 helpers.ts，不动 shim 验证基线

// ---------- 4) 完整性校验 (覆盖 function/const/let/type 等所有顶层声明) ----------
const missing = decls
  .filter((d) => !(d.name in MODULE_MAP) && !KEEP_IN_HELPERS.has(d.name) && d.name !== 'smartCardRuntimeConfigFallback')
  .map((d) => `${d.kind} ${d.name}`);
if (missing.length) throw new Error('以下声明未在 MODULE_MAP 中且非 buildShim/let: ' + missing.join(', '));

// ---------- 5) 函数调用图 + 模块级无环校验 ----------
function sliceOf(d) { return lines.slice(d.line - 1, d.end).join('\n'); }
const fnNames = decls.filter((d) => d.kind === 'function' || d.kind === 'const').map((d) => d.name);
const allNames = new Set(fnNames);
function calledBy(d) {
  const seg = sliceOf(d);
  const called = new Set();
  for (const n of allNames) {
    if (n === d.name) continue;
    if (new RegExp('\\b' + n + '\\s*\\(', 'g').test(seg)) called.add(n);
  }
  return called;
}
const edges = {};
for (const d of decls) if (d.kind === 'function' || d.kind === 'const') edges[d.name] = calledBy(d);

// module-level edges
const modEdges = {}; // mod -> Set(mod)
for (const [name, callees] of Object.entries(edges)) {
  const fromMod = MODULE_MAP[name];
  if (!fromMod) continue; // buildShim
  for (const c of callees) {
    const toMod = MODULE_MAP[c];
    if (toMod && toMod !== fromMod) {
      (modEdges[fromMod] = modEdges[fromMod] || new Set()).add(toMod);
    }
  }
}
// DFS 环检测
const mods = ['primitives', 'hashing', 'storage', 'html-detect', 'viewport-theme', 'script-norm', 'html-extract', 'resource', 'adapter-css'];
const color = {}; // 0=unvisited 1=in-stack 2=done
let cyclePath = null;
function dfs(m, stack) {
  color[m] = 1;
  for (const nxt of modEdges[m] || []) {
    if (color[nxt] === 1) { cyclePath = [...stack, nxt]; return true; }
    if (!color[nxt] && dfs(nxt, [...stack, nxt])) return true;
  }
  color[m] = 2;
  return false;
}
for (const m of mods) {
  if (!color[m] && dfs(m, [m])) throw new Error('检测到模块级循环依赖: ' + cyclePath.join(' -> '));
}
console.log('[ok] 完整性 + 无环校验通过');

// ---------- 6) 各模块收集函数切片 ----------
const moduleFns = {}; // mod -> [decl]
for (const d of decls) {
  if (d.kind !== 'function' && d.kind !== 'const' && d.kind !== 'type') continue;
  const mod = MODULE_MAP[d.name];
  if (mod) (moduleFns[mod] = moduleFns[mod] || []).push(d);
}
// smartCardRuntimeConfigFallback 的 let 声明 -> primitives
const letDecl = decls.find((d) => d.name === 'smartCardRuntimeConfigFallback' && d.kind === 'let');
if (!letDecl) throw new Error('未找到 smartCardRuntimeConfigFallback 的 let 声明');
const letSlice = sliceOf(letDecl);

// ---------- 7) 每个模块生成导入 ----------
function tokenize(code) {
  const set = new Set();
  const re = /[A-Za-z_$][\w$]*/g;
  let m;
  while ((m = re.exec(code)) !== null) set.add(m[0]);
  return set;
}
// 合并多个 { src -> Set(names) } 映射（同名 src 合并为同一集合）
function mergeSources(...maps) {
  const out = {};
  for (const m of maps) {
    for (const [src, names] of Object.entries(m)) {
      const target = (out[src] = out[src] || new Set());
      for (const n of names) target.add(n);
    }
  }
  return out;
}
// 统一生成 import 语句：区分 default / 具名值 / 仅类型
function emitImports(bySource) {
  let imp = '';
  for (const [src, names] of Object.entries(bySource)) {
    const arr = [...names];
    const defaults = arr.filter((n) => defaultNames.has(n));
    const types = arr.filter((n) => typeNames.has(n) && !defaultNames.has(n));
    const values = arr.filter((n) => !defaultNames.has(n) && !typeNames.has(n));
    let line = '';
    if (defaults.length) {
      if (values.length) line += `import ${defaults.join(', ')}, { ${values.sort().join(', ')} } from '${src}';`;
      else line += `import ${defaults.join(', ')} from '${src}';`;
    } else if (values.length) {
      line += `import { ${values.sort().join(', ')} } from '${src}';`;
    }
    if (types.length) {
      if (line) line += '\n';
      line += `import type { ${types.sort().join(', ')} } from '${src}';`;
    }
    imp += line + '\n';
  }
  return imp;
}
const moduleCode = {}; // mod -> concatenated code
for (const mod of mods) {
  const fns = moduleFns[mod] || [];
  let code = fns.map(sliceOf).join('\n\n');
  // 把 let 声明放到 primitives 顶部
  if (mod === 'primitives') code = letSlice + '\n\n' + code;
  moduleCode[mod] = code;
}

const moduleFiles = {}; // mod -> final file content
for (const mod of mods) {
  const code = moduleCode[mod];
  const tokens = tokenize(code);
  const localNames = new Set((moduleFns[mod] || []).map((d) => d.name));
  if (mod === 'primitives') localNames.add('smartCardRuntimeConfigFallback');
  // 外部/共享导入
  const extBySource = {};
  for (const tok of tokens) {
    if (Object.prototype.hasOwnProperty.call(importMap, tok) && !localNames.has(tok)) {
      const src = importMap[tok];
      (extBySource[src] = extBySource[src] || new Set()).add(tok);
    }
  }
  // 跨模块函数导入（key 直接带 ./ 前缀，供 emitImports 直接拼接）
  const crossByMod = {};
  for (const tok of tokens) {
    if (Object.prototype.hasOwnProperty.call(MODULE_MAP, tok) && MODULE_MAP[tok] !== mod && !localNames.has(tok)) {
      const key = './' + MODULE_MAP[tok];
      (crossByMod[key] = crossByMod[key] || new Set()).add(tok);
    }
  }
  const bySource = mergeSources(extBySource, crossByMod);
  const imp = emitImports(bySource);
  moduleFiles[mod] = `// AUTO-SPLIT from helpers.ts (P1-b, 逻辑未改动)\n${imp}\n${code}\n`;
}

// ---------- 8) 写模块文件 ----------
for (const mod of mods) {
  fs.writeFileSync(path.join(DIR, mod + '.ts'), moduleFiles[mod], 'utf8');
  console.log(`[write] ${mod}.ts  (${moduleFiles[mod].length} bytes, ${(moduleFns[mod] || []).length + (mod === 'primitives' ? 1 : 0)} 个顶层)`);
}

// ---------- 9) 重写 helpers.ts ----------
const buildShimDecl = declByName.get('buildShim');
const buildShimCode = sliceOf(buildShimDecl);
// 用与子模块相同的 token 扫描 + 跨模块路由来生成 helpers.ts 的导入，避免漏导 buildShim 用到的符号
const buildTokens = tokenize(buildShimCode);
const helpBySource = {};
  for (const tok of buildTokens) {
    if (tok === 'buildShim') continue;
    if (Object.prototype.hasOwnProperty.call(MODULE_MAP, tok)) {
      const key = './' + MODULE_MAP[tok];
      (helpBySource[key] = helpBySource[key] || new Set()).add(tok);
    } else if (Object.prototype.hasOwnProperty.call(importMap, tok)) {
      const src = importMap[tok];
      (helpBySource[src] = helpBySource[src] || new Set()).add(tok);
    }
  }
const helpersImports = emitImports(helpBySource);
const reExports = mods.map((m) => `export * from './${m}';`).join('\n');
const newHelpers =
`// AUTO-GENERATED (P1-b 拆分后: 仅保留 buildShim + 重新导出各子模块)
// 源: src/components/ui/custom/CharacterCardRenderer.tsx
${helpersImports}

${reExports}

${buildShimCode}
`;
fs.writeFileSync(HELPERS, newHelpers, 'utf8');
console.log(`[write] helpers.ts  (${newHelpers.length} bytes, 保留 buildShim)`);
console.log('DONE');
