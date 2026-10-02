/**
 * 卡内脚本的 IndexedDB 按角色分库（2026-10-02，Q2 甲方案）
 *
 * 缺陷：气泡插件把 CG / 头像缓存存在 IndexedDB 的 `BubbleDialogueAvatars` 库里，
 * 而 `cg_groups` 的主键是 `'cg_group__' + group` —— **不含角色**。
 * 两张卡用了同名分组时，后写的会 `_put` 整条覆盖前者，
 * 且 `listCgGroups` 按 charId 过滤后前者**永久不可见** —— 是数据丢失，不只是串读。
 *
 * 修法：给库名加角色后缀，让每张卡开自己的库。
 *
 * ── 为什么是白名单，而不是一刀切 ────────────────────────────────────────
 * `GalgameUIPluginDB` 这个库名是**两边共用**的：父帧的 Live2DPoolPanel 写不带后缀的那个，
 * 帧内 galgame 插件读它。一刀切给所有库加后缀 → 插件去读 `GalgameUIPluginDB__<id>` → 空库
 * → **Live2D 绑定直接失效**。所以只动有实证问题的 BubbleDialogueAvatars。
 *
 * ── 为什么本文件要导出「JS 源码字符串」而不是普通函数 ────────────────────
 * 消费方 `smart-card-runtime/SillyTavernCompatRuntime.ts` 整体是一个注入 iframe 的
 * **模板字符串**（生成的是脚本文本，不是运行的 TS）。那边没法 import 本模块，
 * 只能把源码文本插值进去。因此这里同时提供：
 *   - TS 实现（给单测用、给父帧侧复用）
 *   - `IDB_NS_RUNTIME_SOURCE`：等价的纯 JS 源码文本（给 iframe 侧插值注入）
 * 两边语义必须一致，单测里会把 RUNTIME_SOURCE 丢进 vm 跑一遍来钉住它。
 *
 * ⚠️ 维护守则：`IDB_NS_RUNTIME_SOURCE` 里**不许出现反引号、美元符号加花括号的插值写法、
 * 以及会被模板吃掉的反斜杠转义** —— 它会经过宿主模板字符串，写错就是「整段运行时静默死亡」。
 */

/** 需要按角色分库的库名白名单（精确匹配）。新增前先确认它不是父帧与帧内共用的库。 */
export const CARD_SCOPED_IDB_DBS = ['BubbleDialogueAvatars'];

/** 分库后缀的分隔符 */
const SUFFIX_SEPARATOR = '__';

/**
 * 止血开关的 localStorage 键。在**主框架**（App 那个窗口）里写
 * `localStorage.palink_idb_namespace = '0'` 后刷新，即整体关闭按角色分库。
 *
 * 为什么要有它：本次改动落在所有智能卡共用的 iframe 运行时上，爆半径远大于单卡，
 * 而「出问题要重新构建才能关掉」是不可接受的 —— 与 `palink_card_tavern_helper_scripts`
 * 同一套约定（见 card-script-runner.ts）。
 *
 * 注意开关读的是**父窗口的真实 localStorage**：卡 iframe 里那份 localStorage 已被换成
 * 按角色桶，读它等于每张卡各配一份开关，失去止血意义。
 */
export const IDB_NS_KILL_SWITCH_KEY = 'palink_idb_namespace';

/** 后缀长度上限，避免超长 id 把库名撑爆 */
const SUFFIX_MAX_LEN = 64;

/**
 * 把角色 id 安全化成可放进 IDB 库名的后缀。
 * 拿不到 / 全是非法字符时返回空串 —— 空串代表「不分库」，
 * 宁可少隔离，也不能生成一个谁都认不出来的库名。
 */
export function sanitizeIdbSuffix(raw: string | null | undefined): string {
  const input = String(raw == null ? '' : raw).trim();
  const safe = input.replace(/[^A-Za-z0-9_-]/g, '').slice(0, SUFFIX_MAX_LEN);
  return safe.length > 0 ? safe : '';
}

/** 白名单内的库名加后缀，其余原样返回（一刀切会打断 Live2D，见文件头说明）。 */
export function scopeIdbName(name: string | null | undefined, suffix: string): string {
  const raw = String(name == null ? '' : name);
  if (!suffix) return raw;
  return CARD_SCOPED_IDB_DBS.indexOf(raw) >= 0 ? raw + SUFFIX_SEPARATOR + suffix : raw;
}

/**
 * 在 srcdoc 最前面插入自举脚本。
 * 不是 HTML（空串、纯文本）就原样返回 —— 免得把人家的东西改坏。
 */
export function prependIdbBootstrap(html: unknown, bootstrap: string): string {
  const src = html == null ? '' : String(html);
  if (src.length === 0 || src.indexOf('<') < 0) return src;
  return '<script>' + bootstrap + '</script>' + src;
}

/**
 * 子帧自举脚本源码。
 *
 * 跑在嵌套 srcdoc 子帧（dcRoot）的最前面 —— 只有「分库」这一件事。
 * 之所以需要它：存储 shim 装的是**本 realm 的 window**，而子帧是浏览器给的全新 realm，
 * 不继承任何父帧属性。不传播的话，本帧分了库、插件那边照样写回共用的旧库，等于白做。
 *
 * 用纯字符串拼接、不含反引号与插值：它要被塞进别人的 srcdoc 里，
 * 任何转义意外都会变成「整张卡解析失败」。
 */
export function buildIdbBootstrapSource(suffix: string): string {
  return (
    '(function(){try{' +
    'var S=' + JSON.stringify(suffix) + ',' +
    'N=window.indexedDB,' +
    'L=' + JSON.stringify(CARD_SCOPED_IDB_DBS) + ';' +
    'if(!N||!S)return;' +
    'var F=function(n){var s=String(n==null?"":n);return L.indexOf(s)>=0?s+"' + SUFFIX_SEPARATOR + '"+S:s;};' +
    'Object.defineProperty(window,"indexedDB",{configurable:true,value:{' +
    'open:function(a,b){return N.open(F(a),b);},' +
    'deleteDatabase:function(a){return N.deleteDatabase(F(a));},' +
    'cmp:function(a,b){return N.cmp(a,b);}' +
    '}});' +
    '}catch(e){}})();'
  );
}

/**
 * iframe 侧要用的运行时源码（纯 JS 文本，供 SillyTavernCompatRuntime 插值注入）。
 *
 * 提供：`scopeIdbName` / `makeScopedIdbShim` / `installIdbShimPropagation`。
 * 调用方负责先算出 suffix 再调 install。
 */
export const IDB_NS_RUNTIME_SOURCE = [
  'var IDB_NAMESPACE_DBS = ' + JSON.stringify(CARD_SCOPED_IDB_DBS) + ';',
  'var sanitizeIdbSuffix = function (raw) {',
  '  var input = String(raw == null ? "" : raw).trim();',
  '  var safe = input.replace(/[^A-Za-z0-9_-]/g, "").slice(0, ' + SUFFIX_MAX_LEN + ');',
  '  return safe.length > 0 ? safe : "";',
  '};',
  'var idbNamespaceDisabled = function () {',
  '  try {',
  '    var p = window.parent;',
  '    if (p && p !== window && p.localStorage) {',
  '      return p.localStorage.getItem("' + IDB_NS_KILL_SWITCH_KEY + '") === "0";',
  '    }',
  '  } catch (e) {}',
  '  return false;',
  '};',
  'var buildIdbBootstrap = function (suffix) {',
  '  return (',
  '    "(function(){try{" +',
  '    "var S=" + JSON.stringify(suffix) + "," +',
  '    "N=window.indexedDB," +',
  '    "L=" + JSON.stringify(IDB_NAMESPACE_DBS) + ";" +',
  '    "if(!N||!S)return;" +',
  '    "var F=function(n){var s=String(n==null?\\"\\":n);return L.indexOf(s)>=0?s+\\"' + SUFFIX_SEPARATOR + '\\"+S:s;};" +',
  '    "Object.defineProperty(window,\\"indexedDB\\",{configurable:true,value:{" +',
  '    "open:function(a,b){return N.open(F(a),b);}," +',
  '    "deleteDatabase:function(a){return N.deleteDatabase(F(a));}," +',
  '    "cmp:function(a,b){return N.cmp(a,b);}" +',
  '    "}});" +',
  '    "}catch(e){}})();"',
  '  );',
  '};',
  'var scopeIdbName = function (name, suffix) {',
  '  var raw = String(name == null ? "" : name);',
  '  if (!suffix) return raw;',
  '  return IDB_NAMESPACE_DBS.indexOf(raw) >= 0 ? raw + "' + SUFFIX_SEPARATOR + '" + suffix : raw;',
  '};',
  'var makeScopedIdbShim = function (native, suffix) {',
  '  return {',
  '    open: function (name, version) { return native.open(scopeIdbName(name, suffix), version); },',
  '    deleteDatabase: function (name) { return native.deleteDatabase(scopeIdbName(name, suffix)); },',
  '    cmp: function (a, b) { return native.cmp(a, b); }',
  '  };',
  '};',
  'var prependIdbBootstrap = function (html, bootstrap) {',
  '  var src = html == null ? "" : String(html);',
  '  if (src.length === 0 || src.indexOf("<") < 0) return src;',
  '  return "<script>" + bootstrap + "</" + "script>" + src;',
  '};',
  'var installIdbShimPropagation = function (suffix, bootstrapSource) {',
  '  if (!suffix) return;',
  '  var proto = window.HTMLIFrameElement && window.HTMLIFrameElement.prototype;',
  '  if (!proto) return;',
  '  try {',
  '    var desc = Object.getOwnPropertyDescriptor(proto, "srcdoc");',
  '    if (!desc || typeof desc.set !== "function") return;',
  '    var originalSet = desc.set, originalGet = desc.get;',
  '    Object.defineProperty(proto, "srcdoc", {',
  '      configurable: true,',
  '      get: function () { return typeof originalGet === "function" ? originalGet.call(this) : undefined; },',
  '      set: function (value) {',
  '        try { originalSet.call(this, prependIdbBootstrap(value, bootstrapSource)); }',
  '        catch (e) { try { originalSet.call(this, value); } catch (e2) {} }',
  '      }',
  '    });',
  '  } catch (e) {}',
  '  try {',
  '    var originalSetAttribute = proto.setAttribute;',
  '    if (typeof originalSetAttribute !== "function" || originalSetAttribute.__palinkIdbNs) return;',
  '    var patched = function (name, value) {',
  '      try {',
  '        if (String(name == null ? "" : name).toLowerCase() === "srcdoc") {',
  '          return originalSetAttribute.call(this, name, prependIdbBootstrap(value, bootstrapSource));',
  '        }',
  '      } catch (e) {}',
  '      return originalSetAttribute.call(this, name, value);',
  '    };',
  '    patched.__palinkIdbNs = true;',
  '    proto.setAttribute = patched;',
  '  } catch (e) {}',
  '};',
].join('\n');
